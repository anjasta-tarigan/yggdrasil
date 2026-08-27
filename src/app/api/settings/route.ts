import { NextResponse } from "next/server";
import { defaultModelId } from "@/lib/ai/provider";
import { chatTools } from "@/lib/ai/tools";
import { countChatsDb } from "@/lib/chat-service";
import { getSettingsDb, setSettingsDb } from "@/lib/settings-service";
import pkg from "../../../../package.json";

/**
 * Settings endpoint.
 *
 * GET returns a read-only snapshot of the server's effective
 * configuration for the Settings page (secrets reduced to flags) plus
 * the mutable settings store (providers, embedding) that the client
 * hydrates from.
 *
 * PUT persists changes to the settings store. Payloads are shape-
 * validated; invalid entries are rejected rather than stored.
 */

const TOOL_KEY_ENV: Record<string, string | undefined> = {
  web_search: "EXA_API_KEY",
  fetch_page: "FIRECRAWL_API_KEY",
};

type SettingsKey = "providers" | "embedding";

type ProviderShape = {
  id: string;
  kind: "openai-compatible" | "ollama";
  name: string;
  baseUrl: string;
  apiKey?: string;
};

function isProviderShape(value: unknown): value is ProviderShape {
  if (typeof value !== "object" || value === null) return false;
  const p = value as Record<string, unknown>;
  return (
    typeof p.id === "string" &&
    p.id.length > 0 &&
    p.id.length <= 128 &&
    typeof p.name === "string" &&
    p.name.length > 0 &&
    p.name.length <= 128 &&
    typeof p.baseUrl === "string" &&
    /^https?:\/\//.test(p.baseUrl) &&
    p.baseUrl.length <= 2048 &&
    (p.kind === "openai-compatible" || p.kind === "ollama") &&
    (p.apiKey === undefined || typeof p.apiKey === "string")
  );
}

function sanitizeProvider(value: unknown): ProviderShape | null {
  if (!isProviderShape(value)) return null;
  return {
    id: value.id,
    kind: value.kind,
    name: value.name,
    baseUrl: value.baseUrl,
    ...(value.kind === "openai-compatible" && value.apiKey !== undefined
      ? { apiKey: value.apiKey }
      : {}),
  };
}

/** Validate and normalize a PUT payload; returns null when invalid. */
function sanitizeSettingsPayload(
  body: unknown
): Record<SettingsKey, unknown> | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return null;
  }
  const payload = body as Record<string, unknown>;
  const result: Partial<Record<SettingsKey, unknown>> = {};

  if (payload.providers !== undefined) {
    if (!Array.isArray(payload.providers) || payload.providers.length > 50) {
      return null;
    }
    const providers: ProviderShape[] = [];
    const seen = new Set<string>();
    for (const entry of payload.providers) {
      const clean = sanitizeProvider(entry);
      if (!clean || seen.has(clean.id)) return null;
      seen.add(clean.id);
      providers.push(clean);
    }
    result.providers = providers;
  }

  if (payload.embedding !== undefined) {
    if (typeof payload.embedding !== "object" || payload.embedding === null) {
      return null;
    }
    const emb = payload.embedding as Record<string, unknown>;
    if (emb.model !== undefined && typeof emb.model !== "string") return null;
    const model =
      typeof emb.model === "string" ? emb.model.trim().slice(0, 200) : "";
    result.embedding = { ...(model ? { model } : {}) };
  }

  // Require at least one known settings key; reject no-op payloads.
  if (Object.keys(result).length === 0) return null;

  return result as Record<SettingsKey, unknown>;
}

export async function GET() {
  const baseUrl = process.env.LLM_BASE_URL ?? null;
  const apiKeyConfigured = Boolean(process.env.LLM_API_KEY);

  const tools = Object.entries(chatTools).map(([name, tool]) => {
    const envKey = TOOL_KEY_ENV[name];
    return {
      name,
      description:
        (tool as { description?: string }).description?.split("\n")[0] ?? "",
      configured: envKey ? Boolean(process.env[envKey]) : true,
      requires: envKey ?? null,
    };
  });

  let chatCount = 0;
  try {
    chatCount = await countChatsDb();
  } catch {
    // Database not initialized yet — report zero rather than failing.
  }

  let store: Record<string, unknown> = {};
  try {
    store = getSettingsDb();
  } catch {
    // Database not initialized yet — report an empty store.
  }

  const storedEmbedding =
    typeof store.embedding === "object" && store.embedding !== null
      ? (store.embedding as Record<string, unknown>)
      : {};

  return NextResponse.json({
    ai: {
      baseUrl,
      modelId: defaultModelId,
      apiKeyConfigured,
    },
    embedding: {
      baseUrl,
      model:
        typeof storedEmbedding.model === "string" && storedEmbedding.model
          ? storedEmbedding.model
          : "text-embedding-3-small",
      apiKeyConfigured,
      fallback: "deterministic-hash-64d",
    },
    database: {
      engine: "SQLite",
      driver: "better-sqlite3 + drizzle-orm",
      features: ["WAL", "FTS5", "sqlite-vec"],
      chatCount,
    },
    tools,
    about: {
      name: "Yggdrasil",
      version: pkg.version,
      stack: "Next.js · AI SDK v7 · shadcn/ui · SQLite",
    },
    store: {
      providers: Array.isArray(store.providers) ? store.providers : [],
      embedding: storedEmbedding,
    },
  });
}

export async function PUT(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const patch = sanitizeSettingsPayload(body);
  if (!patch) {
    return NextResponse.json(
      { error: "Invalid settings payload" },
      { status: 400 }
    );
  }

  try {
    setSettingsDb(patch);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[api/settings] Failed to save settings:", error);
    return NextResponse.json(
      { error: "Failed to save settings" },
      { status: 500 }
    );
  }
}
