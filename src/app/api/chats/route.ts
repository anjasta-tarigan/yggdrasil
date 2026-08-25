import { NextResponse } from "next/server";
import { listChatsDb, saveChatDb } from "@/lib/chat-service";

export async function GET() {
  try {
    const chats = await listChatsDb();
    return NextResponse.json({ chats });
  } catch (error) {
    console.error("[api/chats] Failed to list chats:", error);
    return NextResponse.json({ error: "Failed to load chats" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const chat = await req.json();
    await saveChatDb(chat);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[api/chats] Failed to save chat:", error);
    return NextResponse.json({ error: "Failed to save chat" }, { status: 500 });
  }
}
