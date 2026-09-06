import { NextResponse } from "next/server";
import { getSystemPersona, saveSystemPersona } from "@/lib/persona-service";
import { DEFAULT_SYSTEM_PERSONA } from "@/lib/persona/types";
import { ZodError } from "zod";

export async function GET() {
  try {
    const persona = await getSystemPersona();
    return NextResponse.json({
      persona,
      defaultPersona: DEFAULT_SYSTEM_PERSONA,
    });
  } catch (error) {
    console.error("[api/settings/persona] GET error:", error);
    return new NextResponse("Failed to load persona settings", { status: 500 });
  }
}

export async function PUT(req: Request) {
  try {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return new NextResponse("Invalid JSON body", { status: 400 });
    }

    if (!body || typeof body !== "object") {
      return new NextResponse("Request body must be an object", { status: 400 });
    }

    const payload = body as { name?: string; instructions?: string };
    const saved = await saveSystemPersona(payload);

    return NextResponse.json({
      success: true,
      persona: saved,
    });
  } catch (error) {
    if (error instanceof ZodError) {
      return NextResponse.json(
        { error: "Validation failed", details: error.issues },
        { status: 400 }
      );
    }
    console.error("[api/settings/persona] PUT error:", error);
    return new NextResponse("Failed to save persona settings", { status: 500 });
  }
}
