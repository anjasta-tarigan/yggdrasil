import { HfError, type HfModelInfo, type HfSearchResult, type HfTreeEntry, type ModelKind } from "./types";

export function isAllowedHfHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === "huggingface.co" ||
    host.endsWith(".huggingface.co") ||
    host === "hf.co" ||
    host.endsWith(".hf.co")
  );
}

export interface HfClientOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export function createHfClient(options: HfClientOptions = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 30_000;

  async function fetchWithRedirects(url: string, init: RequestInit = {}): Promise<Response> {
    let currentUrl = url;
    for (let hop = 0; hop < 5; hop++) {
      const parsed = new URL(currentUrl);
      if (parsed.protocol !== "https:") {
        throw new HfError(`Only HTTPS is supported (got ${parsed.protocol})`);
      }
      if (!isAllowedHfHost(parsed.hostname)) {
        throw new HfError(`Host forbidden by allowlist: ${parsed.hostname}`);
      }

      const signal = init.signal
        ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)])
        : AbortSignal.timeout(timeoutMs);

      const customHeaders = init.headers instanceof Headers
        ? Object.fromEntries(init.headers.entries())
        : Array.isArray(init.headers)
          ? Object.fromEntries(init.headers)
          : (init.headers ?? {});

      const headers: Record<string, string> = {
        "user-agent": "yggdrasil/0.1 (onnx-installer)",
        ...customHeaders,
      };

      const res = await fetchImpl(currentUrl, {
        ...init,
        redirect: "manual",
        signal,
        headers,
      });

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
    async searchModels(query: string, kind: ModelKind): Promise<HfSearchResult[]> {
      const tag = kind === "embedding" ? "feature-extraction" : "text-classification";
      const u = new URL("https://huggingface.co/api/models");
      u.searchParams.set("search", query);
      u.searchParams.set("filter", "transformers.js");
      u.searchParams.set("pipeline_tag", tag);
      u.searchParams.set("full", "true");
      u.searchParams.set("limit", "20");

      const res = await fetchWithRedirects(u.toString());
      return res.json() as Promise<HfSearchResult[]>;
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
