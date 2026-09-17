import { NextResponse } from "next/server";
import { listCustomTools, saveCustomTool, maskCustomToolSummary } from "@/lib/ai/custom-tools/service";

// ponytail: pagination/sorting for custom tools → skipped: in-memory list is small (<100 tools), add when tool registry grows significantly.
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
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 }
    );
  }
}
