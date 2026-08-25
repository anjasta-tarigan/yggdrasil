import { NextResponse } from "next/server";
import { defaultModelId } from "@/lib/ai/provider";
import { chatTools } from "@/lib/ai/tools";
import { listChatsDb } from "@/lib/chat-service";
import pkg from "../../../../package.json";

/**
 * Read-only snapshot of the server's effective configuration for the
 * Settings page. Secrets are reduced to a configured/not-configured flag;
 * nothing sensitive is ever returned.
 */

const TOOL_KEY_ENV: Record<string, string | undefined> = {
  web_search: "EXA_API_KEY",
  fetch_page: "FIRECRAWL_API_KEY",
};

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
    chatCount = (await listChatsDb()).length;
  } catch {
    // Database not initialized yet — report zero rather than failing.
  }

  return NextResponse.json({
    ai: {
      baseUrl,
      modelId: defaultModelId,
      apiKeyConfigured,
    },
    embedding: {
      baseUrl,
      model: "text-embedding-3-small",
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
  });
}
