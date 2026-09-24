import { env } from "@/env";
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  SECRETS_PATH,
  __setSecretsPath,
  readSecretsMap,
} from "./secrets";
import {
  RegistryDocumentSchema,
  type EmbeddingBlock,
  type ProviderEntry,
  type ProviderEntryView,
  type RegistryDocument,
} from "./schema";

if (typeof window !== "undefined" && env.NODE_ENV !== "test") {
  throw new Error("provider-config store is server-only");
}

let registryPath = path.resolve(
  env.YGGDRASIL_PROVIDER_CONFIG_DIR ??
    path.resolve(process.cwd(), "data"),
  "providers.json",
);

export let REGISTRY_PATH = registryPath;

/** Test-only: repoint registry + secrets files at a temp directory. */
export function setProviderConfigPathsForTest(rootDir: string): void {
  registryPath = path.join(rootDir, "providers.json");
  REGISTRY_PATH = registryPath;
  __setSecretsPath(path.join(rootDir, "providers.secrets.env"));
}

export class ProviderConfigError extends Error {
  constructor(
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message);
    this.name = "ProviderConfigError";
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }

  get path(): string {
    return registryPath;
  }
}

/**
 * Cross-process registry mutex (Spec §8.5).
 *
 * A module-level Promise queue serializes only within one process, so two
 * workers, two route handlers, or a CLI run would still read-modify-write the
 * registry concurrently and lose a merge. The lock is an `O_EXCL` sidecar file
 * next to the registry: creation is atomic on every supported platform, and a
 * stale lock left by a crashed process is reclaimed once it ages past
 * `STALE_LOCK_MS`. A lock we cannot acquire in time surfaces as a failure, never
 * as a silent skip — a skipped merge would report models as discoverable that
 * were never persisted (Spec §8.4).
 */
const STALE_LOCK_MS = 30_000;
const LOCK_RETRY_MS = 25;
/**
 * Attempt budget, not a wall-clock deadline: the loop makes progress on its own,
 * so it behaves identically under a mocked clock. A write holds the lock for one
 * registry read plus one write (single-digit milliseconds), so 1s of retries is
 * ~50x the expected hold time while staying far inside the 20s route deadline.
 */
const LOCK_MAX_ATTEMPTS = 40;

/** Raised when the cross-process registry lock cannot be acquired in time. */
export class RegistryLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistryLockError";
  }
}

function lockPath(): string {
  return `${registryPath}.lock`;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Acquires the cross-process registry lock, returning the release function.
 *
 * Every writer of the registry must hold this lock across its whole
 * read-modify-write (Rule 17). `EPERM`/`EBUSY` on the sidecar's `stat`/`unlink`
 * mean Windows still holds it open — a wait condition, not a failure — while
 * `ENOENT` means the owner released it first, so we retry `open` at once.
 */
export async function acquireRegistryLock(): Promise<() => Promise<void>> {
  const path = lockPath();
  let attempts = 0;

  for (;;) {
    try {
      const handle = await open(path, "wx");
      await handle.writeFile(`${process.pid}:${Date.now()}`, "utf8");
      await handle.close();
      return async () => {
        await unlink(path).catch(() => {});
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new RegistryLockError(
          `could not create the provider registry lock: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    attempts += 1;
    if (attempts >= LOCK_MAX_ATTEMPTS) {
      throw new RegistryLockError(
        "timed out waiting for the provider registry lock; another process is writing it"
      );
    }

    // Reclaim a lock whose owner died without releasing it. A fresh lock is
    // respected: stealing it would reintroduce the lost-update race.
    let isStale = false;
    try {
      isStale = Date.now() - (await stat(path)).mtimeMs > STALE_LOCK_MS;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") continue;
      if (code !== "EPERM" && code !== "EBUSY") {
        throw new RegistryLockError(
          `could not inspect the provider registry lock: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    if (isStale) {
      try {
        await unlink(path);
        continue;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") continue;
        if (code !== "EPERM" && code !== "EBUSY") {
          throw new RegistryLockError(
            `could not reclaim the provider registry lock: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
    }

    await sleep(LOCK_RETRY_MS);
  }
}

export async function loadRegistry(): Promise<RegistryDocument> {
  let text: string;
  try {
    text = await readFile(registryPath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new ProviderConfigError(
        "provider registry not initialized — migration will seed it: " +
          registryPath,
        { cause: error },
      );
    }
    throw new ProviderConfigError(
      `failed to read provider registry at ${registryPath}`,
      { cause: error },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ProviderConfigError(
      `provider registry at ${registryPath} is corrupt JSON`,
      { cause: error },
    );
  }

  const result = RegistryDocumentSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new ProviderConfigError(
      `provider registry at ${registryPath} is invalid: ${issue.path.join(".")}: ${issue.message}`,
      { cause: result.error },
    );
  }
  return result.data;
}

export async function saveRegistry(doc: RegistryDocument): Promise<void> {
  // Defensive demotion before validation: Task 1's schema rejects documents
  // with more than one isDefault:true model, so demote first, then validate.
  // The most recently set default wins; earlier flags are cleared.
  const clone: RegistryDocument = structuredClone(doc);
  // `models` may be absent pre-parse (Zod defaults it to []) — treat
  // missing as empty so the demotion walk cannot TypeError.
  // Web-session providers can never supply the default (their callers are
  // unattended jobs with no browser session), so clear those flags first.
  for (const provider of clone.providers) {
    if (provider.kind !== "web-session") continue;
    for (const model of provider.models ?? []) {
      model.isDefault = false;
    }
  }
  const flagged = clone.providers.flatMap((provider) =>
    (provider.models ?? []).filter((model) => model.isDefault),
  );
  for (const model of flagged.slice(0, -1)) {
    model.isDefault = false;
  }

  const parsed = RegistryDocumentSchema.parse(clone);

  await mkdir(path.dirname(registryPath), { recursive: true });
  const tmp = `${registryPath}.tmp.${process.pid}`;
  await writeFile(tmp, JSON.stringify(parsed, null, 2), "utf8");
  // Restrict the temp file BEFORE rename (deterministic mode, not umask-masked).
  try {
    await chmod(tmp, 0o600);
  } catch (error) {
    if (process.platform !== "win32") throw error;
    // Windows: chmod may be unsupported; proceed best-effort.
  }
  await rename(tmp, registryPath);
}

export function resolveApiKeySync(
  entry: { apiKeyEnv?: string },
  secretsMap: Map<string, string>,
): string | undefined {
  if (!entry.apiKeyEnv) return undefined;
  return (
    process.env[entry.apiKeyEnv] ?? secretsMap.get(entry.apiKeyEnv) ?? undefined
  );
  // entry.apiKeyEnv is a dynamic key name validated by the provider schema
  // (ProviderEntrySchema.apiKeyEnv regex), not a static env var — the secrets
  // map provides the validated boundary for provider credentials.
}

export async function resolveApiKey(
  entry: Pick<ProviderEntry, "apiKeyEnv" | "apiKeys">,
): Promise<string | undefined> {
  const map = await readSecretsMap();
  if (entry.apiKeys) {
    return entry.apiKeys.map(row => resolveApiKeySync(row, map)).find(value => value?.trim());
  }
  return resolveApiKeySync(entry, map);
}

/** Resolve every configured reference in order; selection/rotation belongs to transport. */
export async function resolveApiKeys(
  entry: Pick<ProviderEntry, "apiKeyEnv" | "apiKeys">,
): Promise<string[]> {
  const map = await readSecretsMap();
  if (entry.apiKeys) {
    return entry.apiKeys.map(row => {
      const value = resolveApiKeySync(row, map);
      if (!value?.trim()) throw new ProviderConfigError(`API key ${row.id} is not configured`);
      return value;
    });
  }
  const value = resolveApiKeySync(entry, map);
  if (entry.apiKeyEnv && !value?.trim()) {
    throw new ProviderConfigError("Legacy API key is not configured");
  }
  return value ? [value] : [];
}

export async function getProviderById(
  id: string,
): Promise<ProviderEntry | null> {
  const doc = await loadRegistry();
  return doc.providers.find((p) => p.id === id) ?? null;
}

export function toViewEntry(
  entry: ProviderEntry,
  secretsMap: Map<string, string>,
): ProviderEntryView {
  const apiKeys = entry.apiKeys?.map(row => ({
    id: row.id,
    apiKeyEnv: row.apiKeyEnv,
    configured: Boolean(resolveApiKeySync(row, secretsMap)?.trim()),
  }));
  return {
    id: entry.id,
    kind: entry.kind,
    name: entry.name,
    baseUrl: entry.baseUrl,
    ...(entry.preset ? { preset: entry.preset } : {}),
    ...(entry.apiKeyEnv ? { apiKeyEnv: entry.apiKeyEnv } : {}),
    ...(apiKeys ? { apiKeys } : {}),
    apiKeyConfigured: apiKeys
      ? apiKeys.every(row => row.configured)
      : Boolean(resolveApiKeySync(entry, secretsMap)),
    models: entry.models,
  };
}

export async function getRegistryView(): Promise<{
  providers: ProviderEntryView[];
  embedding?: EmbeddingBlock & { apiKeyConfigured: boolean };
}> {
  const doc = await loadRegistry();
  const map = await readSecretsMap();
  const embedding = doc.embedding
    ? {
        ...doc.embedding,
        apiKeyConfigured: Boolean(
          doc.embedding.apiKeyEnv &&
            resolveApiKeySync({ apiKeyEnv: doc.embedding.apiKeyEnv }, map),
        ),
      }
    : undefined;
  return {
    providers: doc.providers.map((p) => toViewEntry(p, map)),
    embedding,
  };
}

export { SECRETS_PATH };
