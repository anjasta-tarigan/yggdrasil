import type { WebSearchProviderKind } from "@/lib/settings";

/**
 * Shared constants and pure helpers for the Settings page. One module
 * so the shell and the tab components stay in sync (labels, web-search
 * metadata, formatters) without circular imports.
 */

/** The settings tabs in switcher order, with short labels. */
export const SETTINGS_TABS = [
  { value: "general", label: "General" },
  { value: "persona", label: "Persona" },
  { value: "provider", label: "Providers" },
  { value: "embedding", label: "Embedding" },
  { value: "reranker", label: "Reranker" },
  { value: "database", label: "Database" },
  { value: "tools", label: "Tools" },
  { value: "about", label: "About" },
] as const;

export type SettingsTab = (typeof SETTINGS_TABS)[number]["value"];

/** Intro paragraph shown under the tab bar for the active section. */
export const SETTINGS_TAB_INTROS: Record<SettingsTab, string> = {
  general: "Theme preference and general assistant behavior.",
  persona:
    "Customize your assistant's personality, tone, role identity, and behavioral instructions.",
  provider:
    "Every provider you add becomes active immediately — all of their models appear grouped in the chat model selector.",
  embedding:
    "Embeddings power memory search. Choose where they are computed; a deterministic local fallback keeps memory working when nothing is reachable.",
  reranker:
    "Cross-encoder reranking refines memory retrieval by scoring candidate relevance. Discovered local ONNX models run entirely on-device.",
  database:
    "Conversations, settings and memories persist in a local SQLite database on this server. Statistics are read live from the database file.",
  tools:
    "Toggle the tools the assistant may call, and configure the web_search provider chain.",
  about: "About this Yggdrasil instance.",
};

/** Display metadata for the web search providers in priority order. */
export const WEB_SEARCH_PROVIDER_META: Array<{
  kind: WebSearchProviderKind;
  label: string;
  /** SearXNG needs an instance URL; the others need an API key. */
  needsUrl: boolean;
  envHint: string;
}> = [
  {
    kind: "exa",
    label: "Exa",
    needsUrl: false,
    envHint: "Falls back to EXA_API_KEY when empty",
  },
  {
    kind: "firecrawl",
    label: "Firecrawl",
    needsUrl: false,
    envHint: "Falls back to FIRECRAWL_API_KEY when empty",
  },
  {
    kind: "searxng",
    label: "SearXNG (self-hosted)",
    needsUrl: true,
    envHint: "Falls back to SEARXNG_BASE_URL when empty",
  },
];

export const WEB_SEARCH_LABELS: Record<WebSearchProviderKind, string> = {
  exa: "Exa",
  firecrawl: "Firecrawl",
  searxng: "SearXNG",
};

/** Human labels for cognitive job types in the last-run list. */
export const COGNITIVE_JOB_LABELS: Record<string, string> = {
  ingest_turn: "Turn ingestion",
  reflect_turn: "Reflection",
  sleep_consolidation: "Light sleep",
  dream_graph_discovery: "Dream cycle",
  decay_sweep: "Deep sleep sweep",
  scheduled_reminder: "Reminders",
};

export const MAINTENANCE_LABELS: Record<
  "light_sleep" | "dream_cycle" | "decay_sweep",
  string
> = {
  light_sleep: "Light sleep",
  dream_cycle: "Dream cycle",
  decay_sweep: "Deep sleep sweep",
};

export function formatIsoLocal(iso: string | null | undefined): string {
  if (!iso) return "never";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "never";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1
  );
  const value = bytes / 1024 ** i;
  return `${value >= 10 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

/** Locale-grouped integer ("12,345"). */
export function formatCount(n: number): string {
  return Number.isFinite(n) ? n.toLocaleString() : "—";
}
