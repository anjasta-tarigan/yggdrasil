import { tool } from "ai";
import { z } from "zod";

export const ask_user_question = tool({
  description:
    "Ask the user structured interactive multiple-choice questions when requirements are ambiguous, have multiple valid architectural approaches, or require explicit user choices. Supports category tags, detailed trade-offs, code/mockup previews, and multi-selection. Note: This tool pauses execution on the client so the user can interactively select or type their answers; do NOT guess or answer this tool yourself.",
  inputSchema: z.object({
    questions: z
      .array(
        z.object({
          question: z
            .string()
            .describe("The specific question to ask the user"),
          header: z
            .string()
            .max(20)
            .describe(
              "Short tag/category chip (e.g., 'Framework', 'Database', 'Approach')"
            ),
          multiSelect: z
            .boolean()
            .default(false)
            .describe("Whether multiple options can be selected"),
          options: z
            .array(
              z.object({
                label: z
                  .string()
                  .describe("Concise option title (1-5 words)"),
                description: z
                  .string()
                  .describe(
                    "Explanation of trade-offs, consequences, or implementation details"
                  ),
                preview: z
                  .string()
                  .optional()
                  .describe(
                    "Optional multi-line code, diagram, or ASCII mockup preview"
                  ),
              })
            )
            .min(2)
            .max(4)
            .describe("2-4 distinct mutually exclusive choices"),
        })
      )
      .min(1)
      .max(4)
      .describe("1-4 questions to present to the user"),
  }),
  // Omit execute so AI SDK v7 treats ask_user_question as an interactive client-side tool.
  // The server loop halts step execution on this tool, emitting state="input-available"
  // and waiting for the user to answer via addToolResult on the client.
});