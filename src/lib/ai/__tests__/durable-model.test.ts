import { describe, it, expect } from "vitest";
import {
  DurableLanguageModel,
  type DurableModelInit,
} from "@/lib/ai/durable-model";

// Serialization symbols are written literally in the class (the SWC serde-discovery
// heuristic only matches a literal `Symbol.for("workflow-serialize")` form), so the
// test reads them the same way rather than via an exported const.
const SERIALIZE = Symbol.for("workflow-serialize");
const DESERIALIZE = Symbol.for("workflow-deserialize");

const init: DurableModelInit = {
  providerId: "test-provider",
  modelId: "test-model",
  baseUrl: "http://localhost:11434/v1",
  apiKey: "sk-test",
  isOllama: false,
};

// The serialization symbols are static methods keyed by symbol; TS needs an
// explicit index signature. Cast through unknown to satisfy it.
const ModelWithSerde = DurableLanguageModel as unknown as Record<
  symbol,
  (i: unknown) => unknown
>;

describe("DurableLanguageModel", () => {
  it("implements the workflow serialization protocol", () => {
    expect(typeof ModelWithSerde[SERIALIZE]).toBe("function");
    expect(typeof ModelWithSerde[DESERIALIZE]).toBe("function");
  });

  it("serializes to plain data only", () => {
    const serialized = ModelWithSerde[SERIALIZE](
      new DurableLanguageModel(init)
    ) as DurableModelInit;
    expect(serialized).toEqual(init);
    // Must survive structured cloning: no functions, no class instances.
    expect(() => structuredClone(serialized)).not.toThrow();
  });

  it("round-trips back to an equivalent model", () => {
    const restored = ModelWithSerde[DESERIALIZE](init) as DurableLanguageModel;
    expect(restored).toBeInstanceOf(DurableLanguageModel);
    expect(restored.provider).toBe("test-provider");
    expect(restored.modelId).toBe("test-model");
  });

  it("exposes the V4 specification version the SDK requires", () => {
    expect(new DurableLanguageModel(init).specificationVersion).toBe("v4");
  });

  it("carries plain connection data across the boundary", () => {
    // The model rebuilds its provider on the far side from baseUrl + apiKey, so
    // those must be part of the serialized form — not attached out of band.
    const serialized = ModelWithSerde[SERIALIZE](
      new DurableLanguageModel(init)
    ) as DurableModelInit;
    expect(Object.keys(serialized).sort()).toEqual([
      "apiKey",
      "baseUrl",
      "isOllama",
      "modelId",
      "providerId",
    ]);
  });

  it("exposes supportedUrls, which LanguageModelV4 requires", () => {
    // The SDK reads `await model.supportedUrls` unconditionally and passes it to
    // isUrlSupported, which does Object.entries(...) with no guard. Omitting it
    // throws "Cannot convert undefined or null to object" as soon as a prompt
    // carries a file or image part.
    const model = new DurableLanguageModel(init);
    expect(model.supportedUrls).toBeDefined();
    expect(() => Object.entries(model.supportedUrls)).not.toThrow();
  });

  it("rebuilds a provider from carried data without touching the filesystem", () => {
    // The boundary crossing is the whole point: a deserialized model must rebuild
    // its provider from baseUrl + apiKey alone. resolve() uses pure-JS
    // createOpenAICompatible (no node:fs), so it runs on either side of the
    // serialization boundary. The "no filesystem" property is what lets the model
    // survive doStreamStep, where the registry is unreachable. Actual generation is
    // covered by the live gate-9 workflow test; here we only assert the model is
    // constructed with the carried data (no network, no fs).
    const restored = ModelWithSerde[DESERIALIZE](init) as DurableLanguageModel;
    expect(restored.provider).toBe(init.providerId);
    expect(restored.modelId).toBe(init.modelId);
  });
});

describe("chunk watchdog", () => {
  it("aborts a stream that emits nothing within chunkMs", async () => {
    const model = new DurableLanguageModel(
      { providerId: "p", modelId: "m", baseUrl: "http://x", apiKey: "k" },
      { chunkMs: 50 }
    );
    // A stream that never produces a chunk.
    const stalled = new ReadableStream<never>({
      start() {
        /* never enqueue, never close */
      },
    });
    const guarded = model.guardChunkGap(stalled);
    const reader = guarded.getReader();
    await expect(reader.read()).rejects.toThrow(/chunk/i);
  });

  it("passes chunks through while they keep arriving", async () => {
    const model = new DurableLanguageModel(
      { providerId: "p", modelId: "m", baseUrl: "http://x", apiKey: "k" },
      { chunkMs: 1_000 }
    );
    const stream = new ReadableStream<string>({
      start(controller) {
        controller.enqueue("a");
        controller.enqueue("b");
        controller.close();
      },
    });
    const out: string[] = [];
    for await (const chunk of model.guardChunkGap(stream) as ReadableStream<string>) {
      out.push(chunk);
    }
    expect(out).toEqual(["a", "b"]);
  });
});
