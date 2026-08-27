import {
  afterAll,
  beforeAll,
  beforeEach,
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const getSettingDbMock = vi.fn();

vi.mock("@/lib/settings-service", () => ({
  getSettingDb: (...args: unknown[]) => getSettingDbMock(...args),
}));

import {
  getWebSearchChain,
  isProviderCoolingDown,
  isProviderReady,
  resetSearchCooldowns,
  runWebSearch,
  QUOTA_COOLDOWN_MS,
} from "../web-search";

// ---- Test fixtures ----

const ENV_KEYS = ["EXA_API_KEY", "FIRECRAWL_API_KEY", "SEARXNG_BASE_URL"];
const originalEnv: Record<string, string | undefined> = {};

function setEnv(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const EXA_RESULTS = {
  results: [
    { title: "Exa result", url: "https://exa.example/a", text: "exa snippet" },
  ],
};
const FIRECRAWL_RESULTS = {
  data: [
    {
      title: "Firecrawl result",
      url: "https://firecrawl.example/b",
      description: "firecrawl snippet",
    },
  ],
};
const SEARXNG_RESULTS = {
  results: [
    {
      title: "SearXNG result",
      url: "https://searxng.example/c",
      content: "searxng snippet",
    },
  ],
};

const fetchMock = vi.fn();

beforeAll(() => {
  for (const key of ENV_KEYS) originalEnv[key] = process.env[key];
  vi.stubGlobal("fetch", fetchMock);
});

afterAll(() => {
  for (const [key, value] of Object.entries(originalEnv)) setEnv(key, value);
  vi.unstubAllGlobals();
});

beforeEach(() => {
  getSettingDbMock.mockReset();
  getSettingDbMock.mockReturnValue(undefined);
  fetchMock.mockReset();
  resetSearchCooldowns();
  setEnv("EXA_API_KEY", "exa-key");
  setEnv("FIRECRAWL_API_KEY", "firecrawl-key");
  setEnv("SEARXNG_BASE_URL", undefined);
});

afterEach(() => {
  resetSearchCooldowns();
});

// ---- Chain resolution ----

describe("getWebSearchChain", () => {
  it("builds the default chain from env keys in priority order", () => {
    expect(getWebSearchChain()).toEqual([
      { kind: "exa", enabled: true },
      { kind: "firecrawl", enabled: true },
    ]);
  });

  it("includes SearXNG in the default chain when SEARXNG_BASE_URL is set", () => {
    setEnv("SEARXNG_BASE_URL", "http://localhost:8080");
    expect(getWebSearchChain()).toEqual([
      { kind: "exa", enabled: true },
      { kind: "firecrawl", enabled: true },
      { kind: "searxng", enabled: true, baseUrl: "http://localhost:8080" },
    ]);
  });

  it("returns an empty chain when nothing is configured", () => {
    setEnv("EXA_API_KEY", undefined);
    setEnv("FIRECRAWL_API_KEY", undefined);
    expect(getWebSearchChain()).toEqual([]);
  });

  it("prefers the stored configuration over env defaults", () => {
    getSettingDbMock.mockReturnValue({
      providers: [
        { kind: "searxng", enabled: true, baseUrl: "http://sx:8080" },
        { kind: "exa", enabled: false },
      ],
    });
    expect(getWebSearchChain()).toEqual([
      { kind: "searxng", enabled: true, baseUrl: "http://sx:8080" },
      { kind: "exa", enabled: false },
    ]);
  });

  it("filters invalid stored entries and keeps valid ones", () => {
    getSettingDbMock.mockReturnValue({
      providers: [
        { kind: "bogus", enabled: true },
        "junk",
        { kind: "firecrawl", enabled: true, apiKey: "" },
      ],
    });
    expect(getWebSearchChain()).toEqual([
      { kind: "firecrawl", enabled: true },
    ]);
  });

  it("falls back to env defaults when every stored entry is invalid", () => {
    getSettingDbMock.mockReturnValue({ providers: [{ kind: "nope" }] });
    expect(getWebSearchChain()).toEqual([
      { kind: "exa", enabled: true },
      { kind: "firecrawl", enabled: true },
    ]);
  });

  it("survives a failing settings store", () => {
    getSettingDbMock.mockImplementation(() => {
      throw new Error("db offline");
    });
    expect(getWebSearchChain()).toEqual([
      { kind: "exa", enabled: true },
      { kind: "firecrawl", enabled: true },
    ]);
  });
});

describe("isProviderReady", () => {
  it("resolves credentials from the entry or the environment", () => {
    expect(isProviderReady({ kind: "exa", enabled: true })).toBe(true);
    expect(
      isProviderReady({ kind: "exa", enabled: true, apiKey: "override" })
    ).toBe(true);

    setEnv("EXA_API_KEY", undefined);
    expect(isProviderReady({ kind: "exa", enabled: true })).toBe(false);
    expect(
      isProviderReady({ kind: "exa", enabled: true, apiKey: "override" })
    ).toBe(true);

    expect(isProviderReady({ kind: "searxng", enabled: true })).toBe(false);
    expect(
      isProviderReady({
        kind: "searxng",
        enabled: true,
        baseUrl: "http://sx:8080",
      })
    ).toBe(true);
  });
});

// ---- Fallback chain behaviour ----

describe("runWebSearch fallback chain", () => {
  it("returns results from the first healthy provider", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(EXA_RESULTS));

    const outcome = await runWebSearch("test query");

    expect(outcome.provider).toBe("exa");
    expect(outcome.query).toBe("test query");
    expect(outcome.results).toEqual([
      { title: "Exa result", url: "https://exa.example/a", snippet: "exa snippet" },
    ]);
    expect(outcome.attempts).toEqual([{ provider: "exa", ok: true }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to the next provider when the first fails", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: "quota" }, 429))
      .mockResolvedValueOnce(jsonResponse(FIRECRAWL_RESULTS));

    const outcome = await runWebSearch("test query");

    expect(outcome.provider).toBe("firecrawl");
    expect(outcome.attempts).toHaveLength(2);
    expect(outcome.attempts[0].ok).toBe(false);
    expect(outcome.attempts[0].error).toContain("429");
    expect(outcome.attempts[1]).toEqual({ provider: "firecrawl", ok: true });
  });

  it("puts a provider on cooldown after a quota failure", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: "quota" }, 429))
      .mockResolvedValueOnce(jsonResponse(FIRECRAWL_RESULTS));
    await runWebSearch("test query");

    expect(isProviderCoolingDown("exa")).toBe(true);
    expect(isProviderCoolingDown("firecrawl")).toBe(false);

    // Next search skips the exhausted provider entirely.
    fetchMock.mockClear();
    fetchMock.mockResolvedValueOnce(jsonResponse(FIRECRAWL_RESULTS));
    const outcome = await runWebSearch("test query 2");
    expect(outcome.provider).toBe("firecrawl");
    expect(outcome.attempts[0]).toEqual({
      provider: "exa",
      ok: false,
      error: "skipped (quota cooldown)",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("cools down for QUOTA_COOLDOWN_MS then retries the provider", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      fetchMock
        .mockResolvedValueOnce(jsonResponse({}, 402))
        .mockResolvedValueOnce(jsonResponse({ results: [] }));
      await expect(runWebSearch("q")).rejects.toThrow(
        /All web search providers failed/
      );
      expect(isProviderCoolingDown("exa")).toBe(true);

      // Just before the cooldown window closes it is still skipped…
      vi.setSystemTime(new Date("2026-01-01T00:14:59Z"));
      expect(isProviderCoolingDown("exa")).toBe(true);

      // …and right after, the provider is in play again.
      vi.setSystemTime(
        new Date("2026-01-01T00:00:00Z").getTime() + QUOTA_COOLDOWN_MS + 1000
      );
      expect(isProviderCoolingDown("exa")).toBe(false);

      fetchMock.mockResolvedValueOnce(jsonResponse(EXA_RESULTS));
      const outcome = await runWebSearch("q");
      expect(outcome.provider).toBe("exa");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not cool a provider down for ordinary failures", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: "boom" }, 500))
      .mockResolvedValueOnce(jsonResponse(FIRECRAWL_RESULTS));

    await runWebSearch("test query");
    expect(isProviderCoolingDown("exa")).toBe(false);
  });

  it("resetSearchCooldowns clears active cooldowns", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({}, 429))
      .mockResolvedValueOnce(jsonResponse(FIRECRAWL_RESULTS));
    await runWebSearch("q");
    expect(isProviderCoolingDown("exa")).toBe(true);

    resetSearchCooldowns();
    expect(isProviderCoolingDown("exa")).toBe(false);
  });

  it("falls through when a provider returns no results", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ results: [] }))
      .mockResolvedValueOnce(jsonResponse(FIRECRAWL_RESULTS));

    const outcome = await runWebSearch("test query");
    expect(outcome.provider).toBe("firecrawl");
    expect(outcome.attempts[0]).toEqual({
      provider: "exa",
      ok: false,
      error: "no results",
    });
  });

  it("skips disabled providers in a stored chain", async () => {
    getSettingDbMock.mockReturnValue({
      providers: [
        { kind: "exa", enabled: false },
        { kind: "firecrawl", enabled: true },
      ],
    });
    fetchMock.mockResolvedValueOnce(jsonResponse(FIRECRAWL_RESULTS));

    const outcome = await runWebSearch("test query");
    expect(outcome.provider).toBe("firecrawl");
    expect(outcome.attempts).toEqual([{ provider: "firecrawl", ok: true }]);
  });

  it("throws a summarized error when every provider fails", async () => {
    setEnv("SEARXNG_BASE_URL", "http://localhost:8080");
    fetchMock
      .mockResolvedValueOnce(jsonResponse({}, 500))
      .mockResolvedValueOnce(jsonResponse({}, 503))
      .mockResolvedValueOnce(jsonResponse({}, 502));

    await expect(runWebSearch("test query")).rejects.toThrow(
      /All web search providers failed — exa: .*500.*; firecrawl: .*503.*; searxng: .*502/
    );
  });

  it("throws a helpful error when nothing is configured", async () => {
    setEnv("EXA_API_KEY", undefined);
    setEnv("FIRECRAWL_API_KEY", undefined);
    await expect(runWebSearch("test query")).rejects.toThrow(
      /No web search providers configured/
    );
  });

  it("throws when every stored provider is disabled", async () => {
    getSettingDbMock.mockReturnValue({
      providers: [
        { kind: "exa", enabled: false },
        { kind: "firecrawl", enabled: false },
      ],
    });
    await expect(runWebSearch("test query")).rejects.toThrow(
      /No enabled web search providers/
    );
  });
});

// ---- Provider request/response contracts ----

describe("provider contracts", () => {
  it("sends the Exa request shape and maps results", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(EXA_RESULTS));

    await runWebSearch("quantum computing", {
      numResults: 3,
      includeText: true,
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.exa.ai/search");
    expect(init.method).toBe("POST");
    expect(init.headers["x-api-key"]).toBe("exa-key");
    expect(JSON.parse(init.body)).toEqual({
      query: "quantum computing",
      numResults: 3,
      contents: { text: { maxCharacters: 1000 } },
    });
  });

  it("uses a stored API key override instead of the env var", async () => {
    getSettingDbMock.mockReturnValue({
      providers: [{ kind: "exa", enabled: true, apiKey: "override-key" }],
    });
    fetchMock.mockResolvedValueOnce(jsonResponse(EXA_RESULTS));

    await runWebSearch("q");
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers["x-api-key"]).toBe("override-key");
  });

  it("sends the Firecrawl v2 search request shape and maps results", async () => {
    getSettingDbMock.mockReturnValue({
      providers: [{ kind: "firecrawl", enabled: true }],
    });
    fetchMock.mockResolvedValueOnce(jsonResponse(FIRECRAWL_RESULTS));

    const outcome = await runWebSearch("ai agents", {
      numResults: 7,
      includeText: true,
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.firecrawl.dev/v2/search");
    expect(init.headers.Authorization).toBe("Bearer firecrawl-key");
    expect(JSON.parse(init.body)).toMatchObject({
      query: "ai agents",
      limit: 7,
      sources: ["web"],
    });
    expect(outcome.results).toEqual([
      {
        title: "Firecrawl result",
        url: "https://firecrawl.example/b",
        snippet: "firecrawl snippet",
      },
    ]);
  });

  it("maps the Firecrawl grouped-by-source response shape", async () => {
    getSettingDbMock.mockReturnValue({
      providers: [{ kind: "firecrawl", enabled: true }],
    });
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        data: {
          web: [{ title: "Grouped", url: "https://g.example", description: "d" }],
        },
      })
    );

    const outcome = await runWebSearch("q", { includeText: true });
    expect(outcome.results).toEqual([
      { title: "Grouped", url: "https://g.example", snippet: "d" },
    ]);
  });

  it("queries SearXNG with the JSON format and maps results", async () => {
    getSettingDbMock.mockReturnValue({
      providers: [
        { kind: "searxng", enabled: true, baseUrl: "http://sx:8080/" },
      ],
    });
    fetchMock.mockResolvedValueOnce(jsonResponse(SEARXNG_RESULTS));

    const outcome = await runWebSearch("self hosting", {
      numResults: 4,
      includeText: true,
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("http://sx:8080/search?");
    expect(url).toContain("format=json");
    expect(url).toContain("q=self+hosting");
    expect(init.headers["User-Agent"]).toBeTruthy();
    expect(outcome.results).toEqual([
      {
        title: "SearXNG result",
        url: "https://searxng.example/c",
        snippet: "searxng snippet",
      },
    ]);
  });

  it("omits SearXNG snippets unless includeText is set", async () => {
    getSettingDbMock.mockReturnValue({
      providers: [{ kind: "searxng", enabled: true, baseUrl: "http://sx:8080" }],
    });
    fetchMock.mockResolvedValueOnce(jsonResponse(SEARXNG_RESULTS));

    const outcome = await runWebSearch("q");
    expect(outcome.results[0].snippet).toBeUndefined();
  });

  it("falls back to the SEARXNG_BASE_URL env var", async () => {
    setEnv("SEARXNG_BASE_URL", "http://env-sx:9090");
    getSettingDbMock.mockReturnValue({
      providers: [{ kind: "searxng", enabled: true }],
    });
    fetchMock.mockResolvedValueOnce(jsonResponse(SEARXNG_RESULTS));

    await runWebSearch("q");
    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain("http://env-sx:9090/search?");
  });

  it("reports a clear error when SearXNG answers with HTML", async () => {
    getSettingDbMock.mockReturnValue({
      providers: [{ kind: "searxng", enabled: true, baseUrl: "http://sx:8080" }],
    });
    fetchMock.mockResolvedValueOnce(
      new Response("<html>search page</html>", { status: 200 })
    );

    await expect(runWebSearch("q")).rejects.toThrow(
      /SearXNG returned a non-JSON response/
    );
  });

  it("clamps numResults into the 1-10 range", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(EXA_RESULTS));

    await runWebSearch("q", { numResults: 99 });
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body).numResults).toBe(10);
  });
});
