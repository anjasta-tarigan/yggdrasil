import { NextResponse } from "next/server";
import { getChatDb, deleteChatDb } from "@/lib/chat-service";

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

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    await deleteChatDb(id);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[api/chats/[id]] DELETE error:", error);
    return NextResponse.json({ error: "Failed to delete chat" }, { status: 500 });
  }
}
