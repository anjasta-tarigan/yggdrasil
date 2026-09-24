import { env } from "@/env";
import { syslog } from "@/lib/observability/log-store";
import { ERROR_MAPPING } from "./adapter";
import { recordProtocolFailure } from "./circuit-breaker";
import { touchWebSessionCheckedAt } from "./session-store";
import {
  DEEPSEEK_WEB_ORIGIN,
  DeepSeekWebAdapter,
  type AdapterFailure,
  type AdapterRequestIdentity,
} from "./deepseek";
import type { WebProviderSession } from "./types";
import type { ModelEntry } from "../provider-config/schema";
import {
  acquireRegistryLock,
  loadRegistry,
  saveRegistry,
} from "../provider-config/store";

/**
 * Model auto-discovery orchestration (Spec §8.4–§8.5).
 *
 * The adapter owns normalization; this module owns the policy the adapter must
 * not know about: a bounded TTL cache, request coalescing, the explicit-refresh
 * cooldown, the stale-serving window, and the registry merge. It is deliberately
 * the only writer of discovered models, so every rule about *when* a model
 * becomes selectable lives in one place.
 */

export const DEEPSEEK_WEB_PROVIDER_ID = "deepseek-web";

/**
 * Part of the cache key (Spec §8.5). Bump it when the adapter's normalization
 * contract changes so entries produced by the old contract are never served
 * under the new one.
 */
export const DISCOVERY_ADAPTER_VERSION = "deepseek-web-adapter-v1";

/**
 * `fresh`/`hit`/`coalesced`/`cooldown` are successful reads; `empty` is a
 * successful catalog with no models; `stale` is the last-known list served
 * because a refresh failed with a timeout or network error (Spec §8.5).
 */
export type DiscoveryCacheState =
  | "fresh"
  | "hit"
  | "coalesced"
  | "cooldown"
  | "empty"
  | "stale";

export type DiscoveryResult =
  | { ok: true; models: ModelEntry[]; cache: DiscoveryCacheState }
  | AdapterFailure;

export type DiscoverFn = (
  identity: AdapterRequestIdentity,
  signal?: AbortSignal
) => Promise<{ ok: true; models: ModelEntry[] } | AdapterFailure>;

export interface DiscoveryOptions {
  force?: boolean;
  discoverFn?: DiscoverFn;
  signal?: AbortSignal;
}

interface CacheEntry {
  providerId: string;
  sessionId: string;
  sessionVersion: number;
  models: ModelEntry[];
  /** Success time. A failed refresh never advances it (Spec §8.5). */
  storedAt: number;
}

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<DiscoveryResult>>();
/** Explicit-refresh cooldown clock, keyed like the cache (Spec §8.5). */
const lastRefreshAt = new Map<string, number>();
/** Monotonic dispatch order, so a slower older response cannot win. */
let dispatchSequence = 0;
const lastAppliedSequence = new Map<string, number>();

/** Test-only: drop all cache, coalescing, cooldown, and ordering state. */
export function resetDiscoveryCacheForTest(): void {
  cache.clear();
  inFlight.clear();
  lastRefreshAt.clear();
  lastAppliedSequence.clear();
  dispatchSequence = 0;
}

/** Test-only: current number of cached discovery entries. */
export function getDiscoveryCacheSizeForTest(): number {
  return cache.size;
}

/** Test-only: largest size of the cooldown/ordering tracking maps. */
export function getDiscoveryTrackingSizeForTest(): number {
  return Math.max(lastRefreshAt.size, lastAppliedSequence.size);
}

function cacheKeyFor(session: WebProviderSession): string {
  return [
    session.providerId,
    session.id,
    session.sessionVersion,
    DISCOVERY_ADAPTER_VERSION,
  ].join(":");
}

/** A timeout or network error is the only failure that may serve stale models. */
function isStaleEligible(code: AdapterFailure["code"]): boolean {
  return code === "upstream_timeout" || code === "network_error";
}

function describe(state: DiscoveryCacheState, models: ModelEntry[]): DiscoveryCacheState {
  return models.length === 0 ? "empty" : state;
}

function cooldownFailure(retryAfterSeconds: number): AdapterFailure {
  return {
    ok: false,
    code: "rate_limited",
    httpStatus: ERROR_MAPPING.rate_limited.status,
    message: "A model refresh was requested too recently. Try again after the cooldown.",
    retryAfterSeconds,
  };
}

function dropEntry(key: string): void {
  cache.delete(key);
  lastRefreshAt.delete(key);
  lastAppliedSequence.delete(key);
}

/** A replaced session's older entries are unreachable and must not linger. */
function evictSupersededVersions(session: WebProviderSession): void {
  for (const [key, entry] of cache) {
    if (
      entry.providerId === session.providerId &&
      entry.sessionId === session.id &&
      entry.sessionVersion !== session.sessionVersion
    ) {
      dropEntry(key);
    }
  }
}

/** Keep the process cache within its configured bound, oldest success first. */
function enforceCacheBound(): void {
  const limit = env.YGGDRASIL_WEB_PROVIDER_DISCOVERY_MAX_CACHE_ENTRIES;
  while (cache.size > limit) {
    let oldestKey: string | null = null;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [key, entry] of cache) {
      if (entry.storedAt < oldestAt) {
        oldestAt = entry.storedAt;
        oldestKey = key;
      }
    }
    if (oldestKey === null) return;
    dropEntry(oldestKey);
  }
}

/**
 * Keeps the cooldown/ordering maps bounded (Rule 02).
 *
 * Two passes: drop tracking for superseded versions of this session (every
 * request may fail to persist, so those keys would otherwise outlive the
 * request), then cap the maps at the cache bound by evicting the oldest keys.
 * The current key is never evicted — its cooldown must survive a failed refresh
 * (Spec §8.5).
 */
function pruneTracking(session: WebProviderSession): void {
  const prefix = `${session.providerId}:${session.id}:`;
  const currentKey = cacheKeyFor(session);

  for (const key of lastRefreshAt.keys()) {
    if (key !== currentKey && key.startsWith(prefix) && !cache.has(key)) {
      lastRefreshAt.delete(key);
    }
  }
  for (const key of lastAppliedSequence.keys()) {
    if (key !== currentKey && key.startsWith(prefix) && !cache.has(key)) {
      lastAppliedSequence.delete(key);
    }
  }

  const limit = env.YGGDRASIL_WEB_PROVIDER_DISCOVERY_MAX_CACHE_ENTRIES;
  evictOldest(lastRefreshAt, limit, currentKey);
  evictOldest(lastAppliedSequence, limit, currentKey);
}

/** Drops the lowest-valued keys until `map` holds at most `limit` entries. */
function evictOldest(map: Map<string, number>, limit: number, keepKey: string): void {
  while (map.size > limit) {
    let oldestKey: string | null = null;
    let oldestValue = Number.POSITIVE_INFINITY;
    for (const [key, value] of map) {
      if (key !== keepKey && value < oldestValue) {
        oldestValue = value;
        oldestKey = key;
      }
    }
    if (oldestKey === null) return;
    map.delete(oldestKey);
  }
}

function cacheResult(key: string, state: DiscoveryCacheState): DiscoveryResult | null {
  const entry = cache.get(key);
  if (!entry) return null;
  return { ok: true, models: entry.models, cache: describe(state, entry.models) };
}

/**
 * Merges discovered models into the provider's registry entry.
 *
 * The whole read-modify-write runs under the shared cross-process lock
 * (`acquireRegistryLock`, Spec §8.5), so a concurrent Settings save cannot drop
 * a discovered model: the registry is read *after* the lock is held, so a
 * concurrent writer's models cannot be dropped by a stale read. New models are
 * appended; an existing `modelId` keeps its user-curated capabilities and
 * `isDefault` untouched (Spec §8.4). The entry is created when absent, because
 * the fixed DeepSeek Web metadata carries no secret and a missing entry would
 * otherwise make discovered models permanently unselectable (Spec §11.1 assigns
 * this registration to the migration).
 */
async function mergeIntoRegistry(providerId: string, discovered: ModelEntry[]): Promise<void> {
  const release = await acquireRegistryLock();
  try {
    const doc = await loadRegistry();
    let provider = doc.providers.find((p) => p.id === providerId);

    if (!provider) {
      provider = {
        id: providerId,
        kind: "web-session",
        preset: "deepseek-web",
        name: "DeepSeek Web",
        baseUrl: DEEPSEEK_WEB_ORIGIN,
        models: [],
      };
      doc.providers.push(provider);
    }

    const existingIds = new Set(provider.models.map((model) => model.modelId));
    const additions = discovered.filter((model) => !existingIds.has(model.modelId));
    if (additions.length === 0) return;

    provider.models = [...provider.models, ...additions];
    await saveRegistry(doc);
  } finally {
    await release();
  }
}

/**
 * Discovers the provider's models and persists the valid ones.
 *
 * Ordering is load-bearing: the registry write happens before the cache write,
 * so a model is never reported as discoverable before it is selectable
 * (Spec §8.4). A failed refresh leaves both the registry and the previous
 * successful cache entry untouched.
 */
export async function discoverAndMergeModels(
  session: WebProviderSession,
  options: DiscoveryOptions = {}
): Promise<DiscoveryResult> {
  const force = options.force === true;
  const key = cacheKeyFor(session);
  const startedAt = Date.now();

  evictSupersededVersions(session);

  if (!force) {
    const cached = cache.get(key);
    if (cached && startedAt - cached.storedAt < env.YGGDRASIL_WEB_PROVIDER_DISCOVERY_TTL_MS) {
      return { ok: true, models: cached.models, cache: describe("hit", cached.models) };
    }

    // Identical implicit requests share one upstream call (Spec §8.5).
    const pending = inFlight.get(key);
    if (pending) {
      const shared = await pending;
      if (!shared.ok) return shared;
      return { ok: true, models: shared.models, cache: describe("coalesced", shared.models) };
    }
  } else {
    // An explicit refresh bypasses the TTL but not the cooldown (Spec §8.5).
    const lastRefresh = lastRefreshAt.get(key);
    if (lastRefresh !== undefined) {
      const elapsed = startedAt - lastRefresh;
      const cooldownMs = env.YGGDRASIL_WEB_PROVIDER_DISCOVERY_REFRESH_COOLDOWN_MS;
      if (elapsed < cooldownMs) {
        const cached = cacheResult(key, "cooldown");
        if (cached) return cached;
        return cooldownFailure(Math.ceil((cooldownMs - elapsed) / 1000));
      }
    }
  }

  const sequence = ++dispatchSequence;
  // The request itself consumes the cooldown, so the post-save discovery
  // request and an immediate manual refresh cannot both reach upstream.
  lastRefreshAt.set(key, startedAt);
  // Prune after registering this key so the maps never exceed their bound.
  pruneTracking(session);

  const promise = (async (): Promise<DiscoveryResult> => {
    const adapter = new DeepSeekWebAdapter();
    const discoverFn = options.discoverFn ?? adapter.discoverModels.bind(adapter);
    const outcome = await discoverFn(
      {
        userToken: session.userToken,
        userAgentMode: session.userAgentMode ?? "server-default",
        selectedUserAgent: session.selectedUserAgent,
      },
      options.signal
    );

    const latencyMs = Date.now() - startedAt;

    if (!outcome.ok) {
      // A newer result already landed: report it rather than the older outcome.
      if (sequence < (lastAppliedSequence.get(key) ?? 0)) {
        const current = cacheResult(key, "hit");
        if (current) return current;
      }

      const previous = cache.get(key);
      const staleEligible =
        previous !== undefined &&
        session.status === "verified" &&
        isStaleEligible(outcome.code) &&
        Date.now() - previous.storedAt <= env.YGGDRASIL_WEB_PROVIDER_DISCOVERY_MAX_STALE_MS;

      if (staleEligible && previous) {
        // The last-known list stays usable, but its success time does not
        // advance, so it still expires 24h after it was actually discovered.
        syslog(
          "warn",
          "web-provider",
          `web_provider.models.discovery_failed providerId=${session.providerId} resultCode=${outcome.code} httpStatusClass=${Math.floor(outcome.httpStatus / 100)}xx latencyMs=${latencyMs} cacheState=stale`
        );
        return { ok: true, models: previous.models, cache: describe("stale", previous.models) };
      }

      syslog(
        "warn",
        "web-provider",
        `web_provider.models.discovery_failed providerId=${session.providerId} resultCode=${outcome.code} httpStatusClass=${Math.floor(outcome.httpStatus / 100)}xx latencyMs=${latencyMs} cacheState=miss`
      );
      // Spec §11.3: an upstream parse failure is one of the two protocol-failure
      // sources the circuit breaker counts. A timeout, network error, or auth
      // rejection says nothing about protocol support, so it is not recorded.
      if (outcome.code === "protocol_error" || outcome.code === "unsupported_protocol") {
        await recordProtocolFailure(session.providerId, outcome.code);
      }
      return outcome;
    }

    const models = outcome.models;

    if (sequence < (lastAppliedSequence.get(key) ?? 0)) {
      // An older in-flight response must never overwrite a newer result
      // (Spec §8.5); the newer entry is authoritative.
      const current = cacheResult(key, "hit");
      if (current) return current;
      return { ok: true, models, cache: describe("fresh", models) };
    }

    lastAppliedSequence.set(key, sequence);

    if (models.length > 0) {
      try {
        await mergeIntoRegistry(session.providerId, models);
      } catch (error) {
        syslog(
          "error",
          "web-provider",
          `web_provider.models.discovery_failed providerId=${session.providerId} resultCode=protocol_error latencyMs=${latencyMs} cacheState=miss error=${error instanceof Error ? error.message : String(error)}`
        );
        return {
          ok: false,
          code: "protocol_error",
          httpStatus: ERROR_MAPPING.protocol_error.status,
          message: "Discovered models could not be persisted to the provider registry.",
        };
      }
    }

    // Spec §8.5: a successful discovery proves the session is alive and its
    // model data current, so it advances the same freshness clock the chat
    // path's 24h stale TTL reads. Without this, the stale gate's "refresh the
    // discovered models" instruction could never clear the condition. A failed
    // bookkeeping write must not turn a completed discovery into an error, but
    // it is logged rather than dropped (Rule 02) — the models are already
    // selectable, so the route still reports success.
    try {
      await touchWebSessionCheckedAt(session.providerId, new Date());
    } catch {
      // `protocol_error` is this subsystem's closed code for a failed internal
      // store write (the session-save route uses the same); §12 allows the
      // event with providerId + resultCode only.
      syslog(
        "error",
        "web-provider",
        `web_provider.request.failed providerId=${session.providerId} resultCode=protocol_error`
      );
    }

    cache.set(key, {
      providerId: session.providerId,
      sessionId: session.id,
      sessionVersion: session.sessionVersion,
      models,
      storedAt: Date.now(),
    });
    enforceCacheBound();

    syslog(
      "info",
      "web-provider",
      `web_provider.models.discovered providerId=${session.providerId} modelCount=${models.length} cacheState=fresh latencyMs=${latencyMs}`
    );

    return { ok: true, models, cache: describe("fresh", models) };
  })();

  inFlight.set(key, promise);

  try {
    return await promise;
  } finally {
    // Only the newest dispatch owns the slot; an older response completing
    // after a newer one must not evict the newer in-flight request.
    if (inFlight.get(key) === promise) inFlight.delete(key);
  }
}
