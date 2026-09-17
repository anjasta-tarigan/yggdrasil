// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateText, streamText } from "ai";
import { chatModelForEntry } from "@/lib/ai/provider";
import { createRotatingProviderFetch } from "@/lib/ai/provider-fetch";
import type { ProviderEntry } from "@/lib/ai/provider-config/schema";

const responseBody = {
  id: "test", object: "chat.completion", created: 1, model: "test-model",
  choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};

function entry(id: string) {
  vi.stubEnv("PROVIDER_NIM_A_API_KEY", "key-a");
  vi.stubEnv("PROVIDER_NIM_B_API_KEY", "key-b");
  return {
    id, kind: "openai-compatible", preset: "nvidia-nim", name: "NVIDIA NIM",
    baseUrl: "https://integrate.api.nvidia.com/v1", models: [],
    apiKeys: [
      { id: "a", apiKeyEnv: "PROVIDER_NIM_A_API_KEY" },
      { id: "b", apiKeyEnv: "PROVIDER_NIM_B_API_KEY" },
    ],
  } as ProviderEntry;
}

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("NIM request rotation", () => {
  it("injects headers at the fetch boundary for concurrent requests and preserves cancellation", async () => {
    const captured: RequestInit[] = [];
    const transport: typeof fetch = async (_input, init) => {
      captured.push(init!);
      return Response.json(responseBody);
    };
    const rotating = createRotatingProviderFetch(entry("nim-direct"), transport);
    const controller = new AbortController();
    await Promise.all(Array.from({ length: 4 }, () => rotating(
      "https://integrate.api.nvidia.com/v1/chat/completions",
      { method: "POST", headers: { "x-test": "kept", authorization: "stale" }, body: "{}", signal: controller.signal },
    )));
    expect(captured.map(init => new Headers(init.headers).get("authorization"))).toEqual([
      "Bearer key-a", "Bearer key-b", "Bearer key-a", "Bearer key-b",
    ]);
    expect(captured.every(init => init.signal === controller.signal && init.redirect === "error" && new Headers(init.headers).get("x-test") === "kept")).toBe(true);
    controller.abort();
    await expect(rotating("https://integrate.api.nvidia.com/v1/chat/completions", { signal: controller.signal })).rejects.toThrow();
    await expect(rotating("https://other.example/v1/chat/completions")).rejects.toThrow(/outside/);
    expect(captured).toHaveLength(4);
  });
  it("shares rotation across model instances without changing the endpoint or body", async () => {
    const requests: { url: string; authorization: string | null; body: unknown }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      requests.push({ url: String(url), authorization: new Headers(init.headers).get("authorization"), body: JSON.parse(init.body as string) });
      return Response.json(responseBody);
    });
    const provider = entry("nim-shared");
    const first = chatModelForEntry("test-model", provider);
    const second = chatModelForEntry("test-model", provider);
    for (const model of [first, second, first]) {
      expect((await generateText({ model, prompt: "hi", maxRetries: 0 })).text).toBe("hello");
    }
    expect(requests.map(r => r.authorization)).toEqual(["Bearer key-a", "Bearer key-b", "Bearer key-a"]);
    expect(requests.every(r => r.url === "https://integrate.api.nvidia.com/v1/chat/completions")).toBe(true);
    expect(requests[0].body).toMatchObject({ model: "test-model", messages: [{ role: "user", content: "hi" }] });
  });

  it("advances on SDK retries without adding a second retry loop", async () => {
    const keys: (string | null)[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      keys.push(new Headers(init.headers).get("authorization"));
      return keys.length === 1
        ? Response.json({ error: { message: "busy", type: "rate_limit" } }, { status: 429, headers: { "retry-after": "0" } })
        : Response.json(responseBody);
    });
    const result = await generateText({ model: chatModelForEntry("test-model", entry("nim-retry")), prompt: "hi", maxRetries: 1 });
    expect(result.text).toBe("hello");
    expect(keys).toEqual(["Bearer key-a", "Bearer key-b"]);
  });

  it("does not buffer streaming responses and rotates between streams", async () => {
    const keys: (string | null)[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      keys.push(new Headers(init.headers).get("authorization"));
      expect(JSON.parse(init.body as string).stream).toBe(true);
      const chunk = { id: "test", created: 1, model: "test-model", choices: [{ index: 0, delta: { content: "hello" }, finish_reason: "stop" }] };
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
    });
    const model = chatModelForEntry("test-model", entry("nim-stream"));
    for (let i = 0; i < 2; i++) {
      const result = streamText({ model, prompt: "hi", maxRetries: 0 });
      expect(await result.text).toBe("hello");
    }
    expect(keys).toEqual(["Bearer key-a", "Bearer key-b"]);
  });
});
