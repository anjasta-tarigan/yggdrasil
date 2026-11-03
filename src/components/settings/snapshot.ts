import type { ProviderConfig, WebSearchProviderKind } from "@/lib/settings";

/**
 * Response shape of `GET /api/settings`, as consumed by the settings view.
 *
 * Kept structurally typed (rather than imported from the server) so the client
 * bundle does not pull in server-only modules.
 */
export type SettingsSnapshot = {
  embedding: {
    provider?: "server" | "openai-compatible" | "ollama" | "onnx";
    providerId: string | null;
    baseUrl?: string | null;
    apiKeyEnv?: string;
    apiKeyConfigured: boolean;
    model?: string | null;
    /** ONNX model file (absolute path or filename in data/models/embedding/). */
    modelPath?: string | null;
    dimensions?: number | null;
    chunkSize?: number;
    chunkOverlap?: number;
  } | null;
  /** The new embedding model the server detected was just saved, or null. */
  embeddingModelChanged: string | null;
  database: {
    engine: string;
    driver: string;
    features: string[];
    path: string;
    sizeBytes: number;
    chatCount: number;
    messageCount: number;
    memories: { episodic: number; semantic: number; working: number };
    queue: { pending: number; completed: number; failed: number };
    /** Optional: older servers (hot-reload window) may not send it yet. */
    cognitive?: {
      daemonRunning: boolean;
      queueRunnerRunning: boolean;
      relations: number;
      unembedded: { episodic: number; semantic: number };
      lastRuns: Array<{ type: string; at: string | null }>;
      lastFailure: { type: string; error: string | null; at: string | null } | null;
    };
  };
  tools: Array<{
    name: string;
    description: string;
    configured: boolean;
    requires: string | null;
    enabled: boolean;
    disableable: boolean;
  }>;
  /** Built-in tools currently also served by released MCP duplicates. */
  mcpDuplicates?: Array<{
    tool: string;
    servers: Array<{ name: string; exposedName: string; primary?: boolean }>;
  }>;
  /** Live status of the multi-provider web search chain. */
  webSearch?: {
    providers: Array<{
      kind: WebSearchProviderKind;
      enabled: boolean;
      ready: boolean;
      coolingDown: boolean;
    }>;
    chain: WebSearchProviderKind[];
  };
  about: { name: string; version: string; stack: string };
  /** Neural reranker diagnostic status and discovered models. */
  reranker?: {
    enabled: boolean;
    environmentEnabled?: boolean;
    available: boolean;
    loaded: boolean;
    /** Provider kind: local ONNX or remote OpenAI-compatible endpoint. */
    provider: "onnx" | "openai-compatible";
    modelPath: string | null;
    /** Remote endpoint base URL (when provider === "openai-compatible"). */
    baseUrl?: string;
    /** Remote model name (when provider === "openai-compatible"). */
    model?: string;
    mode: "active" | "standby" | "fallback" | "disabled";
    discoveredModels: Array<{ filename: string; sizeBytes: number }>;
  };
  /** ONNX embedding model diagnostic status and discovered models. */
  onnxEmbedding?: {
    modelPath: string | null;
    loaded: boolean;
    discoveredModels: Array<{ filename: string; sizeBytes: number }>;
  };
  /** Mutable settings store persisted in the database. */
  store: {
    providers: ProviderConfig[];
    websearch?: {
      providers?: Array<{
        kind: WebSearchProviderKind;
        enabled: boolean;
        apiKey?: string;
        baseUrl?: string;
      }>;
    };
    reranker?: {
      enabled: boolean;
      provider?: "onnx" | "openai-compatible";
      selectedModel?: string;
      baseUrl?: string;
      model?: string;
      apiKeyEnv?: string;
      idleTimeoutMinutes?: number;
    };
  };
};

export const MOBILE_SETTINGS_QUERY = "(max-width: 767px)";

export function subscribeToMobileSettings(callback: () => void) {
  const mediaQuery = window.matchMedia(MOBILE_SETTINGS_QUERY);
  mediaQuery.addEventListener("change", callback);
  return () => mediaQuery.removeEventListener("change", callback);
}

export function getMobileSettingsSnapshot() {
  return window.matchMedia(MOBILE_SETTINGS_QUERY).matches;
}

/** Form state for the three web search providers. */
export type WebSearchForm = Record<
  WebSearchProviderKind,
  { enabled: boolean; apiKey: string; apiKeys: Array<{ id: string; configured: true }>; removeApiKeyIds: string[]; baseUrl: string }
>;

export function emptyWebSearchForm(): WebSearchForm {
  return {
    exa: { enabled: false, apiKey: "", apiKeys: [], removeApiKeyIds: [], baseUrl: "" },
    firecrawl: { enabled: false, apiKey: "", apiKeys: [], removeApiKeyIds: [], baseUrl: "" },
    searxng: { enabled: false, apiKey: "", apiKeys: [], removeApiKeyIds: [], baseUrl: "" },
  };
}

export function webSearchFormFromEntries(
  entries: Array<{
    kind: WebSearchProviderKind;
    enabled: boolean;
    apiKeys?: Array<{ id: string; configured: true }>;
    apiKeyConfigured?: boolean;
    baseUrl?: string;
  }>
): WebSearchForm {
  const form = emptyWebSearchForm();
  for (const entry of entries) {
    form[entry.kind] = {
      enabled: entry.enabled,
      apiKey: "",
      apiKeys: entry.apiKeys ?? (entry.apiKeyConfigured ? [{ id: "legacy", configured: true }] : []),
      removeApiKeyIds: [],
      baseUrl: entry.baseUrl ?? "",
    };
  }
  return form;
}

/** Shared PUT helper for settings patches — eliminates duplicated fetch("/api/settings") calls. */
export async function saveSettingsPatch(
  patch: object,
): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch("/api/settings", {
    body: JSON.stringify(patch),
    headers: { "Content-Type": "application/json" },
    method: "PUT",
  });
  const data = (await res.json().catch(() => null)) as { error?: string } | null;
  if (!res.ok) {
    return { ok: false, error: data?.error ?? `HTTP ${res.status}` };
  }
  return { ok: true };
}

/** Shared GET helper for the initial settings snapshot. */
export async function loadSettingsSnapshot(): Promise<SettingsSnapshot> {
  const res = await fetch("/api/settings");
  if (!res.ok) throw new Error(String(res.status));
  return (await res.json()) as SettingsSnapshot;
}
