import { NextResponse } from "next/server";
import type { UIMessage } from "ai";
import { listChatMetadataDb, saveChatDb } from "@/lib/chat-service";
import type { StoredChat } from "@/lib/chat-storage";

/**
 * GET /api/chats — lightweight chat listing. Returns session metadata
 * (id, title, pinned, updatedAt) WITHOUT message bodies so the client's
 * 60s / focus sync does not parse full _rawParts JSON for every message
 * across every chat. Full messages load via GET /api/chats/[id].
 */
export async function GET() {
  try {
    const chats = await listChatMetadataDb();
    return NextResponse.json({ chats });
  } catch (error) {
    console.error("[api/chats] Failed to list chats:", error);
    return NextResponse.json({ error: "Failed to load chats" }, { status: 500 });
  }
}

const MAX_MESSAGES = 5000;

function isMessageShape(value: unknown): value is UIMessage {
  if (typeof value !== "object" || value === null) return false;
  const m = value as Record<string, unknown>;
  return (
    typeof m.id === "string" &&
    m.id.length > 0 &&
    (m.role === "user" || m.role === "assistant" || m.role === "system") &&
    Array.isArray(m.parts)
  );
}

/** Validate an incoming chat payload; returns null when unusable. */
function sanitizeChatPayload(body: unknown): StoredChat | null {
  if (typeof body !== "object" || body === null) return null;
  const chat = body as Record<string, unknown>;

  if (typeof chat.id !== "string" || chat.id.length === 0 || chat.id.length > 128) {
    return null;
  }
  if (!Array.isArray(chat.messages) || chat.messages.length > MAX_MESSAGES) {
    return null;
  }
  const messages = chat.messages.filter(isMessageShape);

  const title =
    typeof chat.title === "string" && chat.title.trim()
      ? chat.title.trim().slice(0, 120)
      : "Untitled chat";

  return {
    id: chat.id,
    title,
    updatedAt: typeof chat.updatedAt === "number" ? chat.updatedAt : Date.now(),
    messages,
    pinned: chat.pinned === true ? true : undefined,
  };
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const chat = sanitizeChatPayload(body);
  if (!chat) {
    return NextResponse.json({ error: "Invalid chat payload" }, { status: 400 });
  }

  try {
    await saveChatDb(chat);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[api/chats] Failed to save chat:", error);
    return NextResponse.json({ error: "Failed to save chat" }, { status: 500 });
  }
}
