import {
  convertToModelMessages,
  createUIMessageStreamResponse,
  stepCountIs,
  streamText,
  toUIMessageStream,
  type UIMessage,
} from "ai";
import { defaultModel, defaultModelId, llm } from "@/lib/ai/provider";
import { listModels } from "@/lib/ai/models";
import { chatTools } from "@/lib/ai/tools";

export async function POST(req: Request) {
  const { messages, model }: { messages: UIMessage[]; model?: string } =
    await req.json();

  // Validate the requested model against the served list so a bad selection
  // fails fast with a clear message instead of an opaque upstream 404.
  if (model && model !== defaultModelId) {
    const available = await listModels();
    if (
      available.length > 0 &&
      !available.some((m) => m.id === model)
    ) {
      // Plain text: the client transport surfaces the response body verbatim
      // as the error message.
      return new Response(`Model "${model}" is not available on this server.`, {
        status: 400,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }
  }

  const result = streamText({
    model: model ? llm.chatModel(model) : defaultModel,
    system:
      "You are Yggdrasil, a helpful personal AI assistant. Be concise and direct. " +
      "You have web_search and fetch_page tools for current information; use them when a question needs up-to-date or external data, and cite the URLs you used. " +
      "For complex multi-step requests, use the manage_tasks tool to show the user a plan, and call it again as you progress to mark items in_progress or completed.\n\n" +
      "ARTIFACTS — when you produce a self-contained piece of content that the user will likely want to view as a distinct document, reuse, edit, copy, or download — rather than read once inline — wrap it in an <artifact> tag instead of a normal markdown code block.\n" +
      "Use an artifact for: code files or components longer than ~20 lines; standalone documents (reports, articles, essays, letters, guides); web pages, HTML/CSS/JS demos; React components; SVG graphics or Mermaid diagrams; structured reference content the user will save or reuse.\n" +
      "Do NOT use an artifact for: short conversational answers; short snippets (<20 lines) that only illustrate a point inline; lists/tables/brief explanations that belong in the chat flow.\n" +
      'Format: <artifact identifier="unique-slug" type="text/markdown|text/html|application/vnd.react|image/svg+xml|application/code" language="optional-lang" title="Human readable title">…full content…</artifact>\n' +
      "Rules: always give a short stable identifier slug — if you are updating a previous artifact in this conversation, reuse its EXACT identifier so it versions instead of duplicating. Put ONLY raw content inside the tag (no commentary, no surrounding markdown fences). ALWAYS end the artifact by writing the literal closing tag </artifact> exactly — never substitute another closing tag. Outside the tag respond normally with a short intro line and, if needed, a short follow-up line; do not restate the artifact's content in chat. One artifact per response unless asked for multiple distinct files.",
    messages: await convertToModelMessages(messages),
    tools: chatTools,
    // Let the model run up to 5 steps (e.g. search, then fetch a result,
    // then answer) before it must produce a final response.
    stopWhen: stepCountIs(5),
  });

  return createUIMessageStreamResponse({
    stream: toUIMessageStream({
      stream: result.stream,
      // Attach per-step token usage to the assistant message metadata so
      // the client's context-window indicator shows real numbers. The last
      // step's usage wins: its inputTokens is the full prompt of the final
      // request (whole conversation + tool results), i.e. the true context
      // size — unlike totalUsage, which sums every step and double-counts
      // the growing prompt in multi-step tool loops.
      messageMetadata: ({ part }) => {
        if (part.type === "finish-step") {
          return { usage: part.usage };
        }
        return undefined;
      },
      // Surface a readable error (including the failing model) instead of
      // the default generic "An error occurred." message.
      onError: (error) => {
        console.error("[chat] stream error:", error);
        const detail = error instanceof Error ? error.message : String(error);
        return model
          ? `Request to model "${model}" failed: ${detail}`
          : `Request failed: ${detail}`;
      },
    }),
  });
}
