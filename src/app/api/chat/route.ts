import {
  convertToModelMessages,
  createUIMessageStreamResponse,
  streamText,
  toUIMessageStream,
  type UIMessage,
} from "ai";
import { defaultModel, defaultModelId, llm } from "@/lib/ai/provider";
import { listModels } from "@/lib/ai/models";

export async function POST(req: Request) {
  const { messages, model }: { messages: UIMessage[]; model?: string } =
    await req.json();

  // Validate the requested model against the served list so a bad selection
  // fails fast with a clear message instead of an opaque upstream 404.
  if (model && model !== defaultModelId) {
    const available = await listModels();
    if (available.length > 0 && !available.includes(model)) {
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
      "You are Yggdrasil, a helpful personal AI assistant. Be concise and direct.",
    messages: await convertToModelMessages(messages),
  });

  return createUIMessageStreamResponse({
    stream: toUIMessageStream({
      stream: result.stream,
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
