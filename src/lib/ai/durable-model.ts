import type { wrapLanguageModel } from "ai";

/**
 * The Workflow SDK's serialization protocol symbols.
 *
 * Exported so tests can index the class with them: `Symbol.for()` is typed
 * `symbol`, not `unique symbol`, so a test holding its own `Symbol.for(...)`
 * cannot index the class type without an error. Sharing these constants keeps
 * the test's lookup and the class's declaration the same value.
 */
export const WORKFLOW_SERIALIZE = Symbol.for("workflow-serialize");
export const WORKFLOW_DESERIALIZE = Symbol.for("workflow-deserialize");

/** Serializable inputs. Plain data only — this crosses the step boundary. */
export interface DurableModelInit {
  providerId: string;
  modelId: string;
  /** Env var name to read the key from — never the key value itself. */
  apiKeyEnv?: string;
}

/**
 * A language model that survives the Workflow step boundary.
 *
 * `WorkflowAgent` passes the model as an argument to its `doStreamStep`, so the
 * model must be serializable. Three shapes were measured and rejected:
 * a `wrapLanguageModel` result (its `doGenerate`/`doStream` are functions, so
 * it fails at `.args[1].doGenerate`), a bare provider class from `node_modules`
 * (the SWC plugin derives class ids from file paths, so a `node_modules` class
 * is never registered), and a model factory (`doStreamStep` only handles a
 * string or passes the value through — it never invokes a function, so the
 * factory becomes the model and fails the version check).
 *
 * This class is defined locally, so the plugin discovers and registers it, and
 * it serializes to plain data only. The real provider — and the reasoning
 * middleware wrapper — are built lazily on first use, inside the step, so
 * neither ever crosses the boundary.
 */
export class DurableLanguageModel {
  readonly specificationVersion = "v4" as const;
  readonly provider: string;
  readonly modelId: string;
  /**
   * URL patterns the model accepts natively. Required by `LanguageModelV4`, and
   * the SDK reads it unconditionally (`ai/dist/index.js` passes
   * `await resolvedModel.supportedUrls` into `convertToLanguageModelPrompt`).
   * `isUrlSupported` then does `Object.entries(supportedUrls)` with no guard, so
   * omitting it throws `TypeError: Cannot convert undefined or null to object`
   * as soon as a prompt contains a file or image part.
   *
   * Empty is accurate rather than a placeholder: it declares that this class
   * handles no URL natively, so the SDK downloads every remote asset instead of
   * passing it through. That matches the openai-compatible provider's own
   * default (`@ai-sdk/openai-compatible` also reports `{}`), and this field is
   * deliberately not proxied from the provider — it is read synchronously
   * during prompt conversion, before `resolve()` has necessarily run, so
   * proxying it would mean an async lookup on a hot path for no behavioural
   * gain.
   */
  readonly supportedUrls: Record<string, RegExp[]> = {};
  private readonly apiKeyEnv?: string;
  private resolved?: ReturnType<typeof wrapLanguageModel>;

  constructor(init: DurableModelInit) {
    this.provider = init.providerId;
    this.modelId = init.modelId;
    this.apiKeyEnv = init.apiKeyEnv;
  }

  static [WORKFLOW_SERIALIZE](instance: DurableLanguageModel): DurableModelInit {
    return {
      providerId: instance.provider,
      modelId: instance.modelId,
      apiKeyEnv: instance.apiKeyEnv,
    };
  }

  static [WORKFLOW_DESERIALIZE](init: DurableModelInit): DurableLanguageModel {
    return new DurableLanguageModel(init);
  }

  /**
   * Builds the underlying provider on first call, inside the step.
   *
   * The provider stack is imported dynamically **to keep it out of the static
   * import graph of this module**, because this module is reachable from a
   * workflow function and the Workflow compiler bundles that graph with
   * `platform: 'neutral'` plus a Node-module error plugin
   * (`@workflow/builders/dist/base-builder.js:985,1036`) — any `node:fs` /
   * `better-sqlite3` in the graph fails the build with
   * `node-js-module-in-workflow`.
   *
   * Honest caveat, measured: a dynamic import is **not** by itself sufficient.
   * The bundler follows `import(...)` as well, so if the provider stack ends up
   * inside a workflow's bundle, the same error appears either way. What actually
   * keeps this working is that this class is only ever *constructed* in a
   * workflow function while its provider work happens in a step, and Task 9 must
   * keep the provider-touching modules out of the workflow bundle by structure
   * (a separate step module), not rely on this comment.
   *
   * @throws {Error} if the provider or model is missing from the registry, or
   *   if the provider needs a key and none is configured — a model that cannot
   *   be built should fail loudly rather than produce empty generations.
   */
  private async resolve(): Promise<ReturnType<typeof wrapLanguageModel>> {
    if (this.resolved) return this.resolved;

    const [{ loadRegistry, resolveApiKey }, { chatModelForEntry }] =
      await Promise.all([
        import("@/lib/ai/provider-config/store"),
        import("@/lib/ai/provider"),
      ]);

    const doc = await loadRegistry();
    const provider = doc.providers.find((p) => p.id === this.provider);
    if (!provider) {
      throw new Error(
        `Durable model: provider "${this.provider}" is not in the registry.`
      );
    }
    const model = provider.models.find((m) => m.modelId === this.modelId);
    if (!model) {
      throw new Error(
        `Durable model: model "${this.modelId}" is not in provider "${provider.name}".`
      );
    }

    const apiKey =
      provider.kind === "ollama" ? undefined : await resolveApiKey(provider);
    if (provider.kind !== "ollama" && provider.apiKeyEnv && !apiKey) {
      throw new Error(
        `Durable model: API key not set for ${provider.name} (${provider.apiKeyEnv}).`
      );
    }

    // `chatModelForEntry` already wraps the provider in
    // `extractReasoningMiddleware({ tagName: "think" })`, so wrapping again here
    // would run the same `think`-tag extraction twice over every chunk.
    this.resolved = chatModelForEntry(this.modelId, provider, apiKey);
    return this.resolved;
  }

  async doStream(options: unknown) {
    const model = await this.resolve();
    return model.doStream(options as never);
  }

  async doGenerate(options: unknown) {
    const model = await this.resolve();
    return model.doGenerate(options as never);
  }
}
