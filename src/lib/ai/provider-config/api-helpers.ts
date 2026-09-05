import { ZodError } from "zod";
import { loadRegistry, ProviderConfigError, saveRegistry } from "./store";
import { deriveEnvName, readSecretsMap, writeSecretsEnv } from "./secrets";
import { RegistryDocumentSchema, type RegistryDocument } from "./schema";

if (typeof window !== "undefined" && process.env.NODE_ENV !== "test") {
  throw new Error("provider-config store is server-only");
}

/**
 * Registry-patch failure the API routes map onto a JSON error response.
 * Carries only a status and a value-free message (paths/issues, never
 * key values).
 */
export class RegistryPatchError extends Error {
  /** HTTP status the route should return for this failure. */
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "RegistryPatchError";
    this.status = status;
  }
}

/** One provider's key intent, extracted from the patch body. */
type KeyAction = {
  /** Secrets-file env name to write/delete (derived when absent). */
  envName?: string;
  /** Non-empty key value to store; absent leaves the stored secret alone. */
  setKey?: string;
  /** Delete the stored secret (applied before `setKey`, so set wins). */
  clear: boolean;
};

/** Fixed env name for the standalone embedding endpoint's key. */
const EMBEDDING_API_KEY_ENV = "PROVIDER_EMBEDDING_API_KEY";

/**
 * Split the write-only key fields off the patch body and build the
 * document to persist. Unknown provider-level fields (e.g. the redacted
 * view's `apiKeyConfigured`) are left for Zod to strip; unknown top-level
 * fields are rejected by the strict document schema.
 */
function prepareBody(body: unknown): {
  doc: RegistryDocument;
  actions: KeyAction[];
} {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new RegistryPatchError("Body must be a JSON object", 400);
  }
  const raw = body as Record<string, unknown>;
  if (!Array.isArray(raw.providers)) {
    throw new RegistryPatchError("`providers` must be an array", 400);
  }

  // Standalone embedding block: write-only key handling, same contract as
  // provider keys — non-empty apiKey stores it, empty/absent leaves the
  // stored secret alone, clearApiKey removes it. The block keeps only the
  // apiKeyEnv pointer; the value goes to the secrets file.
  let embeddingAction: KeyAction | null = null;
  let embedding = raw.embedding;
  if (
    embedding !== null &&
    typeof embedding === "object" &&
    !Array.isArray(embedding)
  ) {
    const block = { ...(embedding as Record<string, unknown>) };
    const { apiKey, clearApiKey } = block;
    delete block.apiKey;
    delete block.clearApiKey;

    if (apiKey !== undefined && typeof apiKey !== "string") {
      throw new RegistryPatchError("`embedding.apiKey` must be a string", 400);
    }
    if (clearApiKey !== undefined && typeof clearApiKey !== "boolean") {
      throw new RegistryPatchError(
        "`embedding.clearApiKey` must be a boolean",
        400,
      );
    }

    const wantsWrite = (apiKey !== undefined && apiKey !== "") || clearApiKey === true;
    if (wantsWrite) {
      block.apiKeyEnv = EMBEDDING_API_KEY_ENV;
      embeddingAction = {
        envName: EMBEDDING_API_KEY_ENV,
        ...(apiKey !== undefined && apiKey !== "" ? { setKey: apiKey } : {}),
        clear: clearApiKey === true,
      };
    }
    embedding = block;
  }

  const providerActions: KeyAction[] = [];
  const providers: Array<Record<string, unknown>> = [];

  for (const entry of raw.providers) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new RegistryPatchError("every provider must be an object", 400);
    }
    const provider = { ...(entry as Record<string, unknown>) };
    const { apiKey, clearApiKey } = provider;
    delete provider.apiKey;
    delete provider.clearApiKey;

    if (apiKey !== undefined && typeof apiKey !== "string") {
      throw new RegistryPatchError("`provider.apiKey` must be a string", 400);
    }
    if (clearApiKey !== undefined && typeof clearApiKey !== "boolean") {
      throw new RegistryPatchError(
        "`provider.clearApiKey` must be a boolean",
        400,
      );
    }

    const wantsWrite = (apiKey !== undefined && apiKey !== "") || clearApiKey === true;
    let envName: string | undefined =
      typeof provider.apiKeyEnv === "string" && provider.apiKeyEnv !== ""
        ? provider.apiKeyEnv
        : undefined;
    if (wantsWrite && envName === undefined) {
      // No pointer yet: derive one so the stored key is reachable.
      if (typeof provider.id !== "string" || provider.id === "") {
        throw new RegistryPatchError(
          "`provider.id` is required to derive the key's env name",
          400,
        );
      }
      envName = deriveEnvName(provider.id);
      provider.apiKeyEnv = envName;
    }

    if (wantsWrite) {
      providerActions.push({
        envName,
        ...(apiKey !== undefined && apiKey !== "" ? { setKey: apiKey } : {}),
        clear: clearApiKey === true,
      });
    }
    providers.push(provider);
  }

  // Preserve the original top-level shape: unknown document-level keys flow
  // through so the strict schema rejects them, while provider-level extras
  // (the redacted view's `apiKeyConfigured`, …) are Zod-stripped.
  const doc = { ...raw, providers } as RegistryDocument;
  if (embedding !== undefined) {
    (doc as Record<string, unknown>).embedding = embedding;
  }

  const actions = embeddingAction ? [...providerActions, embeddingAction] : providerActions;
  return { doc, actions };
}

/** Format the first Zod issue without echoing any input values. */
function zodMessage(error: ZodError): string {
  const issue = error.issues[0];
  const path = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
  return `Invalid provider registry: ${path}${issue.message}`;
}

/**
 * Apply a full-document registry patch (the body IS the next
 * RegistryDocument) — shared by the registry API routes.
 *
 * Write-only key handling:
 * - `apiKey: "<non-empty>"`  → stored in the secrets file under the entry's
 *   env name (existing `apiKeyEnv`, else `deriveEnvName(id)`) and stripped
 *   from the document, which keeps only the `apiKeyEnv` pointer.
 * - `apiKey: ""` / absent     → the stored secret is left untouched.
 * - `clearApiKey: true`      → the secrets-file entry is deleted.
 *
 * A rejected patch mutates neither the registry nor the secrets file: the
 * full candidate document is validated before any write.
 */
export async function applyRegistryPatch(
  body: { providers?: unknown; embedding?: unknown },
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  let prepared: { doc: RegistryDocument; actions: KeyAction[] };
  try {
    prepared = prepareBody(body);
  } catch (error) {
    if (error instanceof RegistryPatchError) {
      return { ok: false, status: error.status, error: error.message };
    }
    console.error("[api/providers] PUT failed to read body:", error);
    return {
      ok: false,
      status: 500,
      error: "Failed to save provider registry",
    };
  }

  try {
    // Embedding carry-fix: a patch may submit `embedding.providerId: null`
    // alongside the base URL (the caller only knows the URL). If the
    // CURRENT registry already holds a provider on exactly that baseUrl,
    // mirror its id into the candidate so the block survives the
    // round-trip instead of dropping the configured embedding provider.
    const embedding = body.embedding;
    if (
      embedding !== null &&
      typeof embedding === "object" &&
      !Array.isArray(embedding) &&
      ((embedding as Record<string, unknown>).providerId === null ||
        (embedding as Record<string, unknown>).providerId === undefined) &&
      typeof (embedding as Record<string, unknown>).baseUrl === "string"
    ) {
      const baseUrl = (embedding as Record<string, unknown>).baseUrl;
      let current: RegistryDocument;
      try {
        current = await loadRegistry();
      } catch (error) {
        const enoent =
          (error as { cause?: { code?: string } })?.cause?.code === "ENOENT";
        if (
          error instanceof ProviderConfigError &&
          (enoent || error.message.includes("not initialized"))
        ) {
          // First write before any GET ran migration: nothing to carry.
          current = { version: 1, providers: [] };
        } else {
          throw error;
        }
      }
      const match = current.providers.find((p) => p.baseUrl === baseUrl);
      if (match) {
        prepared.doc.embedding = {
          ...(embedding as Record<string, unknown>),
          providerId: match.id,
        } as RegistryDocument["embedding"];
      }
    }

    // Validate the FULL candidate document BEFORE any write, so a rejected
    // patch mutates neither the registry nor the secrets file. The candidate
    // mirrors saveRegistry's defensive isDefault demotion (the strict
    // schema rejects >1 default; saveRegistry demotes before parsing), so
    // this accepts exactly the document saveRegistry will persist.
    const candidate = structuredClone(prepared.doc);
    // `models` is optional pre-parse (Zod defaults it to []): a models-less
    // wire entry arrives with `models === undefined`, so the demotion walk
    // must treat missing as empty — same guard as saveRegistry's demotion.
    const flagged = candidate.providers.flatMap((provider) =>
      (provider.models ?? []).filter((model) => model.isDefault),
    );
    for (const model of flagged.slice(0, -1)) {
      model.isDefault = false;
    }
    const result = RegistryDocumentSchema.safeParse(candidate);
    if (!result.success) {
      return { ok: false, status: 400, error: zodMessage(result.error) };
    }

    // Persist the registry first, then the secrets: a schema-rejected patch
    // (400) now leaves both files untouched, and live credentials are only
    // replaced once the document referencing them is safely on disk.
    await saveRegistry(candidate);

    // Apply key intents to the secrets map.
    const secrets = await readSecretsMap();
    let dirty = false;
    for (const action of prepared.actions) {
      if (action.envName === undefined) continue;
      if (action.clear && secrets.delete(action.envName)) dirty = true;
      if (action.setKey !== undefined) {
        secrets.set(action.envName, action.setKey);
        dirty = true;
      }
    }
    if (dirty) {
      await writeSecretsEnv(secrets);
    }

    return { ok: true };
  } catch (error) {
    if (error instanceof ZodError) {
      return { ok: false, status: 400, error: zodMessage(error) };
    }
    if (error instanceof ProviderConfigError) {
      return { ok: false, status: 500, error: error.message };
    }
    console.error("[api/providers] PUT failed:", error);
    return {
      ok: false,
      status: 500,
      error: "Failed to save provider registry",
    };
  }
}
