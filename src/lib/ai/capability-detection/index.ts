import { Capabilities, CapabilitySources, Modality } from "@/lib/ai/provider-config/schema";
import { getProviderById, resolveApiKey } from "@/lib/ai/provider-config/store";
import {
  CatalogEntry,
  getModelsDevCatalog,
  inferKnownModelCapabilities,
  matchCatalogModel,
} from "./catalog";
import { fetchProviderMetadata } from "./provider-meta";
import { probeModality, ProbeModality } from "./probes";
import { mergeCapabilities } from "./merge";

export type DetectionResult = {
  capabilities: Capabilities;
  capabilitySources: CapabilitySources;
  matchedCatalogId?: string;
  matchedCatalogName?: string;
};

/** Detection asked for a provider the registry does not hold. */
export class ProviderNotFoundError extends Error {
  constructor(providerId: string) {
    super(`Provider "${providerId}" not found`);
    this.name = "ProviderNotFoundError";
  }
}

/**
 * Detection was asked for a `kind: "web-session"` provider.
 *
 * Detection fetches `{baseUrl}/models` and probes `/chat/completions` — both
 * outside the adapter's fixed `DEEPSEEK_WEB_ENDPOINTS` allowlist (Spec §7.1,
 * §15.7). Manual model entry for these providers therefore never routes through
 * detection; this error is the server-side backstop for any other caller.
 */
export class WebSessionDetectionUnsupportedError extends Error {
  constructor(providerId: string) {
    super(
      `Capability detection is not available for the web-session provider "${providerId}".`
    );
    this.name = "WebSessionDetectionUnsupportedError";
  }
}

// In-memory rate-limit cache: 60s TTL per providerId::modelId. Expired
// entries are evicted on write and the size is capped — the map cannot
// grow for the process lifetime (Rule 02: no unbounded caches).
const CACHE_MAX_ENTRIES = 100;
const detectionCache = new Map<string, { result: DetectionResult; at: number }>();
const CACHE_TTL_MS = 60_000;

function cacheSet(key: string, value: DetectionResult) {
  // Evict everything already past its TTL before inserting.
  const now = Date.now();
  for (const [k, v] of detectionCache) {
    if (now - v.at >= CACHE_TTL_MS) detectionCache.delete(k);
  }
  // Hard cap: drop the oldest entries when at the limit.
  while (detectionCache.size >= CACHE_MAX_ENTRIES) {
    const oldest = detectionCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    detectionCache.delete(oldest);
  }
  detectionCache.set(key, { result: value, at: now });
}

export function extractCatalogCapabilities(entry: CatalogEntry): Partial<Capabilities> {
  const caps: Partial<Capabilities> = {};

  const contextWindow =
    typeof entry.contextWindow === "number" && entry.contextWindow > 0
      ? entry.contextWindow
      : typeof entry.context_length === "number" && entry.context_length > 0
        ? entry.context_length
        : null;
  if (contextWindow !== null) {
    caps.contextWindow = Math.round(contextWindow);
  }

  const maxOutput =
    typeof entry.maxOutputTokens === "number" && entry.maxOutputTokens > 0
      ? entry.maxOutputTokens
      : typeof entry.max_output_tokens === "number" && entry.max_output_tokens > 0
        ? entry.max_output_tokens
        : typeof entry.max_completion_tokens === "number" && entry.max_completion_tokens > 0
          ? entry.max_completion_tokens
          : null;
  if (maxOutput !== null) {
    caps.maxOutputTokens = Math.round(maxOutput);
  }

  if (typeof entry.supportsToolCalls === "boolean") {
    caps.supportsToolCalls = entry.supportsToolCalls;
  }
  if (typeof entry.supportsReasoning === "boolean") {
    caps.supportsReasoning = entry.supportsReasoning;
  }
  if (Array.isArray(entry.inputModalities) && entry.inputModalities.length > 0) {
    caps.inputModalities = entry.inputModalities as Modality[];
  }
  if (Array.isArray(entry.outputModalities) && entry.outputModalities.length > 0) {
    caps.outputModalities = entry.outputModalities as Modality[];
  }

  return caps;
}

export async function detectCapabilities(opts: {
  providerId: string;
  modelId: string;
  force?: boolean;
}): Promise<DetectionResult> {
  const cacheKey = `${opts.providerId}::${opts.modelId}`;
  const now = Date.now();

  // 1. Rate-limit guard: check in-memory cache
  if (!opts.force) {
    const cached = detectionCache.get(cacheKey);
    if (cached && now - cached.at < CACHE_TTL_MS) {
      return cached.result;
    }
  }

  // 2. Look up provider
  const provider = await getProviderById(opts.providerId);
  if (!provider) {
    throw new ProviderNotFoundError(opts.providerId);
  }

  // A web-session provider has no key-based metadata or probe surface; the
  // request must not escape to an unpinned origin (Spec §7.1, §15.7).
  if (provider.kind === "web-session") {
    throw new WebSessionDetectionUnsupportedError(opts.providerId);
  }

  // 3. Resolve API key
  const apiKey = await resolveApiKey(provider);

  // 4. Find existing model in provider (to preserve user overrides)
  const existingModel = provider.models.find((m) => m.modelId === opts.modelId);

  // 5. Layer 1: models.dev Catalog (or recognized model family heuristic fallback)
  const catalog = await getModelsDevCatalog();
  const catalogMatch = matchCatalogModel(opts.modelId, catalog);
  const catalogCaps = catalogMatch?.entry
    ? extractCatalogCapabilities(catalogMatch.entry)
    : (inferKnownModelCapabilities(opts.modelId) as Partial<Capabilities> | null);

  // 6. Layer 2: Provider Metadata (/models, /api/show)
  const providerMeta = await fetchProviderMetadata({
    baseUrl: provider.baseUrl,
    apiKey,
    kind: provider.kind,
    modelId: opts.modelId,
  });

  // 7. Initial merge: Catalog + Provider Metadata (preserving existing model user overrides)
  let { capabilities, capabilitySources } = mergeCapabilities(
    {
      catalog: catalogCaps ?? undefined,
      providerMeta,
    },
    existingModel
      ? {
          capabilities: existingModel.capabilities,
          capabilitySources: existingModel.capabilitySources,
        }
      : undefined,
  );

  // 8. Layer 3: Live Probes
  // If user has not overridden inputModalities, and we don't have definitive catalog/metadata inputModalities or probing is needed:
  const userModalitiesOverridden =
    existingModel?.capabilitySources?.inputModalities === "user";

  if (!userModalitiesOverridden) {
    // Determine which modalities need probing (≤ 3 live probes per run: image, audio, video)
    const modalitiesToProbe: ProbeModality[] = [];

    // If source for inputModalities is not authoritative or image/audio/video not resolved
    // When catalog or provider-metadata didn't provide inputModalities (source is not "models.dev" or "provider-metadata"):
    const hasModalitySource =
      capabilitySources.inputModalities === "models.dev" ||
      capabilitySources.inputModalities === "provider-metadata";

    if (!hasModalitySource) {
      modalitiesToProbe.push("image", "audio", "video");
    }

    if (modalitiesToProbe.length > 0) {
      // Execute up to 3 probes
      const probeList = modalitiesToProbe.slice(0, 3);
      const probeResults = await Promise.all(
        probeList.map(async (modality) => {
          const res = await probeModality({
            baseUrl: provider.baseUrl,
            apiKey,
            kind: provider.kind,
            modelId: opts.modelId,
            modality,
          });
          return { modality, res };
        }),
      );

      const supportedModalities = new Set<Modality>(capabilities.inputModalities ?? ["text"]);
      let probeRecorded = false;

      for (const { modality, res } of probeResults) {
        if (res.supported === true) {
          supportedModalities.add(modality as Modality);
          probeRecorded = true;
        } else if (res.supported === false) {
          supportedModalities.delete(modality as Modality);
          probeRecorded = true;
        }
      }

      if (probeRecorded) {
        const probeMerged = mergeCapabilities(
          {
            probes: {
              inputModalities: Array.from(supportedModalities) as Modality[],
            },
          },
          {
            capabilities,
            capabilitySources,
          },
        );
        capabilities = probeMerged.capabilities;
        capabilitySources = probeMerged.capabilitySources;
      }
    }
  }

  const result: DetectionResult = {
    capabilities,
    capabilitySources,
    matchedCatalogId: catalogMatch?.matchedId,
    matchedCatalogName: catalogMatch?.entry.name,
  };

  // Cache in rate-limit map
  cacheSet(cacheKey, result);

  return result;
}
