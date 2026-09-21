import { describe, it, expect } from "vitest";
import { start } from "workflow/api";
import { durableModelProbeWorkflow } from "./durable-model-probe";

/**
 * Gate 8's end-to-end proof: the model instance must deserialize inside a step.
 *
 * The probe passes an unconfigured provider id, so the provider build fails —
 * but it fails *inside the step*, which is itself the proof: the instance
 * crossed the boundary. The assertion checks the instance's own fields rather
 * than generation, so it needs no provider configured.
 */
describe("DurableLanguageModel across the step boundary", () => {
  it("deserializes inside a step", async () => {
    const run = await start(durableModelProbeWorkflow, [
      { providerId: "p", modelId: "m", apiKeyEnv: "K" },
    ]);

    const result = await run.returnValue;
    expect(result).toMatchObject({
      specificationVersion: "v4",
      provider: "p",
      modelId: "m",
    });
    // The provider build is expected to fail (no such provider in the registry),
    // and the failure must come from inside the step — proving the step ran.
    expect(result.buildError).toMatch(/not in the registry/);
  });
});
