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

  const input = await req.json().catch(() => ({}));
  const result = await executeHttpCustomTool(tool.execution, input);
  return NextResponse.json(result);
}
