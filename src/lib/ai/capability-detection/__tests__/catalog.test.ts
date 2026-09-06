import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  matchCatalogModel,
  getModelsDevCatalog,
  normalizeCatalog,
  inferKnownModelCapabilities,
  ModelsDevCatalog,
} from "@/lib/ai/capability-detection/catalog";
import * as fs from "node:fs/promises";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    stat: vi.fn(actual.stat),
    readFile: vi.fn(actual.readFile),
    writeFile: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined),
  };
});

/**
 * Real models.dev /api.json payload fragment: the document is a map of
 * PROVIDER objects, each keyed by provider id, whose `models` map holds
 * entries with `limit.{context,output}`, `modalities.{input,output}`,
 * `tool_call`, `reasoning` and `attachment` — NOT a flat array of
 * `{id, contextWindow}` objects. Verified against the live payload.
 */
const realApiPayload = {
  openai: {
    id: "openai",
    name: "OpenAI",
    models: {
      "gpt-4o": {
        id: "gpt-4o",
        modalities: { input: ["text", "image", "pdf"], output: ["text"] },
        tool_call: true,
        reasoning: false,
        limit: { context: 128000, output: 16384 },
      },
      "gpt-4o-2024-05-13": {
        id: "gpt-4o-2024-05-13",
        modalities: { input: ["text", "image"], output: ["text"] },
        tool_call: true,
        reasoning: false,
        limit: { context: 128000, output: 16384 },
      },
    },
  },
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    models: {
      "claude-3-5-sonnet": {
        id: "claude-3-5-sonnet",
        modalities: { input: ["text", "image", "pdf"], output: ["text"] },
        tool_call: true,
        reasoning: true,
        limit: { context: 200000, output: 128000 },
      },
    },
  },
};

const realCatalog = normalizeCatalog(realApiPayload);

describe("normalizeCatalog (real models.dev payload)", () => {
  it("flattens the provider-keyed models map into a models array", () => {
    expect(realCatalog.models.map((m) => m.id)).toEqual([
      "gpt-4o",
      "gpt-4o-2024-05-13",
      "claude-3-5-sonnet",
    ]);
  });

  it("maps limit.context/limit.output onto contextWindow/maxOutputTokens", () => {
    const gpt = realCatalog.models.find((m) => m.id === "gpt-4o")!;
    expect(gpt.contextWindow).toBe(128000);
    expect(gpt.maxOutputTokens).toBe(16384);
  });

  it("maps modalities.input/output and tool_call/reasoning", () => {
    const gpt = realCatalog.models.find((m) => m.id === "gpt-4o")!;
    expect(gpt.inputModalities).toEqual(["text", "image", "pdf"]);
    expect(gpt.outputModalities).toEqual(["text"]);
    expect(gpt.supportsToolCalls).toBe(true);
    expect(gpt.supportsReasoning).toBe(false);
  });

  it("still accepts the legacy {models: []} cache shape written by older builds", () => {
    const legacy = normalizeCatalog({ models: [{ id: "cached-model" }] });
    expect(legacy.models[0].id).toBe("cached-model");
  });

  it("degrades unknown shapes to an empty catalog", () => {
    expect(normalizeCatalog({}).models).toEqual([]);
    expect(normalizeCatalog("nope" as unknown as object).models).toEqual([]);
  });
});

describe("matchCatalogModel", () => {
  it("exact match wins", () => {
    const res = matchCatalogModel("gpt-4o", realCatalog);
    expect(res?.confidence).toBe("exact");
    expect(res?.matchedId).toBe("gpt-4o");
  });

  it("case-insensitive exact is second", () => {
    const res = matchCatalogModel("GPT-4O", realCatalog);
    expect(res?.confidence).toBe("case-insensitive");
    expect(res?.matchedId).toBe("gpt-4o");
  });

  it("matches a date-suffixed id against the bare catalog id", () => {
    const res = matchCatalogModel("gpt-4o-2024-05-13", realCatalog);
    expect(res?.confidence).toBe("exact");
  });

  it("normalized prefix-strip matches single candidate with known provider prefix", () => {
    const res = matchCatalogModel("openai/gpt-4o", realCatalog);
    expect(res?.confidence).toBe("normalized");
    expect(res?.matchedId).toBe("gpt-4o");
  });

  it("normalized prefix-strip matches with date suffix", () => {
    const res = matchCatalogModel(
      "anthropic/claude-3-5-sonnet-20241022",
      realCatalog,
    );
    expect(res?.confidence).toBe("normalized");
    expect(res?.matchedId).toBe("claude-3-5-sonnet");
  });

  it("normalized prefix-strip matches with hyphenated date suffix", () => {
    const res = matchCatalogModel("claude-3-5-sonnet-2024-10-22", realCatalog);
    expect(res?.confidence).toBe("normalized");
    expect(res?.matchedId).toBe("claude-3-5-sonnet");
  });

  it("returns null on ambiguous/no match — never fuzzy", () => {
    expect(matchCatalogModel("gpt-4", realCatalog)).toBeNull();
    expect(matchCatalogModel("totally-unknown-model", realCatalog)).toBeNull();
  });

  it("returns null when normalized match has >1 candidate", () => {
    const ambiguousCatalog: ModelsDevCatalog = {
      models: [
        { id: "gpt-4o", contextWindow: 128000 },
        { id: "GPT-4O", contextWindow: 128000 },
      ],
    };
    expect(matchCatalogModel("openai/gpt-4o", ambiguousCatalog)).toBeNull();
  });

  it("strips gateway prefixes and matches nested vendor models", () => {
    const customCatalog: ModelsDevCatalog = {
      models: [
        { id: "deepseek/deepseek-v4-pro", contextWindow: 1000000, maxOutputTokens: 384000 },
        { id: "minimax/minimax-m3", contextWindow: 512000, maxOutputTokens: 80000 },
        { id: "poolside/laguna-s-2.1", contextWindow: 1048576, maxOutputTokens: 131072 },
      ],
    };

    // Multi-segment gateway prefixes: "xk/deepseek/deepseek-v4-pro" -> "deepseek/deepseek-v4-pro"
    const deepseekRes = matchCatalogModel("xk/deepseek/deepseek-v4-pro", customCatalog);
    expect(deepseekRes?.confidence).toBe("normalized");
    expect(deepseekRes?.matchedId).toBe("deepseek/deepseek-v4-pro");
    expect(deepseekRes?.entry.contextWindow).toBe(1000000);

    // Gateway prefix with variant tag: "openrouter/minimax/minimax-m3:free" -> "minimax/minimax-m3"
    const minimaxRes = matchCatalogModel("openrouter/minimax/minimax-m3:free", customCatalog);
    expect(minimaxRes?.confidence).toBe("normalized");
    expect(minimaxRes?.matchedId).toBe("minimax/minimax-m3");
    expect(minimaxRes?.entry.contextWindow).toBe(512000);

    // Simple gateway prefix: "ps/poolside/laguna-s-2.1" -> "poolside/laguna-s-2.1"
    const lagunaRes = matchCatalogModel("ps/poolside/laguna-s-2.1", customCatalog);
    expect(lagunaRes?.confidence).toBe("normalized");
    expect(lagunaRes?.matchedId).toBe("poolside/laguna-s-2.1");
  });
});

describe("inferKnownModelCapabilities", () => {
  it("infers DeepSeek V4 1M context and reasoning capabilities", () => {
    const caps = inferKnownModelCapabilities("xk/deepseek/deepseek-v4-pro");
    expect(caps).not.toBeNull();
    expect(caps?.contextWindow).toBe(1_000_000);
    expect(caps?.maxOutputTokens).toBe(384_000);
    expect(caps?.supportsReasoning).toBe(true);
    expect(caps?.supportsToolCalls).toBe(true);
  });

  it("infers DeepSeek R1 reasoning and 128k context", () => {
    const caps = inferKnownModelCapabilities("deepseek-r1");
    expect(caps?.contextWindow).toBe(128_000);
    expect(caps?.supportsReasoning).toBe(true);
  });

  it("infers Poolside / Laguna 1M context", () => {
    const caps = inferKnownModelCapabilities("ps/poolside/laguna-s-2.1");
    expect(caps?.contextWindow).toBe(1_048_576);
  });

  it("infers Minimax M3 512k context", () => {
    const caps = inferKnownModelCapabilities("openrouter/minimax/minimax-m3:free");
    expect(caps?.contextWindow).toBe(512_000);
  });

  it("returns null for completely unrecognized custom model id", () => {
    expect(inferKnownModelCapabilities("custom-internal-model-1")).toBeNull();
  });
});

describe("getModelsDevCatalog", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("fetches the real payload shape and writes the normalized cache", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({ ok: true, json: async () => realApiPayload } as any);

    vi.mocked(fs.stat).mockRejectedValueOnce(new Error("ENOENT"));

    const catalog = await getModelsDevCatalog();
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://models.dev/api.json",
      expect.objectContaining({ signal: expect.any(Object) }),
    );
    expect(catalog.models.map((m) => m.id)).toContain("gpt-4o");
    // The write call must receive the NORMALIZED catalog, not the raw payload.
    const written = vi.mocked(fs.writeFile).mock.calls[0]?.[1] as string;
    expect(() => JSON.parse(written)).not.toThrow();
    expect(JSON.parse(written).models[0].id).toBe("gpt-4o");
  });

  it("returns stale cache if network fetch fails", async () => {
    vi.mocked(fs.stat).mockRejectedValueOnce(new Error("expired"));
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("Network error"));
    vi.mocked(fs.readFile).mockResolvedValueOnce(
      JSON.stringify({ models: [{ id: "cached-model" }] }),
    );

    const catalog = await getModelsDevCatalog();
    expect(catalog.models[0].id).toBe("cached-model");
  });

  it("returns empty catalog if network fails and no cache exists", async () => {
    vi.mocked(fs.stat).mockRejectedValueOnce(new Error("ENOENT"));
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("Network error"));
    vi.mocked(fs.readFile).mockRejectedValueOnce(new Error("ENOENT"));

    const catalog = await getModelsDevCatalog();
    expect(catalog).toEqual({ models: [] });
  });

  it("uses valid cache within 24h without network fetch", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    vi.mocked(fs.stat).mockResolvedValueOnce({
      mtime: new Date(Date.now() - 1000 * 60 * 60), // 1 hour ago
    } as any);
    vi.mocked(fs.readFile).mockResolvedValueOnce(
      JSON.stringify({ models: [{ id: "fresh-cached-model" }] }),
    );

    const catalog = await getModelsDevCatalog();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(catalog.models[0].id).toBe("fresh-cached-model");
  });

  it("does not trust an EMPTY cached catalog — it refetches (poisoned-cache guard)", async () => {
    // A cache written by the pre-fix parser holds {models: []} with a
    // fresh mtime; trusting it would pin an empty Layer 1 for 24h.
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({ ok: true, json: async () => realApiPayload } as any);
    vi.mocked(fs.stat).mockResolvedValueOnce({
      mtime: new Date(Date.now() - 1000 * 60 * 60),
    } as any);
    vi.mocked(fs.readFile).mockResolvedValueOnce(
      JSON.stringify({ models: [] }),
    );

    const catalog = await getModelsDevCatalog();
    expect(fetchSpy).toHaveBeenCalled();
    expect(catalog.models.map((m) => m.id)).toContain("gpt-4o");
  });
});
