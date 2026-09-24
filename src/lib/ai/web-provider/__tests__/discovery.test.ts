import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { env } from "@/env";
import { ERROR_MAPPING } from "../adapter";

// Spec §11.3: discovery is one of the two failure sources that feed the
// protocol circuit breaker. The breaker's own thresholds are covered by
// `circuit-breaker.test.ts`; here we assert only the wiring.
const recordProtocolFailureMock = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("../circuit-breaker", () => ({
  recordProtocolFailure: recordProtocolFailureMock,
  resetProtocolFailures: vi.fn(),
}));
import {
  DEEPSEEK_WEB_PROVIDER_ID,
  discoverAndMergeModels,
  getDiscoveryCacheSizeForTest,
  getDiscoveryTrackingSizeForTest,
  resetDiscoveryCacheForTest,
  type DiscoveryResult,
} from "../discovery";
import {
  loadRegistry,
  saveRegistry,
  setProviderConfigPathsForTest,
} from "../../provider-config/store";
import type { AdapterFailure } from "../deepseek";
import type { ModelEntry, RegistryDocument } from "../../provider-config/schema";
import type { WebProviderSession } from "../types";
import {
  cleanupTestProviderRegistry,
  createTestProviderRegistryDir,
} from "@/test-utils/provider-registry";

/**
 * Discovery orchestration contract (Spec §8.4–§8.5, §14.4).
 *
 * The adapter's own normalization is covered by `deepseek-adapter.test.ts`; these
 * tests drive the orchestrator with an injected `discoverFn`, so they assert only
 * cache, merge, and persistence behavior — never unverified provider payload
 * truth (Spec §13.1).
 */

const registryDir = createTestProviderRegistryDir("ygg-discovery");

/**
 * The TTL and cooldown are wall-clock policies, so every test drives a fake
 * clock instead of sleeping. `advance` moves it forward without re-rendering.
 */
let clock = 0;
function advance(ms: number): void {
  clock += ms;
}

function candidateModel(modelId: string, displayName = modelId): ModelEntry {
  return {
    modelId,
    displayName,
    isDefault: false,
    capabilities: {
      contextWindow: null,
      maxOutputTokens: null,
      inputModalities: ["text"],
      outputModalities: ["text"],
      supportsToolCalls: null,
      supportsReasoning: null,
    },
    capabilitySources: {
      inputModalities: "provider-metadata",
      outputModalities: "provider-metadata",
    },
  };
}

/** A user-curated model carrying capability overrides and the default flag. */
function existingModel(): ModelEntry {
  return {
    modelId: "existing-model",
    displayName: "Existing Model",
    isDefault: true,
    capabilities: {
      contextWindow: 128000,
      maxOutputTokens: 4096,
      inputModalities: ["text"],
      outputModalities: ["text"],
      supportsToolCalls: true,
      supportsReasoning: true,
    },
    capabilitySources: {
      contextWindow: "user",
      maxOutputTokens: "user",
      supportsToolCalls: "user",
      supportsReasoning: "user",
    },
  };
}

async function seedRegistry(models: ModelEntry[] = []): Promise<void> {
  setProviderConfigPathsForTest(registryDir);
  const doc: RegistryDocument = {
    version: 1,
    providers: [
      {
        id: DEEPSEEK_WEB_PROVIDER_ID,
        kind: "web-session",
        preset: "deepseek-web",
        name: "DeepSeek Web",
        baseUrl: "https://chat.deepseek.com",
        models,
      },
    ],
  };
  await saveRegistry(doc);
}

function makeSession(overrides: Partial<WebProviderSession> = {}): WebProviderSession {
  return {
    id: "session-1",
    providerId: DEEPSEEK_WEB_PROVIDER_ID,
    userToken: "synthetic-token",
    status: "verified",
    lastCheckedAt: null,
    lastFailureCode: null,
    userAgentMode: "server-default",
    capturedAt: null,
    sessionVersion: 1,
    ...overrides,
  };
}

const success = (models: ModelEntry[]) => async () => ({ ok: true as const, models });

const failure = (code: AdapterFailure["code"], message = "upstream failed") =>
  async (): Promise<AdapterFailure> => ({
    ok: false,
    code,
    httpStatus: ERROR_MAPPING[code].status,
    message,
  });

async function registeredModelIds(): Promise<string[]> {
  const doc = await loadRegistry();
  const provider = doc.providers.find((p) => p.id === DEEPSEEK_WEB_PROVIDER_ID);
  return provider?.models.map((model) => model.modelId) ?? [];
}

function expectSuccess(result: DiscoveryResult): { models: ModelEntry[]; cache: string } {
  if (!result.ok) throw new Error(`expected success, got ${result.code}`);
  return result;
}

describe("web provider model discovery orchestrator", () => {
  beforeEach(async () => {
    resetDiscoveryCacheForTest();
    clock = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    await seedRegistry();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await cleanupTestProviderRegistry(registryDir);
  });

  it("coalesces concurrent requests with the same cache key into one upstream call", async () => {
    const discoverFn = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return { ok: true as const, models: [candidateModel("deepseek-chat")] };
    });

    const [first, second] = await Promise.all([
      discoverAndMergeModels(makeSession(), { discoverFn }),
      discoverAndMergeModels(makeSession(), { discoverFn }),
    ]);

    expect(discoverFn).toHaveBeenCalledTimes(1);
    expect(expectSuccess(first).models.map((model) => model.modelId)).toEqual([
      "deepseek-chat",
    ]);
    expect(expectSuccess(second).cache).toBe("coalesced");
  });

  it("serves a fresh cache hit without a second upstream call", async () => {
    const discoverFn = vi.fn(success([candidateModel("deepseek-chat")]));

    const fresh = await discoverAndMergeModels(makeSession(), { discoverFn });
    const cached = await discoverAndMergeModels(makeSession(), { discoverFn });

    expect(discoverFn).toHaveBeenCalledTimes(1);
    expect(expectSuccess(fresh).cache).toBe("fresh");
    expect(expectSuccess(cached).cache).toBe("hit");
  });

  it("refetches once the TTL has expired", async () => {
    const discoverFn = vi.fn(success([candidateModel("deepseek-chat")]));

    await discoverAndMergeModels(makeSession(), { discoverFn });
    advance(env.YGGDRASIL_WEB_PROVIDER_DISCOVERY_TTL_MS + 1);
    await discoverAndMergeModels(makeSession(), { discoverFn });

    expect(discoverFn).toHaveBeenCalledTimes(2);
  });

  it("bypasses the TTL on force but enforces the 30s refresh cooldown", async () => {
    const discoverFn = vi.fn(success([candidateModel("deepseek-chat")]));

    const initial = await discoverAndMergeModels(makeSession(), { discoverFn });
    expect(expectSuccess(initial).cache).toBe("fresh");

    // A forced refresh inside the cooldown is served from cache, not upstream.
    advance(1_000);
    const cooled = await discoverAndMergeModels(makeSession(), { force: true, discoverFn });
    expect(expectSuccess(cooled).cache).toBe("cooldown");
    expect(discoverFn).toHaveBeenCalledTimes(1);

    // Past the cooldown, force reaches upstream even though the TTL is unexpired.
    advance(env.YGGDRASIL_WEB_PROVIDER_DISCOVERY_REFRESH_COOLDOWN_MS);
    const forced = await discoverAndMergeModels(makeSession(), { force: true, discoverFn });

    expect(expectSuccess(forced).cache).toBe("fresh");
    expect(discoverFn).toHaveBeenCalledTimes(2);
  });

  it.each(["session_rejected", "rate_limited", "protocol_error"] as const)(
    "never caches a %s result as a successful entry",
    async (code) => {
      const discoverFn = vi.fn(failure(code));

      const first = await discoverAndMergeModels(makeSession(), { discoverFn });
      expect(first.ok).toBe(false);
      expect(getDiscoveryCacheSizeForTest()).toBe(0);

      const second = await discoverAndMergeModels(makeSession(), { discoverFn });
      expect(second.ok).toBe(false);
      expect(discoverFn).toHaveBeenCalledTimes(2);
    }
  );

  it("preserves existing registry models on an empty catalog and on a malformed result", async () => {
    await seedRegistry([existingModel()]);

    const empty = await discoverAndMergeModels(makeSession(), {
      discoverFn: success([]),
    });
    expect(expectSuccess(empty).cache).toBe("empty");
    expect(await registeredModelIds()).toEqual(["existing-model"]);

    advance(env.YGGDRASIL_WEB_PROVIDER_DISCOVERY_REFRESH_COOLDOWN_MS + 1);
    const malformed = await discoverAndMergeModels(makeSession(), {
      force: true,
      discoverFn: failure("protocol_error"),
    });

    expect(malformed.ok).toBe(false);
    expect(await registeredModelIds()).toEqual(["existing-model"]);
  });

  it("adds new models while preserving user capability overrides, and never a web-session default", async () => {
    await seedRegistry([existingModel()]);

    const result = await discoverAndMergeModels(makeSession(), {
      discoverFn: success([
        candidateModel("existing-model", "Upstream Display Name"),
        candidateModel("deepseek-chat", "DeepSeek Chat"),
      ]),
    });

    expect(expectSuccess(result).models.map((model) => model.modelId)).toEqual([
      "existing-model",
      "deepseek-chat",
    ]);

    const doc = await loadRegistry();
    const models = doc.providers[0].models;
    expect(models.map((model) => model.modelId)).toEqual([
      "existing-model",
      "deepseek-chat",
    ]);

    const curated = models.find((model) => model.modelId === "existing-model")!;
    expect(curated.displayName).toBe("Existing Model");
    // B4: a web-session provider can never hold the default, even when the
    // seed carried the flag; discovery must not resurrect it.
    expect(curated.isDefault).toBe(false);
    expect(curated.capabilities.contextWindow).toBe(128000);
    expect(curated.capabilitySources.contextWindow).toBe("user");

    expect(models.find((model) => model.modelId === "deepseek-chat")!.isDefault).toBe(false);
  });

  it("reclaims a stale registry lock left by a crashed process", async () => {
    await seedRegistry([existingModel()]);
    const lockPath = path.join(registryDir, "providers.json.lock");
    await fs.writeFile(lockPath, "999999:0", "utf8");
    const stale = new Date(Date.now() - 60_000);
    await fs.utimes(lockPath, stale, stale);

    const result = await discoverAndMergeModels(makeSession(), {
      discoverFn: success([candidateModel("deepseek-chat")]),
    });

    expect(expectSuccess(result).cache).toBe("fresh");
    expect(await registeredModelIds()).toEqual(["existing-model", "deepseek-chat"]);
    await expect(fs.stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails the merge instead of stealing a fresh lock held by another process", async () => {
    await seedRegistry([existingModel()]);
    const lockPath = path.join(registryDir, "providers.json.lock");
    await fs.writeFile(lockPath, "424242:0", "utf8");

    try {
      const result = await discoverAndMergeModels(makeSession(), {
        discoverFn: success([candidateModel("deepseek-chat")]),
      });

      // A merge that never happened must not be reported as discovered (Spec §8.4).
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("protocol_error");
      expect(await registeredModelIds()).toEqual(["existing-model"]);
      expect(getDiscoveryCacheSizeForTest()).toBe(0);
    } finally {
      await fs.unlink(lockPath).catch(() => {});
    }
  });

  it("does not drop a concurrently written model from another process", async () => {
    await seedRegistry([existingModel()]);

    // Another process appends a model between the discovery read and write; the
    // lock plus read-after-lock must preserve it (Spec §8.5).
    const externalDiscover = async () => {
      const doc = await loadRegistry();
      doc.providers[0].models.push(candidateModel("external-model", "External Model"));
      await saveRegistry(doc);
      return { ok: true as const, models: [candidateModel("deepseek-chat")] };
    };

    const result = await discoverAndMergeModels(makeSession(), { discoverFn: externalDiscover });

    expect(expectSuccess(result).models.map((model) => model.modelId)).toEqual([
      "deepseek-chat",
    ]);
    expect(await registeredModelIds()).toEqual([
      "existing-model",
      "external-model",
      "deepseek-chat",
    ]);
  });

  it("releases the cross-process registry lock after a successful merge", async () => {
    await discoverAndMergeModels(makeSession(), {
      discoverFn: success([candidateModel("deepseek-chat")]),
    });

    // The O_EXCL sidecar must not survive the write, or the next discovery
    // would stall until the stale-lock timeout.
    await expect(
      fs.stat(path.join(registryDir, "providers.json.lock"))
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("leaves registry and cache unchanged when a refresh fails", async () => {
    await seedRegistry([existingModel()]);
    const discoverFn = vi.fn(success([candidateModel("deepseek-chat")]));
    await discoverAndMergeModels(makeSession(), { discoverFn });

    advance(env.YGGDRASIL_WEB_PROVIDER_DISCOVERY_REFRESH_COOLDOWN_MS + 1);
    const failed = await discoverAndMergeModels(makeSession(), {
      force: true,
      // Not stale-eligible: a protocol failure must not fall back to the
      // last-known list, and must not mutate anything.
      discoverFn: failure("protocol_error"),
    });

    expect(failed.ok).toBe(false);
    expect(await registeredModelIds()).toEqual(["existing-model", "deepseek-chat"]);
    expect(getDiscoveryCacheSizeForTest()).toBe(1);

    // The prior successful entry still serves reads: a failed refresh did not evict it.
    const cached = await discoverAndMergeModels(makeSession(), { discoverFn });
    expect(expectSuccess(cached).cache).toBe("hit");
  });

  it("serves the last-known list as stale only on a timeout or network error from a verified session", async () => {
    await seedRegistry([existingModel()]);
    const discoverFn = vi.fn(success([candidateModel("deepseek-chat")]));
    await discoverAndMergeModels(makeSession(), { discoverFn });

    advance(env.YGGDRASIL_WEB_PROVIDER_DISCOVERY_REFRESH_COOLDOWN_MS + 1);
    const stale = await discoverAndMergeModels(makeSession(), {
      force: true,
      discoverFn: failure("network_error"),
    });
    const staleResult = expectSuccess(stale);
    expect(staleResult.cache).toBe("stale");
    expect(staleResult.models.map((model) => model.modelId)).toEqual(["deepseek-chat"]);

    // An unverified session may not keep using the last-known list.
    advance(env.YGGDRASIL_WEB_PROVIDER_DISCOVERY_REFRESH_COOLDOWN_MS + 1);
    const rejected = await discoverAndMergeModels(makeSession({ status: "rejected" }), {
      force: true,
      discoverFn: failure("upstream_timeout"),
    });
    expect(rejected.ok).toBe(false);
  });

  it("expires stale data after YGGDRASIL_WEB_PROVIDER_DISCOVERY_MAX_STALE_MS", async () => {
    await seedRegistry([existingModel()]);
    const discoverFn = vi.fn(success([candidateModel("deepseek-chat")]));
    await discoverAndMergeModels(makeSession(), { discoverFn });

    advance(env.YGGDRASIL_WEB_PROVIDER_DISCOVERY_MAX_STALE_MS + 1);
    const expired = await discoverAndMergeModels(makeSession(), {
      force: true,
      discoverFn: failure("upstream_timeout"),
    });

    expect(expired.ok).toBe(false);
  });

  it("does not let an older in-flight response overwrite a newer result", async () => {
    let resolveOlder: (value: { ok: true; models: ModelEntry[] }) => void = () => {};
    const older = new Promise<{ ok: true; models: ModelEntry[] }>((resolve) => {
      resolveOlder = resolve;
    });
    const olderDiscover = vi.fn(async () => older);
    const pendingOlder = discoverAndMergeModels(makeSession(), { discoverFn: olderDiscover });

    // Force a second, newer request past the cooldown.
    advance(env.YGGDRASIL_WEB_PROVIDER_DISCOVERY_REFRESH_COOLDOWN_MS + 1);
    const newer = await discoverAndMergeModels(makeSession(), {
      force: true,
      discoverFn: success([candidateModel("deepseek-chat")]),
    });
    expect(expectSuccess(newer).models.map((model) => model.modelId)).toEqual([
      "deepseek-chat",
    ]);

    // The stale response lands last and must not win the cache.
    resolveOlder({ ok: true, models: [candidateModel("stale-model")] });
    const stale = await pendingOlder;
    expect(expectSuccess(stale).models.map((model) => model.modelId)).toEqual([
      "deepseek-chat",
    ]);

    const cached = await discoverAndMergeModels(makeSession(), { discoverFn: olderDiscover });
    expect(expectSuccess(cached).models.map((model) => model.modelId)).toEqual([
      "deepseek-chat",
    ]);
  });

  it("keys the cache by session version so a replaced session invalidates older entries", async () => {
    const discoverFn = vi.fn(success([candidateModel("deepseek-chat")]));
    await discoverAndMergeModels(makeSession({ sessionVersion: 1 }), { discoverFn });

    await discoverAndMergeModels(makeSession({ sessionVersion: 2 }), { discoverFn });

    expect(discoverFn).toHaveBeenCalledTimes(2);
    expect(getDiscoveryCacheSizeForTest()).toBe(1);
  });

  it("does not let repeated failed refreshes grow the tracking maps without bound", async () => {
    await seedRegistry([existingModel()]);
    const limit = env.YGGDRASIL_WEB_PROVIDER_DISCOVERY_MAX_CACHE_ENTRIES;

    // Every request fails to persist, so no cache entry is ever created. Session
    // ids churn too, as a delete-then-re-import would produce.
    for (let index = 0; index <= limit + 10; index += 1) {
      await discoverAndMergeModels(makeSession({ id: `session-${index}` }), {
        discoverFn: failure("protocol_error"),
      });
    }

    expect(getDiscoveryCacheSizeForTest()).toBe(0);
    expect(getDiscoveryTrackingSizeForTest()).toBeLessThanOrEqual(limit);
  });

  it("keeps the current session's cooldown after a failed refresh", async () => {
    await seedRegistry([existingModel()]);

    // A failed refresh consumes the cooldown, so an immediate force is refused
    // from the cooldown clock rather than reaching upstream again (Spec §8.5).
    const failing = vi.fn(failure("protocol_error"));
    await discoverAndMergeModels(makeSession(), { discoverFn: failing });
    const second = await discoverAndMergeModels(makeSession(), { force: true, discoverFn: failing });

    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.code).toBe("rate_limited");
    expect(failing).toHaveBeenCalledTimes(1);
  });

  it("bounds the cache to YGGDRASIL_WEB_PROVIDER_DISCOVERY_MAX_CACHE_ENTRIES", async () => {
    const discoverFn = vi.fn(success([candidateModel("deepseek-chat")]));
    const limit = env.YGGDRASIL_WEB_PROVIDER_DISCOVERY_MAX_CACHE_ENTRIES;

    for (let index = 0; index <= limit + 5; index += 1) {
      await discoverAndMergeModels(makeSession({ id: `session-${index}` }), { discoverFn });
    }

    expect(getDiscoveryCacheSizeForTest()).toBe(limit);
  });

  it.each(["protocol_error", "unsupported_protocol"] as const)(
    "records a %s discovery failure with the circuit breaker",
    async (code) => {
      recordProtocolFailureMock.mockClear();

      const result = await discoverAndMergeModels(makeSession(), {
        discoverFn: failure(code),
      });

      expect(result.ok).toBe(false);
      expect(recordProtocolFailureMock).toHaveBeenCalledTimes(1);
      expect(recordProtocolFailureMock).toHaveBeenCalledWith(DEEPSEEK_WEB_PROVIDER_ID, code);
    }
  );

  it.each(["session_rejected", "rate_limited", "network_error", "upstream_timeout"] as const)(
    "does not record the non-protocol %s discovery failure",
    async (code) => {
      recordProtocolFailureMock.mockClear();

      await discoverAndMergeModels(makeSession(), { discoverFn: failure(code) });

      expect(recordProtocolFailureMock).not.toHaveBeenCalled();
    }
  );
});
