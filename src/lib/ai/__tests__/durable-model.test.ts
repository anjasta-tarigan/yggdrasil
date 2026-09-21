import { describe, it, expect } from "vitest";
import {
  DurableLanguageModel,
  WORKFLOW_SERIALIZE,
  WORKFLOW_DESERIALIZE,
  type DurableModelInit,
} from "@/lib/ai/durable-model";

const init: DurableModelInit = {
  providerId: "test-provider",
  modelId: "test-model",
  apiKeyEnv: "TEST_PROVIDER_KEY",
};

describe("DurableLanguageModel", () => {
  it("implements the workflow serialization protocol", () => {
    expect(typeof DurableLanguageModel[WORKFLOW_SERIALIZE]).toBe("function");
    expect(typeof DurableLanguageModel[WORKFLOW_DESERIALIZE]).toBe("function");
  });

  it("serializes to plain data only", () => {
    const serialized = DurableLanguageModel[WORKFLOW_SERIALIZE](
      new DurableLanguageModel(init)
    );
    expect(serialized).toEqual(init);
    // Must survive structured cloning: no functions, no class instances.
    expect(() => structuredClone(serialized)).not.toThrow();
  });

  it("round-trips back to an equivalent model", () => {
    const restored = DurableLanguageModel[WORKFLOW_DESERIALIZE](init);
    expect(restored).toBeInstanceOf(DurableLanguageModel);
    expect(restored.provider).toBe("test-provider");
    expect(restored.modelId).toBe("test-model");
  });

  it("exposes the V4 specification version the SDK requires", () => {
    expect(new DurableLanguageModel(init).specificationVersion).toBe("v4");
  });

  it("does not carry a live provider across the boundary", () => {
    // Distinct from the structuredClone test above: that proves the *shape*
    // survives cloning, this proves the serialized form is exactly the declared
    // init fields and nothing else — so a provider handle or the reasoning
    // wrapper can never leak into the payload by being added to the class.
    const serialized = DurableLanguageModel[WORKFLOW_SERIALIZE](
      new DurableLanguageModel(init)
    );
    expect(Object.keys(serialized).sort()).toEqual([
      "apiKeyEnv",
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

  it("omits apiKeyEnv when the provider needs no key", () => {
    const noKey: DurableModelInit = { providerId: "p", modelId: "m" };
    const serialized = DurableLanguageModel[WORKFLOW_SERIALIZE](
      new DurableLanguageModel(noKey)
    );
    expect(serialized.apiKeyEnv).toBeUndefined();
  });
});
