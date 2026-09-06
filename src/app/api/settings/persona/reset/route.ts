import { NextResponse } from "next/server";
import { resetSystemPersona } from "@/lib/persona-service";

export async function POST() {
  try {
    const reset = await resetSystemPersona();
    return NextResponse.json({
      success: true,
      persona: reset,
    });
  } catch (error) {
    console.error("[api/settings/persona/reset] POST error:", error);
    return new NextResponse("Failed to reset persona settings", { status: 500 });
  }
}
