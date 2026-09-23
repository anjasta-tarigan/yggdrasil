// @vitest-environment node
/**
 * Contract tests for the web-session language model. The frame payloads are
 * synthetic and intentionally unverified; the protocol spike must confirm the
 * provider grammar before enablement (Spec §13.1). These tests bind only the
 * adapter/model boundary: JSON delta frames become SDK v4 text parts, while
 * malformed frames and classified upstream failures remain typed errors.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  AdapterRequestError,
  DEEPSEEK_WEB_ENDPOINTS,
  DEEPSEEK_WEB_ORIGIN,
} from "../deepseek";
import {
  WebProviderGenerationUnavailableError,
  createWebProviderModel,
} from "../language-model";
import { clearLogs, queryLogs } from "@/lib/observability/log-store";
import type { ProviderEntry } from "@/lib/ai/provider-config/schema";
import type { WebProviderSession } from "../types";

const CHAT_URL = `${DEEPSEEK_WEB_ORIGIN}${DEEPSEEK_WEB_ENDPOINTS.chat}`;

const webSessionEntry: ProviderEntry = {
  id: "deepseek-web",
  kind: "web-session",
  name: "DeepSeek Web",
  baseUrl: "https://chat.deepseek.com",
  models: [],
};

const verifiedSession: WebProviderSession = {
  id: "wps-1",
  providerId: "deepseek-web",
  userToken: "secret-session-token",
  status: "verified",
  lastCheckedAt: null,
  lastFailureCode: null,
  userAgentMode: "browser",
  capturedAt: null,
  sessionVersion: 1,
};

function sseResponse(frames: string[], status = 200): Response {
  return new Response(frames.join(""), {
    status,
    headers: { "content-type": "text/event-stream" },
  });
}

function model(session: WebProviderSession | null = verifiedSession) {
  return createWebProviderModel(webSessionEntry, "deepseek-chat", session);
}

describe("WebProviderLanguageModel", () => {
  beforeEach(() => clearLogs());

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("declares the v4 specification and empty supportedUrls", () => {
    const instance = model();

    expect(instance.specificationVersion).toBe("v4");
    expect(instance.provider).toBe("deepseek-web");
    expect(instance.modelId).toBe("deepseek-chat");
    expect(instance.supportedUrls).toEqual({});
    expect(instance.session).toBe(verifiedSession);
  });

  it("converts synthetic JSON delta frames to AI SDK v4 parts", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      sseResponse([
        // Synthetic, unverified frame grammar: only the contract is asserted.
        'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
        "data: [DONE]\n\n",
      ])
    );

    const result = (await model().doStream({ prompt: [] })) as {
      stream: ReadableStream<Record<string, unknown>>;
    };
    const parts: Record<string, unknown>[] = [];
    const reader = result.stream.getReader();
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        parts.push(next.value);
      }
    } finally {
      reader.releaseLock();
    }

    expect(parts.map((part) => part.type)).toEqual([
      "stream-start",
      "text-start",
      "text-delta",
      "text-delta",
      "text-end",
      "finish",
    ]);
    expect(parts.filter((part) => part.type === "text-delta")).toEqual([
      { type: "text-delta", id: "web-text-1", delta: "Hello" },
      { type: "text-delta", id: "web-text-1", delta: " world" },
    ]);
    expect(JSON.stringify(parts)).not.toContain(verifiedSession.userToken);
  });

  it("surfaces a malformed frame as a typed protocol error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      sseResponse(["data: { not-json\n\n"])
    );

    const result = (await model().doStream({ prompt: [] })) as {
      stream: ReadableStream<Record<string, unknown>>;
    };
    const reader = result.stream.getReader();
    const outcome = await (async () => {
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) return undefined;
        }
      } catch (error) {
        return error;
      } finally {
        reader.releaseLock();
      }
    })();

    expect(outcome).toBeInstanceOf(AdapterRequestError);
    expect((outcome as AdapterRequestError).failure.code).toBe("protocol_error");
  });

  it("surfaces a classified 401 failure and does not log the session token", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      sseResponse([], 401)
    );

    const outcome = await model().doStream({ prompt: [] }).catch((error) => error);

    expect(outcome).toBeInstanceOf(AdapterRequestError);
    expect((outcome as AdapterRequestError).failure.code).toBe("session_rejected");
    expect(JSON.stringify(queryLogs({}))).not.toContain(verifiedSession.userToken);
    expect(JSON.stringify(outcome)).not.toContain(verifiedSession.userToken);
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(CHAT_URL, expect.any(Object));
  });

  it("keeps the null-session seam typed instead of attempting a request", async () => {
    await expect(model(null).doStream({})).rejects.toBeInstanceOf(
      WebProviderGenerationUnavailableError
    );
  });
});
