import {
  convertToModelMessages,
  createUIMessageStreamResponse,
  streamText,
  toUIMessageStream,
  type UIMessage,
} from "ai";
import { defaultModel, llm } from "@/lib/ai/provider";

export async function POST(req: Request) {
  const { messages, model }: { messages: UIMessage[]; model?: string } =
    await req.json();

  const result = streamText({
    model: model ? llm.chatModel(model) : defaultModel,
    system:
      "You are Yggdrasil, a helpful personal AI assistant. Be concise and direct.",
    messages: await convertToModelMessages(messages),
  });

  return createUIMessageStreamResponse({
    stream: toUIMessageStream({ stream: result.stream }),
  });
}
