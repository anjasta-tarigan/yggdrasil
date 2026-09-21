import { loadRegistry, resolveApiKey } from "@/lib/ai/provider-config/store";
import type { DurableLanguageModel, DurableModelInit } from "./durable-model";

/**
 * Resolves a registry entry into the plain connection data a
 * {@link DurableLanguageModel} needs, inside a step.
 *
 * ## Why this is a separate module
 *
 * The Workflow compiler bundles a workflow function's reachable graph into a
 * `platform: 'neutral'` VM bundle and rejects any `node:*` builtin in it
 * (`@workflow/builders/dist/base-builder.js:985,1036`). The provider registry
 * reads `node:fs`/`node:path`/`node:crypto` and pulls in SQLite, so importing it
 * from `durable-model.ts` — which a workflow function must reference — broke the
 * build with 6 `node-js-module-in-workflow` errors. Keeping those imports here,
 * in a module that only a step calls, keeps them out of the workflow bundle
 * while the step bundle (which *is* allowed Node access) gets them.
 *
 * The model itself must NOT be given a provider object to hold: `doStreamStep`
 * serializes the model argument and rebuilds it on the far side, where a held
 * provider would be lost. Instead this step returns the resolved `baseUrl` and
 * `apiKey` as plain data, which the model carries through its own serialization
 * and uses to rebuild the provider in `resolve()` (pure JS, no fs).
 *
 * @throws {Error} if the provider or model is missing from the registry, or if
 *   the provider needs a key and none is configured — failing loudly beats
 *   generating from a half-built model.
 */
export async function buildDurableModel(init: DurableModelInit): Promise<DurableModelInit> {
  "use step";

  const doc = await loadRegistry();
  const provider = doc.providers.find((p) => p.id === init.providerId);
  if (!provider) {
    throw new Error(
      `Durable model: provider "${init.providerId}" is not in the registry.`
    );
  }
  const entry = provider.models.find((m) => m.modelId === init.modelId);
  if (!entry) {
    throw new Error(
      `Durable model: model "${init.modelId}" is not in provider "${provider.name}".`
    );
  }

  const apiKey =
    provider.kind === "ollama" ? "ollama" : (await resolveApiKey(provider)) ?? "";
  if (provider.kind !== "ollama" && provider.apiKeyEnv && !apiKey) {
    throw new Error(
      `Durable model: API key not set for ${provider.name} (${provider.apiKeyEnv}).`
    );
  }

  return {
    providerId: init.providerId,
    modelId: init.modelId,
    baseUrl: provider.baseUrl ?? "",
    apiKey,
    isOllama: provider.kind === "ollama",
  };
}
