import { NextResponse } from "next/server";
import { listEnabledCommands } from "@/lib/plugins/lifecycle";

export const dynamic = "force-dynamic";

/** GET /api/plugins/commands — slash-commands of enabled plugins. */
export async function GET() {
  try {
    const commands = await listEnabledCommands();
    return NextResponse.json({ commands });
  } catch (error) {
    console.error("[api/plugins/commands] GET error:", error);
    return NextResponse.json({ error: "Failed to list commands" }, { status: 500 });
  }
}
