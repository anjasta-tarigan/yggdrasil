import { NextResponse } from "next/server";
import { getProject, setProjectTrusted } from "@/lib/project-service";
import { validateProjectApiRequest } from "../../guard";

export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  context: { params: Promise<{ id: string }> }
) {
  const guardResponse = validateProjectApiRequest(req, { requireJsonBody: true });
  if (guardResponse) return guardResponse;

  const { id } = await context.params;
  const project = await getProject(id);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (typeof body !== "object" || body === null) {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  const payload = body as Record<string, unknown>;
  if (typeof payload.trusted !== "boolean") {
    return NextResponse.json(
      { error: "Field 'trusted' must be a boolean" },
      { status: 400 }
    );
  }

  try {
    const updated = await setProjectTrusted(id, payload.trusted);
    return NextResponse.json(updated);
  } catch (error: unknown) {
    const err = error as Error;
    return NextResponse.json(
      { error: err.message || "Failed to update project trust" },
      { status: 500 }
    );
  }
}
