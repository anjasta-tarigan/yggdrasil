import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { wrapLanguageModel, extractReasoningMiddleware } from "ai";

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
 * Written LITERALLY (`static [Symbol.for("workflow-serialize")]`, not via a
 * const) because the SWC serde-discovery heuristic (fast-discovery.js
 * hasLikelySerdeClass) only matches a literal `Symbol.for("workflow-serialize")`
 * form — an indirection through a const defeats detection, so the class is never
 * registered for cross-boundary deserialization and crosses the doStreamStep
 * boundary as an unknown class.
 */
export interface DurableModelInit {
  providerId: string;
  modelId: string;
  /**
   * The provider base URL, resolved from the registry in a step and carried as
   * plain data. Needed because this class rebuilds its provider on the far side
   * of the `doStreamStep` serialization boundary (where the registry is not
   * reachable), so it cannot re-read the registry at call time.
   */
  baseUrl: string;
  /**
   * The resolved API key (or "ollama" for Ollama). Carried as plain data for the
   * same reason as `baseUrl`. NEVER serialize a secret across a boundary; this is
   * the already-resolved value from the secrets store, scoped to one run.
   */
  apiKey: string;
  /** Whether the provider is Ollama (needs no real key, routes through /v1). */
  isOllama?: boolean;
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
 * ## Why this class is self-sufficient after deserialization
 *
 * The model argument is serialized when handed to `doStreamStep` and
 * deserialized on the far side, which rebuilds a fresh instance. A provider held
 * as a private field would be lost there (serialization emits only the plain
 * init fields), and the SDK-owned step has no hook to re-attach it — so a real
 * turn died with "no provider attached". The fix: carry `baseUrl` + `apiKey` as
 * plain data and rebuild the provider in `resolve()` via pure-JS
 * `createOpenAICompatible`, which needs no `node:*` access. The registry lookup
 * that produces those two fields happens once, in a `"use step"` function
 * (`buildDurableModel` in `durable-model-step.ts`), and the resolved data is
 * threaded through `DurableModelInit`.
 *
 * ## Why this module imports only pure-JS providers
 *
 * The Workflow compiler bundles a workflow function's reachable graph into a
 * `platform: 'neutral'` VM bundle and **fails the build** if any `node:*` builtin
 * or `better-sqlite3` is in it (`@workflow/builders/dist/base-builder.js:985,1036`).
 * The provider registry reads `node:fs`/`node:path`/`node:crypto` and pulls in
 * SQLite, so importing it here — even dynamically — broke the build. Keeping this
 * file to pure-JS provider construction (no registry, no fs) keeps it out of the
 * workflow bundle; the step that resolves the init fields is the only place that
 * touches the registry.
 */
export interface DurableModelOptions {
  /**
   * Gap between consecutive output chunks before the stream is treated as dead.
   * Mirrors `HARNESS_TIMEOUT.chunkMs` (300000ms). It is defined here rather than
   * imported from `@/lib/ai/harness-loop` because that module pulls in
   * `log-store`/`harness-context`/`streamText`, which would drag `node:fs` and
   * SQLite back into this otherwise-pure-JS workflow bundle (see the module note
   * above). Keep the two values in sync.
   */
  chunkMs?: number;
}

/** Local mirror of `HARNESS_TIMEOUT.chunkMs` — see {@link DurableModelOptions}. */
const DEFAULT_CHUNK_MS = 300_000;

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
   * default (`@ai-sdk/openai-compatible` also reports `{}`).
   */
  readonly supportedUrls: Record<string, RegExp[]> = {};
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly isOllama: boolean;
  private readonly chunkMs: number;
  private providerModel?: DurableProviderModel;

  constructor(init: DurableModelInit, options?: DurableModelOptions) {
    this.provider = init.providerId;
    this.modelId = init.modelId;
    this.baseUrl = init.baseUrl;
    this.apiKey = init.apiKey;
    this.isOllama = init.isOllama ?? false;
    this.chunkMs = options?.chunkMs ?? DEFAULT_CHUNK_MS;
  }

  static [Symbol.for("workflow-serialize")](instance: DurableLanguageModel): DurableModelInit {
    return {
      providerId: instance.provider,
      modelId: instance.modelId,
      baseUrl: instance.baseUrl,
      apiKey: instance.apiKey,
      isOllama: instance.isOllama,
    };
  }

  static [Symbol.for("workflow-deserialize")](init: DurableModelInit): DurableLanguageModel {
    return new DurableLanguageModel(init);
  }

  /**
   * @throws {Error} if called and the provider cannot be rebuilt from the carried
   *   init data — the model is only usable after `buildDurableModel` has resolved
   *   its base URL and key into `DurableModelInit`.
   */
  async doStream(options: unknown) {
    const model = await this.resolve();
    const result = (await model.doStream(options as never)) as {
      stream: ReadableStream<unknown>;
    } & Record<string, unknown>;
    // Re-arm a stall watchdog around the provider's output stream (spec §3.7).
    return { ...result, stream: this.guardChunkGap(result.stream) };
  }

  async doGenerate(options: unknown) {
    return this.resolve().doGenerate(options as never);
  }

  /**
   * Wraps a model stream so a genuine stall is detected.
   *
   * `WorkflowAgent` exposes only a single `timeout` number, so Stage 1's per-gap
   * `chunkMs` watchdog has no direct equivalent on the durable path. This
   * reimplements it: the timer re-arms on every chunk and fires only when the gap
   * exceeds `chunkMs`, which is what distinguishes a dead socket from a reasoning
   * model that is simply thinking (reasoning deltas are chunks). A local timer is
   * the only place a watchdog can live — a wrapped model is a live object that
   * cannot cross the step boundary, so the guard must run in-band with the stream
   * it guards.
   */
  guardChunkGap<T>(stream: ReadableStream<T>): ReadableStream<T> {
    const chunkMs = this.chunkMs;
    return new ReadableStream<T>({
      start(controller) {
        const reader = stream.getReader();
        let timer: ReturnType<typeof setTimeout> | undefined;

        const arm = () => {
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => {
            reader.cancel().catch(() => undefined);
            controller.error(
              new Error(
                `Chunk timeout of ${chunkMs}ms exceeded — stream stalled.`
              )
            );
          }, chunkMs);
        };

        const pump = async () => {
          arm();
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              arm();
              controller.enqueue(value);
            }
            if (timer) clearTimeout(timer);
            controller.close();
          } catch (err) {
            if (timer) clearTimeout(timer);
            controller.error(err);
          }
        };

        void pump();
      },
      cancel() {
        return stream.cancel();
      },
    });
  }

  /**
   * Rebuilds the provider from the carried plain data. Runs on whichever side of
   * the boundary `doStream`/`doGenerate` is invoked on, so it must not touch the
   * filesystem — `createOpenAICompatible` is pure JS.
   */
  private resolve(): DurableProviderModel {
    if (this.providerModel) return this.providerModel;

    if (!this.baseUrl) {
      throw new Error(
        `Durable model: no base URL resolved for "${this.provider}/${this.modelId}". ` +
          `Call buildDurableModel(...) in a "use step" function before generating.`
      );
    }

    const provider = createOpenAICompatible({
      name: this.isOllama ? "ollama" : this.provider,
      baseURL: this.isOllama
        ? `${this.baseUrl.replace(/\/$/, "")}/v1`
        : this.baseUrl,
      apiKey: this.isOllama ? "ollama" : this.apiKey,
      supportsStructuredOutputs: true,
    });

    this.providerModel = wrapLanguageModel({
      model: provider.chatModel(this.modelId),
      middleware: extractReasoningMiddleware({ tagName: "think" }),
    });
    return this.providerModel;
  }
}
