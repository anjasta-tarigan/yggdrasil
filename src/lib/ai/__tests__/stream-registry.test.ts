import { describe, it, expect, afterEach } from "vitest";
import {
  publishStream,
  attachStream,
  cancelStream,
  activeStreamIds,
  resetStreamRegistry,
} from "../stream-registry";

afterEach(() => {
  resetStreamRegistry();
});

/** Build a string stream that emits chunks then closes. */
function chunkStream(chunks: string[], delayMs = 0): ReadableStream<string> {
  let i = 0;
  return new ReadableStream<string>({
    async pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(chunks[i++]);
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      } else {
        controller.close();
      }
    },
  });
}

/** Read a stream fully into a string array. */
async function collect(stream: ReadableStream<string>): Promise<string[]> {
  const reader = stream.getReader();
  const out: string[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.push(value);
  }
  return out;
}

describe("stream-registry", () => {
  it("attach returns the published chunks to a late joiner", async () => {
    const source = chunkStream(["a", "b", "c"]);
    publishStream("s1", "chat-1", source);

    // Simulate the HTTP response being closed immediately (its branch
    // cancelled) while the registry keeps the generation alive.
    const attached = attachStream("s1");
    expect(attached).not.toBeNull();
    expect(await collect(attached!)).toEqual(["a", "b", "c"]);
  }, 20_000);

  it("serves multiple attachers from one live stream", async () => {
    // Slow producer: stays live long enough for two attachers.
    const source = chunkStream(["x", "y", "z"], 5);
    publishStream("s2", "chat-2", source);

    const a = attachStream("s2");
    const b = attachStream("s2");
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();

    const [ac, bc] = await Promise.all([collect(a!), collect(b!)]);
    expect(ac).toEqual(["x", "y", "z"]);
    expect(bc).toEqual(["x", "y", "z"]);
  }, 20_000);

  it("an attacher cancelling does not kill the stream for others", async () => {
    const source = chunkStream(["m", "n"], 5);
    publishStream("s3", "chat-3", source);

    const quitter = attachStream("s3");
    quitter!.cancel(); // first client disconnects immediately
    await new Promise((r) => setTimeout(r, 10));

    const survivor = attachStream("s3");
    expect(survivor).not.toBeNull();
    expect(await collect(survivor!)).toEqual(["m", "n"]);
  }, 20_000);

  it("attach returns null once the stream finished", async () => {
    const source = chunkStream(["done"]);
    publishStream("s4", "chat-4", source);
    // Drain the generation fully.
    const attached = attachStream("s4");
    await collect(attached!);
    // Give the registry's own drain pump a tick to settle.
    await new Promise((r) => setTimeout(r, 10));

    expect(attachStream("s4")).toBeNull();
    expect(activeStreamIds()).toEqual([]);
  }, 20_000);

  it("cancelStream stops a live stream and removes it", async () => {
    // Producer emits slowly and for a long time — cancel must stop it
    // long before it finishes. Bounded (not infinite) so a broken
    // cancel surfaces as a timeout, not a hung runner.
    const chunks = Array.from({ length: 500 }, (_, i) => `tick-${i}`);
    const source = chunkStream(chunks, 20);
    publishStream("s5", "chat-5", source);

    await new Promise((r) => setTimeout(r, 30)); // a few ticks stream out
    expect(cancelStream("s5")).toBe(true);
    expect(attachStream("s5")).toBeNull();
    expect(cancelStream("s5")).toBe(false); // already gone
    expect(activeStreamIds()).toEqual([]);
  }, 20_000);

  it("attaching an unknown id returns null", () => {
    expect(attachStream("never-published")).toBeNull();
  });

  it("activeStreamIds reports live entries with their chats", () => {
    publishStream("s6", "chat-6", chunkStream(["q"]));
    const live = activeStreamIds();
    expect(live).toEqual([{ chatId: "chat-6", streamId: "s6" }]);
  });
});
