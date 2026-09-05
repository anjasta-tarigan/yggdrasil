import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  matchCatalogModel,
  getModelsDevCatalog,
  ModelsDevCatalog,
} from "@/lib/ai/capability-detection/catalog";
import * as fs from "node:fs/promises";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    stat: vi.fn(actual.stat),
    readFile: vi.fn(actual.readFile),
    writeFile: vi.fn(actual.writeFile),
    mkdir: vi.fn(actual.mkdir),
  };
});

describe("matchCatalogModel", () => {
  const catalog: ModelsDevCatalog = {
    models: [
      { id: "gpt-4o", contextWindow: 128000 },
      { id: "claude-3-5-sonnet", contextWindow: 200000 },
      { id: "qwen-2.5-72b-instruct", contextWindow: 32768 },
    ],
  };

  it("exact match wins", () => {
    const res = matchCatalogModel("gpt-4o", catalog);
    expect(res).not.toBeNull();
    expect(res?.confidence).toBe("exact");
    expect(res?.matchedId).toBe("gpt-4o");
    expect(res?.entry.id).toBe("gpt-4o");
  });

  it("case-insensitive exact is second", () => {
    const res = matchCatalogModel("GPT-4O", catalog);
    expect(res).not.toBeNull();
    expect(res?.confidence).toBe("case-insensitive");
    expect(res?.matchedId).toBe("gpt-4o");
  });

  it("normalized prefix-strip matches single candidate with known provider prefix", () => {
    const res = matchCatalogModel("openai/gpt-4o", catalog);
    expect(res).not.toBeNull();
    expect(res?.confidence).toBe("normalized");
    expect(res?.matchedId).toBe("gpt-4o");
  });

  it("normalized prefix-strip matches with date suffix", () => {
    const res = matchCatalogModel("anthropic/claude-3-5-sonnet-20241022", {
      models: [{ id: "claude-3-5-sonnet", contextWindow: 200000 }],
    });
    expect(res).not.toBeNull();
    expect(res?.confidence).toBe("normalized");
    expect(res?.matchedId).toBe("claude-3-5-sonnet");
  });

  it("normalized prefix-strip matches with hyphenated date suffix", () => {
    const res = matchCatalogModel("claude-3-5-sonnet-2024-10-22", {
      models: [{ id: "claude-3-5-sonnet", contextWindow: 200000 }],
    });
    expect(res).not.toBeNull();
    expect(res?.confidence).toBe("normalized");
    expect(res?.matchedId).toBe("claude-3-5-sonnet");
  });

  it("returns null on ambiguous/no match — never fuzzy", () => {
    expect(matchCatalogModel("gpt-4", catalog)).toBeNull();
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
});

describe("getModelsDevCatalog", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("fetches from models.dev and writes to cache", async () => {
    const mockData: ModelsDevCatalog = {
      models: [{ id: "gpt-4o", contextWindow: 128000 }],
    };

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      json: async () => mockData,
    } as any);

    vi.mocked(fs.stat).mockRejectedValueOnce(new Error("ENOENT"));

    const catalog = await getModelsDevCatalog();
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://models.dev/api.json",
      expect.objectContaining({ signal: expect.any(Object) })
    );
    expect(catalog.models).toHaveLength(1);
    expect(catalog.models[0].id).toBe("gpt-4o");
  });

  it("returns stale cache if network fetch fails", async () => {
    vi.mocked(fs.stat).mockRejectedValueOnce(new Error("Cache expired / force fetch"));
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("Network error"));
    vi.mocked(fs.readFile).mockResolvedValueOnce(
      JSON.stringify({ models: [{ id: "cached-model" }] })
    );

    const catalog = await getModelsDevCatalog();
    expect(catalog.models).toHaveLength(1);
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
      JSON.stringify({ models: [{ id: "fresh-cached-model" }] })
    );

    const catalog = await getModelsDevCatalog();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(catalog.models[0].id).toBe("fresh-cached-model");
  });
});
