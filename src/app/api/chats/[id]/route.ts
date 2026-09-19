import { NextResponse } from "next/server";
import { getChatDb, deleteChatDb, updateChatMetaDb } from "@/lib/chat-service";
import { clearChatDeviceLocation } from "@/lib/location/geocoding";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const chat = await getChatDb(id);
    if (!chat) {
      return NextResponse.json({ error: "Chat not found" }, { status: 404 });
    }
    return NextResponse.json({ chat });
  } catch (error) {
    console.error("[api/chats/[id]] GET error:", error);
    return NextResponse.json({ error: "Failed to load chat" }, { status: 500 });
  }
}

/**
 * Update chat metadata (title and/or pinned) without touching messages.
 * Body: { title?: string, pinned?: boolean }
 */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

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
  const patch: { title?: string; pinned?: boolean } = {};
  if (payload.title !== undefined) {
    if (typeof payload.title !== "string") {
      return NextResponse.json({ error: "Invalid title" }, { status: 400 });
    }
    patch.title = payload.title;
  }
  if (payload.pinned !== undefined) {
    if (typeof payload.pinned !== "boolean") {
      return NextResponse.json({ error: "Invalid pinned" }, { status: 400 });
    }
    patch.pinned = payload.pinned;
  }
  if (patch.title === undefined && patch.pinned === undefined) {
    return NextResponse.json(
      { error: "Nothing to update" },
      { status: 400 }
    );
  }

  try {
    const updated = await updateChatMetaDb(id, patch);
    if (!updated) {
      return NextResponse.json({ error: "Chat not found" }, { status: 404 });
    }
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[api/chats/[id]] PATCH error:", error);
    return NextResponse.json(
      { error: "Failed to update chat" },
      { status: 500 }
    );
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    await deleteChatDb(id);
    clearChatDeviceLocation(id);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[api/chats/[id]] DELETE error:", error);
    return NextResponse.json({ error: "Failed to delete chat" }, { status: 500 });
  }
}
