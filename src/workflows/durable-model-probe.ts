import { DurableLanguageModel, type DurableModelInit } from "@/lib/ai/durable-model";
// Relative, not `@/`: the workflow bundle resolves relative specifiers but not
// the tsconfig path alias for this import.
import { buildDurableModel } from "../lib/ai/durable-model-step";

/**
 * Proves {@link DurableLanguageModel} survives the Workflow step boundary.
 *
 * The workflow function constructs the (serializable) model and hands it to a
 * step that builds the provider and reports the instance's fields. Reaching the
 * step's body at all means the instance deserialized on the far side, which is
 * the property every later task needs — `WorkflowAgent` passes the model as an
 * argument to its own `doStreamStep`.
 *
 * The workflow lives in this module (not in the test) because the builder
 * rejects a `"use workflow"` directive inside a test callback.
 *
 * The provider is not built against a real registry here: the probe passes an
 * unconfigured provider id, so `buildDurableModel` is expected to throw. That
 * still exercises the boundary, because the throw happens *inside* the step,
 * after the instance has crossed.
 */
export async function durableModelProbeWorkflow(init: DurableModelInit) {
  "use workflow";
  const model = new DurableLanguageModel(init);
  return await probeStep(model, init);
}

async function probeStep(model: DurableLanguageModel, init: DurableModelInit) {
  "use step";
  // `buildDurableModel` is itself a step; calling it here proves the class is
  // usable from a step context. A missing provider is expected and is not the
  // point — the point is that `model` arrived.
  let buildError: string | null = null;
  try {
    await buildDurableModel(model, init);
  } catch (err) {
    buildError = err instanceof Error ? err.message : String(err);
  }
  return {
    specificationVersion: model.specificationVersion,
    provider: model.provider,
    modelId: model.modelId,
    buildError,
  };
}
