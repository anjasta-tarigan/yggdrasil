import { listModels } from "@/lib/ai/models";

export const dynamic = "force-dynamic";

/**
 * Proxies the model list from the OpenAI-compatible endpoint so the
 * client never needs the API key. Includes each model's context-window
 * limits so the UI can size the context indicator to the selected model.
 */
export async function GET() {
  const models = await listModels();
  return Response.json({ models });
}
