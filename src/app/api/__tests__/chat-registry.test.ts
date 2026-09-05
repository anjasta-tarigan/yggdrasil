import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@/db/schema";
import { setupFtsAndTriggers } from "@/db/init";
import {
  setProviderConfigPathsForTest,
  saveRegistry,
} from "@/lib/ai/provider-config/store";
import { writeSecretsEnv } from "@/lib/ai/provider-config/secrets";
import type {
  ModelEntry,
  RegistryDocument,
} from "@/lib/ai/provider-config/schema";

// The chat POST touches the real SQLite database (chat row pre-creation,
// stream pointers) — run it against a throwaway in-memory DB so the test
// never mutates the developer's data directory.
let testDb: ReturnType<typeof drizzle>;
let testSqlite: Database.Database;

vi.mock("@/db", () => ({
  get db() {
    return testDb;
  },
  get defaultDb() {
    return testDb;
  },
  get sqlite() {
    return testSqlite;
  },
}));

import { POST } from "@/app/api/chat/route";

/** Seed document: one server provider with m1 (default) + poolside ids. */
function seedDoc(): RegistryDocument {
  const caps = () =>
    ({
      contextWindow: null,
      maxOutputTokens: null,
      inputModalities: ["text"],
      outputModalities: ["text"],
      supportsToolCalls: null,
      supportsReasoning: null,
    }) as ModelEntry["capabilities"];
  const model = (modelId: string, isDefault: boolean): ModelEntry => ({
    modelId,
    displayName: modelId,
    isDefault,
    capabilities: caps(),
    capabilitySources: {},
  });
  return {
    version: 1,
    providers: [
      {
        id: "server",
        kind: "openai-compatible",
        name: "This server",
        baseUrl: "http://registry-test.local/v1",
        apiKeyEnv: "PROVIDER_SERVER_API_KEY",
        models: [model("m1", true), model("ps/poolside/laguna-s-2.1", false)],
      },
      {
        id: "p2",
        kind: "ollama",
        name: "Ollama Local",
        baseUrl: "http://localhost:11434",
        models: [model("m2", false)],
      },
    ],
    embedding: undefined,
  };
}

describe("POST /api/chat (registry-backed)", () => {
  let dataDir: string;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    setupFtsAndTriggers(sqlite);
    testSqlite = sqlite;
    testDb = drizzle(sqlite, { schema });

    dataDir = await mkdtemp(join(tmpdir(), "ygg-chat-"));
    setProviderConfigPathsForTest(dataDir);
    await saveRegistry(seedDoc());
    await writeSecretsEnv(
      new Map([["PROVIDER_SERVER_API_KEY", "sk-chat-registry-test"]])
    );

    // The registry holds an unreachable baseUrl; a hanging or erroring
    // upstream fetch is fine — resolution happens before any network I/O
    // and the assertions only pin the resolution outcome (400 vs 500),
    // never a successful stream.
    fetchMock = vi.fn().mockRejectedValue(new Error("upstream unreachable"));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(dataDir, { recursive: true, force: true });
  });

  const chatReq = (payload: unknown) =>
    new Request("http://test/api/chat", {
      method: "POST",
      body: JSON.stringify(payload),
      headers: { "Content-Type": "application/json" },
    });

  const userMsg = [{ role: "user", parts: [{ type: "text", text: "hi" }] }];

  it("resolves model ref via registry and never echoes a key", async () => {
    const res = await POST(
      chatReq({
        messages: userMsg,
        model: "server::ps/poolside/laguna-s-2.1",
      })
    );
    // Resolution succeeded (registry model), so the request proceeds past
    // validation; no response path may leak the registry's API key.
    expect(res.status).not.toBe(500);
    const text = await res.clone().text();
    expect(text).not.toContain("sk-chat-registry-test");
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "sk-chat-registry-test" })
    );
  });

  it("returns 400 with a named error for a stale model ref", async () => {
    const res = await POST(
      chatReq({ messages: userMsg, model: "server::does-not-exist" })
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/does-not-exist/i);
  });

  it("ignores a client-supplied provider field (no key smuggling)", async () => {
    const res = await POST(
      chatReq({
        messages: userMsg,
        model: "server::m1",
        provider: { baseUrl: "http://evil", apiKey: "stolen" },
      })
    );
    // The evil baseUrl must never be contacted: the route resolves via
    // the registry only (any fetch goes to the registry's baseUrl).
    expect(res.status).not.toBe(500);
    for (const call of fetchMock.mock.calls) {
      const url = String(call[0]);
      expect(url).not.toContain("http://evil");
    }
  });

  it("resolves qualified ref from non-server provider without 400", async () => {
    const res = await POST(
      chatReq({
        messages: userMsg,
        model: "p2::m2",
      })
    );
    // Resolution against provider p2 should succeed and proceed to stream
    // attempt rather than failing with 400 missing model in server provider.
    expect(res.status).not.toBe(400);
    expect(res.status).not.toBe(500);
  });
});
