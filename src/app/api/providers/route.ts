import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { ensureMigrated } from "@/lib/ai/provider-config/migrate";
import {
  deriveEnvName,
  readSecretsMap,
  writeSecretsEnv,
} from "@/lib/ai/provider-config/secrets";
import {
  getRegistryView,
  ProviderConfigError,
  saveRegistry,
} from "@/lib/ai/provider-config/store";
import {
  RegistryDocumentSchema,
  type RegistryDocument,
} from "@/lib/ai/provider-config/schema";

/**
 * Provider registry API.
 *
 * The registry files (`data/providers.json` + `data/providers.secrets.env`)
 * are the SSOT for user-added AI providers; this route is its CRUD surface.
 *
 * - GET  → redacted view (`apiKeyConfigured` flags, never key values).
 * - PUT  → full-document replace (the body IS the next RegistryDocument).
 *
 * Write-only key handling on PUT:
 * - `apiKey: "<non-empty>"`  → stored in the secrets file under the entry's
 *   env name (existing `apiKeyEnv`, else `deriveEnvName(id)`) and stripped
 *   from the document, which keeps only the `apiKeyEnv` pointer.
 * - `apiKey: ""` / absent     → the stored secret is left untouched.
 * - `clearApiKey: true`      → the secrets-file entry is deleted.
 *
 * Responses never contain key values: the view is redacted by construction
 * and error messages carry paths/issues, not inputs.
 */

export const dynamic = "force-dynamic";

/** Local 400 signal for malformed PUT bodies (before Zod sees them). */
class BodyValidationError extends Error {}

/** One provider's key intent, extracted from the PUT body. */
type KeyAction = {
  /** Secrets-file env name to write/delete (derived when absent). */
  envName?: string;
  /** Non-empty key value to store; absent leaves the stored secret alone. */
  setKey?: string;
  /** Delete the stored secret (applied before `setKey`, so set wins). */
  clear: boolean;
};

/**
 * Split the write-only key fields off the PUT body and build the document
 * to persist. Unknown provider-level fields (e.g. the redacted view's
 * `apiKeyConfigured`) are left for Zod to strip; unknown top-level fields
 * are rejected by the strict document schema.
 */
function prepareBody(body: unknown): {
  doc: RegistryDocument;
  actions: KeyAction[];
} {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new BodyValidationError("Body must be a JSON object");
  }
  const raw = body as Record<string, unknown>;
  if (!Array.isArray(raw.providers)) {
    throw new BodyValidationError("`providers` must be an array");
  }

  const actions: KeyAction[] = [];
  const providers: Array<Record<string, unknown>> = [];

  for (const entry of raw.providers) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new BodyValidationError("every provider must be an object");
    }
    const provider = { ...(entry as Record<string, unknown>) };
    const { apiKey, clearApiKey } = provider;
    delete provider.apiKey;
    delete provider.clearApiKey;

    if (apiKey !== undefined && typeof apiKey !== "string") {
      throw new BodyValidationError("`provider.apiKey` must be a string");
    }
    if (clearApiKey !== undefined && typeof clearApiKey !== "boolean") {
      throw new BodyValidationError("`provider.clearApiKey` must be a boolean");
    }

    const wantsWrite = (apiKey !== undefined && apiKey !== "") || clearApiKey === true;
    let envName: string | undefined =
      typeof provider.apiKeyEnv === "string" && provider.apiKeyEnv !== ""
        ? provider.apiKeyEnv
        : undefined;
    if (wantsWrite && envName === undefined) {
      // No pointer yet: derive one so the stored key is reachable.
      if (typeof provider.id !== "string" || provider.id === "") {
        throw new BodyValidationError(
          "`provider.id` is required to derive the key's env name",
        );
      }
      envName = deriveEnvName(provider.id);
      provider.apiKeyEnv = envName;
    }

    if (wantsWrite) {
      actions.push({
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

  return { doc, actions };
}

/** Format the first Zod issue without echoing any input values. */
function zodMessage(error: ZodError): string {
  const issue = error.issues[0];
  const path = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
  return `Invalid provider registry: ${path}${issue.message}`;
}

export async function GET() {
  try {
    // First load after a legacy (env / SQLite) deployment seeds the registry.
    await ensureMigrated();
    return NextResponse.json(await getRegistryView());
  } catch (error) {
    if (error instanceof ProviderConfigError) {
      // Message names the file and what is wrong with it — never a value.
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    console.error("[api/providers] GET failed:", error);
    return NextResponse.json(
      { error: "Failed to load provider registry" },
      { status: 500 },
    );
  }
}

export async function PUT(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  let prepared: { doc: RegistryDocument; actions: KeyAction[] };
  try {
    prepared = prepareBody(body);
  } catch (error) {
    if (error instanceof BodyValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error("[api/providers] PUT failed to read body:", error);
    return NextResponse.json(
      { error: "Failed to save provider registry" },
      { status: 500 },
    );
  }

  try {
    // Validate the FULL candidate document BEFORE any write, so a rejected
    // PUT mutates neither the registry nor the secrets file. The candidate
    // mirrors saveRegistry's defensive isDefault demotion (the strict
    // schema rejects >1 default; saveRegistry demotes before parsing), so
    // this accepts exactly the document saveRegistry will persist.
    const candidate = structuredClone(prepared.doc);
    const flagged = candidate.providers.flatMap((provider) =>
      provider.models.filter((model) => model.isDefault),
    );
    for (const model of flagged.slice(0, -1)) {
      model.isDefault = false;
    }
    const result = RegistryDocumentSchema.safeParse(candidate);
    if (!result.success) {
      return NextResponse.json(
        { error: zodMessage(result.error) },
        { status: 400 },
      );
    }

    // Persist the registry first, then the secrets: a schema-rejected PUT
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

    return NextResponse.json(await getRegistryView());
  } catch (error) {
    if (error instanceof ZodError) {
      return NextResponse.json({ error: zodMessage(error) }, { status: 400 });
    }
    if (error instanceof ProviderConfigError) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    console.error("[api/providers] PUT failed:", error);
    return NextResponse.json(
      { error: "Failed to save provider registry" },
      { status: 500 },
    );
  }
}
