import {
  DurableLanguageModel,
  type DurableModelInit,
} from "@/lib/ai/durable-model";

/**
 * Proves {@link DurableLanguageModel} survives the Workflow step boundary.
 *
 * The workflow function is deliberately trivial: it constructs the model and
 * hands it to a step. Reaching the step's body at all means the instance
 * deserialized on the far side, which is the property every later task needs —
 * `WorkflowAgent` passes the model as an argument to its own `doStreamStep`.
 *
 * The workflow lives in this module (not in the test) because the builder
 * rejects a `"use workflow"` directive inside a test callback.
 */
export async function durableModelProbeWorkflow(init: DurableModelInit) {
  "use workflow";
  const model = new DurableLanguageModel(init);
  return await reportModel(model);
}

async function reportModel(model: DurableLanguageModel) {
  "use step";
  // No provider is configured for the probe, and none is needed: the point is
  // that the *instance* arrived, not that it can generate.
  return {
    specificationVersion: model.specificationVersion,
    provider: model.provider,
    modelId: model.modelId,
  };
}
