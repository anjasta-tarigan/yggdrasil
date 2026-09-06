import { describe, it, expect, vi } from "vitest";
import { GET, POST } from "../chats/route";
import {
  GET as GET_BY_ID,
  DELETE as DELETE_BY_ID,
  PATCH as PATCH_BY_ID,
} from "../chats/[id]/route";

vi.mock("@/lib/chat-service", () => ({
  listChatMetadataDb: vi.fn().mockResolvedValue([
    { id: "c1", title: "Test Chat", updatedAt: 1000, pinned: false },
  ]),
  listChatsDb: vi.fn(),
  getChatDb: vi.fn().mockImplementation((id: string) => {
    if (id === "c1") {
      return Promise.resolve({
        id: "c1",
        title: "Test Chat",
        updatedAt: 1000,
        messages: [],
      });
    }
    return Promise.resolve(undefined);
  }),
  saveChatDb: vi.fn().mockResolvedValue(undefined),
  deleteChatDb: vi.fn().mockResolvedValue(undefined),
  updateChatMetaDb: vi.fn().mockImplementation((id: string) => {
    return Promise.resolve(id === "c1");
  }),
}));

describe("Chats API Handler", () => {
  it("GET /api/chats returns JSON list of stored chats", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.chats).toBeDefined();
    expect(data.chats.length).toBe(1);
    expect(data.chats[0].title).toBe("Test Chat");
  });

  it("POST /api/chats saves chat payload", async () => {
    const req = new Request("http://localhost/api/chats", {
      method: "POST",
      body: JSON.stringify({
        id: "c2",
        title: "New Chat",
        updatedAt: 2000,
        messages: [],
      }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
  });

  it("POST /api/chats rejects malformed payloads", async () => {
    const missingId = new Request("http://localhost/api/chats", {
      method: "POST",
      body: JSON.stringify({ title: "No id", messages: [] }),
    });
    expect((await POST(missingId)).status).toBe(400);

    const badMessages = new Request("http://localhost/api/chats", {
      method: "POST",
      body: JSON.stringify({ id: "c3", title: "T", messages: "nope" }),
    });
    expect((await POST(badMessages)).status).toBe(400);
  });

  it("GET /api/chats/[id] returns a single chat if found", async () => {
    const req = new Request("http://localhost/api/chats/c1");
    const res = await GET_BY_ID(req, {
      params: Promise.resolve({ id: "c1" }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.chat).toBeDefined();
    expect(data.chat.id).toBe("c1");
  });

  it("GET /api/chats/[id] returns 404 if chat not found", async () => {
    const req = new Request("http://localhost/api/chats/nonexistent");
    const res = await GET_BY_ID(req, {
      params: Promise.resolve({ id: "nonexistent" }),
    });
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toBe("Chat not found");
  });

  it("DELETE /api/chats/[id] deletes chat", async () => {
    const req = new Request("http://localhost/api/chats/c1", {
      method: "DELETE",
    });
    const res = await DELETE_BY_ID(req, {
      params: Promise.resolve({ id: "c1" }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
  });

  it("PATCH /api/chats/[id] updates chat metadata", async () => {
    const req = new Request("http://localhost/api/chats/c1", {
      method: "PATCH",
      body: JSON.stringify({ title: "Renamed", pinned: true }),
    });
    const res = await PATCH_BY_ID(req, {
      params: Promise.resolve({ id: "c1" }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
  });

  it("PATCH /api/chats/[id] returns 404 for unknown chats", async () => {
    const req = new Request("http://localhost/api/chats/missing", {
      method: "PATCH",
      body: JSON.stringify({ pinned: true }),
    });
    const res = await PATCH_BY_ID(req, {
      params: Promise.resolve({ id: "missing" }),
    });
    expect(res.status).toBe(404);
  });

  it("PATCH /api/chats/[id] rejects invalid payloads", async () => {
    const badType = new Request("http://localhost/api/chats/c1", {
      method: "PATCH",
      body: JSON.stringify({ pinned: "yes" }),
    });
    expect(
      (await PATCH_BY_ID(badType, { params: Promise.resolve({ id: "c1" }) }))
        .status
    ).toBe(400);

    const empty = new Request("http://localhost/api/chats/c1", {
      method: "PATCH",
      body: JSON.stringify({}),
    });
    expect(
      (await PATCH_BY_ID(empty, { params: Promise.resolve({ id: "c1" }) }))
        .status
    ).toBe(400);
  });
});

