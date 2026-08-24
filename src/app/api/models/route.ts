import { listModels } from "@/lib/ai/models";

export const dynamic = "force-dynamic";

/**
 * Proxies the model list from the OpenAI-compatible endpoint so the
 * client never needs the API key. Returns a simplified list of ids.
 */
export async function GET() {
  const models = await listModels();
  return Response.json({ models });
}
