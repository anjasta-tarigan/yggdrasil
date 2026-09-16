import { describe, it, expect, vi } from "vitest";
import { createHfClient, isAllowedHfHost, isCrossEncoderRepo, isInstallableRepo, isRerankerRepo } from "../hf-client";
import { HfError } from "../types";

describe("hf-client", () => {
  describe("isAllowedHfHost", () => {
    it("strictly validates allowed hosts with exact/suffix check", () => {
      expect(isAllowedHfHost("huggingface.co")).toBe(true);
      expect(isAllowedHfHost("cdn.hf.co")).toBe(true);
      expect(isAllowedHfHost("us.aws.cdn.hf.co")).toBe(true);
      expect(isAllowedHfHost("hf.co")).toBe(true);
      expect(isAllowedHfHost("sub.hf.co")).toBe(true);
      expect(isAllowedHfHost("HUGGINGFACE.CO")).toBe(true);
      expect(isAllowedHfHost("Us.Aws.Cdn.Hf.Co")).toBe(true);

      expect(isAllowedHfHost("evil-hf.co")).toBe(false);
      expect(isAllowedHfHost("hf.co.attacker.net")).toBe(false);
      expect(isAllowedHfHost("huggingface.co.evil.com")).toBe(false);
      expect(isAllowedHfHost("evil-huggingface.co")).toBe(false);
      expect(isAllowedHfHost("example.com")).toBe(false);
      expect(isAllowedHfHost("")).toBe(false);
    });
  });

  describe("fetchWithRedirects", () => {
    it("follows redirects up to 5 hops and validates target host at each hop", async () => {
      const mockFetch = vi.fn()
        .mockResolvedValueOnce(new Response(null, {
          status: 302,
          headers: { Location: "https://us.aws.cdn.hf.co/model.onnx" },
        }))
        .mockResolvedValueOnce(new Response("model bytes", { status: 200 }));

      const client = createHfClient({ fetchImpl: mockFetch });
      const res = await client.fetchWithRedirects("https://huggingface.co/repo/resolve/main/model.onnx");
      expect(res.status).toBe(200);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("resolves relative redirect paths against current URL", async () => {
      const mockFetch = vi.fn()
        .mockResolvedValueOnce(new Response(null, {
          status: 307,
          headers: { Location: "/api/resolve-cache/model.onnx" },
        }))
        .mockResolvedValueOnce(new Response("model bytes", { status: 200 }));

      const client = createHfClient({ fetchImpl: mockFetch });
      const res = await client.fetchWithRedirects("https://huggingface.co/repo/resolve/main/model.onnx");
      expect(res.status).toBe(200);
      expect(mockFetch).toHaveBeenNthCalledWith(
        2,
        "https://huggingface.co/api/resolve-cache/model.onnx",
        expect.anything()
      );
    });

    it("rejects redirects to unallowed hosts", async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce(new Response(null, {
        status: 302,
        headers: { Location: "https://evil.com/model.onnx" },
      }));

      const client = createHfClient({ fetchImpl: mockFetch });
      await expect(client.fetchWithRedirects("https://huggingface.co/repo/resolve/main/model.onnx"))
        .rejects.toThrow(HfError);
    });

    it("rejects non-https URLs", async () => {
      const mockFetch = vi.fn();
      const client = createHfClient({ fetchImpl: mockFetch });
      await expect(client.fetchWithRedirects("http://huggingface.co/model.onnx"))
        .rejects.toThrow(HfError);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("rejects redirect responses without Location header", async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce(new Response(null, { status: 302 }));
      const client = createHfClient({ fetchImpl: mockFetch });
      await expect(client.fetchWithRedirects("https://huggingface.co/model.onnx"))
        .rejects.toThrow(/without Location header/);
    });

    it("throws when redirect limit of 5 hops is exceeded", async () => {
      const mockFetch = vi.fn().mockImplementation(() => {
        return Promise.resolve(new Response(null, {
          status: 302,
          headers: { Location: "https://huggingface.co/redirect-target" },
        }));
      });

      const client = createHfClient({ fetchImpl: mockFetch });
      await expect(client.fetchWithRedirects("https://huggingface.co/start"))
        .rejects.toThrow(/Too many redirects/);
      expect(mockFetch).toHaveBeenCalledTimes(5);
    });

    it("throws HfError on non-ok HTTP status with status code", async () => {
      const mockFetch = vi.fn().mockResolvedValue(new Response("Not Found", { status: 404 }));
      const client = createHfClient({ fetchImpl: mockFetch });
      const errorPromise = client.fetchWithRedirects("https://huggingface.co/api/models/missing");
      await expect(errorPromise).rejects.toThrow(HfError);
      try {
        await client.fetchWithRedirects("https://huggingface.co/api/models/missing");
      } catch (err) {
        expect(err).toBeInstanceOf(HfError);
        expect((err as HfError).status).toBe(404);
      }
    });

    it("includes user-agent header and preserves custom headers", async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce(new Response("ok", { status: 200 }));
      const client = createHfClient({ fetchImpl: mockFetch });
      await client.fetchWithRedirects("https://huggingface.co/api/models", {
        headers: { Authorization: "Bearer test-token" },
      });
      expect(mockFetch).toHaveBeenCalledWith(
        "https://huggingface.co/api/models",
        expect.objectContaining({
          redirect: "manual",
          headers: expect.objectContaining({
            "user-agent": "yggdrasil/0.1 (onnx-installer)",
            Authorization: "Bearer test-token",
          }),
        })
      );
    });

    it("does not abort response body stream after handshake timeout has elapsed", async () => {
      // Stream that yields data after the handshake timeout
      const stream = new ReadableStream({
        async start(controller) {
          await new Promise((r) => setTimeout(r, 60));
          controller.enqueue(new TextEncoder().encode("delayed model chunk"));
          controller.close();
        },
      });

      const mockFetch = vi.fn().mockResolvedValueOnce(new Response(stream, { status: 200 }));
      const client = createHfClient({ fetchImpl: mockFetch, timeoutMs: 30 });

      const res = await client.fetchWithRedirects("https://huggingface.co/repo/resolve/main/model.onnx");
      expect(res.status).toBe(200);

      // Verify reading the body stream succeeds even though 60ms > timeoutMs (30ms)
      const text = await res.text();
      expect(text).toBe("delayed model chunk");
    });

    it("throws HfError on handshake timeout before response headers arrive", async () => {
      const mockFetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
          });
        });
      });

      const client = createHfClient({ fetchImpl: mockFetch, timeoutMs: 30 });
      await expect(
        client.fetchWithRedirects("https://huggingface.co/api/models/slow")
      ).rejects.toThrow(/timed out/);
    });
  });

  describe("isInstallableRepo", () => {
    it("requires both a tokenizer and a non-excluded ONNX graph", () => {
      expect(
        isInstallableRepo([{ rfilename: "tokenizer.json" }, { rfilename: "onnx/model.onnx" }]),
      ).toBe(true);
      expect(isInstallableRepo([{ rfilename: "onnx/model.onnx" }])).toBe(false);
      expect(isInstallableRepo([{ rfilename: "tokenizer.json" }])).toBe(false);
      expect(isInstallableRepo([])).toBe(false);
      expect(isInstallableRepo(undefined)).toBe(false);
    });

    it("rejects a repo whose only graph is fp16 (aborts natively on CPU)", () => {
      expect(
        isInstallableRepo([{ rfilename: "tokenizer.json" }, { rfilename: "onnx/model_fp16.onnx" }]),
      ).toBe(false);
    });

    it("accepts a tokenizer nested in a subdirectory edge case only at repo root", () => {
      // `tokenizerPathFor` resolves `<modelDir>/tokenizer.json` only, so a
      // nested tokenizer is NOT usable and must not qualify the repo.
      expect(
        isInstallableRepo([
          { rfilename: "onnx/tokenizer.json" },
          { rfilename: "onnx/model.onnx" },
        ]),
      ).toBe(false);
    });
  });

  describe("isCrossEncoderRepo", () => {
    it("flags cross-encoders by name", () => {
      expect(isCrossEncoderRepo("BAAI/bge-reranker-large")).toBe(true);
      expect(isCrossEncoderRepo("corto-ai/jina-reranker-v1-turbo-en-onnx")).toBe(true);
      expect(isCrossEncoderRepo("ConfidentialMind/gte-multilingual-reranker-base-onnx")).toBe(true);
      expect(isCrossEncoderRepo("shawnw3i/Qwen3-Reranker-4B-ONNX")).toBe(true);
      expect(isCrossEncoderRepo("vendor/cross-encoder-ms-marco")).toBe(true);
      expect(isCrossEncoderRepo("vendor/Cross_Encoder_model")).toBe(true);
    });

    it("keeps embedders whose names merely look similar", () => {
      expect(isCrossEncoderRepo("sentence-transformers/all-MiniLM-L6-v2")).toBe(false);
      expect(isCrossEncoderRepo("BAAI/bge-small-en-v1.5")).toBe(false);
      expect(isCrossEncoderRepo("jrc2139/e5-small-v2-ONNX")).toBe(false);
      // "embedding" must not be mistaken for "cross-encoder".
      expect(isCrossEncoderRepo("ibm-granite/granite-embedding-small-english-r2-ONNX")).toBe(false);
      expect(isCrossEncoderRepo("vectoriseai/instructor-large")).toBe(false);
    });
  });

  describe("isRerankerRepo", () => {
    it("accepts repos whose name or tags signal a reranking purpose", () => {
      // Name-based: matches isCrossEncoderRepo (reranker/cross-encoder in id)
      expect(isRerankerRepo("BAAI/bge-reranker-base", undefined, [])).toBe(true);
      expect(isRerankerRepo("cross-encoder/ms-marco-MiniLM-L6-v2", undefined, [])).toBe(true);
      expect(isRerankerRepo("jinaai/jina-reranker-v2-base-multilingual", undefined, [])).toBe(true);
      // pipeline_tag-based: text-ranking repos are rerankers by definition
      expect(isRerankerRepo("some-org/some-model", "text-ranking", [])).toBe(true);
      // tags-based: HF "reranker" tag on the repo
      expect(isRerankerRepo("some-org/some-model", "text-classification", ["reranker"])).toBe(true);
    });

    it("rejects generic classifiers with no reranking signal", () => {
      expect(isRerankerRepo(
        "distilbert/distilbert-base-uncased-finetuned-sst-2-english",
        "text-classification",
        ["text-classification", "transformers"],
      )).toBe(false);
      expect(isRerankerRepo("livekit/turn-detector", "text-classification", [])).toBe(false);
      expect(isRerankerRepo("cardiffnlp/twitter-roberta-base-sentiment", "text-classification", [])).toBe(false);
    });
  });

  describe("searchModels", () => {
    const INSTALLABLE_SIBLINGS = [
      { rfilename: "config.json" },
      { rfilename: "tokenizer.json" },
      { rfilename: "onnx/model.onnx" },
      { rfilename: "onnx/model_int8.onnx" },
    ];

    /** Mock fetch returning `rows` for every pipeline tag it is asked for. */
    function mockHub(rows: unknown) {
      return vi.fn().mockImplementation(
        async () => new Response(JSON.stringify(rows), { status: 200 })
      );
    }

    /** Pipeline tags present across every URL the client requested. */
    function requestedTags(mockFetch: ReturnType<typeof vi.fn>): string[] {
      return mockFetch.mock.calls.map((call) => new URL(call[0]).searchParams.get("pipeline_tag") ?? "");
    }

    it("searches embedding models across both embedding pipeline tags, filtered to ONNX", async () => {
      const mockResults = [
        { id: "Xenova/all-MiniLM-L6-v2", downloads: 1000, likes: 50, siblings: INSTALLABLE_SIBLINGS }
      ];
      const mockFetch = mockHub(mockResults);

      const client = createHfClient({ fetchImpl: mockFetch });
      const results = await client.searchModels({ query: "minilm", kind: "embedding" });
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe("Xenova/all-MiniLM-L6-v2");

      const calledUrl = new URL(mockFetch.mock.calls[0][0]);
      expect(calledUrl.searchParams.get("search")).toBe("minilm");
      // `onnx`, not `transformers.js`: the library filter hides canonical repos.
      expect(calledUrl.searchParams.get("filter")).toBe("onnx");
      expect(calledUrl.searchParams.get("full")).toBe("true");
      // Best-first ordering.
      expect(calledUrl.searchParams.get("sort")).toBe("downloads");
      expect(calledUrl.searchParams.get("direction")).toBe("-1");
      // The Hub has no OR semantics for repeated pipeline_tag params, so each
      // tag is a separate request and the pages are merged client-side.
      expect(requestedTags(mockFetch)).toEqual(["feature-extraction", "sentence-similarity"]);
    });

    it("finds canonical non-Xenova repos tagged sentence-similarity", async () => {
      // Regression: these are installable (ONNX + root tokenizer.json) but were
      // invisible while the client filtered on `transformers.js`.
      const canonical = [
        { id: "BAAI/bge-small-en-v1.5", downloads: 64_018_437, likes: 900, siblings: INSTALLABLE_SIBLINGS },
        { id: "nomic-ai/nomic-embed-text-v1.5", downloads: 20_000_000, likes: 300, siblings: INSTALLABLE_SIBLINGS },
      ];
      const mockFetch = vi.fn().mockImplementation(async (url: string) => {
        const tag = new URL(url).searchParams.get("pipeline_tag");
        return new Response(JSON.stringify(tag === "sentence-similarity" ? canonical : []), { status: 200 });
      });

      const client = createHfClient({ fetchImpl: mockFetch });
      const results = await client.searchModels({ query: "bge-small-en-v1.5", kind: "embedding" });
      expect(results.map((r) => r.id)).toEqual(["BAAI/bge-small-en-v1.5", "nomic-ai/nomic-embed-text-v1.5"]);
    });

    it("browses the ranked catalog when no query is given", async () => {
      const mockResults = [
        { id: "BAAI/bge-small-en-v1.5", downloads: 5000, likes: 10, siblings: INSTALLABLE_SIBLINGS },
      ];
      const mockFetch = mockHub(mockResults);

      const client = createHfClient({ fetchImpl: mockFetch });
      const results = await client.searchModels({ kind: "embedding" });
      expect(results).toHaveLength(1);

      const calledUrl = new URL(mockFetch.mock.calls[0][0]);
      expect(calledUrl.searchParams.get("search")).toBeNull();
      expect(calledUrl.searchParams.get("sort")).toBe("downloads");
      // Browse mode requests a larger page than an explicit search.
      expect(Number(calledUrl.searchParams.get("limit"))).toBeGreaterThan(20);
    });

    it("searches reranker models across both text-classification and text-ranking pipeline tags", async () => {
      const mockFetch = mockHub([]);

      const client = createHfClient({ fetchImpl: mockFetch });
      await client.searchModels({ query: "bge-reranker", kind: "reranker" });

      expect(requestedTags(mockFetch)).toEqual(["text-classification", "text-ranking"]);
    });

    it("surfaces cross-encoder repos tagged text-ranking that were previously invisible", async () => {
      // cross-encoder/* repos use pipeline_tag=text-ranking, not text-classification.
      // Before this fix the reranker search only queried text-classification, so
      // cross-encoder/ms-marco-MiniLM-L6-v2 and its siblings never appeared.
      const textRankingRows = [
        { id: "cross-encoder/ms-marco-MiniLM-L6-v2", downloads: 950_000, likes: 200, siblings: INSTALLABLE_SIBLINGS },
        { id: "Alibaba-NLP/gte-reranker-modernbert-base", downloads: 100_000, likes: 50, siblings: INSTALLABLE_SIBLINGS },
      ];
      const mockFetch = vi.fn().mockImplementation(async (url: string) => {
        const tag = new URL(url).searchParams.get("pipeline_tag");
        return new Response(JSON.stringify(tag === "text-ranking" ? textRankingRows : []), { status: 200 });
      });

      const client = createHfClient({ fetchImpl: mockFetch });
      const results = await client.searchModels({ query: "cross-encoder", kind: "reranker" });
      expect(results.map((r) => r.id)).toEqual([
        "cross-encoder/ms-marco-MiniLM-L6-v2",
        "Alibaba-NLP/gte-reranker-modernbert-base",
      ]);
    });

    it("drops generic text-classification models that are not rerankers from reranker results", async () => {
      // text-classification covers sentiment analysis, NLI, topic classifiers, etc.
      // Without a filter, distilbert-sst2 or livekit/turn-detector would pollute
      // the reranker market. Only repos whose name/tag signals a reranking purpose
      // or that come from text-ranking are kept.
      const textClassRows = [
        // Genuine reranker tagged text-classification
        { id: "BAAI/bge-reranker-base", downloads: 500_000, likes: 100, pipeline_tag: "text-classification", siblings: INSTALLABLE_SIBLINGS },
        // Generic sentiment classifier — must be dropped
        { id: "distilbert/distilbert-base-uncased-finetuned-sst-2-english", downloads: 400_000, likes: 80, pipeline_tag: "text-classification", siblings: INSTALLABLE_SIBLINGS },
        // Turn-detector model with no reranking purpose — must be dropped
        { id: "livekit/turn-detector", downloads: 300_000, likes: 30, pipeline_tag: "text-classification", siblings: INSTALLABLE_SIBLINGS },
      ];
      const mockFetch = vi.fn().mockImplementation(async (url: string) => {
        const tag = new URL(url).searchParams.get("pipeline_tag");
        return new Response(JSON.stringify(tag === "text-classification" ? textClassRows : []), { status: 200 });
      });

      const client = createHfClient({ fetchImpl: mockFetch });
      const results = await client.searchModels({ kind: "reranker" });
      expect(results.map((r) => r.id)).toEqual(["BAAI/bge-reranker-base"]);
    });

    it("merges pages, dedupes repos returned by both tags, and re-sorts by downloads", async () => {
      const shared = { id: "shared/model", downloads: 10, likes: 1, siblings: INSTALLABLE_SIBLINGS };
      const mockFetch = vi.fn().mockImplementation(async (url: string) => {
        const tag = new URL(url).searchParams.get("pipeline_tag");
        const rows = tag === "feature-extraction"
          ? [{ id: "low/model", downloads: 5, likes: 0, siblings: INSTALLABLE_SIBLINGS }, shared]
          : [{ id: "high/model", downloads: 900, likes: 0, siblings: INSTALLABLE_SIBLINGS }, shared];
        return new Response(JSON.stringify(rows), { status: 200 });
      });

      const client = createHfClient({ fetchImpl: mockFetch });
      const results = await client.searchModels({ kind: "embedding" });
      expect(results.map((r) => r.id)).toEqual(["high/model", "shared/model", "low/model"]);
      // Ranks are recomputed over the merged list, not per page.
      expect(results.map((r) => r.rank)).toEqual([1, 2, 3]);
    });

    it("over-fetches beyond the requested limit to absorb filtering losses", async () => {
      const mockFetch = mockHub([]);

      const client = createHfClient({ fetchImpl: mockFetch });
      await client.searchModels({ kind: "embedding", limit: 200 });

      const calledUrl = new URL(mockFetch.mock.calls[0][0]);
      // 200 * 1.5 = 300 requested upstream, so filtering can still fill 200.
      expect(Number(calledUrl.searchParams.get("limit"))).toBe(300);
    });

    it("caps the upstream limit at the Hub maximum of 1000", async () => {
      const mockFetch = mockHub([]);

      const client = createHfClient({ fetchImpl: mockFetch });
      await client.searchModels({ kind: "embedding", limit: 900 });

      const calledUrl = new URL(mockFetch.mock.calls[0][0]);
      expect(Number(calledUrl.searchParams.get("limit"))).toBe(1000);
    });

    it("keeps only repos shipping both an ONNX graph and a tokenizer", async () => {
      const mockResults = [
        {
          id: "good/model",
          downloads: 100,
          likes: 1,
          siblings: [{ rfilename: "tokenizer.json" }, { rfilename: "onnx/model.onnx" }],
        },
        {
          // ONNX present but no tokenizer.json — would install into a
          // silently unembedded state, so it must be dropped.
          id: "no-tokenizer/model",
          downloads: 99,
          likes: 1,
          siblings: [{ rfilename: "onnx/model.onnx" }],
        },
        {
          id: "no-onnx/model",
          downloads: 98,
          likes: 1,
          siblings: [{ rfilename: "tokenizer.json" }],
        },
      ];
      const mockFetch = mockHub(mockResults);

      const client = createHfClient({ fetchImpl: mockFetch });
      const results = await client.searchModels({ query: "model", kind: "embedding" });
      expect(results.map((r) => r.id)).toEqual(["good/model"]);
    });

    it("ranks ONNX variants by the CPU-safe preference ladder and excludes fp16", async () => {
      const mockResults = [
        {
          id: "ladder/model",
          downloads: 10,
          likes: 1,
          siblings: [
            { rfilename: "tokenizer.json" },
            { rfilename: "onnx/model.onnx" },
            { rfilename: "onnx/model_fp16.onnx" },
            { rfilename: "onnx/model_int8.onnx" },
          ],
        },
      ];
      const mockFetch = mockHub(mockResults);

      const client = createHfClient({ fetchImpl: mockFetch });
      const results = await client.searchModels({ query: "ladder", kind: "embedding" });
      expect(results[0].variants).toEqual(["onnx/model_int8.onnx", "onnx/model.onnx"]);
      expect(results[0].onnxVariants).toBe(2);
      expect(results[0].rank).toBe(1);
    });

    it("caps the response at the requested limit", async () => {
      const mockResults = Array.from({ length: 10 }, (_, i) => ({
        id: `m/${i}`,
        downloads: 1000 - i,
        likes: 0,
        siblings: [{ rfilename: "tokenizer.json" }, { rfilename: "onnx/model.onnx" }],
      }));
      const mockFetch = mockHub(mockResults);

      const client = createHfClient({ fetchImpl: mockFetch });
      const results = await client.searchModels({ kind: "embedding", limit: 3 });
      expect(results).toHaveLength(3);
    });

    it("returns an empty list when the API responds with a non-array", async () => {
      const mockFetch = mockHub({ error: "unexpected" });
      const client = createHfClient({ fetchImpl: mockFetch });
      await expect(client.searchModels({ kind: "embedding" })).resolves.toEqual([]);
    });

    it("still returns results when only one pipeline tag request fails", async () => {
      const survivors = [
        { id: "BAAI/bge-m3", downloads: 700, likes: 1, siblings: INSTALLABLE_SIBLINGS },
      ];
      const mockFetch = vi.fn().mockImplementation(async (url: string) => {
        const tag = new URL(url).searchParams.get("pipeline_tag");
        if (tag === "feature-extraction") return new Response(null, { status: 500 });
        return new Response(JSON.stringify(survivors), { status: 200 });
      });

      const client = createHfClient({ fetchImpl: mockFetch });
      const results = await client.searchModels({ kind: "embedding" });
      expect(results.map((r) => r.id)).toEqual(["BAAI/bge-m3"]);
    });

    it("surfaces the error when every pipeline tag request fails", async () => {
      const mockFetch = vi.fn().mockImplementation(
        async () => new Response(null, { status: 503 })
      );

      const client = createHfClient({ fetchImpl: mockFetch });
      await expect(client.searchModels({ kind: "embedding" })).rejects.toThrow(/HTTP 503/);
    });

    it("drops cross-encoders from the embedding list, and drops non-reranker classifiers from the reranker list", async () => {
      // A cross-encoder's graph emits `[1, num_labels]` logits, which
      // `pickEmbeddingTensor` would accept as a pooled vector — producing
      // 1-element "embeddings" and silently degenerate retrieval.
      const mockResults = [
        { id: "BAAI/bge-reranker-large", downloads: 900, likes: 0, siblings: INSTALLABLE_SIBLINGS },
        { id: "corto-ai/jina-reranker-v1-turbo-en-onnx", downloads: 800, likes: 0, siblings: INSTALLABLE_SIBLINGS },
        { id: "vendor/cross-encoder-ms-marco", downloads: 700, likes: 0, siblings: INSTALLABLE_SIBLINGS },
        // Genuine embedder — not a reranker, not a cross-encoder.
        { id: "ibm-granite/granite-embedding-small", downloads: 600, likes: 0, siblings: INSTALLABLE_SIBLINGS },
      ];
      const mockFetch = mockHub(mockResults);

      const client = createHfClient({ fetchImpl: mockFetch });
      const embedded = await client.searchModels({ kind: "embedding" });
      // Rerankers are stripped from embedding results.
      expect(embedded.map((r) => r.id)).toEqual(["ibm-granite/granite-embedding-small"]);

      const reranked = await client.searchModels({ kind: "reranker" });
      // Genuine embedder has no reranking signal — stripped from reranker results.
      expect(reranked.map((r) => r.id)).toEqual([
        "BAAI/bge-reranker-large",
        "corto-ai/jina-reranker-v1-turbo-en-onnx",
        "vendor/cross-encoder-ms-marco",
      ]);
    });

    it("ranks by downloads across merged pages before truncating", async () => {
      const rows = [
        { id: "a/first", downloads: 500, likes: 0, siblings: INSTALLABLE_SIBLINGS },
        { id: "a/second", downloads: 400, likes: 0, siblings: INSTALLABLE_SIBLINGS },
        { id: "a/third", downloads: 300, likes: 0, siblings: INSTALLABLE_SIBLINGS },
      ];
      const mockFetch = mockHub(rows);

      const client = createHfClient({ fetchImpl: mockFetch });
      const results = await client.searchModels({ kind: "embedding", limit: 2 });
      // The two highest-download repos survive, not the first two encountered.
      expect(results.map((r) => r.id)).toEqual(["a/first", "a/second"]);
    });
  });

  describe("getModelTree", () => {
    it("queries tree recursive=true for specified repo", async () => {
      const mockTree = [
        { path: "config.json", type: "file", size: 1024 },
        { path: "onnx/model.onnx", type: "file", size: 50000000 },
      ];
      const mockFetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(mockTree), { status: 200 }));

      const client = createHfClient({ fetchImpl: mockFetch });
      const tree = await client.getModelTree("Xenova/all-MiniLM-L6-v2");
      expect(tree).toHaveLength(2);
      expect(mockFetch).toHaveBeenCalledWith(
        "https://huggingface.co/api/models/Xenova/all-MiniLM-L6-v2/tree/main?recursive=true",
        expect.anything()
      );
    });
  });

  describe("getModelInfo", () => {
    it("queries repo model info endpoint", async () => {
      const mockInfo = {
        id: "Xenova/bge-reranker-base",
        pipeline_tag: "text-classification",
        tags: ["transformers.js"],
      };
      const mockFetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(mockInfo), { status: 200 }));

      const client = createHfClient({ fetchImpl: mockFetch });
      const info = await client.getModelInfo("Xenova/bge-reranker-base");
      expect(info.id).toBe("Xenova/bge-reranker-base");
      expect(mockFetch).toHaveBeenCalledWith(
        "https://huggingface.co/api/models/Xenova/bge-reranker-base",
        expect.anything()
      );
    });
  });
});
