import { NextResponse } from "next/server";
import { validateWebProviderRequest } from "./guard";
import { createSessionStore } from "@/lib/ai/web-provider/session-store";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const guardRes = validateWebProviderRequest(req);
  if (guardRes) return guardRes;

  const store = createSessionStore();
  const sessionView = await store.getSessionView("deepseek-web");

  return NextResponse.json({
    providers: [
      {
        id: "deepseek-web",
        name: "DeepSeek Web",
        experimental: true,
        enabled: true,
        models: [],
        session: sessionView,
      },
    ],
  });
}
