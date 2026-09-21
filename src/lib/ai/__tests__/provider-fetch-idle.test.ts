// @vitest-environment node
/**
 * The transport-level dead-socket guard.
 *
 * Why it lives here and not in `HARNESS_TIMEOUT.chunkMs`: the SDK's chunk
 * watchdog is armed on the *step* signal, not the socket, and it is reset only
 * by output chunks — `tool-result` is not one (ai/dist/index.js isOutputChunk2).
 * So it aborts a step whose model streams nothing for N seconds, and it also
 * keeps counting while a tool runs. Measured in production: a 154s model call
 * with no deltas, then an abort exactly 300s after the next call started.
 *
 * A guard at the fetch boundary measures the right thing — bytes arriving from
 * the provider — so a dead socket is detected while a slow-but-alive model and
 * a long-running tool are both left alone.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRotatingProviderFetch } from "@/lib/ai/provider-fetch";
import type { ProviderEntry } from "@/lib/ai/provider-config/schema";

function entry(): ProviderEntry {
  vi.stubEnv("PROVIDER_IDLE_KEY", "k");
  return {
    id: "idle-test",
    kind: "openai-compatible",
    name: "Idle Test",
    baseUrl: "https://idle.example/v1",
    models: [],
    apiKeys: [{ id: "a", apiKeyEnv: "PROVIDER_IDLE_KEY" }],
  } as ProviderEntry;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

/** A body that emits one chunk, then stalls forever. */
function stallingBody(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("data: first\n\n"));
      // Never enqueue again and never close: a dead socket.
    },
  });
}

describe("provider transport idle guard", () => {
  it("aborts the body when the provider goes silent past the idle window", async () => {
    const transport: typeof fetch = async () =>
      new Response(stallingBody(), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });

    const guarded = createRotatingProviderFetch(entry(), transport, {
      idleMs: 50,
    });
    const res = await guarded("https://idle.example/v1/chat/completions", {
      method: "POST",
    });

    const reader = res.body!.getReader();
    // The first chunk must arrive normally — the guard must not delay traffic.
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe("data: first\n\n");

    // Then silence must surface as an error, not an infinite hang.
    await expect(reader.read()).rejects.toThrow(/idle|stall|silent/i);
  });

  it("leaves a steadily-streaming body untouched", async () => {
    const transport: typeof fetch = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            const enc = new TextEncoder();
            for (const s of ["a", "b", "c"]) {
              controller.enqueue(enc.encode(s));
              await new Promise((r) => setTimeout(r, 5));
            }
            controller.close();
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } }
      );

    const guarded = createRotatingProviderFetch(entry(), transport, {
      idleMs: 500,
    });
    const res = await guarded("https://idle.example/v1/chat/completions", {
      method: "POST",
    });

    const reader = res.body!.getReader();
    const chunks: string[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(new TextDecoder().decode(value));
    }
    expect(chunks.join("")).toBe("abc");
  });

  it("does not arm the guard for non-streaming responses", async () => {
    const transport: typeof fetch = async () =>
      Response.json({ ok: true }, { headers: { "content-type": "application/json" } });

    const guarded = createRotatingProviderFetch(entry(), transport, {
      idleMs: 50,
    });
    const res = await guarded("https://idle.example/v1/chat/completions", {
      method: "POST",
    });
    await expect(res.json()).resolves.toEqual({ ok: true });
  });

  it("honours caller cancellation (does not mask an AbortSignal)", async () => {
    const transport: typeof fetch = async () =>
      new Response(stallingBody(), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });

    const guarded = createRotatingProviderFetch(entry(), transport, {
      idleMs: 10_000,
    });
    const controller = new AbortController();
    const res = await guarded("https://idle.example/v1/chat/completions", {
      method: "POST",
      signal: controller.signal,
    });
    const reader = res.body!.getReader();
    await reader.read();
    controller.abort();
    await expect(reader.read()).rejects.toThrow();
  });
});
