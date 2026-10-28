/**
 * AI-powered chat title generation.
 *
 * Produces a short, descriptive title from a user message plus the
 * assistant's reply to it — the reply is what makes the title describe the
 * actual topic instead of parroting the opening question.
 *
 * `scope: "first"` uses the opening exchange (the first title), while
 * `scope: "recent"` uses the latest exchange (a re-title after the
 * conversation moves to a new topic).
 *
 * On any failure (model mismatch, API error, timeout, abort, or an
 * unusable completion) callers fall back to the deterministic
 * `deriveTitle` — this function never throws.
 */

import { generateText, type UIMessage } from "ai";
import { syslog } from "@/lib/observability/log-store";

/** Maximum length enforced on the stored title. */
export const TITLE_MAX_LENGTH = 64;

/** What the model is asked to stay under. */
const TITLE_TARGET_LENGTH = 48;

/** How much of each message is sent to the model. */
const USER_CONTEXT_CHARS = 600;
const ASSISTANT_CONTEXT_CHARS = 400;

export type TitleScope = "first" | "recent";

interface GenerateChatTitleOptions {
  fallback?: string;
  abortSignal?: AbortSignal;
  /** Which exchange to summarise. Defaults to the opening one. */
  scope?: TitleScope;
}

function messageText(message: UIMessage | undefined): string {
  if (!message) return "";
  return message.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The user message + the assistant reply that follows it. For "first"
 * these are the opening turns; for "recent" the latest pair.
 */
function pickExchange(
  messages: UIMessage[],
  scope: TitleScope
): { user: string; assistant: string } {
  const userIndexes = messages
    .map((m, i) => (m.role === "user" && messageText(m) ? i : -1))
    .filter((i) => i >= 0);

  if (userIndexes.length === 0) return { user: "", assistant: "" };

  const userIdx = scope === "recent" ? userIndexes[userIndexes.length - 1] : userIndexes[0];

  const reply = messages
    .slice(userIdx + 1)
    .find((m) => m.role === "assistant" && messageText(m));

  return {
    user: messageText(messages[userIdx]).slice(0, USER_CONTEXT_CHARS),
    assistant: messageText(reply).slice(0, ASSISTANT_CONTEXT_CHARS),
  };
}

/**
 * Normalise a raw completion into a bare title: first non-empty line,
 * no code fences/headings/quotes/backticks/"Title:" prefix, no trailing
 * sentence punctuation, word-boundary truncation.
 */
export function cleanGeneratedTitle(raw: string): string {
  const firstLine =
    raw
      .replace(/\r/g, "")
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "";

  let text = firstLine
    .replace(/^```[a-z0-9_-]*\s*/i, "")
    .replace(/^#{1,6}\s*/, "")
    .replace(/^(?:chat\s+)?(?:title|judul)\s*[:\-–—]\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();

  // Strip wrapping quotes/backticks/emphasis and trailing sentence
  // punctuation in any order, so `Title: "X".` and `"X"` both end as `X`.
  for (let pass = 0; pass < 3; pass += 1) {
    const before = text;
    text = text
      .replace(/^["'`“”‘’«»*_~]+\s*/, "")
      .replace(/\s*["'`“”‘’«»*_~]+$/, "")
      .replace(/[.,;:!?。]+$/, "")
      .trim();
    if (text === before) break;
  }

  if (text.length > TITLE_MAX_LENGTH) {
    const cut = text.slice(0, TITLE_MAX_LENGTH);
    const lastSpace = cut.lastIndexOf(" ");
    text = (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trim();
  }

  return text;
}

/** A completion that describes the prompt instead of titling it. */
function isMetaComment(title: string): boolean {
  return /^(?:the user|user is|the conversation|this conversation|the chat|conversation is)\b/i.test(
    title
  );
}

/**
 * Generate a concise chat title from one exchange.
 *
 * @param messages  The chat messages.
 * @param model     A resolved AI SDK language model to use.
 * @param options   Fallback, abort signal, and which exchange to use.
 */
export async function generateChatTitle(
  messages: UIMessage[],
  model: Parameters<typeof generateText>[0]["model"],
  options?: GenerateChatTitleOptions
): Promise<string> {
  const fallback = options?.fallback ?? "New chat";
  const { user, assistant } = pickExchange(messages, options?.scope ?? "first");

  if (!user) return fallback;

  try {
    const result = await generateText({
      model,
      instructions: `You name chat conversations. Reply with the title only — no quotes, no markdown, no "Title:" prefix, no closing punctuation.

Rules:
- 3 to 6 words, at most ${TITLE_TARGET_LENGTH} characters.
- Write in the same language as the user.
- Name the concrete topic or goal, not the fact that it is a question.
- Describe what the conversation is about, not how the user phrased it.
- Do not copy the user's message verbatim.`,
      prompt: `Conversation excerpt.

User:
${user}

Assistant:
${assistant || "(no reply yet)"}

Write the title of this conversation.`,
      maxOutputTokens: 256,
      temperature: 0.2,
      abortSignal: options?.abortSignal,
    });

    // Only the text channel is a title. Reasoning output is deliberately
    // ignored: it is a thinking trace, not a title.
    const candidate = cleanGeneratedTitle(result.text);

    if (candidate.length < 3 || isMetaComment(candidate)) {
      return fallback;
    }
    return candidate;
  } catch (err) {
    syslog(
      "warn",
      "title-generation",
      `generateChatTitle fallback: ${err instanceof Error ? err.message : String(err)}`
    );
    return fallback;
  }
}
