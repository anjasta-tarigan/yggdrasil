import { z } from "zod";

/**
 * Schema for the structured result a subagent returns when its
 * `ToolLoopAgent` is configured with `Output.object`. Replaces the
 * prior free-text "SUMMARY COMPLETE." suffix convention with a
 * schema-validated object that `toModelOutput` can parse reliably.
 *
 * **Important:** This module is deliberately separate from
 * `tools/task.ts` to keep `SubagentResultSchema` (a Zod schema object,
 * not a `Tool`) out of the `...task` spread in `tools/index.ts`. If it
 * lived in `task.ts`, the `builtinTools` object would include it as a
 * "tool" entry, and the OpenAI-compatible providers (DeepSeek, etc.)
 * would reject it with "Unsupported tool type: object".
 */
export const SubagentResultSchema = z.object({
  summary: z
    .string()
    .min(1)
    .describe("Concise summary of what the subagent did"),
  keyFindings: z
    .array(z.string())
    .describe("Key facts or results discovered"),
  nextSteps: z
    .array(z.string())
    .describe("Suggested follow-up actions"),
});

export type SubagentResult = z.infer<typeof SubagentResultSchema>;
