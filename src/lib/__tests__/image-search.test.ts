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
  isImageProviderCoolingDown,
  resetImageSearchCooldowns,
  runImageSearch,
  sanitizeText,
  cleanImageUrl,
  isSafeImageUrl,
  matchesAspectRatio,
  matchesDimensions,
  deduplicateAndRankResults,
  classifySourceTier,
  scoreImageCandidate,
  isNearDuplicate,
  type ImageSearchResult,
} from "../image-search";

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
  resetImageSearchCooldowns();
  setEnv("EXA_API_KEY", "exa-key");
  setEnv("FIRECRAWL_API_KEY", "firecrawl-key");
  setEnv("SEARXNG_BASE_URL", undefined);
});

afterEach(() => {
  resetImageSearchCooldowns();
});

describe("Image Search Sanitization & Security", () => {
  it("sanitizes text by stripping HTML tags and trimming whitespace", () => {
    expect(sanitizeText("<script>alert('xss')</script>Hello <b>World</b>")).toBe(
      "Hello World"
    );
    expect(sanitizeText("   Clean Title   ")).toBe("Clean Title");
  });

  it("truncates excessively long text to prevent prompt injection payload bloating", () => {
    const huge = "a".repeat(1000);
    expect(sanitizeText(huge, 200).length).toBe(200);
  });

  it("cleans and normalizes image URLs by stripping tracking parameters", () => {
    const dirty =
      "https://images.example.com/photo.jpg?utm_source=twitter&utm_medium=cpc&id=123";
    const cleaned = cleanImageUrl(dirty);
    expect(cleaned).toBe("https://images.example.com/photo.jpg?id=123");
  });

  it("validates safe image URLs and rejects unsafe protocols / SSRF attempts", () => {
    expect(isSafeImageUrl("https://images.example.com/photo.jpg")).toBe(true);
    expect(isSafeImageUrl("http://images.example.com/photo.jpg")).toBe(true);
    expect(isSafeImageUrl("ftp://images.example.com/photo.jpg")).toBe(false);
    expect(isSafeImageUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeImageUrl("file:///etc/passwd")).toBe(false);
    expect(isSafeImageUrl("data:image/png;base64,abc")).toBe(false);
    expect(isSafeImageUrl("http://localhost:3000/photo.jpg")).toBe(false);
    expect(isSafeImageUrl("http://127.0.0.1/photo.jpg")).toBe(false);
    expect(isSafeImageUrl("http://169.254.169.254/latest/meta-data/")).toBe(
      false
    );
    expect(isSafeImageUrl("http://192.168.1.1/secret.jpg")).toBe(false);
    expect(isSafeImageUrl("http://10.0.0.5/test.png")).toBe(false);
    expect(isSafeImageUrl("http://internal.service.local/image.png")).toBe(
      false
    );
  });
});

describe("Image Filtering & Deduplication", () => {
  const sampleResults: ImageSearchResult[] = [
    {
      title: "Landscape Photo",
      image_url: "https://example.com/land.jpg",
      source_url: "https://example.com/article",
      source_name: "example.com",
      width: 1920,
      height: 1080,
      rank: 1,
    },
    {
      title: "Portrait Photo",
      image_url: "https://example.com/port.jpg",
      source_url: "https://example.com/portrait",
      source_name: "example.com",
      width: 1080,
      height: 1920,
      rank: 2,
    },
    {
      title: "Square Photo",
      image_url: "https://example.com/square.jpg",
      source_url: "https://example.com/sq",
      source_name: "example.com",
      width: 800,
      height: 800,
      rank: 3,
    },
  ];

  it("filters by aspect ratio when dimensions are known", () => {
    expect(matchesAspectRatio(sampleResults[0], "landscape")).toBe(true);
    expect(matchesAspectRatio(sampleResults[0], "portrait")).toBe(false);

    expect(matchesAspectRatio(sampleResults[1], "portrait")).toBe(true);
    expect(matchesAspectRatio(sampleResults[1], "landscape")).toBe(false);

    expect(matchesAspectRatio(sampleResults[2], "square")).toBe(true);
    expect(matchesAspectRatio(sampleResults[0], "any")).toBe(true);
  });

  it("filters by minimum width and height when dimensions are known", () => {
    expect(matchesDimensions(sampleResults[0], 1200, 800)).toBe(true);
    expect(matchesDimensions(sampleResults[0], 2000, 800)).toBe(false);
    expect(matchesDimensions(sampleResults[0], 1200, 1200)).toBe(false);
  });

  it("deduplicates identical image URLs and prioritizes preferred domains", () => {
    const raw: ImageSearchResult[] = [
      {
        title: "Random Aggregator View",
        image_url: "https://cdn.example.com/rtx5090.jpg?utm_source=feed",
        source_url: "https://random-aggregator.com/post",
        source_name: "random-aggregator.com",
        rank: 1,
      },
      {
        title: "NVIDIA Official RTX 5090",
        image_url: "https://cdn.example.com/rtx5090.jpg",
        source_url: "https://www.nvidia.com/en-us/geforce/5090",
        source_name: "nvidia.com",
        rank: 2,
      },
      {
        title: "Another Official Shot",
        image_url: "https://images.nvidia.com/5090-angle.jpg",
        source_url: "https://www.nvidia.com/en-us/geforce/5090",
        source_name: "nvidia.com",
        rank: 3,
      },
    ];

    const deduplicated = deduplicateAndRankResults(raw, {
      count: 2,
      preferred_domains: ["nvidia.com"],
    });

    // Should deduplicate the two cdn.example.com/rtx5090.jpg entries into one,
    // preferring the one from nvidia.com over random-aggregator.com
    expect(deduplicated.length).toBe(2);
    expect(deduplicated[0].source_name).toBe("nvidia.com");
    expect(deduplicated[0].source_url).toContain("nvidia.com");
    expect(deduplicated[0].rank).toBe(1);
    expect(deduplicated[1].rank).toBe(2);
  });

  it("classifies source domains into hierarchy tiers", () => {
    // Tier 1: official, museum, archive, educational/gov
    expect(classifySourceTier("loc.gov").tier).toBe(1);
    expect(classifySourceTier("si.edu").tier).toBe(1);
    expect(classifySourceTier("nvidia.com").tier).toBe(1);
    expect(classifySourceTier("computerhistory.org").tier).toBe(1);
    expect(classifySourceTier("custom-official.org", ["custom-official.org"]).tier).toBe(1);

    // Tier 2: reputable reference, educational, major publication
    expect(classifySourceTier("wikimedia.org").tier).toBe(2);
    expect(classifySourceTier("wikipedia.org").tier).toBe(2);
    expect(classifySourceTier("nature.com").tier).toBe(2);
    expect(classifySourceTier("theverge.com").tier).toBe(2);
    expect(classifySourceTier("bbc.com").tier).toBe(2);

    // Tier 3: general websites
    expect(classifySourceTier("mytechblog.net").tier).toBe(3);

    // Tier -1: penalized low-quality / social media / watermarked aggregators
    expect(classifySourceTier("pinterest.com").tier).toBe(-1);
    expect(classifySourceTier("alamy.com").tier).toBe(-1);
    expect(classifySourceTier("shutterstock.com").tier).toBe(-1);
  });

  it("scores image candidates prioritizing source authority and exact subject match", () => {
    const candidateGov: ImageSearchResult = {
      title: "ENIAC Vacuum Tube Computer Historical Photo",
      image_url: "https://www.loc.gov/item/eniac.jpg",
      source_url: "https://www.loc.gov/item/123",
      source_name: "loc.gov",
      width: 1200,
      height: 800,
      rank: 2,
    };

    const candidateRandom: ImageSearchResult = {
      title: "Computer history pic",
      image_url: "https://randomsite.com/pic.jpg",
      source_url: "https://randomsite.com/blog",
      source_name: "randomsite.com",
      width: 1200,
      height: 800,
      rank: 1,
    };

    const candidateWatermark: ImageSearchResult = {
      title: "ENIAC Stock Photo",
      image_url: "https://alamy.com/eniac-stock.jpg",
      source_url: "https://alamy.com/image",
      source_name: "alamy.com",
      width: 1200,
      height: 800,
      rank: 1,
    };

    const scoreGov = scoreImageCandidate(candidateGov, "ENIAC vacuum tube computer");
    const scoreRandom = scoreImageCandidate(candidateRandom, "ENIAC vacuum tube computer");
    const scoreWatermark = scoreImageCandidate(candidateWatermark, "ENIAC vacuum tube computer");

    expect(scoreGov).toBeGreaterThan(scoreRandom);
    expect(scoreRandom).toBeGreaterThan(scoreWatermark);
  });

  it("prioritizes Tier 1 authoritative sources over generic blogs in deduplicateAndRankResults", () => {
    const raw: ImageSearchResult[] = [
      {
        title: "Vintage Computer Photo",
        image_url: "https://cdn.blog.com/pic1.jpg",
        source_url: "https://randomblog.com/post",
        source_name: "randomblog.com",
        rank: 1,
      },
      {
        title: "ENIAC early vacuum tube computer historical photograph",
        image_url: "https://images.si.edu/eniac-original.jpg",
        source_url: "https://si.edu/collections/eniac",
        source_name: "si.edu",
        rank: 2,
        width: 1600,
        height: 1200,
      },
    ];

    const ranked = deduplicateAndRankResults(raw, {
      query: "ENIAC vacuum tube computer",
      count: 2,
    });

    // The Smithsonian (Tier 1) should jump to rank 1 over randomblog.com
    expect(ranked[0].source_name).toBe("si.edu");
    expect(ranked[0].rank).toBe(1);
  });

  it("limits normal image candidates to at most 2 and rejects near-duplicates", () => {
    const rawMany: ImageSearchResult[] = [
      {
        title: "Vacuum Tube Computer ENIAC",
        image_url: "https://loc.gov/photos/eniac_full_view.jpg",
        source_url: "https://loc.gov/item/1",
        source_name: "loc.gov",
        width: 1200,
        height: 800,
        rank: 1,
      },
      // Near-duplicate 1: same filename on mirror site
      {
        title: "ENIAC photo mirror",
        image_url: "https://mirror-cdn.com/archive/eniac_full_view.jpg",
        source_url: "https://mirror.com/1",
        source_name: "mirror.com",
        width: 1200,
        height: 800,
        rank: 2,
      },
      // Near-duplicate 2: same domain, almost identical title
      {
        title: "Vacuum Tube Computer ENIAC View",
        image_url: "https://loc.gov/photos/eniac_full_view_alt.jpg",
        source_url: "https://loc.gov/item/1",
        source_name: "loc.gov",
        width: 1200,
        height: 800,
        rank: 3,
      },
      // Distinct image: close-up detail from museum
      {
        title: "ENIAC Vacuum Tube Modules Close-up Detail",
        image_url: "https://si.edu/photos/eniac_tubes_detail.jpg",
        source_url: "https://si.edu/item/2",
        source_name: "si.edu",
        width: 1200,
        height: 800,
        rank: 4,
      },
      // Additional images that should be excluded by default limit
      {
        title: "Another distinct image 3",
        image_url: "https://computerhistory.org/img3.jpg",
        source_url: "https://computerhistory.org",
        source_name: "computerhistory.org",
        rank: 5,
      },
      {
        title: "Another distinct image 4",
        image_url: "https://computerhistory.org/img4.jpg",
        source_url: "https://computerhistory.org",
        source_name: "computerhistory.org",
        rank: 6,
      },
    ];

    // Default call with no count passed (should cap at 2 distinct candidates)
    const resultDefault = deduplicateAndRankResults(rawMany, {
      query: "ENIAC vacuum tube computer",
    });

    expect(resultDefault.length).toBe(2);
    expect(resultDefault[0].image_url).toBe("https://loc.gov/photos/eniac_full_view.jpg");
    expect(resultDefault[1].image_url).toBe("https://si.edu/photos/eniac_tubes_detail.jpg");

    // When near-duplicates are the only other candidates, result collapses to 1
    const rawOnlyNearDups: ImageSearchResult[] = [
      rawMany[0],
      rawMany[1],
      rawMany[2],
    ];
    const resultPruned = deduplicateAndRankResults(rawOnlyNearDups, {
      query: "ENIAC vacuum tube computer",
    });
    expect(resultPruned.length).toBe(1);

    // Explicit gallery request (count: 4) allows up to 4 distinct images
    const resultExplicit = deduplicateAndRankResults(rawMany, {
      query: "ENIAC vacuum tube computer",
      count: 4,
    });
    expect(resultExplicit.length).toBe(4);
  });

  it("identifies near duplicates by filename or title from the same host", () => {
    const itemA: ImageSearchResult = {
      title: "GeForce RTX 5090 Official",
      image_url: "https://nvidia.com/assets/rtx5090_hero.png",
      source_url: "https://nvidia.com/5090",
      source_name: "nvidia.com",
      rank: 1,
    };

    const itemB: ImageSearchResult = {
      title: "RTX 5090 mirror",
      image_url: "https://cdn.mirror.org/files/rtx5090_hero.png",
      source_url: "https://mirror.org/5090",
      source_name: "mirror.org",
      rank: 2,
    };

    const itemC: ImageSearchResult = {
      title: "GeForce RTX 5090 Official Angle",
      image_url: "https://nvidia.com/assets/rtx5090_hero.jpg",
      source_url: "https://nvidia.com/5090",
      source_name: "nvidia.com",
      rank: 3,
    };

    const itemDistinct: ImageSearchResult = {
      title: "Blackwell Architecture Block Diagram",
      image_url: "https://nvidia.com/assets/blackwell_diagram.png",
      source_url: "https://nvidia.com/5090",
      source_name: "nvidia.com",
      rank: 4,
    };

    expect(isNearDuplicate(itemA, itemB)).toBe(true);
    expect(isNearDuplicate(itemA, itemC)).toBe(true);
    expect(isNearDuplicate(itemA, itemDistinct)).toBe(false);
  });
});

describe("Image Search Provider Execution (Exa)", () => {
  it("searches via Exa, extracting primary images and image links", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        results: [
          {
            title: "GeForce RTX 5090",
            url: "https://www.nvidia.com/en-us/geforce/graphics-cards/50-series/rtx-5090/",
            image:
              "https://www.nvidia.com/content/dam/geforce-rtx-5090-hero.jpg",
            extras: {
              imageLinks: [
                "https://www.nvidia.com/content/dam/geforce-rtx-5090-angle.jpg",
              ],
            },
          },
        ],
      })
    );

    const outcome = await runImageSearch("RTX 5090", { count: 2 });
    expect(outcome.provider).toBe("exa");
    expect(outcome.results.length).toBeGreaterThan(0);
    expect(outcome.results[0].image_url).toBe(
      "https://www.nvidia.com/content/dam/geforce-rtx-5090-hero.jpg"
    );
    expect(outcome.results[0].source_name).toBe("nvidia.com");
    expect(outcome.results[0].rank).toBe(1);
  });

  it("passes includeDomains to Exa when preferred_domains are provided", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        results: [
          {
            title: "Official Product",
            url: "https://www.nvidia.com/card",
            image: "https://www.nvidia.com/image.png",
          },
        ],
      })
    );

    await runImageSearch("RTX 5090", {
      preferred_domains: ["nvidia.com"],
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.includeDomains).toEqual(["nvidia.com"]);
  });
});

describe("Image Search Fallback Chain (Exa -> SearXNG -> Firecrawl)", () => {
  it("falls back to SearXNG when Exa fails with rate limit (429)", async () => {
    setEnv("SEARXNG_BASE_URL", "https://searxng.example.com");

    // Exa returns 429
    fetchMock.mockResolvedValueOnce(
      new Response("Rate limit", { status: 429 })
    );

    // SearXNG returns results
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        results: [
          {
            title: "SearXNG Image Result",
            url: "https://authoritative.com/page",
            img_src: "https://authoritative.com/image.jpg",
            thumbnail_src: "https://authoritative.com/thumb.jpg",
            resolution: "1920x1080",
            source: "bing images",
          },
        ],
      })
    );

    const outcome = await runImageSearch("Eiffel Tower");
    expect(outcome.provider).toBe("searxng");
    expect(outcome.results[0].image_url).toBe(
      "https://authoritative.com/image.jpg"
    );
    expect(outcome.results[0].width).toBe(1920);
    expect(outcome.results[0].height).toBe(1080);
    expect(outcome.attempts[0].ok).toBe(false);
    expect(outcome.attempts[1].ok).toBe(true);

    // Exa should now be on cooldown
    expect(isImageProviderCoolingDown("exa")).toBe(true);
  });

  it("falls back to Firecrawl when Exa and SearXNG fail or are unconfigured", async () => {
    setEnv("EXA_API_KEY", undefined);
    setEnv("SEARXNG_BASE_URL", undefined);

    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: {
          web: [
            {
              title: "Firecrawl Scraped Page",
              url: "https://nature.example.com/mountains",
              description:
                "Look at this scenic mountain: ![Mount Everest Peak](https://nature.example.com/everest.jpg)",
            },
          ],
        },
      })
    );

    const outcome = await runImageSearch("Mount Everest");
    expect(outcome.provider).toBe("firecrawl");
    expect(outcome.results[0].image_url).toBe(
      "https://nature.example.com/everest.jpg"
    );
    expect(outcome.results[0].alt_text).toBe("Mount Everest Peak");
  });

  it("throws clear error when all providers fail", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("Exa service error", { status: 500 })
    );
    fetchMock.mockResolvedValueOnce(
      new Response("Firecrawl error", { status: 500 })
    );

    await expect(runImageSearch("Fail query")).rejects.toThrow(
      /All image search providers failed/
    );
  });

  it("handles empty results gracefully by trying next provider or returning empty list", async () => {
    // Exa returns empty
    fetchMock.mockResolvedValueOnce(jsonResponse({ results: [] }));
    // Firecrawl returns results
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: {
          web: [
            {
              title: "Result Page",
              url: "https://example.com",
              description: "![Alt](https://example.com/img.png)",
            },
          ],
        },
      })
    );

    const outcome = await runImageSearch("query");
    expect(outcome.provider).toBe("firecrawl");
    expect(outcome.results.length).toBe(1);
  });
});
