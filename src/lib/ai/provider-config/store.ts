import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  SECRETS_PATH,
  __setSecretsPath,
  readSecretsMap,
  writeSecretsEnv,
} from "./secrets";
import {
  RegistryDocumentSchema,
  type EmbeddingBlock,
  type ProviderEntry,
  type ProviderEntryView,
  type RegistryDocument,
} from "./schema";

if (typeof window !== "undefined" && process.env.NODE_ENV !== "test") {
  throw new Error("provider-config store is server-only");
}

let registryPath = path.resolve(
  process.env.YGGDRASIL_PROVIDER_CONFIG_DIR ??
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
  const flagged = clone.providers.flatMap((provider) =>
    provider.models.filter((model) => model.isDefault),
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
}

export async function resolveApiKey(
  entry: { apiKeyEnv?: string },
): Promise<string | undefined> {
  return resolveApiKeySync(entry, await readSecretsMap());
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
  return {
    id: entry.id,
    kind: entry.kind,
    name: entry.name,
    baseUrl: entry.baseUrl,
    ...(entry.apiKeyEnv ? { apiKeyEnv: entry.apiKeyEnv } : {}),
    apiKeyConfigured: Boolean(resolveApiKeySync(entry, secretsMap)),
    models: entry.models,
  } as ProviderEntryView;
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
