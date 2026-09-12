import { tool } from "ai";
import { z } from "zod";
import { enqueueJob } from "@/lib/queue/queue";

/**
 * Task and reminder tools: the visible plan checklist and scheduled
 * follow-ups. Both surface in the client UI (task list panel and the
 * notification inbox in the app header).
 */

/**
 * Schema for the structured result a subagent returns when its
 * `ToolLoopAgent` is configured with `Output.object`. Replaces the
 * prior free-text "SUMMARY COMPLETE." suffix convention with a
 * schema-validated object that `toModelOutput` can parse reliably.
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

export const task_list_manager = tool({
  description:
    "Create or update a visible task checklist shown to the user. Use it for complex, multi-step requests: first call it with the full plan (all items pending), then call it again as work progresses, marking items in_progress or completed. The latest call replaces the displayed list.",
  inputSchema: z.object({
    title: z.string().describe("Short title for the task list"),
    items: z
      .array(
        z.object({
          text: z.string().describe("Short description of the task item"),
          status: z
            .enum(["pending", "in_progress", "completed"])
            .describe("Current status of the item"),
        })
      )
      .min(1)
      .max(20)
      .describe("The complete task list (replaces any previous list)"),
  }),
  execute: async ({ title, items }) => {
    const completed = items.filter((i) => i.status === "completed").length;
    return {
      title,
      items,
      completed,
      total: items.length,
      done: completed === items.length,
    };
  },
});

export const reminder_schedule = tool({
  description:
    "Schedule a reminder for the user. When due, it appears in their notification inbox in the app header. Use whenever the user says 'remind me', 'in N minutes/hours', 'tomorrow at...', or asks you to follow up later. Confirm the scheduled time in your reply.",
  inputSchema: z.object({
    title: z
      .string()
      .min(1)
      .max(120)
      .describe("Short reminder title shown to the user, e.g. 'Stand up and stretch'"),
    body: z
      .string()
      .max(500)
      .optional()
      .describe("Optional extra detail or context for the reminder"),
    delayMinutes: z
      .number()
      .int()
      .min(1)
      .max(43200)
      .describe("Minutes from now until the reminder fires (max 30 days)"),
  }),
  execute: async ({ title, body, delayMinutes }) => {
    const runAt = new Date(Date.now() + delayMinutes * 60_000);
    const jobId = await enqueueJob({
      type: "scheduled_reminder",
      payload: { title, body: body ?? null },
      runAt,
    });
    return { jobId, dueAt: runAt.toISOString() };
  },
});
