import fs from "node:fs";
import path from "node:path";

/**
 * Minimal HuggingFace `tokenizer.json` reader for local ONNX embedders.
 *
 * Why this exists: an ONNX graph takes integer token ids, so a local embedder
 * is only as correct as its tokenizer. Hashing words into arbitrary ids (a
 * tempting shortcut) yields vectors that are numerically valid but
 * semantically meaningless — they would silently poison every cosine/KNN
 * retrieval in the memory index. This module therefore reads the real
 * vocabulary and implements the two algorithms that cover the common
 * sentence-embedding checkpoints:
 *
 *   - WordPiece  — BERT family: all-MiniLM-L6-v2, bge-{small,base}-en-v1.5,
 *                  e5-{small,base}-v2, gte-small, nomic-bert.
 *   - BPE        — RoBERTa/GPT-2 family, incl. byte-level pre-tokenization.
 *   - Unigram    — SentencePiece / XLM-R family: bge-m3, granite-embedding,
 *                  multilingual-e5, jina-v3. Viterbi over the scored lattice.
 *
 * Anything else throws a named error rather than approximating — a wrong
 * tokenizer yields vectors that are numerically valid but semantically
 * meaningless, poisoning the memory index silently.
 *
 * Layout: `tokenizer.json` sits beside the `.onnx` file, as HuggingFace
 * exports it (e.g. data/models/embedding/tokenizer.json).
 */

/** Raw tokenizer.json shape (only the fields this reader consumes). */
type RawTokenizer = {
  model?: {
    type?: string;
    /** WordPiece/BPE: token → id. Unigram: `[piece, log-probability][]`. */
    vocab?: Record<string, number> | Array<[string, number]>;
    unk_token?: string;
    unk_id?: number;
    continuing_subword_prefix?: string;
    max_input_chars_per_word?: number;
    merges?: string[] | Array<[string, string]>;
  };
  added_tokens?: Array<{ id?: number; content?: string; special?: boolean }>;
  normalizer?: { type?: string; lowercase?: boolean } | null;
  pre_tokenizer?: unknown;
};

export type TokenizerKind = "wordpiece" | "bpe" | "unigram";

export interface Tokenizer {
  readonly kind: TokenizerKind;
  /** Encode to model input ids, truncated/padded to at most `maxLength`. */
  encode(
    text: string,
    maxLength: number
  ): { inputIds: number[]; attentionMask: number[] };
}

/** Tokenizer file that must accompany the model, by model file name. */
export function tokenizerPathFor(modelPath: string): string {
  return path.join(path.dirname(modelPath), "tokenizer.json");
}

/** Thrown when a model's tokenizer is missing or an unsupported type. */
export class TokenizerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenizerUnavailableError";
  }
}

// ── WordPiece (BERT family) ────────────────────────────────────────────────

/**
 * BERT's BasicTokenizer cleanup: lowercase (uncased models), strip accents,
 * and pad CJK characters with spaces so each becomes its own token.
 */
function basicClean(text: string, lowercase: boolean): string {
  let out = text.normalize("NFD").replace(/[̀-ͯ]/g, "");
  if (lowercase) out = out.toLowerCase();
  out = out.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
  // Whitespace and control chars become separators.
  out = out.replace(/\s+/g, " ").trim();
  // Pad CJK so the punctuation split below isolates each ideograph.
  out = out.replace(/([一-鿿])/g, " $1 ");
  return out;
}

/** Split on whitespace and punctuation (BERT BasicTokenizer). */
function splitOnPunctuation(text: string): string[] {
  const tokens: string[] = [];
  let current = "";
  for (const ch of text) {
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      if (current) tokens.push(current);
      current = "";
      continue;
    }
    // ASCII punctuation and common Unicode punctuation become their own tokens.
    if (/[!-/:-@[-`{-~]/.test(ch)) {
      if (current) tokens.push(current);
      tokens.push(ch);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);
  return tokens;
}

function createWordPieceTokenizer(
  vocab: Map<string, number>,
  unkToken: string,
  continuingPrefix: string,
  maxCharsPerWord: number
): Tokenizer {
  const resolvedUnk = vocab.get(unkToken);
  if (resolvedUnk === undefined) {
    throw new TokenizerUnavailableError(
      `tokenizer.json has no WordPiece vocab entry for ${unkToken}`
    );
  }
  const unkId: number = resolvedUnk;

  /** Greedy longest-match-first subword split for one word. */
  function encodeWord(word: string): number[] {
    if (word.length > maxCharsPerWord) return [unkId];
    const ids: number[] = [];
    let start = 0;
    while (start < word.length) {
      let end = word.length;
      let matched: number | undefined;
      while (start < end) {
        const piece =
          start === 0 ? word.slice(start, end) : continuingPrefix + word.slice(start, end);
        const id = vocab.get(piece);
        if (id !== undefined) {
          matched = id;
          break;
        }
        end -= 1;
      }
      if (matched === undefined) return [unkId];
      ids.push(matched);
      start = end;
    }
    return ids;
  }

  return {
    kind: "wordpiece",
    encode(text, maxLength) {
      // BERT uncased checkpoints lowercase; cased ones (bge-en) do not. The
      // vocab decides: a lowercase-only vocab never contains uppercase pieces.
      const lowercase = !vocab.has("A") && !vocab.has("The");
      const cleaned = basicClean(text, lowercase);
      const words = splitOnPunctuation(cleaned);
      const body: number[] = [];
      for (const word of words) body.push(...encodeWord(word));

      // [CLS] ... [SEP], truncated to leave room for both specials.
      const budget = Math.max(1, maxLength - 2);
      const cls = vocab.get("[CLS]") ?? unkId;
      const sep = vocab.get("[SEP]") ?? unkId;
      const truncated = body.slice(0, budget);
      const inputIds = [cls, ...truncated, sep];
      return {
        inputIds,
        attentionMask: inputIds.map(() => 1),
      };
    },
  };
}

// ── BPE (RoBERTa / GPT-2 family) ───────────────────────────────────────────

/** GPT-2 byte↔unicode table, so every byte survives as a printable char. */
function bytesToUnicode(): Map<number, string> {
  const bs: number[] = [];
  for (let i = 0x21; i <= 0x7e; i++) bs.push(i);
  for (let i = 0xa1; i <= 0xac; i++) bs.push(i);
  for (let i = 0xae; i <= 0xff; i++) bs.push(i);
  const cs = [...bs];
  let n = 0;
  for (let b = 0; b < 256; b++) {
    if (!bs.includes(b)) {
      bs.push(b);
      cs.push(256 + n);
      n += 1;
    }
  }
  const map = new Map<number, string>();
  for (let i = 0; i < bs.length; i++) {
    map.set(bs[i], String.fromCharCode(cs[i]));
  }
  return map;
}

const BYTE_ENCODER = bytesToUnicode();

/** GPT-2 pre-tokenization regex (contractions, words, numbers, punctuation). */
const BPE_SPLIT_RE =
  /'s|'t|'re|'ve|'m|'ll|'d| ?\p{L}+| ?\p{N}+| ?[^\s\p{L}\p{N}]+|\s+(?!\S)|\s+/gu;

function createBpeTokenizer(
  vocab: Map<string, number>,
  merges: string[] | Array<[string, string]>,
  unkToken: string
): Tokenizer {
  const resolvedUnk = vocab.get(unkToken);
  if (resolvedUnk === undefined) {
    throw new TokenizerUnavailableError(
      `tokenizer.json has no BPE vocab entry for ${unkToken}`
    );
  }
  const unkId: number = resolvedUnk;

  // Merge ranks: "a b" → rank. Lower rank merges first.
  const ranks = new Map<string, number>();
  merges.forEach((entry, index) => {
    const pair = Array.isArray(entry) ? entry.join(" ") : entry;
    ranks.set(pair, index);
  });

  /** Apply BPE merges to one pre-token's symbol list. */
  function mergeSymbols(symbols: string[]): string[] {
    if (symbols.length < 2) return symbols;
    let word = [...symbols];
    for (;;) {
      let bestRank = Infinity;
      let bestIndex = -1;
      for (let i = 0; i < word.length - 1; i++) {
        const rank = ranks.get(`${word[i]} ${word[i + 1]}`);
        if (rank !== undefined && rank < bestRank) {
          bestRank = rank;
          bestIndex = i;
        }
      }
      if (bestIndex === -1) break;
      word = [
        ...word.slice(0, bestIndex),
        word[bestIndex] + word[bestIndex + 1],
        ...word.slice(bestIndex + 2),
      ];
    }
    return word;
  }

  return {
    kind: "bpe",
    encode(text, maxLength) {
      const ids: number[] = [];
      for (const chunk of text.match(BPE_SPLIT_RE) ?? []) {
        // Byte-level encode, then split into single characters.
        let mapped = "";
        for (const byte of Buffer.from(chunk, "utf8")) {
          mapped += BYTE_ENCODER.get(byte) ?? "";
        }
        for (const symbol of mergeSymbols([...mapped])) {
          // A symbol absent from the vocab means the merges/vocab disagree;
          // fall back to <unk> rather than silently dropping the position
          // (dropping would shift every later token and skew the vector).
          ids.push(vocab.get(symbol) ?? unkId);
        }
      }

      // RoBERTa convention: <s> ... </s> when present, else bare ids.
      const bos = vocab.get("<s>");
      const eos = vocab.get("</s>");
      const budget = Math.max(
        1,
        maxLength - (bos !== undefined ? 1 : 0) - (eos !== undefined ? 1 : 0)
      );
      const truncated = ids.slice(0, budget);
      const inputIds = [
        ...(bos !== undefined ? [bos] : []),
        ...truncated,
        ...(eos !== undefined ? [eos] : []),
      ];
      return { inputIds, attentionMask: inputIds.map(() => 1) };
    },
  };
}

// ── Unigram (SentencePiece / XLM-R family) ─────────────────────────────────

/**
 * Unigram tokenization as SentencePiece implements it: replace spaces with the
 * metaspace marker, then find the maximum-likelihood segmentation of the
 * string over the scored piece vocabulary (Viterbi over a lattice).
 *
 * This is the algorithm behind XLM-R and every multilingual embedder built on
 * it — bge-m3, granite-embedding, multilingual-e5, jina-v3. Unlike WordPiece's
 * greedy longest-match, the best segmentation is a global optimization, so a
 * dynamic program is required: `best[i]` is the highest total score for the
 * prefix of length `i`.
 *
 * The SentencePiece normalizer (NFKC + a precompiled character map) is
 * approximated with NFKC, which matches it for the Latin/CJK text these
 * embedders see in practice.
 */
function createUnigramTokenizer(
  pieces: Array<[string, number]>,
  unkId: number,
  metaspace: string,
  addPrefixSpace: boolean,
  normalizer: RawTokenizer["normalizer"]
): Tokenizer {
  // Piece → index, because in a Unigram vocab the array INDEX is the id.
  const vocab = new Map<string, number>();
  const scores = new Float64Array(pieces.length);
  pieces.forEach(([piece, score], index) => {
    vocab.set(piece, index);
    scores[index] = typeof score === "number" ? score : 0;
  });

  // Longest piece in the vocab bounds the lattice's lookahead.
  let maxPieceLength = 1;
  for (const [piece] of pieces) {
    if (piece.length > maxPieceLength) maxPieceLength = piece.length;
  }

  const lowercase =
    typeof normalizer === "object" &&
    normalizer !== null &&
    (normalizer as { lowercase?: boolean }).lowercase === true;

  function normalize(text: string): string {
    let out = text.normalize("NFKC");
    if (lowercase) out = out.toLowerCase();
    // SentencePiece escapes whitespace as the metaspace marker so that word
    // boundaries survive as part of the token string.
    out = out.replace(/ /g, metaspace);
    if (addPrefixSpace && !out.startsWith(metaspace)) {
      out = metaspace + out;
    }
    return out;
  }

  /**
   * Viterbi over the lattice. `bestEnd[i]` = best score for the first i
   * characters; `bestStart[i]` = the split point that achieved it.
   */
  function segment(text: string): number[] {
    const n = text.length;
    const NEG = -1e30;
    const bestEnd = new Float64Array(n + 1).fill(NEG);
    const bestStart = new Int32Array(n + 1).fill(-1);
    const bestId = new Int32Array(n + 1).fill(-1);
    bestEnd[0] = 0;

    for (let start = 0; start < n; start++) {
      if (bestEnd[start] === NEG) continue;
      const limit = Math.min(n, start + maxPieceLength);
      // Longest-match preference is encoded in the scores; we still scan every
      // length so a lower-scoring long piece can win when it sums better.
      for (let end = start + 1; end <= limit; end++) {
        const piece = text.slice(start, end);
        const id = vocab.get(piece);
        if (id === undefined) continue;
        const candidate = bestEnd[start] + scores[id];
        if (candidate > bestEnd[end]) {
          bestEnd[end] = candidate;
          bestStart[end] = start;
          bestId[end] = id;
        }
      }
      // Unreachable positions still need a path: fall back to the unknown
      // token so no character is silently dropped.
      if (bestStart[start + 1] === -1 && start + 1 <= n) {
        const candidate = bestEnd[start] + scores[unkId];
        if (candidate > bestEnd[start + 1]) {
          bestEnd[start + 1] = candidate;
          bestStart[start + 1] = start;
          bestId[start + 1] = unkId;
        }
      }
    }

    // Backtrack; if the end is unreachable the whole string is unknown.
    const ids: number[] = [];
    let cursor = n;
    while (cursor > 0) {
      const start = bestStart[cursor];
      if (start === -1) return [unkId];
      ids.push(bestId[cursor]);
      cursor = start;
    }
    return ids.reverse();
  }

  return {
    kind: "unigram",
    encode(text, maxLength) {
      const ids = segment(normalize(text));

      // Template processing: <s> … </s> when the vocab has them.
      const bos = vocab.get("<s>");
      const eos = vocab.get("</s>");
      const budget = Math.max(
        1,
        maxLength - (bos !== undefined ? 1 : 0) - (eos !== undefined ? 1 : 0)
      );
      const truncated = ids.slice(0, budget);
      const inputIds = [
        ...(bos !== undefined ? [bos] : []),
        ...truncated,
        ...(eos !== undefined ? [eos] : []),
      ];
      return { inputIds, attentionMask: inputIds.map(() => 1) };
    },
  };
}

// ── Loader ─────────────────────────────────────────────────────────────────

/**
 * Read and compile the tokenizer beside `modelPath`.
 *
 * @throws {TokenizerUnavailableError} when tokenizer.json is missing, is not
 * valid JSON, or declares an algorithm this reader does not implement
 * (Unigram/SentencePiece). Callers must treat this as "cannot embed" — never
 * fall back to a synthetic tokenizer.
 */
export function loadTokenizer(modelPath: string): Tokenizer {
  const tokenizerPath = tokenizerPathFor(modelPath);
  let raw: RawTokenizer;
  try {
    raw = JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ tokenizerPath, "utf8")) as RawTokenizer;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new TokenizerUnavailableError(
        `No tokenizer.json beside ${path.basename(modelPath)}. Export it with the model ` +
          `(optimum-cli export onnx emits tokenizer.json) into ${path.dirname(modelPath)}.`
      );
    }
    throw new TokenizerUnavailableError(
      `Unreadable tokenizer.json at ${tokenizerPath}: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const model = raw.model;
  const vocabEntries = model?.vocab;
  if (!vocabEntries || typeof vocabEntries !== "object") {
    throw new TokenizerUnavailableError(
      `tokenizer.json at ${tokenizerPath} has no model.vocab`
    );
  }

  const type = model?.type ?? "";

  // Unigram stores vocab as `[piece, log-prob][]` where the array INDEX is the
  // token id (SentencePiece convention) — not a token → id map.
  if (type === "Unigram") {
    if (!Array.isArray(vocabEntries)) {
      throw new TokenizerUnavailableError(
        `Unigram tokenizer at ${tokenizerPath} must have a model.vocab array of [piece, score] pairs`
      );
    }
    const pieces = vocabEntries.filter(
      (e): e is [string, number] =>
        Array.isArray(e) && typeof e[0] === "string"
    );
    if (pieces.length === 0) {
      throw new TokenizerUnavailableError(
        `Unigram tokenizer at ${tokenizerPath} has an empty vocab`
      );
    }
    const unkId =
      typeof model?.unk_id === "number" ? model.unk_id : vocabIndex(pieces, "<unk>");
    if (unkId < 0) {
      throw new TokenizerUnavailableError(
        `Unigram tokenizer at ${tokenizerPath} has no unk_id and no <unk> piece`
      );
    }
    const pre = raw.pre_tokenizer as
      | { type?: string; replacement?: string; add_prefix_space?: boolean }
      | undefined;
    const metaspace = pre?.replacement ?? "▁";
    const addPrefixSpace = pre?.add_prefix_space ?? true;
    return createUnigramTokenizer(
      pieces,
      unkId,
      metaspace,
      addPrefixSpace,
      raw.normalizer
    );
  }

  // WordPiece / BPE: vocab is a plain token → id map.
  const vocab = new Map<string, number>();
  if (Array.isArray(vocabEntries)) {
    vocabEntries.forEach(([token, id], index) => {
      vocab.set(token, typeof id === "number" ? id : index);
    });
  } else {
    for (const [token, id] of Object.entries(vocabEntries)) {
      if (typeof id === "number") vocab.set(token, id);
    }
  }
  // added_tokens carry ids too (special tokens live here in many exports).
  for (const added of raw.added_tokens ?? []) {
    if (
      typeof added.content === "string" &&
      typeof added.id === "number" &&
      !vocab.has(added.content)
    ) {
      vocab.set(added.content, added.id);
    }
  }

  if (type === "WordPiece") {
    return createWordPieceTokenizer(
      vocab,
      model?.unk_token ?? "[UNK]",
      model?.continuing_subword_prefix ?? "##",
      model?.max_input_chars_per_word ?? 100
    );
  }
  if (type === "BPE") {
    return createBpeTokenizer(vocab, model?.merges ?? [], model?.unk_token ?? "<unk>");
  }

  throw new TokenizerUnavailableError(
    `Unsupported tokenizer type "${type || "unknown"}" in ${tokenizerPath}. ` +
      `Supported: WordPiece (BERT family), BPE (RoBERTa family), ` +
      `Unigram (SentencePiece / XLM-R family).`
  );
}

/** Index of a piece in a Unigram vocab array, or -1. */
function vocabIndex(pieces: Array<[string, number]>, token: string): number {
  return pieces.findIndex((e) => e[0] === token);
}
