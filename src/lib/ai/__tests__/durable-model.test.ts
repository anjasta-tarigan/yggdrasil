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
    // The whole point: the serialized form is data. If a provider or the
    // reasoning wrapper leaked into it, structuredClone above would throw —
    // but assert the shape explicitly so the contract is readable.
    const serialized = DurableLanguageModel[WORKFLOW_SERIALIZE](
      new DurableLanguageModel(init)
    );
    expect(Object.keys(serialized).sort()).toEqual([
      "apiKeyEnv",
      "modelId",
      "providerId",
    ]);
  });

  it("omits apiKeyEnv when the provider needs no key", () => {
    const noKey: DurableModelInit = { providerId: "p", modelId: "m" };
    const serialized = DurableLanguageModel[WORKFLOW_SERIALIZE](
      new DurableLanguageModel(noKey)
    );
    expect(serialized.apiKeyEnv).toBeUndefined();
  });
});
