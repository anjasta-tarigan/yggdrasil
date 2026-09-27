import { tool } from "ai";
import { z } from "zod";
import { searchConversationsDb } from "@/lib/chat-service";

/**
 * Raw-transcript recall across past conversations.
 *
 * Complements `memory_search`: memory is the distilled, semantic layer
 * (facts/preferences/learned rules), whereas this searches the literal
 * message history, so it can surface a specific earlier discussion that was
 * never summarized into a memory.
 *
 * The chat-bound factory excludes the CURRENT session by default — its
 * messages are already in the model's context, so returning them would waste
 * the result budget on content the model can already see.
 */

const conversationSearchInputSchema = z.object({
  query: z
    .string()
    .min(1)
    .max(300)
    .describe("Literal keywords to find in past conversation messages"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(20)
    .default(8)
    .describe("Maximum number of matching messages to return"),
  includeCurrentChat: z
    .boolean()
    .default(false)
    .describe(
      "Set true to also search the current conversation. Default false, since its messages are already in your context."
    ),
});

type ConversationSearchInput = z.infer<typeof conversationSearchInputSchema>;

async function runSearch(
  input: ConversationSearchInput,
  currentChatId: string | undefined
) {
  const excludeSessionId =
    !input.includeCurrentChat && currentChatId ? currentChatId : undefined;
  const results = await searchConversationsDb(input.query, {
    limit: input.limit,
    excludeSessionId,
  });
  return {
    count: results.length,
    results: results.map((r) => ({
      sessionId: r.sessionId,
      sessionTitle: r.sessionTitle,
      messageId: r.messageId,
      role: r.role,
      snippet: r.snippet,
    })),
  };
}

/** Static export for the built-in registry (no chat binding). */
export const conversation_search = tool({
  description:
    "Search the raw text of past conversations by keyword (literal match), returning short excerpts with their session title and role. Use this to recall a specific earlier discussion that is not captured by memory_search — e.g. 'what did we decide about X', 'where did I mention Y'. Complements memory_search, which searches distilled facts and preferences.",
  inputSchema: conversationSearchInputSchema,
  execute: async (input) => runSearch(input, undefined),
});

/**
 * Build the conversation-search tool bound to one chat, so the current
 * conversation is excluded from results unless explicitly requested.
 */
export function createConversationSearchTool(currentChatId: string | undefined) {
  return tool({
    description:
      "Search the raw text of past conversations by keyword (literal match), returning short excerpts with their session title and role. The current conversation is excluded by default (its messages are already in your context). Use this to recall a specific earlier discussion not captured by memory_search.",
    inputSchema: conversationSearchInputSchema,
    execute: async (input) => runSearch(input, currentChatId),
  });
}
