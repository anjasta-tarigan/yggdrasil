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
import type { ModelEntry, RegistryDocument } from "@/lib/ai/provider-config/schema";
import {
  applyCompactionSafetyMargin,
  compactForModelSend,
} from "@/lib/ai/context-budget";
import { processIncomingMessageAttachments } from "@/lib/ai/attachments";
import { convertToModelMessages, type UIMessage } from "ai";

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
  const caps = (contextWindow: number | null = null) =>
    ({
      contextWindow,
      maxOutputTokens: null,
      inputModalities: ["text"],
      outputModalities: ["text"],
      supportsToolCalls: null,
      supportsReasoning: null,
    }) as ModelEntry["capabilities"];
  const model = (
    modelId: string,
    isDefault: boolean,
    contextWindow: number | null = null
  ): ModelEntry => ({
    modelId,
    displayName: modelId,
    isDefault,
    capabilities: caps(contextWindow),
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
        models: [
          model("m1", true),
          model("ps/poolside/laguna-s-2.1", false, 400_000),
        ],
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

  it("returns 400 naming provider and env var when the API key is not set (spec §6)", async () => {
    // Remove the stored secret: provider has apiKeyEnv but no value.
    await writeSecretsEnv(new Map());
    const res = await POST(
      chatReq({ messages: userMsg, model: "server::m1" })
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toBe(
      "API key not set for This server (PROVIDER_SERVER_API_KEY)",
    );
  });

  it("does not require a key for ollama providers", async () => {
    const res = await POST(
      chatReq({ messages: userMsg, model: "p2::m2" })
    );
    // Ollama has no apiKeyEnv — resolution proceeds past the key check.
    expect(res.status).not.toBe(400);
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

  it("computes dynamic context budget from model capabilities and avoids premature truncation for large models", async () => {
    // Model has 400,000 contextWindow
    const longMessages: UIMessage[] = [];
    for (let i = 0; i < 30; i++) {
      longMessages.push({
        id: `u-${i}`,
        role: "user",
        parts: [{ type: "text", text: `User query ${i} `.repeat(50) }],
      });
      longMessages.push({
        id: `a-${i}`,
        role: "assistant",
        parts: [{ type: "text", text: `Assistant reply ${i} `.repeat(50) }],
      });
    }

    const res = await POST(
      chatReq({
        messages: longMessages,
        model: "server::ps/poolside/laguna-s-2.1", // 400k context
      })
    );
    expect(res.status).not.toBe(500);
    // Consume the stream so that streamText executes the upstream request
    await res.text();

    // In the old implementation with fixed 24k budget, 60 long messages would be truncated and a context note injected.
    // With 400k context window, none of the 60 messages should be truncated.
    const calls = fetchMock.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    // Find the chat completions call (other calls like embeddings may precede it)
    const chatCall = calls.find((c) => {
      try {
        const parsed = JSON.parse(String(c[1]?.body));
        return Array.isArray(parsed?.messages);
      } catch {
        return false;
      }
    });
    expect(chatCall).toBeDefined();
    const body = JSON.parse(String(chatCall![1]?.body));
    const nonSystemMessages = body.messages.filter(
      (m: { role: string }) => m.role !== "system"
    );
    // The prompt sent upstream should not contain truncation notices or conversation summary rollups
    const firstPromptContent = JSON.stringify(nonSystemMessages[0]);
    expect(firstPromptContent).not.toContain("[Context note:");
    expect(firstPromptContent).not.toContain("[Conversation Summary:");
    // All 60 conversation messages should be preserved
    expect(nonSystemMessages.length).toBe(60);
  });

  it("re-guards client-precompacted modelContextMessages to zero drops (anti-thrash contract)", async () => {
    // Transcript far over any budget m1's 24k fallback window can compute
    // (roughly 10.8k-21k tokens): 60 messages at ~850 tokens each.
    const transcript: UIMessage[] = [];
    for (let i = 0; i < 30; i++) {
      transcript.push({
        id: `u-${i}`,
        role: "user",
        parts: [{ type: "text", text: `User query ${i} `.repeat(250) }],
      });
      transcript.push({
        id: `a-${i}`,
        role: "assistant",
        parts: [{ type: "text", text: `Assistant reply ${i} `.repeat(250) }],
      });
    }

    // Parse a fetch call into a chat-completions body (null for anything
    // else, e.g. embedding-shaped requests), so background queue noise
    // can never be mistaken for the chat prompt.
    const chatBodyAt = (call: unknown): { messages: { role: string }[] } | null => {
      try {
        const parsed = JSON.parse(
        String(((call as unknown[])[1] as { body?: unknown } | undefined)?.body)
      );
        return Array.isArray(parsed?.messages) ? parsed : null;
      } catch {
        return null;
      }
    };

    // ── Turn 1: legacy client (no modelContextMessages). The guard runs on
    // the full transcript and reports its budget + drops via the headers.
    const beforeTurn1 = fetchMock.mock.calls.length;
    const res1 = await POST(chatReq({ messages: transcript, model: "server::m1" }));
    expect(res1.status).toBe(200);
    const budget = Number(res1.headers.get("x-context-budget"));
    expect(Number.isFinite(budget)).toBe(true);
    expect(budget).toBeGreaterThan(0);
    expect(Number(res1.headers.get("x-context-dropped"))).toBeGreaterThan(0);
    await res1.text(); // consume so the upstream request actually fires
    const turn1Body = fetchMock.mock.calls
      .slice(beforeTurn1)
      .map(chatBodyAt)
      .find((b): b is { messages: { role: string }[] } => b !== null);
    expect(turn1Body).toBeDefined();
    const turn1NonSystem = turn1Body!.messages.filter((m) => m.role !== "system");
    // The legacy path had to compact: fewer than 60 messages survived and
    // the server injected its own summary block.
    expect(turn1NonSystem.length).toBeLessThan(60);
    expect(JSON.stringify(turn1NonSystem[0])).toContain("[Conversation Summary:");

    // ── Turn 2: the client mirrors ChatArea's transport — re-compact the
    // FULL transcript to the server-reported budget (with safety margin)
    // and send it as modelContextMessages alongside the full messages.
    const processed = await processIncomingMessageAttachments(transcript);
    const { messages: modelContextMessages, droppedCount: clientDropped } =
      compactForModelSend(processed, applyCompactionSafetyMargin(budget));
    expect(clientDropped).toBeGreaterThan(0); // transcript really overflowed

    const afterTurn1 = fetchMock.mock.calls.length;
    const res2 = await POST(
      chatReq({
        messages: transcript,
        modelContextMessages,
        model: "server::m1",
      })
    );
    expect(res2.status).toBe(200);
    // Anti-thrash contract: the server re-guard on the client's bounded
    // list drops nothing — the "[chat/route] Context guard compacted..."
    // log stays silent instead of re-compacting on every turn.
    expect(res2.headers.get("x-context-dropped")).toBe("0");
    expect(Number(res2.headers.get("x-context-budget"))).toBeGreaterThan(0);
    await res2.text();
    const turn2Body = fetchMock.mock.calls
      .slice(afterTurn1)
      .map(chatBodyAt)
      .find((b): b is { messages: { role: string }[] } => b !== null);
    expect(turn2Body).toBeDefined();
    const turn2NonSystem = turn2Body!.messages.filter((m) => m.role !== "system");
    // The upstream prompt is the client's bounded list — not a re-compaction
    // of the 60-message transcript: same message count the client computed.
    const expected = await convertToModelMessages(modelContextMessages);
    expect(turn2NonSystem.length).toBe(
      expected.filter((m) => m.role !== "system").length
    );
    expect(turn2NonSystem.length).toBeLessThan(60);
    // The client's summary survived exactly once — no second summarization.
    expect(
      turn2NonSystem.filter((m) =>
        JSON.stringify(m).includes("[Conversation Summary:")
      ).length
    ).toBe(1);
  });
});
