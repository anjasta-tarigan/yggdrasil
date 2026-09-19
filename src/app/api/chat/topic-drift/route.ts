import { NextResponse } from "next/server";
import { syslog } from "@/lib/observability/log-store";


export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { text?: unknown; threshold?: unknown };
    if (!body || typeof body.text !== "string") {
      return NextResponse.json({ report: null }, { status: 400 });
    }
    const { detectTopicDrift } = await import(
      "@/lib/ai/pipeline/topic-drift-detector"
    );
    const threshold =
      typeof body.threshold === "number" ? body.threshold : undefined;
    const report = await detectTopicDrift(body.text, { threshold });
    return NextResponse.json({ report });
  } catch (err) {
    syslog("debug", "route", `Error: ${err instanceof Error ? err.message : String(err)}`);
    return NextResponse.json({ report: null }, { status: 500 });
  }
}
