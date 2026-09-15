import { stat } from "node:fs/promises";
import { env, refreshEnv } from "@/env";
import { syslog } from "@/lib/observability/log-store";
import { getSettingsDb, setSettingsDb } from "@/lib/settings-service";
import { deriveEnvName, readSecretsMap, writeSecretsEnv } from "./secrets";
import { REGISTRY_PATH, saveRegistry } from "./store";
import {
  RegistryDocumentSchema,
  type EmbeddingBlock,
  type ModelEntry,
  type ProviderEntry,
  type RegistryDocument,
} from "./schema";

/**
 * Auto-migration: one-shot import of the legacy env vars (LLM_*) and the
 * SQLite settings keys (`providers`, `embedding`) into the provider-config
 * SSOT files (`providers.json` + `providers.secrets.env`).
 *
 * Idempotent: when `providers.json` already exists there is nothing to do.
 * Called best-effort at boot from `src/instrumentation.ts`; a failure there
 * is logged and never crashes boot.
 */

export type MigrationReport = {
  seededServer: boolean;
  importedProviders: number;
  importedEmbedding: boolean;
  createdEmpty: boolean;
};

/** Fresh per-call report for the "nothing to do" path (never shared). */
function emptyReport(): MigrationReport {
  return {
    seededServer: false,
    importedProviders: 0,
    importedEmbedding: false,
    createdEmpty: false,
  };
}

/** Shape of the legacy SQLite `providers` rows (old ProviderConfig). */
type LegacyProvider = {
  id: string;
  kind: "openai-compatible" | "ollama";
  name: string;
  baseUrl: string;
  apiKey?: string;
};

/** Shape of the legacy SQLite `embedding` settings block. */
type LegacyEmbedding = {
  provider?: "server" | "openai-compatible" | "ollama";
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  dimensions?: number;
  chunkSize?: number;
  chunkOverlap?: number;
};

const NULL_CAPABILITIES: ModelEntry["capabilities"] = {
  contextWindow: null,
  maxOutputTokens: null,
  inputModalities: ["text"],
  outputModalities: ["text"],
  supportsToolCalls: null,
  supportsReasoning: null,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Defensive parse of a legacy SQLite providers row; null when invalid. */
function parseLegacyProvider(value: unknown): LegacyProvider | null {
  if (!isRecord(value)) return null;
  const { id, kind, name, baseUrl, apiKey } = value;
  if (typeof id !== "string" || id.trim() === "") return null;
  if (kind !== "openai-compatible" && kind !== "ollama") return null;
  if (typeof name !== "string" || name.trim() === "") return null;
  if (typeof baseUrl !== "string" || !/^https?:\/\//.test(baseUrl)) return null;
  if (apiKey !== undefined && typeof apiKey !== "string") return null;
  return { id, kind, name, baseUrl, apiKey };
}

/**
 * Import env + SQLite config into `providers.json` + the secrets file.
 * Injectable settings getters keep tests off the real database.
 */
export async function ensureMigrated(deps?: {
  getSettingsDb?: typeof getSettingsDb;
  setSettingsDb?: typeof setSettingsDb;
}): Promise<MigrationReport> {
  // 1. Idempotency guard: an existing registry file means nothing to do.
  try {
    await stat(REGISTRY_PATH);
    return emptyReport();
  } catch {
    // ENOENT — proceed with the migration below.
  }

  // 2. Legacy env config (from centralized, validated env schema, re-read at call time).
  const { LLM_BASE_URL, LLM_MODEL_ID, LLM_API_KEY } = refreshEnv();

  // 3. Legacy SQLite settings + existing secrets (one read, reused below).
  const getDb = deps?.getSettingsDb ?? getSettingsDb;
  const setDb = deps?.setSettingsDb ?? setSettingsDb;
  const settings = getDb();
  const existingSecrets = await readSecretsMap();

  const legacyProviders = Array.isArray(settings.providers)
    ? settings.providers
        .map(parseLegacyProvider)
        .filter((p): p is LegacyProvider => p !== null)
    : [];
  const legacyEmbedding = isRecord(settings.embedding)
    ? (settings.embedding as LegacyEmbedding)
    : null;

  const providers: ProviderEntry[] = [];
  const secrets = new Map<string, string>();
  /**
   * Never overwrite a key the user already set via env or secrets file.
   *
   * envName is a dynamically-constructed PROVIDER_*_API_KEY — these are
   * not in the static schema (they depend on provider IDs at runtime), so
   * the raw process.env lookup here is the validated boundary (the secrets
   * map is the validated store for known values).
   */
  const taken = (envName: string) =>
    process.env[envName] !== undefined ||
    existingSecrets.has(envName) ||
    secrets.has(envName);

  // 4. Seed the "server" entry from LLM_* env vars.
  let seededServer = false;
  if (LLM_BASE_URL) {
    const models: ModelEntry[] = [];
    if (LLM_MODEL_ID) {
      models.push({
        modelId: LLM_MODEL_ID,
        displayName: LLM_MODEL_ID,
        isDefault: true,
        capabilities: NULL_CAPABILITIES,
        capabilitySources: {},
      });
    }
    providers.push({
      id: "server",
      kind: "openai-compatible",
      name: "This server",
      baseUrl: LLM_BASE_URL,
      apiKeyEnv: "PROVIDER_SERVER_API_KEY",
      source: "env",
      models,
    });
    seededServer = true;
    if (LLM_API_KEY && !taken("PROVIDER_SERVER_API_KEY")) {
      secrets.set("PROVIDER_SERVER_API_KEY", LLM_API_KEY);
    }
  }

  // 5. Import legacy SQLite providers into registry entries.
  let importedProviders = 0;
  let collisions = 0;
  /** derived-name → provider id that claimed it first */
  const derivedNames = new Map<string, string>();
  for (const legacy of legacyProviders) {
    if (providers.some((p) => p.id === legacy.id)) continue; // "server" wins
    const apiKeyEnv = deriveEnvName(legacy.id);
    const priorOwner = derivedNames.get(apiKeyEnv);
    const isCollision = priorOwner !== undefined;
    if (isCollision) {
      // Two ids normalize to the same env name (e.g. "custom-1"/"custom_1").
      // Never write the second key (taken-guard blocks it below anyway) and
      // never point this entry at the first provider's key.
      collisions += 1;
    } else {
      derivedNames.set(apiKeyEnv, legacy.id);
    }
    providers.push({
      id: legacy.id,
      kind: legacy.kind,
      name: legacy.name,
      baseUrl: legacy.baseUrl,
      // Omit apiKeyEnv on collision so this entry does not resolve to the
      // other provider's credential.
      ...(isCollision ? {} : { apiKeyEnv }),
      models: [],
    });
    importedProviders += 1;
    if (legacy.apiKey && !isCollision && !taken(apiKeyEnv)) {
      secrets.set(apiKeyEnv, legacy.apiKey);
    }
  }
  if (collisions > 0) {
    console.warn(`[provider-config] migration: apiKeyEnv collision skipped for ${collisions} provider(s)`);
    syslog("warn", "provider-config", `migration: apiKeyEnv collision skipped for ${collisions} provider(s)`);
  }

  // 6. Map the legacy embedding block onto the top-level embedding key.
  let importedEmbedding = false;
  let embedding: EmbeddingBlock | undefined;
  if (legacyEmbedding) {
    const providerId = legacyEmbedding.provider === "server" ? "server" : null;
    const standalone = legacyEmbedding.provider !== "server";
    const block: EmbeddingBlock = {
      providerId,
      ...(standalone && legacyEmbedding.baseUrl
        ? { baseUrl: legacyEmbedding.baseUrl }
        : {}),
      ...(legacyEmbedding.apiKey
        ? { apiKeyEnv: "PROVIDER_EMBEDDING_API_KEY" }
        : {}),
      ...(legacyEmbedding.model ? { model: legacyEmbedding.model } : {}),
      ...(legacyEmbedding.dimensions
        ? { dimensions: legacyEmbedding.dimensions }
        : {}),
      ...(legacyEmbedding.chunkSize
        ? { chunkSize: legacyEmbedding.chunkSize }
        : {}),
      ...(legacyEmbedding.chunkOverlap
        ? { chunkOverlap: legacyEmbedding.chunkOverlap }
        : {}),
    };
    // Only a truly empty row (`{}` — everything absent/null) is skipped so
    // the default `embedding: {}` setting does not create a meaningless
    // block. A row carrying ANY config (baseUrl, apiKey, model, tuning
    // fields, or a non-null providerId) is kept.
    const hasEmbeddingConfig =
      block.baseUrl !== undefined ||
      block.apiKeyEnv !== undefined ||
      block.model !== undefined ||
      block.dimensions !== undefined ||
      block.chunkSize !== undefined ||
      block.chunkOverlap !== undefined ||
      block.providerId !== null;
    if (hasEmbeddingConfig) {
      embedding = block;
      importedEmbedding = true;
      if (
        legacyEmbedding.apiKey &&
        !taken("PROVIDER_EMBEDDING_API_KEY") &&
        !secrets.has("PROVIDER_EMBEDDING_API_KEY")
      ) {
        secrets.set("PROVIDER_EMBEDDING_API_KEY", legacyEmbedding.apiKey);
      }
    }
  }

  // 7. Nothing to seed/import → onboarding-friendly empty registry.
  // createdEmpty reflects the truly-empty case: no providers AND no
  // embedding block was imported.
  const createdEmpty = providers.length === 0 && !embedding;
  const doc: RegistryDocument = embedding
    ? { version: 1, providers, embedding }
    : { version: 1, providers };

  // Degrade-don't-abort: an embedding.providerId that references no entry
  // in the final doc (e.g. legacy `provider: "server"` with no server
  // provider) would make schema.parse throw and leave nothing written —
  // a permanent boot failure loop. Null it (standalone embedding without
  // baseUrl is schema-valid) and warn with no value in the message.
  if (embedding && embedding.providerId !== null) {
    const ids = new Set(providers.map((p) => p.id));
    if (!ids.has(embedding.providerId)) {
      embedding = { ...embedding, providerId: null };
      doc.embedding = embedding;
      console.warn("[provider-config] migration: dropped dangling embedding providerId");
      syslog("warn", "provider-config", "migration: dropped dangling embedding providerId");
    }
  }

  // 8. Validate first (invalid docs are never written), then persist.
  //    Write order: SECRETS FIRST, then the registry, then the SQLite
  //    cleanup. Orphan secrets from a later registry failure are harmless
  //    and retry-safe; the reverse order would strand a half-state the
  //    idempotency guard could never retry. ZodError propagates as the
  //    failure signal.
  RegistryDocumentSchema.parse(doc);
  if (secrets.size > 0) {
    // Merge into the existing file so unrelated keys are never dropped.
    for (const [key, value] of secrets) {
      existingSecrets.set(key, value);
    }
    await writeSecretsEnv(existingSecrets);
  }
  await saveRegistry(doc);

  // 9. Only after the files are written, drop the legacy SQLite keys.
  setDb({ providers: undefined, embedding: undefined });

  syslog("info", "provider-config", `migration: seededServer=${seededServer} importedProviders=${importedProviders} importedEmbedding=${importedEmbedding} createdEmpty=${createdEmpty}`);

  return { seededServer, importedProviders, importedEmbedding, createdEmpty };
}
