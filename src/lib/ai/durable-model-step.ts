import { loadRegistry, resolveApiKey } from "@/lib/ai/provider-config/store";
import { chatModelForEntry } from "@/lib/ai/provider";
import type { DurableLanguageModel, DurableModelInit } from "./durable-model";

/**
 * Builds the real provider for a {@link DurableLanguageModel}, inside a step.
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
 * A `"use step"` function still receives serializable arguments, so this takes
 * the model instance and the plain init data, attaches the provider, and
 * returns the instance. The provider itself is never serialized.
 *
 * @throws {Error} if the provider or model is missing from the registry, or if
 *   the provider needs a key and none is configured — failing loudly beats
 *   generating from a half-built model.
 */
export async function buildDurableModel(
  model: DurableLanguageModel,
  init: DurableModelInit
): Promise<DurableLanguageModel> {
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
    provider.kind === "ollama" ? undefined : await resolveApiKey(provider);
  if (provider.kind !== "ollama" && provider.apiKeyEnv && !apiKey) {
    throw new Error(
      `Durable model: API key not set for ${provider.name} (${provider.apiKeyEnv}).`
    );
  }

  // `chatModelForEntry` already applies
  // `extractReasoningMiddleware({ tagName: "think" })`, so wrapping it again
  // would run the same think-tag extraction twice over every chunk.
  model.attachProvider(chatModelForEntry(init.modelId, provider, apiKey));
  return model;
}
