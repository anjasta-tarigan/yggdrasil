import { HfError, type HfModelInfo, type HfSearchResult, type HfTreeEntry, type ModelKind } from "./types";
import { rankOnnxVariants } from "./variant-ladder";

export function isAllowedHfHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === "huggingface.co" ||
    host.endsWith(".huggingface.co") ||
    host === "hf.co" ||
    host.endsWith(".hf.co")
  );
}

/** Pick ONNX variants from a sibling list, ordered by the preference ladder. */
function rankSiblings(siblings: Array<{ rfilename: string }> | undefined): string[] {
  if (!siblings) return [];
  return rankOnnxVariants(siblings.map((s) => s.rfilename));
}

/**
 * A repo is installable only when it ships BOTH an ONNX graph and a
 * `tokenizer.json`. Without the tokenizer the installer still completes, but
 * `loadTokenizer` throws at query time and `embeddings.ts` catches it —
 * storing the memory with **no vector**, a silent retrieval-degradation bug.
 * This is the only guarantee of the pairing: the Hub's `onnx` filter matches
 * on the presence of ONNX files alone, so every result row must be verified
 * here.
 *
 * The tokenizer must sit at the repository root: `tokenizerPathFor` resolves
 * `<modelDir>/tokenizer.json` only, and the installer flattens files to the
 * model root, so a nested `onnx/tokenizer.json` would not be found.
 */
export function isInstallableRepo(siblings: Array<{ rfilename: string }> | undefined): boolean {
  if (!siblings || siblings.length === 0) return false;
  const hasTokenizer = siblings.some((s) => s.rfilename === "tokenizer.json");
  return hasTokenizer && rankSiblings(siblings).length > 0;
}

export interface HfClientOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface HfFetchOptions extends RequestInit {
  timeoutMs?: number;
}

export interface SearchModelsOptions {
  /** Free-text query. Omitted (or empty) browses the top models by downloads. */
  query?: string;
  kind: ModelKind;
  /** Max results to request from the Hub. Defaults to 20 (search) / 60 (browse). */
  limit?: number;
}

/**
 * Pipeline tags queried for each kind. The Hub has no OR semantics for
 * repeated `pipeline_tag` parameters — two tags in one request return zero
 * rows — so one request is issued per tag and the pages are merged.
 *
 * Embeddings need both tags: canonical sentence-embedding repos (`BAAI/*`,
 * `nomic-ai/*`, `intfloat/*`, `jinaai/*`) are tagged `sentence-similarity`,
 * while `transformers.js` conversions are tagged `feature-extraction`.
 * Querying only the latter is what made the catalog look Xenova-only.
 *
 * Rerankers need both tags: BAAI/bge-reranker-* and Xenova conversions are
 * tagged `text-classification`, while the canonical `cross-encoder/*` namespace
 * (ms-marco-MiniLM series) and models like Alibaba-NLP/gte-reranker-* use
 * `text-ranking`. Querying only `text-classification` is what made the entire
 * cross-encoder catalog invisible in the reranker market.
 */
const PIPELINE_TAGS: Record<ModelKind, readonly string[]> = {
  embedding: ["feature-extraction", "sentence-similarity"],
  reranker: ["text-classification", "text-ranking"],
};

/**
 * True for cross-encoder rerankers, which must not appear in the embedding list.
 *
 * A cross-encoder scores a (query, document) pair: its graph emits `logits` of
 * shape `[1, num_labels]`. `pickEmbeddingTensor` accepts `logits` as an
 * already-pooled vector, so installing one as an embedder yields **1-element
 * "embeddings"** — every memory then sits at the same point in a degenerate
 * 1-D space and retrieval silently returns arbitrary rows.
 *
 * Detected by name, not by tag: over the full 1892-row ONNX catalog the name
 * test is exact (it drops `BAAI/bge-reranker-large`, `corto-ai/jina-reranker-*`,
 * `ConfidentialMind/gte-multilingual-reranker-*`, `shawnw3i/Qwen3-Reranker-*`,
 * `jian-mo/jina-reranker-m0-onnx`, … and no embedder), whereas the
 * `text-classification` / `reranker` tags are unreliable in both directions:
 * they are absent from several true cross-encoders and present on genuine
 * embedders (`jrc2139/e5-small-v2-ONNX`, `vectoriseai/instructor-large`).
 *
 * Known blind spot: a cross-encoder whose repo name omits "rerank" (e.g. an
 * `ms-marco-TinyBERT` conversion) still gets through. Those rows carry the
 * `text-classification` tag; matching on it would drop more real embedders
 * than the leak it closes, so the tradeoff is deliberate.
 */
export function isCrossEncoderRepo(id: string): boolean {
  return /rerank|cross[-_]encoder/i.test(id);
}

/**
 * True for a repo that belongs in the reranker market.
 *
 * Three independent signals are sufficient — any one suffices:
 *
 * 1. **Name signal** — id contains "rerank" or "cross-encoder/cross_encoder"
 *    (`isCrossEncoderRepo`). Catches `BAAI/bge-reranker-*`, `cross-encoder/*`,
 *    `jinaai/jina-reranker-*`, etc.
 *
 * 2. **Pipeline-tag signal** — Hub tag is `text-ranking`. The entire
 *    `cross-encoder/*` namespace uses this tag; it is absent from generic
 *    sentiment/NLI classifiers.
 *
 * 3. **Repo-tag signal** — HF `tags` array contains the literal string
 *    `"reranker"`. Some repos (e.g. Xenova/ms-marco conversions) carry this
 *    tag explicitly without it appearing in their name.
 *
 * Deliberately conservative: a `text-classification` repo with no matching
 * name, no `text-ranking` tag, and no explicit `reranker` tag is dropped.
 * The `text-classification` bucket is far too wide (sentiment, NLI, topic
 * classification, turn detection…) to admit by tag alone.
 */
export function isRerankerRepo(
  id: string,
  pipelineTag: string | undefined,
  tags: string[],
): boolean {
  return (
    isCrossEncoderRepo(id) ||
    pipelineTag === "text-ranking" ||
    tags.includes("reranker")
  );
}

export function createHfClient(options: HfClientOptions = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 30_000;

  async function fetchWithRedirects(url: string, init: HfFetchOptions = {}): Promise<Response> {
    const hopTimeoutMs = init.timeoutMs ?? timeoutMs;
    let currentUrl = url;
    for (let hop = 0; hop < 5; hop++) {
      const parsed = new URL(currentUrl);
      if (parsed.protocol !== "https:") {
        throw new HfError(`Only HTTPS is supported (got ${parsed.protocol})`);
      }
      if (!isAllowedHfHost(parsed.hostname)) {
        throw new HfError(`Host forbidden by allowlist: ${parsed.hostname}`);
      }

      const timeoutController = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        timeoutController.abort(new DOMException(`Request timed out after ${hopTimeoutMs}ms`, "TimeoutError"));
      }, hopTimeoutMs);

      const signal = init.signal
        ? AbortSignal.any([init.signal, timeoutController.signal])
        : timeoutController.signal;

      const customHeaders = init.headers instanceof Headers
        ? Object.fromEntries(init.headers.entries())
        : Array.isArray(init.headers)
          ? Object.fromEntries(init.headers)
          : (init.headers ?? {});

      const headers: Record<string, string> = {
        "user-agent": "yggdrasil/0.1 (onnx-installer)",
        ...customHeaders,
      };

      let res: Response;
      try {
        res = await fetchImpl(currentUrl, {
          ...init,
          redirect: "manual",
          signal,
          headers,
        });
      } catch (err) {
        clearTimeout(timer);
        if (timedOut) {
          throw new HfError(`Request to ${parsed.hostname} timed out after ${hopTimeoutMs}ms`);
        }
        throw err;
      }

      // Clear the handshake timeout once response headers arrive so the response body
      // stream can transfer large model files without being aborted by the handshake timer.
      clearTimeout(timer);

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        if (!location) throw new HfError(`Redirect status ${res.status} without Location header`);
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }
      if (!res.ok) {
        throw new HfError(`HuggingFace API HTTP ${res.status} for ${parsed.pathname}`, res.status);
      }
      return res;
    }
    throw new HfError("Too many redirects (> 5)");
  }

  return {
    fetchWithRedirects,
    /**
     * Search or browse the Hub for installable ONNX models.
     *
     * - `filter=onnx` restricts rows to repos that ship ONNX graphs. It is
     *   deliberately wider than `transformers.js`: that library filter hides
     *   canonical repos (`BAAI/*`, `nomic-ai/*`, `intfloat/*`) which do publish
     *   ONNX but are not tagged for the JS runtime.
     * - One request per pipeline tag for `kind` (see `PIPELINE_TAGS`), merged
     *   and re-sorted by downloads so the "best" models come first.
     * - With no `query`, browses the ranked catalog instead of returning nothing.
     *
     * Every returned row is post-filtered:
     * - `isInstallableRepo`: drops any repo whose declared files lack a tokenizer,
     *   so the UI never offers a model that would install into a silently
     *   unembedded state.
     * - Embedding results additionally drop cross-encoders (`isCrossEncoderRepo`).
     * - Reranker results additionally drop generic classifiers that are not
     *   rerankers (`isRerankerRepo`), since `text-classification` covers a very
     *   wide set of non-reranking models (sentiment, NLI, topic classification…).
     */
    async searchModels(options: SearchModelsOptions): Promise<HfSearchResult[]> {
      const { kind } = options;
      const query = options.query?.trim() ?? "";
      const limit = options.limit ?? (query ? 20 : 60);
      // Over-fetch because the installability filter below drops a large share
      // of rows. Capped at the Hub's 1000-per-page maximum so the whole catalog
      // stays reachable via the UI's "Show more" paging.
      const upstreamLimit = String(Math.min(Math.ceil(limit * 1.5), 1000));

      const pages = await Promise.allSettled(
        PIPELINE_TAGS[kind].map(async (tag) => {
          const u = new URL("https://huggingface.co/api/models");
          if (query) u.searchParams.set("search", query);
          u.searchParams.set("filter", "onnx");
          u.searchParams.set("pipeline_tag", tag);
          u.searchParams.set("sort", "downloads");
          u.searchParams.set("direction", "-1");
          u.searchParams.set("full", "true");
          u.searchParams.set("limit", upstreamLimit);

          const res = await fetchWithRedirects(u.toString());
          const rows = (await res.json()) as HfSearchResult[];
          return Array.isArray(rows) ? rows : [];
        })
      );

      // One tag failing must not blank the market, but when every tag fails the
      // caller still needs the error so the UI can offer a retry.
      const fulfilled = pages.filter(
        (page): page is PromiseFulfilledResult<HfSearchResult[]> => page.status === "fulfilled"
      );
      if (fulfilled.length === 0) {
        throw (pages[0] as PromiseRejectedResult).reason;
      }

      const seen = new Set<string>();
      return fulfilled
        .flatMap((page) => page.value)
        // Re-sort across pages so the merged list stays downloads-descending;
        // deduping afterwards therefore keeps each repo's best-ranked row.
        .sort((a, b) => (b.downloads ?? 0) - (a.downloads ?? 0))
        .filter((row) => {
          if (seen.has(row.id)) return false;
          seen.add(row.id);
          return true;
        })
        .filter((row) => (kind === "embedding" ? !isCrossEncoderRepo(row.id) : true))
        .filter((row) => (kind === "reranker" ? isRerankerRepo(row.id, row.pipeline_tag, row.tags ?? []) : true))
        .filter((row) => isInstallableRepo(row.siblings))
        .slice(0, limit)
        .map((row, i) => {
          const variants = rankSiblings(row.siblings);
          return {
            id: row.id,
            downloads: row.downloads ?? 0,
            likes: row.likes ?? 0,
            pipeline_tag: row.pipeline_tag,
            tags: row.tags,
            siblings: row.siblings,
            rank: i + 1,
            onnxVariants: variants.length,
            variants,
          };
        });
    },
    async getModelTree(repo: string): Promise<HfTreeEntry[]> {
      const safeRepo = repo.split("/").map(encodeURIComponent).join("/");
      const u = `https://huggingface.co/api/models/${safeRepo}/tree/main?recursive=true`;
      const res = await fetchWithRedirects(u);
      return res.json() as Promise<HfTreeEntry[]>;
    },
    async getModelInfo(repo: string): Promise<HfModelInfo> {
      const safeRepo = repo.split("/").map(encodeURIComponent).join("/");
      const u = `https://huggingface.co/api/models/${safeRepo}`;
      const res = await fetchWithRedirects(u);
      return res.json() as Promise<HfModelInfo>;
    },
  };
}

export type HfClient = ReturnType<typeof createHfClient>;
