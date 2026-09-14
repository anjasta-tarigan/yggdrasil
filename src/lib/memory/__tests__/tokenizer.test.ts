import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, default: { ...actual, readFileSync: vi.fn() } };
});

import {
  loadTokenizer,
  tokenizerPathFor,
  TokenizerUnavailableError,
} from "../tokenizer";

/** Minimal WordPiece tokenizer.json (BERT-style, uncased). */
function wordpieceJson() {
  return {
    model: {
      type: "WordPiece",
      unk_token: "[UNK]",
      continuing_subword_prefix: "##",
      max_input_chars_per_word: 100,
      vocab: {
        "[PAD]": 0,
        "[UNK]": 100,
        "[CLS]": 101,
        "[SEP]": 102,
        hello: 7592,
        world: 2088,
        "##ing": 2075,
        "##s": 2015,
        play: 2377,
        test: 3231,
        "!": 999,
      },
    },
    added_tokens: [{ id: 101, content: "[CLS]", special: true }],
  };
}

/**
 * Minimal Unigram tokenizer.json (SentencePiece / XLM-R style).
 * IDs are ARRAY INDICES, not an explicit map — the SentencePiece convention.
 */
function unigramJson() {
  // index: piece (score is the log-probability; higher = preferred)
  const pieces: Array<[string, number]> = [
    ["<s>", 0],
    ["<pad>", 0],
    ["</s>", 0],
    ["<unk>", 0],
    ["▁hello", -1.0],
    ["▁world", -1.0],
    ["▁", -2.0],
    ["hello", -3.0],
    ["world", -3.0],
    ["h", -4.0],
    ["e", -4.0],
    ["l", -4.0],
    ["o", -4.0],
    ["w", -4.0],
    ["r", -4.0],
    ["d", -4.0],
  ];
  return {
    model: { type: "Unigram", unk_id: 3, vocab: pieces },
    pre_tokenizer: {
      type: "Metaspace",
      replacement: "▁",
      add_prefix_space: true,
    },
    normalizer: { type: "Sequence", normalizers: [] },
  };
}

/** Minimal byte-level BPE tokenizer.json (GPT-2/RoBERTa-style). */
function bpeJson() {
  const byteChars = ["h", "e", "l", "o", "Ġ", "w", "r", "d", "s"];
  const vocab: Record<string, number> = { "<s>": 0, "</s>": 2, "<unk>": 3 };
  byteChars.forEach((c, i) => {
    vocab[c] = 100 + i;
  });
  // Merged forms used by the assertions below.
  vocab["he"] = 200;
  vocab["ll"] = 201;
  vocab["hell"] = 202;
  vocab["hello"] = 203;
  vocab["Ġ"] = 204;
  return {
    model: {
      type: "BPE",
      unk_token: "<unk>",
      vocab,
      merges: ["h e", "l l", "he ll", "hell o"],
    },
  };
}

function mockTokenizerFile(content: unknown) {
  vi.mocked(fs.readFileSync).mockReturnValue(
    typeof content === "string" ? content : JSON.stringify(content)
  );
}

describe("tokenizer", () => {
  const MODEL = "/models/embed/model.onnx";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("locates tokenizer.json beside the model file", () => {
    expect(tokenizerPathFor(MODEL)).toBe(
      path.join("/models/embed", "tokenizer.json")
    );
  });

  describe("WordPiece", () => {
    it("wraps tokens in [CLS]/[SEP] with a full attention mask", () => {
      mockTokenizerFile(wordpieceJson());
      const tokenizer = loadTokenizer(MODEL);
      const { inputIds, attentionMask } = tokenizer.encode("hello world", 512);

      expect(tokenizer.kind).toBe("wordpiece");
      expect(inputIds[0]).toBe(101); // [CLS]
      expect(inputIds.at(-1)).toBe(102); // [SEP]
      expect(inputIds.slice(1, -1)).toEqual([7592, 2088]); // hello, world
      expect(attentionMask).toEqual(inputIds.map(() => 1));
    });

    it("splits unknown words into ## continuation pieces", () => {
      mockTokenizerFile(wordpieceJson());
      const tokenizer = loadTokenizer(MODEL);
      const { inputIds } = tokenizer.encode("playing", 512);
      // play + ##ing
      expect(inputIds.slice(1, -1)).toEqual([2377, 2075]);
    });

    it("emits [UNK] when no subword decomposition exists", () => {
      mockTokenizerFile(wordpieceJson());
      const tokenizer = loadTokenizer(MODEL);
      const { inputIds } = tokenizer.encode("zzzz", 512);
      expect(inputIds.slice(1, -1)).toEqual([100]);
    });

    it("isolates punctuation as its own token", () => {
      mockTokenizerFile(wordpieceJson());
      const tokenizer = loadTokenizer(MODEL);
      const { inputIds } = tokenizer.encode("test!", 512);
      expect(inputIds.slice(1, -1)).toEqual([3231, 999]);
    });

    it("truncates to maxLength while keeping both specials", () => {
      mockTokenizerFile(wordpieceJson());
      const tokenizer = loadTokenizer(MODEL);
      const { inputIds, attentionMask } = tokenizer.encode(
        "hello world hello world hello world",
        4
      );
      expect(inputIds).toHaveLength(4);
      expect(inputIds[0]).toBe(101);
      expect(inputIds.at(-1)).toBe(102);
      expect(attentionMask).toHaveLength(4);
    });

    it("lowercases when the vocab has no uppercase pieces", () => {
      mockTokenizerFile(wordpieceJson());
      const tokenizer = loadTokenizer(MODEL);
      const { inputIds } = tokenizer.encode("HELLO", 512);
      expect(inputIds.slice(1, -1)).toEqual([7592]);
    });
  });

  describe("BPE", () => {
    it("applies merges and wraps with <s>/</s>", () => {
      mockTokenizerFile(bpeJson());
      const tokenizer = loadTokenizer(MODEL);
      const { inputIds } = tokenizer.encode("hello", 512);

      expect(tokenizer.kind).toBe("bpe");
      expect(inputIds[0]).toBe(0); // <s>
      expect(inputIds.at(-1)).toBe(2); // </s>
      // "hello" merged via the rank table.
      expect(inputIds).toContain(203);
    });

    it("byte-level encodes spaces as the Ġ marker", () => {
      mockTokenizerFile(bpeJson());
      const tokenizer = loadTokenizer(MODEL);
      const { inputIds } = tokenizer.encode("hello world", 512);
      expect(inputIds.length).toBeGreaterThan(2);
      // The leading-space marker for "world" survives encoding.
      expect(inputIds).toContain(204);
    });

    it("truncates to maxLength including the specials", () => {
      mockTokenizerFile(bpeJson());
      const tokenizer = loadTokenizer(MODEL);
      const { inputIds } = tokenizer.encode("hello hello hello hello", 3);
      expect(inputIds).toHaveLength(3);
      expect(inputIds[0]).toBe(0);
      expect(inputIds.at(-1)).toBe(2);
    });

    it("maps symbols missing from the vocab to <unk> instead of dropping them", () => {
      // A character with no vocab entry must still occupy a position — a
      // dropped token would shift every later id and skew the vector.
      const json = bpeJson();
      json.model.vocab = { ...json.model.vocab, "<unk>": 3 };
      mockTokenizerFile(json);
      const tokenizer = loadTokenizer(MODEL);

      const { inputIds } = tokenizer.encode("hÿ", 512);
      // <s>, h, <unk>(ÿ), </s>
      expect(inputIds).toContain(3);
      expect(inputIds[0]).toBe(0);
      expect(inputIds.at(-1)).toBe(2);
    });
  });

  describe("Unigram (SentencePiece / XLM-R)", () => {
    it("uses the array index as the token id", () => {
      mockTokenizerFile(unigramJson());
      const tokenizer = loadTokenizer(MODEL);
      const { inputIds } = tokenizer.encode("hello world", 512);

      expect(tokenizer.kind).toBe("unigram");
      // <s>=0 … </s>=2, with the two metaspace pieces in between.
      expect(inputIds[0]).toBe(0);
      expect(inputIds.at(-1)).toBe(2);
      expect(inputIds.slice(1, -1)).toEqual([4, 5]); // ▁hello, ▁world
    });

    it("replaces spaces with the metaspace marker", () => {
      mockTokenizerFile(unigramJson());
      const tokenizer = loadTokenizer(MODEL);
      // A leading space is added, so "world" alone maps to ▁world (id 5).
      const { inputIds } = tokenizer.encode("world", 512);
      expect(inputIds.slice(1, -1)).toEqual([5]);
    });

    it("finds the maximum-likelihood segmentation, not greedy longest-match", () => {
      // "hello" can be one piece (id 7, score -3) or h+e+l+l+o (score -20).
      // Viterbi must pick the single higher-scoring piece.
      mockTokenizerFile(unigramJson());
      const tokenizer = loadTokenizer(MODEL);
      const { inputIds } = tokenizer.encode("hello", 512);
      // ▁hello (4) wins over ▁ + hello or per-character pieces.
      expect(inputIds.slice(1, -1)).toEqual([4]);
    });

    it("falls back to <unk> for characters absent from the vocab", () => {
      mockTokenizerFile(unigramJson());
      const tokenizer = loadTokenizer(MODEL);
      const { inputIds } = tokenizer.encode("z", 512);
      expect(inputIds).toContain(3); // <unk>
    });

    it("truncates to maxLength keeping both specials", () => {
      mockTokenizerFile(unigramJson());
      const tokenizer = loadTokenizer(MODEL);
      const { inputIds, attentionMask } = tokenizer.encode(
        "hello world hello world",
        3
      );
      expect(inputIds).toHaveLength(3);
      expect(inputIds[0]).toBe(0);
      expect(inputIds.at(-1)).toBe(2);
      expect(attentionMask).toHaveLength(3);
    });

    it("throws when a Unigram vocab is not an array of pairs", () => {
      mockTokenizerFile({
        model: { type: "Unigram", unk_id: 3, vocab: { hello: 0 } },
      });
      expect(() => loadTokenizer(MODEL)).toThrow(/must have a model\.vocab array/);
    });

    it("throws when unk_id is absent and no <unk> piece exists", () => {
      mockTokenizerFile({
        model: { type: "Unigram", vocab: [["▁hi", -1]] },
      });
      expect(() => loadTokenizer(MODEL)).toThrow(/no unk_id and no <unk> piece/);
    });
  });

  describe("unsupported and missing tokenizers", () => {
    it("throws a named error when tokenizer.json is absent", () => {
      const enoent = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        throw enoent;
      });
      expect(() => loadTokenizer(MODEL)).toThrow(TokenizerUnavailableError);
      expect(() => loadTokenizer(MODEL)).toThrow(/No tokenizer\.json beside/);
    });

    it("throws for a genuinely unknown tokenizer type", () => {
      mockTokenizerFile({ model: { type: "FancyNewThing", vocab: { a: 1 } } });
      expect(() => loadTokenizer(MODEL)).toThrow(/Unsupported tokenizer type "FancyNewThing"/);
    });

    it("throws when the vocab is missing", () => {
      mockTokenizerFile({ model: { type: "WordPiece" } });
      expect(() => loadTokenizer(MODEL)).toThrow(/no model\.vocab/);
    });

    it("throws when the unk token is absent from the vocab", () => {
      mockTokenizerFile({
        model: { type: "WordPiece", unk_token: "[MISSING]", vocab: { hi: 1 } },
      });
      expect(() => loadTokenizer(MODEL)).toThrow(/no WordPiece vocab entry/);
    });

    it("throws on malformed JSON", () => {
      mockTokenizerFile("{ not json");
      expect(() => loadTokenizer(MODEL)).toThrow(TokenizerUnavailableError);
    });
  });
});
