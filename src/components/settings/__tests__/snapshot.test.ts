import { afterEach, describe, expect, it, vi } from "vitest";
import {
  emptyWebSearchForm,
  getMobileSettingsSnapshot,
  loadSettingsSnapshot,
  saveSettingsPatch,
  subscribeToMobileSettings,
  webSearchFormFromEntries,
} from "../snapshot";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("saveSettingsPatch", () => {
  it("PUTs the patch as JSON to /api/settings and reports success", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));

    const result = await saveSettingsPatch({ embedding: { model: "nomic" } });

    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/settings");
    expect(init.method).toBe("PUT");
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.parse(String(init.body))).toEqual({ embedding: { model: "nomic" } });
  });

  it("surfaces the server's error message on a non-2xx response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "Unknown embedding provider" }), {
        status: 400,
      }),
    );

    await expect(saveSettingsPatch({})).resolves.toEqual({
      ok: false,
      error: "Unknown embedding provider",
    });
  });

  it("falls back to the HTTP status when the error body is not JSON", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("nope", { status: 502 }),
    );

    await expect(saveSettingsPatch({})).resolves.toEqual({
      ok: false,
      error: "HTTP 502",
    });
  });
});

describe("loadSettingsSnapshot", () => {
  it("returns the parsed snapshot", async () => {
    const snapshot = { about: { name: "Yggdrasil", version: "0.0.0", stack: "next" } };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(snapshot), { status: 200 }),
    );

    await expect(loadSettingsSnapshot()).resolves.toEqual(snapshot);
  });

  it("throws with the status code on a non-2xx response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("", { status: 503 }),
    );

    await expect(loadSettingsSnapshot()).rejects.toThrow("503");
  });
});

describe("web search form helpers", () => {
  it("starts every provider disabled with no keys", () => {
    const form = emptyWebSearchForm();

    expect(Object.keys(form).sort()).toEqual(["exa", "firecrawl", "searxng"]);
    for (const entry of Object.values(form)) {
      expect(entry).toEqual({
        enabled: false,
        apiKey: "",
        apiKeys: [],
        removeApiKeyIds: [],
        baseUrl: "",
      });
    }
  });

  it("maps stored entries onto the form, expressing a legacy key as an id", () => {
    const form = webSearchFormFromEntries([
      { kind: "exa", enabled: true, apiKeys: [{ id: "k1", configured: true }] },
      { kind: "firecrawl", enabled: false, apiKeyConfigured: true },
      { kind: "searxng", enabled: true, baseUrl: "https://searx.example" },
    ]);

    expect(form.exa).toEqual({
      enabled: true,
      apiKey: "",
      apiKeys: [{ id: "k1", configured: true }],
      removeApiKeyIds: [],
      baseUrl: "",
    });
    expect(form.firecrawl.apiKeys).toEqual([{ id: "legacy", configured: true }]);
    expect(form.searxng).toEqual({
      enabled: true,
      apiKey: "",
      apiKeys: [],
      removeApiKeyIds: [],
      baseUrl: "https://searx.example",
    });
  });

  it("returns an empty form when the server sends no entries", () => {
    expect(webSearchFormFromEntries([])).toEqual(emptyWebSearchForm());
  });
});

describe("mobile settings media query", () => {
  it("subscribes to the 767px breakpoint and unsubscribes on cleanup", () => {
    const addEventListener = vi.fn();
    const removeEventListener = vi.fn();
    vi.stubGlobal("matchMedia", () => ({
      matches: true,
      addEventListener,
      removeEventListener,
    }));

    const unsubscribe = subscribeToMobileSettings(() => {});
    const listener = addEventListener.mock.calls[0][1] as () => void;
    unsubscribe();

    expect(addEventListener).toHaveBeenCalledWith("change", listener);
    expect(removeEventListener).toHaveBeenCalledWith("change", listener);
    expect(getMobileSettingsSnapshot()).toBe(true);
  });
});
