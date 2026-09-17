import { NextResponse } from "next/server";
import { getCustomToolById } from "@/lib/ai/custom-tools/service";
import { executeHttpCustomTool } from "@/lib/ai/custom-tools/http-executor";

// ponytail: execution timeout/abort signal pass-through → skipped: relies on http-executor default timeout, add when test runner UI supports custom test timeouts.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const tool = getCustomToolById(id);
  if (!tool) return NextResponse.json({ error: "Tool not found" }, { status: 404 });

  if (tool.execution.type !== "http") {
    return NextResponse.json({ error: "Only http execution is supported in v1." }, { status: 400 });
  }

  let input: Record<string, unknown> = {};
  const bodyText = await req.text();
  if (bodyText) {
    try {
      const parsed = JSON.parse(bodyText);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        input = parsed as Record<string, unknown>;
      }
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
  }
  const start = Date.now();
  const result = await executeHttpCustomTool(tool.execution, input);
  return NextResponse.json({ ...result, durationMs: Date.now() - start });
}
