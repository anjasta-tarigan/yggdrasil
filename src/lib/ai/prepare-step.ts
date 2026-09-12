import type {
  LanguageModel,
  PrepareStepFunction,
  PrepareStepResult,
  ToolSet,
} from "ai";

/**
 * Options for {@link createPrepareStep}.
 *
 * All fields are optional; sensible defaults are applied so that the
 * factory can be called with zero arguments in the common case.
 */
export interface PrepareStepOptions {
  /**
   * After this many steps that produced tool calls, the callback starts
   * returning adapted settings (lowered temperature, optional model
   * swap, tool restrictions).
   *
   * Defaults to `5`.
   */
  temperatureStepThreshold?: number;

  /**
   * Temperature to set once the threshold is crossed and the last step
   * produced tool calls.
   *
   * Defaults to `0.1` (focused / deterministic).
   */
  focusedTemperature?: number;

  /**
   * Optional reasoning-focused model to swap to after the threshold.
   * When omitted, the outer `streamText` model is kept.
   */
  reasoningModel?: LanguageModel;

  /**
   * Tool names to withhold from the model after the threshold step.
   *
   * Defaults to `["bash"]` — the sandbox shell tool is silenced in later
   * steps to keep the model focused on reasoning rather than side-effecting
   * commands during deep tool chains.
   */
  withheldToolNames?: string[];

  /**
   * Full list of tool names available to the `streamText()` call.
   *
   * Required only when you want `activeTools` to be set (i.e. when
   * `withheldToolNames` should actually restrict the tool set). When
   * omitted — or when every tool is still active after filtering — the
   * result contains no `activeTools` override.
   */
  availableToolNames?: string[];
}

/**
 * Args passed to a `prepareStep` callback, extracted from the AI SDK's
 * `PrepareStepFunction` so callers (and tests) get the exact shape the SDK
 * delivers. Specialized to the untyped `ToolSet` so this module stays tool-
 * agnostic (the chat route wires the concrete tool set at the streamText
 * call site).
 */
export type PrepareStepArgs = Parameters<PrepareStepFunction<ToolSet>>[0];

/**
 * Build a `prepareStep` callback for AI SDK v7's `streamText()`.
 *
 * The callback runs before each step in the agentic loop. When the
 * step number reaches `temperatureStepThreshold` **and** the previous step
 * emitted tool calls, it returns adapted call settings:
 *
 * - `temperature` → lowered to `focusedTemperature` (default `0.1`)
 * - `model` → swapped to `reasoningModel` when one is provided
 * - `activeTools` → the full available tool list minus `withheldToolNames`
 *
 * On every other step the callback returns `{}` so the outer
 * `streamText()` call settings flow through unchanged.
 *
 * @example
 * ```ts
 * const prepareStep = createPrepareStep({
 *   availableToolNames: Object.keys(tools),
 * });
 * ```
 */
export function createPrepareStep(
  options?: PrepareStepOptions,
): PrepareStepFunction<ToolSet> {
  const threshold = options?.temperatureStepThreshold ?? 5;
  const focusedTemp = options?.focusedTemperature ?? 0.1;
  const withheldTools = new Set(options?.withheldToolNames ?? ["bash"]);
  const availableToolNames = options?.availableToolNames;

  return async (args: PrepareStepArgs) => {
    const { stepNumber, steps } = args;
    const lastStep = steps[steps.length - 1];
    const hasToolCalls = lastStep?.toolCalls?.length > 0;

    // Only adapt once we've crossed the threshold AND the previous step
    // actually invoked tools — otherwise the model is still exploring and
    // benefits from its default (higher) temperature.
    if (stepNumber >= threshold && hasToolCalls) {
      const result: PrepareStepResult<ToolSet> = {
        temperature: focusedTemp,
      };

      if (options?.reasoningModel) {
        result.model = options.reasoningModel;
      }

      // Constrain the tool set so the model can't fall back to withheld
      // tools (e.g. "bash") during deep-reasoning steps. When
      // `availableToolNames` is provided we always emit an `activeTools`
      // list — even when nothing is withheld, an explicit all-encompassing
      // list is equivalent to "no restriction" and makes the per-step
      // contract deterministic.
      if (availableToolNames && availableToolNames.length > 0) {
        result.activeTools = availableToolNames.filter(
          (name) => !withheldTools.has(name),
        );
      }

      return result;
    }

    // No adaptation: the outer streamText settings are used unchanged.
    return {};
  };
}
