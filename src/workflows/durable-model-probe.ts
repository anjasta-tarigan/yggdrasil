import { DurableLanguageModel, type DurableModelInit } from "@/lib/ai/durable-model";
// Relative, not `@/`: the workflow bundle resolves relative specifiers but not
// the tsconfig path alias for this import.
import { buildDurableModel } from "../lib/ai/durable-model-step";

/**
 * Proves {@link DurableLanguageModel} survives the Workflow step boundary.
 *
 * The workflow function resolves the registry entry into plain `baseUrl`/`apiKey`
 * via `buildDurableModel(init)` (a step, because the registry reads node:fs). With
 * an unconfigured provider id the resolution throws *inside* the step — but the
 * throw still proves the boundary was crossed, because the step body ran. The
 * resolved init (when it succeeds) is what the model carries across as plain data.
 *
 * The workflow lives in this module (not in the test) because the builder rejects
 * a `"use workflow"` directive inside a test callback.
 */
export async function durableModelProbeWorkflow(init: DurableModelInit) {
  "use workflow";

  const { resolvedInit, resolveError } = await resolveInit(init);
  // If resolution failed (unconfigured provider), fall back to the raw init so the
  // model can still be constructed and handed to the step — the boundary crossing
  // is the thing under test, not the registry.
  const model = new DurableLanguageModel(resolvedInit ?? init);
  return await probeStep(model, resolveError);
}

async function resolveInit(init: DurableModelInit): Promise<{
  resolvedInit?: DurableModelInit;
  resolveError: string | null;
}> {
  "use step";
  try {
    return { resolvedInit: await buildDurableModel(init), resolveError: null };
  } catch (err) {
    return { resolvedInit: undefined, resolveError: err instanceof Error ? err.message : String(err) };
  }
}

async function probeStep(model: DurableLanguageModel, resolveError: string | null) {
  "use step";
  // Reaching this body means the instance deserialized on the far side. The model
  // rebuilds its provider from carried plain data in resolve(), so a real turn no
  // longer needs an out-of-band attach step.
  return {
    specificationVersion: model.specificationVersion,
    provider: model.provider,
    modelId: model.modelId,
    resolveError,
  };
}
