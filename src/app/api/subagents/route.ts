import { NextResponse } from "next/server";
import {
  SubagentValidationError,
  createSubagent,
  deleteSubagent,
  listSubagents,
  updateSubagent,
  SUBAGENT_TOOL_REGISTRY,
} from "@/lib/ai/subagents-service";

export const dynamic = "force-dynamic";

/**
 * Subagents management endpoint.
 *
 * GET    — list configured subagents + the grantable tool registry.
 * POST   — create (body: { name, instructions, tools[], enabled?, model?,
 *           maxSteps?, description? }).
 * PATCH  — update by id (body: { id, ...fields }).
 * DELETE — remove by id (?id=sub_...).
 */

export async function GET() {
  try {
    const subagents = listSubagents();
    return NextResponse.json({ subagents, toolRegistry: SUBAGENT_TOOL_REGISTRY });
  } catch (error) {
    console.error("[api/subagents] GET error:", error);
    return NextResponse.json(
      { error: "Failed to list subagents" },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const payload = body as Record<string, unknown>;

  try {
    const subagent = await createSubagent({
      name: payload.name as string,
      instructions: payload.instructions as string,
      tools: payload.tools as never,
      enabled: typeof payload.enabled === "boolean" ? payload.enabled : undefined,
      model: typeof payload.model === "string" ? payload.model : undefined,
      maxSteps:
        typeof payload.maxSteps === "number" ? payload.maxSteps : undefined,
      description:
        typeof payload.description === "string" ? payload.description : undefined,
    });
    return NextResponse.json({ subagent }, { status: 201 });
  } catch (error) {
    if (error instanceof SubagentValidationError) {
      return NextResponse.json(
        { error: error.message, issues: error.issues },
        { status: 400 }
      );
    }
    console.error("[api/subagents] POST error:", error);
    return NextResponse.json(
      { error: "Failed to create subagent" },
      { status: 500 }
    );
  }
}

export async function PATCH(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const payload = body as Record<string, unknown>;

  if (typeof payload?.id !== "string" || payload.id.length === 0) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  const patch: Record<string, unknown> = {};
  if (payload.name !== undefined) patch.name = payload.name;
  if (payload.instructions !== undefined) patch.instructions = payload.instructions;
  if (payload.tools !== undefined) patch.tools = payload.tools;
  if (payload.enabled !== undefined) patch.enabled = payload.enabled;
  if (payload.model !== undefined) patch.model = payload.model;
  if (payload.maxSteps !== undefined) patch.maxSteps = payload.maxSteps;
  if (payload.description !== undefined) patch.description = payload.description;

  try {
    const subagent = await updateSubagent(payload.id, patch);
    if (!subagent) {
      return NextResponse.json({ error: "Subagent not found" }, { status: 404 });
    }
    return NextResponse.json({ subagent });
  } catch (error) {
    if (error instanceof SubagentValidationError) {
      return NextResponse.json(
        { error: error.message, issues: error.issues },
        { status: 400 }
      );
    }
    console.error("[api/subagents] PATCH error:", error);
    return NextResponse.json(
      { error: "Failed to update subagent" },
      { status: 500 }
    );
  }
}

export async function DELETE(req: Request) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) {
    return NextResponse.json(
      { error: "id query parameter is required" },
      { status: 400 }
    );
  }

  try {
    const removed = deleteSubagent(id);
    if (!removed) {
      return NextResponse.json({ error: "Subagent not found" }, { status: 404 });
    }
    return NextResponse.json({ deleted: removed });
  } catch (error) {
    console.error("[api/subagents] DELETE error:", error);
    return NextResponse.json(
      { error: "Failed to delete subagent" },
      { status: 500 }
    );
  }
}
