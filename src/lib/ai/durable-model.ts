/**
 * The minimum this class needs from a language model.
 *
 * Declared structurally rather than imported: `@ai-sdk/provider` is not a direct
 * dependency, and `ai`'s `LanguageModel` is a union that includes bare model-id
 * strings, so neither gives a usable type here. The real provider satisfies this
 * shape, and a structural type keeps this module free of runtime imports.
 */
export interface DurableProviderModel {
  // `PromiseLike`, not `Promise`: the AI SDK's model interface returns
  // `PromiseLike<…StreamResult>`, so narrowing to `Promise` would reject the
  // real provider at the call site.
  doStream(options: unknown): PromiseLike<unknown>;
  doGenerate(options: unknown): PromiseLike<unknown>;
}

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
 * it serializes to plain data only.
 *
 * ## Why this module imports nothing but a type
 *
 * The Workflow compiler bundles a workflow function's entire reachable graph
 * into a `platform: 'neutral'` VM bundle and **fails the build** if any
 * `node:*` builtin or `better-sqlite3` is in it
 * (`@workflow/builders/dist/base-builder.js:985,1036`). The provider registry
 * reads `node:fs`/`node:path`/`node:crypto` and pulls in SQLite, so importing it
 * here — statically *or* dynamically, since the bundler follows `import(...)`
 * too — breaks every workflow that references this class. Measured: doing so
 * produced 6 `node-js-module-in-workflow` errors.
 *
 * The provider is therefore built by {@link buildDurableModel} in
 * `durable-model-step.ts`, which is a `"use step"` function whose bundle *is*
 * allowed Node access. Keep this file free of value imports from the app.
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
   * default (`@ai-sdk/openai-compatible` also reports `{}`), and the field is
   * deliberately not proxied from the provider: it is read synchronously during
   * prompt conversion, before the provider has necessarily been built.
   */
  readonly supportedUrls: Record<string, RegExp[]> = {};
  private readonly apiKeyEnv?: string;
  /**
   * The live provider, attached inside a step. Deliberately not serialized —
   * {@link WORKFLOW_SERIALIZE} emits only the three init fields — so it never
   * crosses the boundary; the step that builds it also uses it.
   */
  private providerModel?: DurableProviderModel;

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

  /** @internal Called by the step in `durable-model-step.ts`. */
  attachProvider(model: DurableProviderModel): void {
    this.providerModel = model;
  }

  /**
   * @throws {Error} if called before the provider has been attached — the model
   *   is only usable after its step has run, and failing loudly is better than
   *   generating from nothing.
   */
  async doStream(options: unknown) {
    return this.resolve().doStream(options as never);
  }

  async doGenerate(options: unknown) {
    return this.resolve().doGenerate(options as never);
  }

  private resolve(): DurableProviderModel {
    if (!this.providerModel) {
      throw new Error(
        `Durable model: no provider attached for "${this.provider}/${this.modelId}". ` +
          `Call buildDurableModel(...) in a "use step" function before generating.`
      );
    }
    return this.providerModel;
  }
}
