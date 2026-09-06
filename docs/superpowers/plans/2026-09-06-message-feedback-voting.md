# Message Feedback & Voting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add thumbs up/down feedback buttons to assistant messages in the chat view, allowing users to rate individual AI responses. Feedback is persisted to the SQLite database in message metadata and synced optimistically, with server-side persistence on chat settle.

**Architecture:** Client-side optimistic feedback toggling with `setMessages` from `useChat`, persisting feedback through the existing chat settle path. Feedback is stored as `metadata.feedback` on each assistant `UIMessage`, which flows through the existing `saveChatDb` → `chat_messages.metadata` JSON column. A dedicated API endpoint (`/api/chats/[chatId]/messages/[messageId]/feedback`) provides standalone persistence for feedback submitted on historical (already-settled) messages. No Drizzle schema migration needed — the `metadata` JSON column already exists on `chat_messages`.

**Tech Stack:** React (`useChat` from `@ai-sdk/react`), SQLite + Drizzle ORM (existing `chat_messages.metadata` JSON column), Next.js API routes (existing `/api/chats/[id]` pattern), `@phosphor-icons/react` (already in use in ChatArea).

**Spec:** This plan implements message-level feedback (thumbs up/down) for AI assistant responses, storing the user's vote so it can be used for model improvement or UI preference tracking.

## Global Constraints

- Use `@phosphor-icons/react` icons (`ThumbsUp`, `ThumbsDown`) with `size="icon-sm"` and `variant="ghost"` on `MessageAction` components to match existing Copy/Regenerate buttons.
- Feedback must be stored per-message in the `UIMessage.metadata` object, which maps to the `chat_messages.metadata` JSON column on SQLite.
- Optimistic local update via `setMessages` from `useChat` — never block the UI on a network round-trip.
- Server-side persistence must reuse the existing `saveChatDb` transaction path for settled-turn saves (no new DB writes during streaming).
- Historical message feedback (already-persisted messages) must have a dedicated API endpoint so users can rate past responses without re-saving the whole conversation.
- Follow the existing hover-revealed `MessageActions` pattern: feedback buttons appear on `group-hover:opacity-100`.
- Follow the existing test patterns in `src/app/api/__tests__/chats-api.test.ts` (Vitest + mocked services).
- No ESLint violations — respect `react-hooks/exhaustive-deps` (no suppressions without justification).
- The `metadata` field on `chat_messages` is already a JSON column — no schema migration, no `ensureColumn` needed.

---

## Task 1: Add feedback type to shared chat utilities

**Files:**
- Modify: `src/components/chat/chat-utils.ts`

**Interfaces:**
- Consumes: `UIMessage` from `ai`
- Produces: `MessageFeedback` type, `getFeedback` helper, `hasFeedback` helper

- [ ] **Step 1: Write the failing test**

Create `src/components/chat/__tests__/chat-utils-feedback.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import type { UIMessage } from "ai";
import { getFeedback, hasFeedback } from "../chat-utils";

function makeMsg(feedback?: "positive" | "negative" | null): UIMessage {
  return {
    id: "m1",
    role: "assistant",
    parts: [{ type: "text", text: "Hello" }],
    ...(feedback !== undefined
      ? { metadata: { feedback } }
      : {}),
  } as UIMessage;
}

describe("getFeedback", () => {
  it("returns the feedback value when present", () => {
    expect(getFeedback(makeMsg("positive"))).toBe("positive");
    expect(getFeedback(makeMsg("negative"))).toBe("negative");
  });

  it("returns undefined when no feedback is set", () => {
    expect(getFeedback(makeMsg(undefined))).toBeUndefined();
  });

  it("returns undefined when metadata has no feedback key", () => {
    const msg: UIMessage = {
      id: "m2", role: "assistant", parts: [], metadata: { usage: {} },
    } as UIMessage;
    expect(getFeedback(msg)).toBeUndefined();
  });
});

describe("hasFeedback", () => {
  it("returns true when feedback is positive", () => {
    expect(hasFeedback(makeMsg("positive"))).toBe(true);
  });

  it("returns true when feedback is negative", () => {
    expect(hasFeedback(makeMsg("negative"))).toBe(true);
  });

  it("returns false when feedback is null or absent", () => {
    expect(hasFeedback(makeMsg(null))).toBe(false);
    expect(hasFeedback(makeMsg(undefined))).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/components/chat/__tests__/chat-utils-feedback.test.ts`

Expected: FAIL — `getFeedback` and `hasFeedback` are not exported from `chat-utils.ts`.

- [ ] **Step 3: Write minimal implementation**

Add to `src/components/chat/chat-utils.ts`:

```typescript
/**
 * User feedback on an assistant message — "positive" for thumbs-up,
 * "negative" for thumbs-down. Stored in message metadata and persisted
 * to chat_messages.metadata on every settle save.
 */
export type MessageFeedback = "positive" | "negative";

/** Read the feedback vote stored on a message, if any. */
export function getFeedback(message: UIMessage): MessageFeedback | undefined {
  const meta = message.metadata as { feedback?: MessageFeedback } | undefined;
  const v = meta?.feedback;
  return v === "positive" || v === "negative" ? v : undefined;
}

/** True when the message carries a feedback vote. */
export function hasFeedback(message: UIMessage): boolean {
  return getFeedback(message) !== undefined;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/components/chat/__tests__/chat-utils-feedback.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/chat/__tests__/chat-utils-feedback.test.ts src/components/chat/chat-utils.ts
git commit -m "feat(feedback): add MessageFeedback type and helpers to chat-utils"
```

---

## Task 2: Add feedback persistence DB layer

**Files:**
- Modify: `src/lib/chat-service.ts`
- Modify: `src/app/api/chats/[id]/route.ts` (or create new sub-route)
- Create: `src/app/api/chats/[id]/messages/[messageId]/feedback/route.ts`

**Interfaces:**
- Consumes: `eq`, `and` from `drizzle-orm`, `chatMessages` table, `AppDatabase`
- Produces: `upsertMessageFeedbackDb` function, `PATCH /api/chats/[id]/messages/[messageId]/feedback` endpoint

- [ ] **Step 1: Write the failing test for the DB function**

Create `src/db/__tests__/feedback-db.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";
import * as schema from "../schema";
import { setupFtsAndTriggers } from "../init";
import { upsertMessageFeedbackDb } from "@/lib/chat-service";

describe("upsertMessageFeedbackDb", () => {
  let sqlite: Database.Database;
  let db: ReturnType<typeof drizzle>;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("foreign_keys = ON");
    sqlite.pragma("busy_timeout = 5000");
    setupFtsAndTriggers(sqlite);
    db = drizzle(sqlite, { schema });

    // Create a session + message to attach feedback to
    sqlite
      .prepare(
        "INSERT INTO chat_sessions (id, title, pinned, created_at, updated_at) VALUES (?, ?, 0, 1000, 1000)"
      )
      .run("sess-1", "Test Session");
    sqlite
      .prepare(
        "INSERT INTO chat_messages (id, session_id, role, content, metadata, created_at) VALUES (?, ?, ?, ?, ?, 1000)"
      )
      .run("msg-1", "sess-1", "assistant", "Hello", null, 1000);
  });

  it("inserts positive feedback on a message", async () => {
    const ok = await upsertMessageFeedbackDb("msg-1", "positive", db);
    expect(ok).toBe(true);

    const [row] = await db
      .select({ metadata: schema.chatMessages.metadata })
      .from(schema.chatMessages)
      .where(eq(schema.chatMessages.id, "msg-1"));
    const meta = JSON.parse(row.metadata ?? "{}");
    expect(meta.feedback).toBe("positive");
  });

  it("updates existing feedback to negative", async () => {
    await upsertMessageFeedbackDb("msg-1", "positive", db);
    const ok = await upsertMessageFeedbackDb("msg-1", "negative", db);
    expect(ok).toBe(true);

    const [row] = await db
      .select({ metadata: schema.chatMessages.metadata })
      .from(schema.chatMessages)
      .where(eq(schema.chatMessages.id, "msg-1"));
    const meta = JSON.parse(row.metadata ?? "{}");
    expect(meta.feedback).toBe("negative");
  });

  it("clears feedback when setting to null", async () => {
    await upsertMessageFeedbackDb("msg-1", "positive", db);
    const ok = await upsertMessageFeedbackDb("msg-1", null, db);
    expect(ok).toBe(true);

    const [row] = await db
      .select({ metadata: schema.chatMessages.metadata })
      .from(schema.chatMessages)
      .where(eq(schema.chatMessages.id, "msg-1"));
    const meta = JSON.parse(row.metadata ?? "{}");
    expect(meta.feedback).toBeUndefined();
  });

  it("returns false for a non-existent message id", async () => {
    const ok = await upsertMessageFeedbackDb("no-such-msg", "positive", db);
    expect(ok).toBe(false);
  });

  it("preserves existing metadata when setting feedback", async () => {
    sqlite
      .prepare(
        "UPDATE chat_messages SET metadata = ? WHERE id = ?",
      )
      .run(JSON.stringify({ usage: { inputTokens: 10 }, feedback: "positive" }), "msg-1");

    const ok = await upsertMessageFeedbackDb("msg-1", "negative", db);
    expect(ok).toBe(true);

    const [row] = await db
      .select({ metadata: schema.chatMessages.metadata })
      .from(schema.chatMessages)
      .where(eq(schema.chatMessages.id, "msg-1"));
    const meta = JSON.parse(row.metadata ?? "{}");
    expect(meta.feedback).toBe("negative");
    expect(meta.usage).toEqual({ inputTokens: 10 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/db/__tests__/feedback-db.test.ts`

Expected: FAIL — `upsertMessageFeedbackDb` does not exist in `chat-service.ts`.

- [ ] **Step 3: Write the DB function**

Add to `src/lib/chat-service.ts`:

```typescript
import type { MessageFeedback } from "@/components/chat/chat-utils";

/**
 * Upsert per-message feedback (thumbs up/down). The metadata JSON column
 * is read and written as a whole — SQLite has no native JSON mutation, so
 * we parse, merge, and re-stringify. Returns false when the message id
 * does not exist (no rows affected).
 */
export async function upsertMessageFeedbackDb(
  messageId: string,
  feedback: MessageFeedback | null,
  db: AppDatabase = defaultDb
): Promise<boolean> {
  const [existing] = await db
    .select({ metadata: chatMessages.metadata })
    .from(chatMessages)
    .where(eq(chatMessages.id, messageId));

  if (!existing) return false;

  const meta = (existing.metadata as Record<string, unknown> | null) ?? {};
  if (feedback === null) {
    delete meta.feedback;
  } else {
    meta.feedback = feedback;
  }

  const result = await db
    .update(chatMessages)
    .set({ metadata: JSON.stringify(meta) })
    .where(eq(chatMessages.id, messageId));

  return result.changes > 0;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/db/__tests__/feedback-db.test.ts`

Expected: PASS

- [ ] **Step 5: Write the failing API endpoint test**

Add to `src/app/api/__tests__/chats-api.test.ts` (or create a new test file `src/app/api/__tests__/message-feedback.test.ts`):

```typescript
import { describe, it, expect, vi } from "vitest";
import { PATCH } from "@/app/api/chats/[id]/messages/[messageId]/feedback/route";

vi.mock("@/lib/chat-service", () => ({
  upsertMessageFeedbackDb: vi.fn().mockResolvedValue(true),
}));

const mockedUpsert = vi.mocked(
  await import("@/lib/chat-service")
).upsertMessageFeedbackDb;

const params = (id: string, messageId: string) => ({
  params: Promise.resolve({ id, messageId }),
});

const feedbackPatch = (feedback: "positive" | "negative" | null) =>
  new Request("http://localhost/api/chats/c1/messages/m1/feedback", {
    method: "PATCH",
    body: JSON.stringify({ feedback }),
    headers: { "Content-Type": "application/json" },
  });

describe("PATCH /api/chats/[id]/messages/[messageId]/feedback", () => {
  // ... (test cases for positive, negative, null, validation, 404)
});
```

- [ ] **Step 6: Write the API route**

Create `src/app/api/chats/[id]/messages/[messageId]/feedback/route.ts`:

```typescript
import { NextResponse } from "next/server";
import { upsertMessageFeedbackDb } from "@/lib/chat-service";
import type { MessageFeedback } from "@/components/chat/chat-utils";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string; messageId: string }> }
) {
  const { id, messageId } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (typeof body !== "object" || body === null) {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  const { feedback } = body as { feedback?: unknown };
  if (feedback !== null && feedback !== "positive" && feedback !== "negative") {
    return NextResponse.json(
      { error: "feedback must be 'positive', 'negative', or null" },
      { status: 400 }
    );
  }

  try {
    const ok = await upsertMessageFeedbackDb(
      messageId,
      feedback as MessageFeedback | null
    );
    if (!ok) {
      return NextResponse.json({ error: "Message not found" }, { status: 404 });
    }
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[api/chats/[id]/messages/[messageId]/feedback] error:", error);
    return NextResponse.json({ error: "Failed to update feedback" }, { status: 500 });
  }
}
```

- [ ] **Step 7: Run API tests to verify they pass**

Run: `pnpm test src/app/api/__tests__/message-feedback.test.ts`

Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/lib/chat-service.ts src/app/api/chats/[id]/messages/[messageId]/feedback/route.ts src/db/__tests__/feedback-db.test.ts src/app/api/__tests__/message-feedback.test.ts
git commit -m "feat(feedback): add feedback DB layer and PATCH API endpoint"
```

---

## Task 3: Add feedback API client utility

**Files:**
- Modify: `src/lib/chat-storage.ts`
- Modify: `src/components/chat/__tests__/chat-utils-feedback.test.ts` (add client test)

**Interfaces:**
- Consumes: `fetch` to `/api/chats/[id]/messages/[messageId]/feedback`
- Produces: `setMessageFeedback` client function

- [ ] **Step 1: Write the failing test**

Add to `src/components/chat/__tests__/chat-utils-feedback.test.ts` (or a new `src/lib/__tests__/chat-storage-feedback.test.ts`):

```typescript
import { describe, it, expect, vi } from "vitest";

vi.mock(".../chat-storage", () => ({
  // ... existing mocks
  setMessageFeedback: vi.fn(),
}));
```

Actually, since `setMessageFeedback` is a thin fetch wrapper, test it with a mocked global `fetch`:

```typescript
// Add to a new test block in chat-utils-feedback.test.ts or a new file
describe("setMessageFeedback (API client)", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true }),
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("POSTs feedback to the correct endpoint", async () => {
    const fetchMock = vi.mocked(global.fetch);
    await setMessageFeedback("chat-1", "msg-1", "positive");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/chats/chat-1/messages/msg-1/feedback",
      expect.objectContaining({
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ feedback: "positive" }),
      })
    );
  });

  it("sends null to clear feedback", async () => {
    const fetchMock = vi.mocked(global.fetch);
    await setMessageFeedback("chat-1", "msg-1", null);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/chats/chat-1/messages/msg-1/feedback",
      expect.objectContaining({
        body: JSON.stringify({ feedback: null }),
      })
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Write the client utility**

Add to `src/lib/chat-storage.ts`:

```typescript
import type { MessageFeedback } from "@/components/chat/chat-utils";

/**
 * Persist a single message's feedback vote to the server. Used for
 * historical messages — in-flight messages persist feedback through the
 * normal chat settle path.
 */
export async function setMessageFeedback(
  chatId: string,
  messageId: string,
  feedback: MessageFeedback | null
): Promise<void> {
  const res = await fetch(
    `/api/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}/feedback`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ feedback }),
    }
  );
  if (!res.ok) {
    throw new Error(`Failed to save feedback (HTTP ${res.status})`);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

- [ ] **Step 5: Commit**

```bash
git add src/lib/chat-storage.ts src/lib/__tests__/chat-storage-feedback.test.ts
git commit -m "feat(feedback): add client-side setMessageFeedback utility"
```

---

## Task 4: Add feedback buttons to ChatArea message actions

**Files:**
- Modify: `src/components/chat/ChatArea.tsx` (the `MessageActions` block)

**Interfaces:**
- Consumes: `getFeedback`, `setMessageFeedback` from chat-utils/chat-storage
- Consumes: `setMessages` from `useChat`
- Produces: Feedback buttons with optimistic local state

- [ ] **Step 1: Write the failing test**

Create `src/components/chat/__tests__/ChatArea-feedback.test.tsx`:

```typescript
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { ChatArea } from "../ChatArea";

// Mock useChat
const mockSetMessages = vi.fn();
const mockMessages = [
  {
    id: "msg-1",
    role: "assistant",
    parts: [{ type: "text", text: "Hello" }],
  },
];

vi.mock("@ai-sdk/react", () => ({
  useChat: () => ({
    messages: mockMessages,
    sendMessage: vi.fn(),
    status: "ready",
    stop: vi.fn(),
    error: null,
    regenerate: vi.fn(),
    addToolResult: vi.fn(),
    addToolApprovalResponse: vi.fn(),
    setMessages: mockSetMessages,
  }),
}));

vi.mock("@/hooks/use-registered-models", () => ({
  useRegisteredModels: () => ({ groups: [], loading: false }),
}));

vi.mock("@/lib/chat-storage", () => ({
  setMessageFeedback: vi.fn().mockResolvedValue(undefined),
}));

describe("ChatArea feedback buttons", () => {
  it("renders thumbs up and down buttons on assistant messages", () => {
    render(<ChatArea chatId="c1" initialMessages={mockMessages as any} model={null} onSelectModel={vi.fn()} onSettled={vi.fn()} />);
    
    // Need to hover to reveal actions — in tests, hover via fireEvent
    const msg = screen.getByText("Hello").closest(".group");
    fireEvent.mouseEnter(msg!);
    
    expect(screen.getByLabelText(/thumbs up/i) || screen.getByRole("button", { name: /positive/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/thumbs down/i) || screen.getByRole("button", { name: /negative/i })).toBeInTheDocument();
  });

  it("optimistically updates local state on click", () => {
    render(<ChatArea chatId="c1" initialMessages={mockMessages as any} model={null} onSelectModel={vi.fn()} onSettled={vi.fn()} />);
    
    const msg = screen.getByText("Hello").closest(".group");
    fireEvent.mouseEnter(msg!);
    
    const thumbsUp = screen.getByRole("button", { name: /positive/i });
    fireEvent.click(thumbsUp);
    
    expect(mockSetMessages).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          id: "msg-1",
          metadata: expect.objectContaining({ feedback: "positive" }),
        }),
      ])
    );
  });

  it("toggles feedback off when clicking the same button again", () => {
    const messagesWithFeedback = [
      {
        id: "msg-1",
        role: "assistant",
        parts: [{ type: "text", text: "Hello" }],
        metadata: { feedback: "positive" },
      },
    ];
    
    mockMessages[0] = messagesWithFeedback[0] as any;
    
    render(<ChatArea chatId="c1" initialMessages={messagesWithFeedback as any} model={null} onSelectModel={vi.fn()} onSettled={vi.fn()} />);
    
    const msg = screen.getByText("Hello").closest(".group");
    fireEvent.mouseEnter(msg!);
    
    const thumbsUp = screen.getByRole("button", { name: /positive/i });
    fireEvent.click(thumbsUp);
    
    expect(mockSetMessages).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          id: "msg-1",
          metadata: { feedback: null },
        }),
      ])
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Implement the feedback buttons**

In `ChatArea.tsx`, import `ThumbsUp` and `ThumbsDown` from `@phosphor-icons/react`, and import `getFeedback` and `setMessageFeedback`:

```tsx
import { ... ThumbsUp, ThumbsDown } from "@phosphor-icons/react";
import { getFeedback, setMessageFeedback } from "./chat-utils"; // or chat-storage
```

Add a feedback handler and state inside `ChatArea`:

```tsx
// Inside ChatArea component, after setMessages is destructured:

const handleFeedback = useCallback(
  async (messageId: string, feedback: MessageFeedback | null) => {
    // Optimistically update local state
    setMessages((prev) =>
      prev.map((m) => {
        if (m.id !== messageId) return m;
        const current = getFeedback(m);
        const next = current === feedback ? null : feedback;
        return {
          ...m,
          metadata: { ...m.metadata, feedback: next },
        };
      })
    );
    // Persist to server (fire-and-forget for already-settled messages)
    try {
      await setMessageFeedback(chatId, messageId, next);
    } catch (err) {
      console.warn("Failed to save feedback:", err);
    }
  },
  [chatId, setMessages]
);
```

**Note:** `setMessages` from `useChat` updates the local UI but is NOT persisted until the next `onSettled` call. In-flight messages will carry their feedback into the settle save automatically because `saveChatDb` iterates all message metadata. For already-settled messages, `setMessageFeedback` handles server persistence independently.

Add the buttons to the `MessageActions` block (after Copy, before Regenerate):

```tsx
{message.role === "assistant" && (
  <MessageActions className="opacity-0 transition-opacity group-hover:opacity-100">
    {/* Feedback buttons */}
    <MessageAction
      label="Thumbs up"
      onClick={() => handleFeedback(message.id, "positive")}
      tooltip="Thumbs up"
    >
      <ThumbsUp
        className={cn(
          "size-3.5",
          feedback === "positive" && "fill-current text-primary"
        )}
      />
    </MessageAction>
    <MessageAction
      label="Thumbs down"
      onClick={() => handleFeedback(message.id, "negative")}
      tooltip="Thumbs down"
      className={cn(feedback === "negative" && "text-primary")}
    >
      <ThumbsDown
        className={cn(
          "size-3.5",
          feedback === "negative" && "fill-current text-primary"
        )}
      />
    </MessageAction>
    {/* Existing actions */}
    <MessageAction ...>Copy</MessageAction>
    {index === messages.length - 1 && <MessageAction ...>Regenerate</MessageAction>}
  </MessageActions>
)}
```

Compute `feedback` for each message inside the `messages.map`:

```tsx
messages.map((message, index) => {
  const feedback = getFeedback(message);
  // ... rest of rendering
```

- [ ] **Step 4: Run test to verify it passes**

- [ ] **Step 5: Run full test suite to check for regressions**

Run: `pnpm test`

- [ ] **Step 6: Commit**

```bash
git add src/components/chat/ChatArea.tsx src/components/chat/__tests__/ChatArea-feedback.test.tsx
git commit -m "feat(feedback): add thumbs up/down buttons to message actions"
```

---

## Task 5: Integration test & verification

**Files:**
- Create: `src/app/api/__tests__/feedback-integration.test.ts`

**Interfaces:**
- End-to-end: UI click → optimistic update → API call → DB read

- [ ] **Step 1: Write integration test**

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@/db/schema";
import { setupFtsAndTriggers } from "@/db/init";
import { upsertMessageFeedbackDb } from "@/lib/chat-service";

describe("Feedback integration", () => {
  let sqlite: Database.Database;
  let db: ReturnType<typeof drizzle>;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("foreign_keys = ON");
    sqlite.pragma("busy_timeout = 5000");
    setupFtsAndTriggers(sqlite);
    db = drizzle(sqlite, { schema });

    sqlite
      .prepare(
        "INSERT INTO chat_sessions (id, title, pinned, created_at, updated_at) VALUES (?, ?, 0, 1000, 1000)"
      )
      .run("chat-1", "Test Session");
    sqlite
      .prepare(
        "INSERT INTO chat_messages (id, session_id, role, content, metadata, created_at) VALUES (?, ?, ?, ?, ?, 1000)"
      )
      .run("msg-1", "chat-1", "assistant", "Hello", null, 1000);
  });

  it("stores and retrieves feedback through the full stack", async () => {
    // Simulate API endpoint call
    const ok = await upsertMessageFeedbackDb("msg-1", "positive", db);
    expect(ok).toBe(true);

    // Verify in DB
    const row = sqlite
      .prepare("SELECT metadata FROM chat_messages WHERE id = ?")
      .get("msg-1") as { metadata: string | null };
    const meta = JSON.parse(row.metadata ?? "{}");
    expect(meta.feedback).toBe("positive");
  });
});
```

- [ ] **Step 2: Run integration test**

- [ ] **Step 3: Commit**

```bash
git add src/app/api/__tests__/feedback-integration.test.ts
git commit -m "test(feedback): add integration test for full feedback flow"
```

---

## Task 6: Documentation

**Files:**
- Create: `docs/superpowers/plans/feedback-feature-notes.md` (internal notes)

- [ ] **Step 1: Document the feature design decisions**

Include:
- Why feedback lives in `message.metadata` (no schema migration needed)
- Why `setMessageFeedback` API endpoint exists separately from the settle path
- How optimistic updates work via `setMessages`
- How `saveChatDb` automatically persists feedback during settle

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/plans/feedback-feature-notes.md
git commit -m "docs(feedback): document feedback feature design decisions"
```

---

## Summary

| Task | Description | Files Touched |
|------|-------------|---------------|
| 1 | Feedback types + helpers in `chat-utils.ts` | `chat-utils.ts`, test |
| 2 | DB layer + API endpoint | `chat-service.ts`, new API route, tests |
| 3 | Client-side API utility | `chat-storage.ts`, test |
| 4 | UI buttons in `ChatArea.tsx` | `ChatArea.tsx`, test |
| 5 | Integration test | New test file |
| 6 | Documentation | New doc file |

**Total new files:** 4 (API route, 3 test files)
**Total modified files:** 4 (`chat-utils.ts`, `chat-service.ts`, `chat-storage.ts`, `ChatArea.tsx`)
**No schema migration needed** — leverages existing `metadata` JSON column on `chat_messages`.
