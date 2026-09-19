import { NextResponse } from "next/server";
import { deleteChatsBulkDb } from "@/lib/chat-service";
import { clearChatDeviceLocation } from "@/lib/location/geocoding";

/**
 * Bulk-delete chat sessions. Body: { ids: string[] }.
 *
 * One request + one SQLite transaction for any batch size (vs N sequential
 * DELETE round-trips). chat_messages cascade via FK. Ids that no longer
 * exist are silently skipped — the sync merge treats server absence as
 * authoritative, so a stale id (deleted in another tab) must succeed, not
 * error, or the client and DB would disagree about who is right.
 */
const MAX_BULK_IDS = 500;

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (typeof body !== "object" || body === null) {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  const rawIds = (body as Record<string, unknown>).ids;
  if (!Array.isArray(rawIds) || rawIds.length === 0) {
    return NextResponse.json({ error: "ids must be a non-empty array" }, { status: 400 });
  }
  if (rawIds.length > MAX_BULK_IDS) {
    return NextResponse.json(
      { error: `ids must not exceed ${MAX_BULK_IDS} entries` },
      { status: 400 }
    );
  }

  // Strict shape: every entry must be a bounded non-empty string. One bad
  // entry rejects the whole payload — bulk deletion must never silently
  // skip a chat the user believed they deleted, nor accept junk ids.
  const ids: string[] = [];
  for (const entry of rawIds) {
    if (typeof entry !== "string" || entry.length === 0 || entry.length > 128) {
      return NextResponse.json({ error: "ids must be non-empty strings" }, { status: 400 });
    }
    ids.push(entry);
  }

  try {
    const deleted = await deleteChatsBulkDb(ids);
    clearChatDeviceLocation(ids);
    return NextResponse.json({ success: true, deleted });
  } catch (error) {
    console.error("[api/chats/bulk-delete] error:", error);
    return NextResponse.json(
      { error: "Failed to delete chats" },
      { status: 500 }
    );
  }
}
