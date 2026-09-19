import { NextResponse } from "next/server";
import {
  getCustomToolById,
  saveCustomTool,
  deleteCustomTool,
  maskCustomToolSummary,
} from "@/lib/ai/custom-tools/service";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const tool = getCustomToolById(id);
  if (!tool) return NextResponse.json({ error: "Tool not found" }, { status: 404 });
  return NextResponse.json({ tool: maskCustomToolSummary(tool) });
}

// NOTE: partial updates via PATCH → skipped: PUT full object replacement suffices, add PATCH when field-level updates are needed.
export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const existing = getCustomToolById(id);
  if (!existing) return NextResponse.json({ error: "Tool not found" }, { status: 404 });

  try {
    const body = await req.json();
    const updated = saveCustomTool(body, id);
    return NextResponse.json({ tool: maskCustomToolSummary(updated) });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 }
    );
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const deleted = deleteCustomTool(id);
  if (!deleted) return NextResponse.json({ error: "Tool not found" }, { status: 404 });
  return NextResponse.json({ ok: true, id });
}
