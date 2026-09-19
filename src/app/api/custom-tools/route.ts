import { NextResponse } from "next/server";
import { syslog } from "@/lib/observability/log-store";
import { listCustomTools, saveCustomTool, maskCustomToolSummary } from "@/lib/ai/custom-tools/service";

// NOTE: pagination/sorting for custom tools → skipped: in-memory list is small (<100 tools), add when tool registry grows significantly.
export async function GET() {
  const tools = listCustomTools().map(maskCustomToolSummary);
  return NextResponse.json({ tools });
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const saved = saveCustomTool(body);
    return NextResponse.json({ tool: maskCustomToolSummary(saved) }, { status: 201 });
  } catch (err) {
    syslog("warn", "custom-tools", `Error: ${err instanceof Error ? err.message : String(err)}`);
    return NextResponse.json(
      { error: "Invalid custom tool definition" },
      { status: 400 }
    );
  }
}
