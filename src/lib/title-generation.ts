/**
 * AI-powered chat title generation.
 *
 * Uses the AI SDK's text generation with the provided model to produce a
 * concise, human-readable title from the first user message.
 *
 * On any failure (model mismatch, API error, timeout, or abort), callers
 * fall back to the deterministic `deriveTitle` — this function never throws.
 */

import { generateText, type UIMessage } from "ai";
import { syslog } from "@/lib/observability/log-store";

/** Maximum length enforced on the generated title. */
export const TITLE_MAX_LENGTH = 64;

interface GenerateChatTitleOptions {
  fallback?: string;
  abortSignal?: AbortSignal;
}

/**
 * Generate a concise chat title from the first user text.
 *
 * @param messages  The chat messages (the first user text is used).
 * @param model     A resolved AI SDK language model to use.
 * @param options   Optional fallback and abort signal.
 */
export async function generateChatTitle(
  messages: UIMessage[],
  model: Parameters<typeof generateText>[0]["model"],
  options?: GenerateChatTitleOptions
): Promise<string> {
  const fallback = options?.fallback ?? "New chat";
  const firstUser = messages.find((m) => m.role === "user");
  const userText =
    firstUser?.parts
      .filter((p) => p.type === "text")
      .map((p) => (p as { type: "text"; text: string }).text)
      .join(" ")
      .trim()
      .slice(0, 500) ?? "";

  if (!userText) return fallback;

  try {
    const { text } = await generateText({
      model,
      system: `You are a helpful assistant that writes concise, descriptive titles for conversations. You only respond with the title itself, nothing else.`,
      prompt: `Write a concise title (under 64 characters) for this conversation. The title should be short, descriptive, and capture the core intent:

"${userText}"

Title:`,
      maxOutputTokens: 32,
      temperature: 0.3,
      abortSignal: options?.abortSignal,
    });

    const trimmed = text.trim().slice(0, TITLE_MAX_LENGTH);
    return trimmed.length >= 3 ? trimmed : fallback;
  } catch (err) {
    syslog("warn", "title-generation", `generateChatTitle fallback: ${err instanceof Error ? err.message : String(err)}`);
    return fallback;
  }
}
