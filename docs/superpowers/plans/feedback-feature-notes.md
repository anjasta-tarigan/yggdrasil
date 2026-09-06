# Message Feedback Architecture and Feature Notes

Internal technical documentation for the message feedback (thumbs up / thumbs down voting) feature implemented on AI assistant responses.

---

## 1. Overview

The message feedback feature allows users to rate individual assistant responses with positive (thumbs up) or negative (thumbs down) sentiment.

Key user-facing and architectural goals:
- **Assistant-scoped actions**: Feedback buttons (`ThumbsUp`, `ThumbsDown`) appear alongside existing message actions (Copy, Regenerate) on assistant message hover.
- **Toggle interaction**: Clicking an active vote toggles it off (`null`), clearing the vote.
- **Zero latency UX**: Optimistic local UI updates via `setMessages` so feedback toggles respond instantly without awaiting network responses.
- **Safe error handling**: Persistent errors are logged/warned without degrading or freezing the chat interface.

---

## 2. Architecture

### Storage in `chat_messages.metadata` JSON Column

Feedback votes are stored directly in the `metadata` JSON column of the `chat_messages` SQLite table:

```json
{
  "usage": { "inputTokens": 42, "outputTokens": 128 },
  "feedback": "positive"
}
```

- **No Schema Migration Required**: The SQLite database schema for `chat_messages` already includes a generic nullable `metadata` column (parsed and serialized as JSON). Adding feedback as a key on this existing JSON payload required no DDL statements, table alters, or schema migration files.
- **Preservation of Sibling Metadata**: Feedback upserts merge into the existing metadata object, preserving sibling properties such as `usage` (token statistics) and any custom metadata.

### Dual-Path Persistence

Feedback persistence operates across two distinct lifecycle paths:

1. **In-Flight Messages (Settle Path)**:
   - When a user votes on an assistant message in the active chat session during or immediately after generation, the feedback state is attached to the in-memory `UIMessage.metadata.feedback`.
   - When the generation finishes and the turn settles (`status === "ready"` or `status === "error"`), the existing `onSettled` / `saveChatDb` pipeline serializes all messages—including their metadata—in a single transaction.
2. **Historical Messages (Dedicated API Path)**:
   - For historical messages settled in previous turns or past sessions, re-saving the entire chat history would be unnecessary and prone to write contention.
   - A dedicated endpoint (`PATCH /api/chats/[id]/messages/[messageId]/feedback`) performs an atomic metadata read-modify-write on that single message row via `upsertMessageFeedbackDb`.

### Optimistic UI Updates via `useChat`

The UI uses `setMessages` returned by `@ai-sdk/react`'s `useChat`:

1. `handleFeedback(messageId, vote)` calculates the next feedback value (`current === vote ? null : vote`).
2. `setMessages` updates the target message's `metadata.feedback` immediately in local React state.
3. A background call to `setMessageFeedback(chatId, messageId, next)` persists the change to the API.
4. Any rejected promise from `setMessageFeedback` is caught and logged as a warning (`console.warn`) rather than crashing or reverting state.

### Toggle Behavior

Clicking an unselected feedback button applies that vote (`"positive"` or `"negative"`). Clicking an already-selected vote removes it, sending `null` to clear the vote from metadata:

```
[None] ──(Click ThumbsUp)──> [positive] ──(Click ThumbsUp)──> [null / None]
[None] ──(Click ThumbsDown)─> [negative] ──(Click ThumbsDown)─> [null / None]
[positive] ──(Click ThumbsDown)─> [negative]
```

---

## 3. API Reference

### `PATCH /api/chats/[id]/messages/[messageId]/feedback`

Updates or clears the feedback vote on an individual settled chat message.

#### Route Handler Location
`src/app/api/chats/[id]/messages/[messageId]/feedback/route.ts`

#### Request
- **Method**: `PATCH`
- **Headers**: `Content-Type: application/json`
- **Path Parameters**:
  - `id`: Chat session ID
  - `messageId`: ID of the target message
- **Body**:
  ```json
  {
    "feedback": "positive" | "negative" | null
  }
  ```

#### Validation
- Returns `400 Bad Request` if the body is not valid JSON or not an object.
- Returns `400 Bad Request` if the `feedback` key is missing from the payload.
- Returns `400 Bad Request` if `feedback` is not one of `"positive"`, `"negative"`, or `null`.

#### Response
- **Success (`200 OK`)**:
  ```json
  {
    "success": true
  }
  ```
- **Message Not Found (`404 Not Found`)**:
  ```json
  {
    "error": "Message not found"
  }
  ```
- **Invalid Payload (`400 Bad Request`)**:
  ```json
  {
    "error": "feedback must be 'positive', 'negative', or null"
  }
  ```
- **Server Error (`500 Internal Server Error`)**:
  ```json
  {
    "error": "Failed to update feedback"
  }
  ```

---

## 4. Database Layer

### `upsertMessageFeedbackDb`
Located in `src/lib/chat-service.ts`:

```typescript
export async function upsertMessageFeedbackDb(
  messageId: string,
  feedback: "positive" | "negative" | null,
  db: AppDatabase = defaultDb
): Promise<boolean>
```

#### Behavior:
1. Queries `chat_messages` table for the existing `metadata` column matching `messageId`.
2. Returns `false` if no row matches.
3. Parses existing metadata into an object or defaults to `{}`.
4. If `feedback === null`, removes the `feedback` property (`delete meta.feedback`) to prevent stale null keys from polluting stored JSON.
5. If `feedback` is `"positive"` or `"negative"`, sets `meta.feedback = feedback`.
6. Updates `chat_messages.metadata` with the updated JSON payload.
7. Returns `true` if `result.changes > 0`.
8. Accepts an optional `db` parameter (supporting custom Drizzle database instances or in-memory SQLite instances for testing).

---

## 5. Component and Utility Changes

### `ChatArea.tsx`
Located in `src/components/chat/ChatArea.tsx`:
- Imports `ThumbsUp` and `ThumbsDown` icons from `@phosphor-icons/react`.
- Extends the `MessageActions` hover block on assistant messages with:
  - Thumbs up button: `label="Good response"`, toggles `"positive"`, highlights with `text-primary` and `weight="fill"` when active.
  - Thumbs down button: `label="Bad response"`, toggles `"negative"`, highlights with `text-primary` and `weight="fill"` when active.
- Uses `handleFeedback` callback to execute optimistic `setMessages` and call `setMessageFeedback`.

### `chat-utils.ts`
Located in `src/components/chat/chat-utils.ts`:
- **`MessageFeedback`**: TypeScript type union `"positive" | "negative"`.
- **`getFeedback(message: UIMessage): MessageFeedback | undefined`**: Safely extracts the feedback string if present and valid; returns `undefined` otherwise.
- **`hasFeedback(message: UIMessage): boolean`**: Helper returning boolean check for non-null feedback.

### `chat-storage.ts`
Located in `src/lib/chat-storage.ts`:
- **`setMessageFeedback(chatId: string, messageId: string, feedback: MessageFeedback | null): Promise<void>`**:
  - Sends the `PATCH` request to `/api/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}/feedback`.
  - Sets `Content-Type: application/json`.
  - Throws an descriptive error if the response is not `res.ok`.

---

## 6. Testing

All components and workflows are covered by unit and integration test suites:

### Unit Tests
1. **`src/components/chat/__tests__/chat-utils-feedback.test.ts`**:
   - Tests `getFeedback` and `hasFeedback` with positive, negative, null, undefined, and arbitrary metadata values.
2. **`src/db/__tests__/feedback-db.test.ts`**:
   - Tests `upsertMessageFeedbackDb` with in-memory SQLite database (`better-sqlite3` + Drizzle).
   - Verifies positive/negative setting, overwriting votes, clearing votes (`null`), preserving other metadata keys (`usage`), and handling missing messages.
3. **`src/app/api/__tests__/message-feedback-api.test.ts`**:
   - Tests `PATCH /api/chats/[id]/messages/[messageId]/feedback` route handler.
   - Verifies 200 on success, 400 on malformed body, missing fields, or invalid values, 404 when message not found, and 500 on database errors.
4. **`src/lib/__tests__/chat-storage-feedback.test.ts`**:
   - Tests client utility `setMessageFeedback`.
   - Verifies correct URL path, method, headers, JSON body serialization, and error throwing on non-OK responses.

### Integration Tests
1. **`src/app/api/__tests__/feedback-integration.test.ts`**:
   - End-to-end integration test validating the lifecycle in an actual SQLite database instance.
   - Tests the full state transition: `positive` -> `negative` (overwrite) -> `null` (cleared) while validating that token usage metadata remains intact throughout each operation.
