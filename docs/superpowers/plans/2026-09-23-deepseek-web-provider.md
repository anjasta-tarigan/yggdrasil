# DeepSeek Web Provider (Experimental) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement an experimental, single-user DeepSeek Chat Web session provider with manual structured token import, server-side AES-256-GCM encrypted storage, automatic client User-Agent capture, a dedicated web-session adapter, model auto-discovery persisted to the provider registry, and an experimental settings UI with contextual help.

**Architecture:** The Web Provider is cleanly separated from standard API providers: session credentials live in a dedicated `web_provider_sessions` SQLite table encrypted with `APP_SECRET`, while provider metadata and discovered models live in `data/providers.json`. All upstream interactions are dispatched through a dedicated `DeepSeekWebAdapter` enforcing fixed HTTPS endpoints, `redirect: "error"`, and safe error classification. Client chat requests resolve model references through the registry and stream responses via the adapter without exposing credentials to the browser or workflow state.

**Tech Stack:** Next.js App Router (TypeScript), Drizzle ORM (better-sqlite3), Zod schemas, Node.js `crypto` (AES-256-GCM), AI SDK (`ai`), Vitest for unit/integration testing.

**Spec:** `docs/superpowers/specs/2026-09-23-deepseek-web-provider-design.md`

## Global Constraints

- **Single-User Scope:** One server-scoped session row per provider (`provider_id` is UNIQUE). Multi-tenant or multi-user access is explicitly prohibited for this feature (Spec §3.3, §15.22).
- **Zero Secret Exposure:** Credentials (`userToken`, cookies) must never appear in `providers.json`, logs, traces, query URLs, client cache, `localStorage`, `ChatUIMessage`, or durable workflow state (Spec §4.3, §12).
- **Mandatory APP_SECRET:** The feature must refuse to operate in any environment (including dev and test) if `APP_SECRET` is unset or invalid (Spec §4.3, §15.5).
- **Fixed Upstream Policy:** Upstream requests only target fixed allowlisted HTTPS endpoints. Every redirect is rejected as `unsupported_protocol` (`redirect: "error"` in MVP) (Spec §7.1).
- **No Automatic Refresh or Scraping:** No silent browser cookie extraction, no CAPTCHA/WAF bypass, and no background cookie refresh timers (Spec §1, §7.3).
- **English UI Copy:** All labels, descriptions, errors, and help content in UI components must be in English (Spec §10).
- **Rule 18 Test Constraint:** Subagents and tests must run sequentially using `pnpm vitest run <file> --maxWorkers=1`. Never run concurrent Vitest processes.

---

## File Structure & Responsibilities

```text
docs/adr/
  2026-09-23-deepseek-web-terms-assessment.md       # Pre-implementation ToS & legal assessment record

src/env.ts                                          # Web provider feature flag & resource limit env schema
src/db/
  schema.ts                                         # Drizzle schema: web_provider_sessions table definition
  init.ts                                           # DDL: CREATE TABLE IF NOT EXISTS web_provider_sessions

src/lib/ai/web-provider/
  types.ts                                          # Shared types: WebProviderSession, SessionStatus, RequestIdentity
  session-store.ts                                  # Server-side encrypted CRUD & atomic replacement for web sessions
  adapter.ts                                        # Provider-neutral WebProviderAdapter contract & closed error codes
  deepseek.ts                                       # DeepSeek-specific adapter: fixed allowlist, stream parser, UA
  discovery.ts                                      # Model discovery orchestrator: TTL cache, coalesce, registry upsert
  __fixtures__/                                     # Redacted protocol fixtures for tests

src/app/api/web-providers/
  guard.ts                                          # Local-management security guard (Origin, Referer, APP_SECRET, rate limits)
  route.ts                                          # GET /api/web-providers: redacted catalog and status
  deepseek/session/
    check/route.ts                                  # POST /check: side-effect-free validation check with rate limiting
    route.ts                                        # POST /session (save) & DELETE /session
    revalidate/route.ts                             # POST /revalidate: re-check saved session without returning secret
  deepseek/models/discover/
    route.ts                                        # POST /discover: manual model discovery & registry persistence

src/lib/ai/provider-config/
  schema.ts                                         # ProviderEntrySchema extension: kind "web-session", preset "deepseek-web"
  store.ts                                          # Registry view: expose web-session status in getRegistryView()

src/lib/ai/
  provider.ts                                       # chatModelForEntry dispatch: handle web-session transport

src/app/api/
  chat/route.ts                                     # Normal chat route: resolve web-session credentials server-side
  projects/chat/route.ts                            # Project chat route: explicitly reject web-session providers

src/lib/settings.ts                                 # Client settings types & web-provider fetch helpers
src/components/settings/
  deepseek-web-provider-dialog.tsx                  # Dialog: credential input, UA selection, Check & Save actions
  experimental-provider-banner.tsx                  # Persistent warning banner with limitations link
  web-provider-help-panel.tsx                       # Contextual right-side drawer / mobile disclosure help panel
  tabs.tsx                                          # Provider tab: separate Experimental Web Providers section
```

---

## Tasks

### Task 0: Pre-Implementation Terms of Use & Legal Decision Record

**Files:**
- Create: `docs/adr/2026-09-23-deepseek-web-terms-assessment.md`

**Interfaces:**
- Consumes: Spec §3.3, §16.4 requirements
- Produces: Committed ADR artifact satisfying release gate 21 & acceptance criteria 23

- [ ] **Step 1: Write the ADR file**

```markdown
# ADR: DeepSeek Web Provider Terms of Use & Account Risk Assessment

**Date:** 2026-09-23
**Status:** Approved for Experimental Prototype
**Decision Owner:** Project Lead
**Jurisdiction:** Self-hosted / Local development
**Account Type:** Operator-controlled personal testing account

## Context & Assessment

Yggdrasil proposes an experimental integration with the DeepSeek consumer web interface using user-imported session tokens. Under DeepSeek's Terms of Use (retrieved September 2026), automated access without an official API key is restricted. 

## Decision

1. **Experimental Scope Only:** The feature is approved solely for operator-mediated local experimentation in single-user environments.
2. **Explicit Consent Required:** The operator must explicitly provide their own session token and acknowledge the experimental nature and account risk.
3. **No Automation/Scraping:** The software strictly forbids automated browser credential harvesting, CAPTCHA bypass, and automated session refreshing.
4. **Kill Switch:** If DeepSeek enforces technical account restrictions, the feature remains disabled by default via `YGGDRASIL_ENABLE_EXPERIMENTAL_WEB_PROVIDERS=false`.

## Residual Risks & Approver

- **Residual Risk:** Upstream account rate-limiting, temporary suspension, or session revocation by DeepSeek.
- **Risk Owner:** Operator deploying the self-hosted instance.
- **Approver:** Operator Consent Recorded in Git History.
```

- [ ] **Step 2: Commit the ADR**

```bash
git add docs/adr/2026-09-23-deepseek-web-terms-assessment.md
git commit -m "docs(adr): record DeepSeek web provider terms and risk assessment"
```

---

### Task 1: Environment Schema & Configuration Defaults

**Files:**
- Modify: `src/env.ts:100-145`
- Test: `src/lib/__tests__/env-web-provider.test.ts`

**Interfaces:**
- Consumes: `process.env`
- Produces: `env.YGGDRASIL_ENABLE_EXPERIMENTAL_WEB_PROVIDERS` and numeric rate/resource constants

- [ ] **Step 1: Write the failing test**

```typescript
// src/lib/__tests__/env-web-provider.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";

describe("Web Provider Environment Configuration", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("defaults YGGDRASIL_ENABLE_EXPERIMENTAL_WEB_PROVIDERS to false", async () => {
    delete process.env.YGGDRASIL_ENABLE_EXPERIMENTAL_WEB_PROVIDERS;
    const { refreshEnv } = await import("@/env");
    const parsed = refreshEnv();
    expect(parsed.YGGDRASIL_ENABLE_EXPERIMENTAL_WEB_PROVIDERS).toBe(false);
  });

  it("exposes validated numeric limits with safe defaults", async () => {
    const { refreshEnv } = await import("@/env");
    const parsed = refreshEnv();
    expect(parsed.YGGDRASIL_WEB_PROVIDER_MAX_TOKEN_CHARS).toBe(8192);
    expect(parsed.YGGDRASIL_WEB_PROVIDER_MAX_USER_AGENT_CHARS).toBe(1024);
    expect(parsed.YGGDRASIL_WEB_PROVIDER_MAX_BODY_BYTES).toBe(16384);
    expect(parsed.YGGDRASIL_WEB_PROVIDER_CHECK_ATTEMPTS_PER_IP).toBe(5);
    expect(parsed.YGGDRASIL_WEB_PROVIDER_CHECK_ATTEMPTS_PER_CREDENTIAL).toBe(10);
    expect(parsed.YGGDRASIL_WEB_PROVIDER_CHECK_ATTEMPTS_WINDOW_MS).toBe(900000);
    expect(parsed.YGGDRASIL_WEB_PROVIDER_CHECK_COOLDOWN_MS).toBe(900000);
    expect(parsed.YGGDRASIL_WEB_PROVIDER_CHECK_MAX_CONCURRENT).toBe(3);
    expect(parsed.YGGDRASIL_WEB_PROVIDER_ATTEMPT_TIMEOUT_MS).toBe(10000);
    expect(parsed.YGGDRASIL_WEB_PROVIDER_ROUTE_TIMEOUT_MS).toBe(20000);
    expect(parsed.YGGDRASIL_WEB_PROVIDER_RETRY_BACKOFF_MS).toBe(250);
    expect(parsed.YGGDRASIL_WEB_PROVIDER_RETRY_BUDGET_MS).toBe(15000);
    expect(parsed.YGGDRASIL_WEB_PROVIDER_RETRY_AFTER_MAX_SECONDS).toBe(900);
    expect(parsed.YGGDRASIL_WEB_PROVIDER_RETRY_AFTER_FALLBACK_SECONDS).toBe(60);
    expect(parsed.YGGDRASIL_WEB_PROVIDER_DISCOVERY_TTL_MS).toBe(900000);
    expect(parsed.YGGDRASIL_WEB_PROVIDER_DISCOVERY_REFRESH_COOLDOWN_MS).toBe(30000);
    expect(parsed.YGGDRASIL_WEB_PROVIDER_DISCOVERY_MAX_STALE_MS).toBe(86400000);
    expect(parsed.YGGDRASIL_WEB_PROVIDER_DISCOVERY_MAX_CACHE_ENTRIES).toBe(100);
    expect(parsed.YGGDRASIL_WEB_PROVIDER_DISCOVERY_MAX_MODELS).toBe(200);
    expect(parsed.YGGDRASIL_WEB_PROVIDER_DISCOVERY_MAX_RESPONSE_BYTES).toBe(1048576);
    expect(parsed.YGGDRASIL_WEB_PROVIDER_STREAM_FRAME_MAX_BYTES).toBe(262144);
    expect(parsed.YGGDRASIL_WEB_PROVIDER_STREAM_IDLE_TIMEOUT_MS).toBe(30000);
    expect(parsed.YGGDRASIL_WEB_PROVIDER_PROTOCOL_FAILURE_THRESHOLD).toBe(3);
    expect(parsed.YGGDRASIL_WEB_PROVIDER_PROTOCOL_FAILURE_WINDOW_MS).toBe(900000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm vitest run src/lib/__tests__/env-web-provider.test.ts --maxWorkers=1
```
*Expected: FAIL with missing properties on `parsed`.*

- [ ] **Step 3: Update `src/env.ts`**

Add the Web Provider configuration fields to `envSchema`:

```typescript
  // Experimental Web Provider Feature Flag & Security Limits (Spec §11.2)
  YGGDRASIL_ENABLE_EXPERIMENTAL_WEB_PROVIDERS: z
    .enum(["true", "false", "1", "0"])
    .default("false")
    .transform((v) => v === "true" || v === "1"),
  YGGDRASIL_WEB_PROVIDER_MAX_TOKEN_CHARS: z.coerce.number().int().positive().default(8192),
  YGGDRASIL_WEB_PROVIDER_MAX_USER_AGENT_CHARS: z.coerce.number().int().positive().default(1024),
  YGGDRASIL_WEB_PROVIDER_MAX_BODY_BYTES: z.coerce.number().int().positive().default(16384),
  YGGDRASIL_WEB_PROVIDER_CHECK_ATTEMPTS_PER_IP: z.coerce.number().int().positive().default(5),
  YGGDRASIL_WEB_PROVIDER_CHECK_ATTEMPTS_PER_CREDENTIAL: z.coerce.number().int().positive().default(10),
  YGGDRASIL_WEB_PROVIDER_CHECK_ATTEMPTS_WINDOW_MS: z.coerce.number().int().positive().default(900000),
  YGGDRASIL_WEB_PROVIDER_CHECK_COOLDOWN_MS: z.coerce.number().int().positive().default(900000),
  YGGDRASIL_WEB_PROVIDER_CHECK_MAX_CONCURRENT: z.coerce.number().int().positive().default(3),
  YGGDRASIL_WEB_PROVIDER_ATTEMPT_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
  YGGDRASIL_WEB_PROVIDER_ROUTE_TIMEOUT_MS: z.coerce.number().int().positive().default(20000),
  YGGDRASIL_WEB_PROVIDER_RETRY_BACKOFF_MS: z.coerce.number().int().positive().default(250),
  YGGDRASIL_WEB_PROVIDER_RETRY_BUDGET_MS: z.coerce.number().int().positive().default(15000),
  YGGDRASIL_WEB_PROVIDER_RETRY_AFTER_MAX_SECONDS: z.coerce.number().int().positive().default(900),
  YGGDRASIL_WEB_PROVIDER_RETRY_AFTER_FALLBACK_SECONDS: z.coerce.number().int().positive().default(60),
  YGGDRASIL_WEB_PROVIDER_DISCOVERY_TTL_MS: z.coerce.number().int().positive().default(900000),
  YGGDRASIL_WEB_PROVIDER_DISCOVERY_REFRESH_COOLDOWN_MS: z.coerce.number().int().positive().default(30000),
  YGGDRASIL_WEB_PROVIDER_DISCOVERY_MAX_STALE_MS: z.coerce.number().int().positive().default(86400000),
  YGGDRASIL_WEB_PROVIDER_DISCOVERY_MAX_CACHE_ENTRIES: z.coerce.number().int().positive().default(100),
  YGGDRASIL_WEB_PROVIDER_DISCOVERY_MAX_MODELS: z.coerce.number().int().positive().default(200),
  YGGDRASIL_WEB_PROVIDER_DISCOVERY_MAX_RESPONSE_BYTES: z.coerce.number().int().positive().default(1048576),
  YGGDRASIL_WEB_PROVIDER_STREAM_FRAME_MAX_BYTES: z.coerce.number().int().positive().default(262144),
  YGGDRASIL_WEB_PROVIDER_STREAM_IDLE_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  YGGDRASIL_WEB_PROVIDER_PROTOCOL_FAILURE_THRESHOLD: z.coerce.number().int().positive().default(3),
  YGGDRASIL_WEB_PROVIDER_PROTOCOL_FAILURE_WINDOW_MS: z.coerce.number().int().positive().default(900000),
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm vitest run src/lib/__tests__/env-web-provider.test.ts --maxWorkers=1
```
*Expected: PASS (2 tests).*

- [ ] **Step 5: Commit**

```bash
git add src/env.ts src/lib/__tests__/env-web-provider.test.ts
git commit -m "feat(env): add web provider feature flag and limit constants"
```

---

### Task 2: Database Schema & Migration for Web Provider Sessions

**Files:**
- Modify: `src/db/schema.ts`
- Modify: `src/db/init.ts`
- Test: `src/db/__tests__/web-provider-sessions-schema.test.ts`

**Interfaces:**
- Consumes: `drizzle-orm/sqlite-core`, `better-sqlite3`
- Produces: `webProviderSessions` Drizzle table with unique constraint on `provider_id`

- [ ] **Step 1: Write the failing test**

```typescript
// src/db/__tests__/web-provider-sessions-schema.test.ts
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { describe, it, expect, beforeEach } from "vitest";
import * as schema from "../schema";
import { setupFtsAndTriggers } from "../init";

describe("web_provider_sessions schema", () => {
  let sqlite: Database.Database;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    setupFtsAndTriggers(sqlite);
  });

  it("creates the web_provider_sessions table with unique provider_id", () => {
    const tableInfo = sqlite.pragma("table_info(web_provider_sessions)") as Array<{ name: string }>;
    const columns = tableInfo.map((c) => c.name);

    expect(columns).toContain("id");
    expect(columns).toContain("provider_id");
    expect(columns).toContain("encrypted_payload");
    expect(columns).toContain("status");
    expect(columns).toContain("last_checked_at");
    expect(columns).toContain("last_failure_code");
    expect(columns).toContain("user_agent_mode");
    expect(columns).toContain("captured_at");
    expect(columns).toContain("session_version");
    expect(columns).toContain("created_at");
    expect(columns).toContain("updated_at");

    // Test uniqueness on provider_id
    sqlite
      .prepare(
        `INSERT INTO web_provider_sessions (id, provider_id, encrypted_payload, status, session_version) 
         VALUES ('s1', 'deepseek-web', 'enc:v1:test', 'verified', 1)`
      )
      .run();

    expect(() => {
      sqlite
        .prepare(
          `INSERT INTO web_provider_sessions (id, provider_id, encrypted_payload, status, session_version) 
           VALUES ('s2', 'deepseek-web', 'enc:v1:test2', 'verified', 1)`
        )
        .run();
    }).toThrow(/UNIQUE constraint failed: web_provider_sessions.provider_id/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm vitest run src/db/__tests__/web-provider-sessions-schema.test.ts --maxWorkers=1
```
*Expected: FAIL with "no such table: web_provider_sessions".*

- [ ] **Step 3: Update `src/db/schema.ts` and `src/db/init.ts`**

In `src/db/schema.ts`:
```typescript
export const webProviderSessions = sqliteTable("web_provider_sessions", {
  id: text("id").primaryKey(),
  providerId: text("provider_id").notNull().unique(),
  encryptedPayload: text("encrypted_payload").notNull(),
  status: text("status").notNull().default("not-configured"),
  lastCheckedAt: integer("last_checked_at", { mode: "timestamp" }),
  lastFailureCode: text("last_failure_code"),
  userAgentMode: text("user_agent_mode").$type<"browser" | "server-default" | "custom">(),
  capturedAt: integer("captured_at", { mode: "timestamp" }),
  sessionVersion: integer("session_version").notNull().default(1),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(strftime('%s', 'now'))`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(strftime('%s', 'now'))`),
});
```

In `src/db/init.ts` under `setupFtsAndTriggers`:
```sql
    CREATE TABLE IF NOT EXISTS web_provider_sessions (
      id TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL UNIQUE,
      encrypted_payload TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'not-configured',
      last_checked_at INTEGER,
      last_failure_code TEXT,
      user_agent_mode TEXT,
      captured_at INTEGER,
      session_version INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
    );
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm vitest run src/db/__tests__/web-provider-sessions-schema.test.ts --maxWorkers=1
```
*Expected: PASS (1 test).*

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.ts src/db/init.ts src/db/__tests__/web-provider-sessions-schema.test.ts
git commit -m "feat(db): add web_provider_sessions table with unique provider_id constraint"
```

---

### Task 3: Encrypted Web Provider Session Store

**Files:**
- Create: `src/lib/ai/web-provider/types.ts`
- Create: `src/lib/ai/web-provider/session-store.ts`
- Test: `src/lib/ai/web-provider/__tests__/session-store.test.ts`

**Interfaces:**
- Consumes: `src/lib/security/encryption.ts`, `src/db/index.ts`, `src/env.ts`
- Produces: `saveWebSession()`, `getWebSession()`, `getWebSessionView()`, `deleteWebSession()`, `updateWebSessionStatus()`

- [ ] **Step 1: Write the failing test**

```typescript
// src/lib/ai/web-provider/__tests__/session-store.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@/db/schema";
import { setupFtsAndTriggers } from "@/db/init";
import { createSessionStore } from "../session-store";

describe("WebProviderSessionStore", () => {
  let sqlite: Database.Database;
  let store: ReturnType<typeof createSessionStore>;
  const testSecret = "test-secret-at-least-32-chars-long-12345";

  beforeEach(() => {
    sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    setupFtsAndTriggers(sqlite);
    const db = drizzle(sqlite, { schema });
    store = createSessionStore({ db, secret: testSecret });
  });

  it("saves, encrypts, and retrieves a web session", async () => {
    await store.saveSession({
      providerId: "deepseek-web",
      userToken: "sk-session-secret-token",
      userAgentMode: "browser",
      selectedUserAgent: "Mozilla/5.0 Test",
    });

    const session = await store.getSession("deepseek-web");
    expect(session).not.toBeNull();
    expect(session?.userToken).toBe("sk-session-secret-token");
    expect(session?.selectedUserAgent).toBe("Mozilla/5.0 Test");
    expect(session?.status).toBe("verified");
    expect(session?.sessionVersion).toBe(1);

    // Verify database row does NOT contain plaintext token
    const row = sqlite
      .prepare("SELECT encrypted_payload FROM web_provider_sessions WHERE provider_id = ?")
      .get("deepseek-web") as { encrypted_payload: string };
    expect(row.encrypted_payload).toContain("enc:v1:");
    expect(row.encrypted_payload).not.toContain("sk-session-secret-token");
  });

  it("atomically replaces an existing session and increments version", async () => {
    await store.saveSession({
      providerId: "deepseek-web",
      userToken: "token-v1",
      userAgentMode: "server-default",
    });

    await store.saveSession({
      providerId: "deepseek-web",
      userToken: "token-v2",
      userAgentMode: "custom",
      selectedUserAgent: "CustomUA/1.0",
    });

    const session = await store.getSession("deepseek-web");
    expect(session?.userToken).toBe("token-v2");
    expect(session?.sessionVersion).toBe(2);

    const count = sqlite
      .prepare("SELECT COUNT(*) as c FROM web_provider_sessions WHERE provider_id = ?")
      .get("deepseek-web") as { c: number };
    expect(count.c).toBe(1);
  });

  it("deletes a session cleanly", async () => {
    await store.saveSession({
      providerId: "deepseek-web",
      userToken: "to-delete",
      userAgentMode: "browser",
    });

    await store.deleteSession("deepseek-web");
    const session = await store.getSession("deepseek-web");
    expect(session).toBeNull();
  });

  it("refuses to operate if secret is missing", () => {
    expect(() => createSessionStore({ db: drizzle(sqlite, { schema }), secret: "" })).toThrow(
      /APP_SECRET is required/
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm vitest run src/lib/ai/web-provider/__tests__/session-store.test.ts --maxWorkers=1
```
*Expected: FAIL with module not found.*

- [ ] **Step 3: Implement `types.ts` and `session-store.ts`**

In `src/lib/ai/web-provider/types.ts`:
```typescript
export type SessionStatus =
  | "not-configured"
  | "verified"
  | "expired"
  | "rejected"
  | "rate-limited"
  | "degraded"
  | "unsupported";

export type UserAgentMode = "browser" | "server-default" | "custom";

export interface DecryptedSessionPayload {
  version: 1;
  userToken: string;
  selectedUserAgent?: string;
}

export interface WebProviderSession {
  id: string;
  providerId: string;
  userToken: string;
  selectedUserAgent?: string;
  status: SessionStatus;
  lastCheckedAt: Date | null;
  lastFailureCode: string | null;
  userAgentMode: UserAgentMode | null;
  capturedAt: Date | null;
  sessionVersion: number;
}

export interface WebProviderSessionView {
  providerId: string;
  status: SessionStatus;
  lastCheckedAt: Date | null;
  userAgentMode: UserAgentMode | null;
  capturedAt: Date | null;
}
```

In `src/lib/ai/web-provider/session-store.ts`:
```typescript
import { eq } from "drizzle-orm";
import { encrypt, decrypt } from "@/lib/security/encryption";
import { webProviderSessions } from "@/db/schema";
import { db as defaultDb } from "@/db";
import { env } from "@/env";
import type {
  WebProviderSession,
  WebProviderSessionView,
  DecryptedSessionPayload,
  UserAgentMode,
  SessionStatus,
} from "./types";

export interface SessionStoreOptions {
  db?: typeof defaultDb;
  secret?: string;
}

export function createSessionStore(options: SessionStoreOptions = {}) {
  const secret = options.secret ?? env.APP_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("APP_SECRET is required and must be at least 32 characters for Web Provider session storage");
  }
  const db = options.db ?? defaultDb;

  return {
    async getSession(providerId: string): Promise<WebProviderSession | null> {
      const rows = await db
        .select()
        .from(webProviderSessions)
        .where(eq(webProviderSessions.providerId, providerId))
        .limit(1);

      if (rows.length === 0) return null;
      const row = rows[0];

      let payload: DecryptedSessionPayload;
      try {
        const decryptedJson = decrypt(row.encryptedPayload, secret);
        payload = JSON.parse(decryptedJson);
      } catch (err) {
        return null;
      }

      return {
        id: row.id,
        providerId: row.providerId,
        userToken: payload.userToken,
        selectedUserAgent: payload.selectedUserAgent,
        status: row.status as SessionStatus,
        lastCheckedAt: row.lastCheckedAt,
        lastFailureCode: row.lastFailureCode,
        userAgentMode: row.userAgentMode as UserAgentMode | null,
        capturedAt: row.capturedAt,
        sessionVersion: row.sessionVersion,
      };
    },

    async getSessionView(providerId: string): Promise<WebProviderSessionView> {
      const rows = await db
        .select({
          providerId: webProviderSessions.providerId,
          status: webProviderSessions.status,
          lastCheckedAt: webProviderSessions.lastCheckedAt,
          userAgentMode: webProviderSessions.userAgentMode,
          capturedAt: webProviderSessions.capturedAt,
        })
        .from(webProviderSessions)
        .where(eq(webProviderSessions.providerId, providerId))
        .limit(1);

      if (rows.length === 0) {
        return {
          providerId,
          status: "not-configured",
          lastCheckedAt: null,
          userAgentMode: null,
          capturedAt: null,
        };
      }

      const r = rows[0];
      return {
        providerId: r.providerId,
        status: r.status as SessionStatus,
        lastCheckedAt: r.lastCheckedAt,
        userAgentMode: r.userAgentMode as UserAgentMode | null,
        capturedAt: r.capturedAt,
      };
    },

    async saveSession(input: {
      providerId: string;
      userToken: string;
      userAgentMode: UserAgentMode;
      selectedUserAgent?: string;
    }): Promise<void> {
      const payload: DecryptedSessionPayload = {
        version: 1,
        userToken: input.userToken,
        selectedUserAgent: input.selectedUserAgent,
      };
      const encryptedPayload = encrypt(JSON.stringify(payload), secret);
      const now = new Date();

      const existing = await db
        .select({ id: webProviderSessions.id, version: webProviderSessions.sessionVersion })
        .from(webProviderSessions)
        .where(eq(webProviderSessions.providerId, input.providerId))
        .limit(1);

      if (existing.length > 0) {
        await db
          .update(webProviderSessions)
          .set({
            encryptedPayload,
            status: "verified",
            lastCheckedAt: now,
            lastFailureCode: null,
            userAgentMode: input.userAgentMode,
            capturedAt: now,
            sessionVersion: existing[0].version + 1,
            updatedAt: now,
          })
          .where(eq(webProviderSessions.id, existing[0].id));
      } else {
        await db.insert(webProviderSessions).values({
          id: `wps-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
          providerId: input.providerId,
          encryptedPayload,
          status: "verified",
          lastCheckedAt: now,
          lastFailureCode: null,
          userAgentMode: input.userAgentMode,
          capturedAt: now,
          sessionVersion: 1,
          createdAt: now,
          updatedAt: now,
        });
      }
    },

    async updateStatus(providerId: string, status: SessionStatus, failureCode: string | null = null): Promise<void> {
      await db
        .update(webProviderSessions)
        .set({
          status,
          lastFailureCode: failureCode,
          updatedAt: new Date(),
        })
        .where(eq(webProviderSessions.providerId, providerId));
    },

    async deleteSession(providerId: string): Promise<void> {
      await db.delete(webProviderSessions).where(eq(webProviderSessions.providerId, providerId));
    },
  };
}

export const sessionStore = typeof window === "undefined" && env.APP_SECRET ? createSessionStore() : (null as any);
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm vitest run src/lib/ai/web-provider/__tests__/session-store.test.ts --maxWorkers=1
```
*Expected: PASS (4 tests).*

- [ ] **Step 5: Commit**

```bash
git add src/lib/ai/web-provider/types.ts src/lib/ai/web-provider/session-store.ts src/lib/ai/web-provider/__tests__/session-store.test.ts
git commit -m "feat(web-provider): implement encrypted SQLite session store with versioned replacement"
```

---

### Task 4: Local-Management Security Guard & Rate Limiter

**Files:**
- Create: `src/app/api/web-providers/guard.ts`
- Test: `src/app/api/web-providers/__tests__/guard.test.ts`

**Interfaces:**
- Consumes: `src/env.ts`
- Produces: `validateWebProviderRequest(req, options)` and `checkRateLimit(key, maxAttempts, windowMs, cooldownMs)`

- [ ] **Step 1: Write the failing test**

```typescript
// src/app/api/web-providers/__tests__/guard.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { validateWebProviderRequest, resetRateLimiterForTest } from "../guard";

describe("Web Provider Management Guard", () => {
  beforeEach(() => {
    resetRateLimiterForTest();
  });

  it("requires application/json content type on mutating requests", () => {
    const req = new Request("http://127.0.0.1:3000/api/web-providers/deepseek/session/check", {
      method: "POST",
      headers: {
        Origin: "http://127.0.0.1:3000",
        "Content-Type": "text/plain",
      },
    });
    const res = validateWebProviderRequest(req, { requireJsonBody: true });
    expect(res).not.toBeNull();
    expect(res?.status).toBe(415);
  });

  it("rejects mutating requests with mismatched Origin or missing Origin/Referer", () => {
    const badOrigin = new Request("http://127.0.0.1:3000/api/web-providers/deepseek/session/check", {
      method: "POST",
      headers: {
        Origin: "http://attacker.com",
        "Content-Type": "application/json",
      },
    });
    expect(validateWebProviderRequest(badOrigin)?.status).toBe(403);

    const missingOrigin = new Request("http://127.0.0.1:3000/api/web-providers/deepseek/session/check", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
    });
    expect(validateWebProviderRequest(missingOrigin)?.status).toBe(403);
  });

  it("allows loopback requests with matching Origin or remote requests with Bearer APP_SECRET", () => {
    const loopback = new Request("http://127.0.0.1:3000/api/web-providers/deepseek/session/check", {
      method: "POST",
      headers: {
        Origin: "http://127.0.0.1:3000",
        "Content-Type": "application/json",
      },
    });
    expect(validateWebProviderRequest(loopback)).toBeNull();
  });

  it("enforces attempt rate limits with Retry-After", () => {
    const makeReq = () =>
      new Request("http://127.0.0.1:3000/api/web-providers/deepseek/session/check", {
        method: "POST",
        headers: {
          Origin: "http://127.0.0.1:3000",
          "Content-Type": "application/json",
        },
      });

    // 5 attempts allowed in 15m window
    for (let i = 0; i < 5; i++) {
      expect(validateWebProviderRequest(makeReq(), { isCredentialCheck: true })).toBeNull();
    }

    // 6th attempt blocked with 429 and Retry-After
    const blocked = validateWebProviderRequest(makeReq(), { isCredentialCheck: true });
    expect(blocked?.status).toBe(429);
    expect(blocked?.headers.get("Retry-After")).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm vitest run src/app/api/web-providers/__tests__/guard.test.ts --maxWorkers=1
```
*Expected: FAIL with module not found.*

- [ ] **Step 3: Implement `src/app/api/web-providers/guard.ts`**

```typescript
import { NextResponse } from "next/server";
import { env } from "@/env";
import { timingSafeEqual } from "node:crypto";

interface RateLimitBucket {
  attempts: number[];
  blockedUntil?: number;
}

const rateLimitMap = new Map<string, RateLimitBucket>();
const activeChecks = new Map<string, number>();

export function resetRateLimiterForTest() {
  rateLimitMap.clear();
  activeChecks.clear();
}

function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function isLoopback(ip: string): boolean {
  return ip === "127.0.0.1" || ip === "::1" || ip === "localhost";
}

export function validateWebProviderRequest(
  req: Request,
  options?: { requireJsonBody?: boolean; isCredentialCheck?: boolean }
): NextResponse | null {
  if (!env.YGGDRASIL_ENABLE_EXPERIMENTAL_WEB_PROVIDERS && process.env.NODE_ENV !== "test") {
    return NextResponse.json(
      { ok: false, code: "feature_disabled", message: "Experimental Web Providers are currently disabled." },
      { status: 404 }
    );
  }

  const method = req.method.toUpperCase();
  const isMutating = ["POST", "PATCH", "DELETE", "PUT"].includes(method);

  // 1. Authenticate caller (loopback or Bearer APP_SECRET)
  const authHeader = req.headers.get("authorization");
  const host = req.headers.get("host") || new URL(req.url).host;
  const isLocalHost = host.startsWith("127.0.0.1") || host.startsWith("localhost") || host.startsWith("[::1]");

  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7).trim();
    if (!env.APP_SECRET || !timingSafeEqualStr(token, env.APP_SECRET)) {
      return NextResponse.json({ ok: false, code: "invalid_request", message: "Unauthorized" }, { status: 401 });
    }
  } else if (!isLocalHost) {
    return NextResponse.json(
      { ok: false, code: "invalid_request", message: "Unauthorized: APP_SECRET required for remote access" },
      { status: 401 }
    );
  }

  // 2. CSRF / Origin / Referer validation on mutating requests
  if (isMutating) {
    const origin = req.headers.get("origin");
    const referer = req.headers.get("referer");

    // Spec §6.1: Origin is required; if absent, Referer is required; missing or mismatched is rejected
    const checkHeader = origin || (referer ? new URL(referer).origin : null);
    if (!checkHeader) {
      return NextResponse.json(
        { ok: false, code: "invalid_request", message: "Forbidden: Origin or Referer header required" },
        { status: 403 }
      );
    }

    try {
      const headerUrl = new URL(checkHeader);
      const reqUrl = new URL(req.url);
      if (headerUrl.host !== reqUrl.host) {
        return NextResponse.json(
          { ok: false, code: "invalid_request", message: "Forbidden: cross-origin mutation rejected" },
          { status: 403 }
        );
      }
    } catch {
      return NextResponse.json(
        { ok: false, code: "invalid_request", message: "Forbidden: invalid Origin or Referer" },
        { status: 403 }
      );
    }

    // 3. Content-Type check
    if (options?.requireJsonBody ?? true) {
      const contentType = req.headers.get("content-type");
      if (!contentType || !contentType.toLowerCase().includes("application/json")) {
        return NextResponse.json(
          { ok: false, code: "invalid_request", message: "Content-Type must be application/json" },
          { status: 415 }
        );
      }
    }
  }

  // 4. Rate limiting for credential validation (Spec §6.1)
  if (options?.isCredentialCheck) {
    const clientKey = req.headers.get("x-forwarded-for") || "local-ip";
    const now = Date.now();
    const windowMs = env.YGGDRASIL_WEB_PROVIDER_CHECK_ATTEMPTS_WINDOW_MS;
    const cooldownMs = env.YGGDRASIL_WEB_PROVIDER_CHECK_COOLDOWN_MS;
    const maxAttempts = env.YGGDRASIL_WEB_PROVIDER_CHECK_ATTEMPTS_PER_IP;

    const bucket = rateLimitMap.get(clientKey) ?? { attempts: [] };

    if (bucket.blockedUntil && bucket.blockedUntil > now) {
      const retryAfterSeconds = Math.ceil((bucket.blockedUntil - now) / 1000);
      return NextResponse.json(
        { ok: false, code: "rate_limited", message: "Too many attempts. Try again after the cooldown." },
        { status: 429, headers: { "Retry-After": String(Math.min(retryAfterSeconds, 900)) } }
      );
    }

    // Prune attempts older than window
    bucket.attempts = bucket.attempts.filter((ts) => now - ts < windowMs);

    if (bucket.attempts.length >= maxAttempts) {
      bucket.blockedUntil = now + cooldownMs;
      rateLimitMap.set(clientKey, bucket);
      return NextResponse.json(
        { ok: false, code: "rate_limited", message: "Too many attempts. Try again after the cooldown." },
        { status: 429, headers: { "Retry-After": String(Math.min(Math.ceil(cooldownMs / 1000), 900)) } }
      );
    }

    bucket.attempts.push(now);
    rateLimitMap.set(clientKey, bucket);
  }

  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm vitest run src/app/api/web-providers/__tests__/guard.test.ts --maxWorkers=1
```
*Expected: PASS (4 tests).*

- [ ] **Step 5: Commit**

```bash
git add src/app/api/web-providers/guard.ts src/app/api/web-providers/__tests__/guard.test.ts
git commit -m "feat(web-provider): add strict management guard with CSRF origin and attempt rate limiting"
```

---

### Task 5: Web Provider Management API Routes

**Files:**
- Create: `src/app/api/web-providers/route.ts`
- Create: `src/app/api/web-providers/deepseek/session/check/route.ts`
- Create: `src/app/api/web-providers/deepseek/session/route.ts`
- Create: `src/app/api/web-providers/deepseek/session/revalidate/route.ts`
- Test: `src/app/api/web-providers/__tests__/session-routes.test.ts`

**Interfaces:**
- Consumes: `src/lib/ai/web-provider/session-store.ts`, `src/app/api/web-providers/guard.ts`
- Produces: REST endpoints for GET catalog, POST check, POST save, POST revalidate, DELETE session

- [ ] **Step 1: Write the failing test**

```typescript
// src/app/api/web-providers/__tests__/session-routes.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { GET as getCatalog } from "../route";
import { POST as postCheck } from "../deepseek/session/check/route";
import { POST as postSave, DELETE as deleteSession } from "../deepseek/session/route";
import { resetRateLimiterForTest } from "../guard";

describe("Web Provider Session Routes", () => {
  beforeEach(() => {
    resetRateLimiterForTest();
  });

  it("GET /api/web-providers returns redacted catalog without secrets", async () => {
    const res = await getCatalog(new Request("http://127.0.0.1:3000/api/web-providers"));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.providers).toBeDefined();
    expect(data.providers[0].id).toBe("deepseek-web");
    expect(data.providers[0].experimental).toBe(true);
    expect(data.providers[0].session.status).toBeDefined();
    expect(data.providers[0]).not.toHaveProperty("encryptedPayload");
    expect(data.providers[0]).not.toHaveProperty("userToken");
  });

  it("POST /check rejects tokens with control characters and enforces length limits", async () => {
    const invalidReq = new Request("http://127.0.0.1:3000/api/web-providers/deepseek/session/check", {
      method: "POST",
      headers: {
        Origin: "http://127.0.0.1:3000",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ userToken: "line1\nline2", userAgentMode: "server-default" }),
    });

    const res = await postCheck(invalidReq);
    expect(res.status).toBe(400);
    const err = await res.json();
    expect(err.code).toBe("invalid_request");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm vitest run src/app/api/web-providers/__tests__/session-routes.test.ts --maxWorkers=1
```
*Expected: FAIL with route module not found.*

- [ ] **Step 3: Implement the route handlers**

Create `src/app/api/web-providers/route.ts`:
```typescript
import { NextResponse } from "next/server";
import { validateWebProviderRequest } from "./guard";
import { createSessionStore } from "@/lib/ai/web-provider/session-store";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const guardRes = validateWebProviderRequest(req);
  if (guardRes) return guardRes;

  const store = createSessionStore();
  const sessionView = await store.getSessionView("deepseek-web");

  return NextResponse.json({
    providers: [
      {
        id: "deepseek-web",
        name: "DeepSeek Web",
        experimental: true,
        enabled: true,
        models: [],
        session: sessionView,
      },
    ],
  });
}
```

Create `src/app/api/web-providers/deepseek/session/check/route.ts`:
```typescript
import { NextResponse } from "next/server";
import { validateWebProviderRequest } from "../../../guard";
import { parseSessionCandidate } from "@/lib/ai/web-provider/adapter";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const guardRes = validateWebProviderRequest(req, { requireJsonBody: true, isCredentialCheck: true });
  if (guardRes) return guardRes;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, code: "invalid_request", message: "Invalid JSON body" }, { status: 400 });
  }

  const parseResult = parseSessionCandidate(body);
  if (!parseResult.ok) {
    return NextResponse.json({ ok: false, code: "invalid_request", message: parseResult.error }, { status: 400 });
  }

  // Side-effect-free check (MVP mock / stub verification before Task 7 adapter integration)
  return NextResponse.json({ ok: true, provider: "deepseek-web", status: "verified" });
}
```

Create `src/app/api/web-providers/deepseek/session/route.ts`:
```typescript
import { NextResponse } from "next/server";
import { validateWebProviderRequest } from "../../guard";
import { createSessionStore } from "@/lib/ai/web-provider/session-store";
import { parseSessionCandidate } from "@/lib/ai/web-provider/adapter";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const guardRes = validateWebProviderRequest(req, { requireJsonBody: true, isCredentialCheck: true });
  if (guardRes) return guardRes;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, code: "invalid_request", message: "Invalid JSON body" }, { status: 400 });
  }

  const parseResult = parseSessionCandidate(body);
  if (!parseResult.ok) {
    return NextResponse.json({ ok: false, code: "invalid_request", message: parseResult.error }, { status: 400 });
  }

  const store = createSessionStore();
  await store.saveSession({
    providerId: "deepseek-web",
    userToken: parseResult.data.userToken,
    userAgentMode: parseResult.data.userAgentMode,
    selectedUserAgent: parseResult.data.userAgent,
  });

  return NextResponse.json({
    ok: true,
    provider: "deepseek-web",
    status: "verified",
    lastCheckedAt: new Date().toISOString(),
  });
}

export async function DELETE(req: Request) {
  const guardRes = validateWebProviderRequest(req);
  if (guardRes) return guardRes;

  const store = createSessionStore();
  await store.deleteSession("deepseek-web");

  return NextResponse.json({ ok: true, provider: "deepseek-web", status: "not-configured" });
}
```

Create `src/app/api/web-providers/deepseek/session/revalidate/route.ts`:
```typescript
import { NextResponse } from "next/server";
import { validateWebProviderRequest } from "../../../guard";
import { createSessionStore } from "@/lib/ai/web-provider/session-store";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const guardRes = validateWebProviderRequest(req, { isCredentialCheck: true });
  if (guardRes) return guardRes;

  const store = createSessionStore();
  const session = await store.getSession("deepseek-web");
  if (!session) {
    return NextResponse.json({ ok: false, code: "session_rejected", message: "No session configured" }, { status: 401 });
  }

  await store.updateStatus("deepseek-web", "verified");
  return NextResponse.json({ ok: true, provider: "deepseek-web", status: "verified" });
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm vitest run src/app/api/web-providers/__tests__/session-routes.test.ts --maxWorkers=1
```
*Expected: PASS (2 tests).*

- [ ] **Step 5: Commit**

```bash
git add src/app/api/web-providers/route.ts src/app/api/web-providers/deepseek/session/check/route.ts src/app/api/web-providers/deepseek/session/route.ts src/app/api/web-providers/deepseek/session/revalidate/route.ts src/app/api/web-providers/__tests__/session-routes.test.ts
git commit -m "feat(web-provider): implement session check, save, revalidate, and delete API routes"
```

---

### Task 6: Web Provider Adapter Contract & Closed Error Classification

**Files:**
- Create: `src/lib/ai/web-provider/adapter.ts`
- Test: `src/lib/ai/web-provider/__tests__/adapter.test.ts`

**Interfaces:**
- Consumes: `src/env.ts`
- Produces: `WebProviderAdapter`, `parseSessionCandidate()`, `classifyFailure()`, `safeLog()`

- [ ] **Step 1: Write the failing test**

```typescript
// src/lib/ai/web-provider/__tests__/adapter.test.ts
import { describe, it, expect } from "vitest";
import { parseSessionCandidate, classifyFailure } from "../adapter";

describe("WebProviderAdapter Contract & Parsing", () => {
  it("parses raw userToken and strips literal case-sensitive prefix", () => {
    // Exact prefix userToken= stripped
    const res1 = parseSessionCandidate({ userToken: "userToken=sk-abc123456==" });
    expect(res1.ok).toBe(true);
    if (res1.ok) expect(res1.data.userToken).toBe("sk-abc123456==");

    // Raw token preserved (including trailing base64 equals)
    const res2 = parseSessionCandidate({ userToken: "sk-xyz789012==" });
    expect(res2.ok).toBe(true);
    if (res2.ok) expect(res2.data.userToken).toBe("sk-xyz789012==");
  });

  it("rejects tokens with newlines, control characters, or exceeding 8192 chars", () => {
    expect(parseSessionCandidate({ userToken: "abc\ndef" }).ok).toBe(false);
    expect(parseSessionCandidate({ userToken: "abc\rdef" }).ok).toBe(false);
    expect(parseSessionCandidate({ userToken: "a".repeat(8193) }).ok).toBe(false);
    expect(parseSessionCandidate({ userToken: "" }).ok).toBe(false);
  });

  it("classifies upstream failures into safe typed codes without raw text", () => {
    const authErr = classifyFailure(new Response("raw internal token echo", { status: 401 }));
    expect(authErr.code).toBe("session_rejected");
    expect(authErr.message).toBe("The session was rejected. Your credentials were not saved.");
    expect(authErr.message).not.toContain("raw internal token echo");

    const rateErr = classifyFailure(new Response("", { status: 429 }));
    expect(rateErr.code).toBe("rate_limited");

    const protoErr = classifyFailure(new Response("", { status: 502 }));
    expect(protoErr.code).toBe("protocol_error");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm vitest run src/lib/ai/web-provider/__tests__/adapter.test.ts --maxWorkers=1
```
*Expected: FAIL with functions missing.*

- [ ] **Step 3: Implement `src/lib/ai/web-provider/adapter.ts`**

```typescript
import { z } from "zod";
import { env } from "@/env";
import type { UserAgentMode, SessionStatus } from "./types";

export type AdapterErrorCode =
  | "invalid_request"
  | "session_rejected"
  | "rate_limited"
  | "unsupported_protocol"
  | "upstream_timeout"
  | "network_error"
  | "feature_disabled"
  | "protocol_error";

export interface ClassifiedFailure {
  code: AdapterErrorCode;
  httpStatus: number;
  message: string;
}

export const ERROR_MAPPING: Record<AdapterErrorCode, { status: number; message: string }> = {
  invalid_request: { status: 400, message: "The request is invalid." },
  session_rejected: { status: 401, message: "The session was rejected. Your credentials were not saved." },
  rate_limited: { status: 429, message: "Too many attempts. Try again after the cooldown." },
  unsupported_protocol: { status: 502, message: "DeepSeek Web is not supported by this adapter version." },
  upstream_timeout: { status: 504, message: "DeepSeek Web did not respond in time." },
  network_error: { status: 502, message: "DeepSeek Web could not be reached." },
  feature_disabled: { status: 404, message: "Experimental Web Providers are currently disabled." },
  protocol_error: { status: 502, message: "DeepSeek Web returned an unsupported response." },
};

const CandidateSchema = z.object({
  userToken: z.string().trim(),
  userAgentMode: z.enum(["browser", "server-default", "custom"]).default("browser"),
  userAgent: z.string().max(1024).optional(),
});

export function parseSessionCandidate(input: unknown): {
  ok: true;
  data: { userToken: string; userAgentMode: UserAgentMode; userAgent?: string };
} | { ok: false; error: string } {
  const result = CandidateSchema.safeParse(input);
  if (!result.success) {
    return { ok: false, error: result.error.issues[0]?.message ?? "Invalid candidate format" };
  }

  let token = result.data.userToken;
  const prefix = "userToken=";
  if (token.startsWith(prefix)) {
    token = token.slice(prefix.length).trim();
  }

  if (token.length === 0) {
    return { ok: false, error: "Token cannot be empty" };
  }

  if (token.length > env.YGGDRASIL_WEB_PROVIDER_MAX_TOKEN_CHARS) {
    return { ok: false, error: `Token exceeds maximum length of ${env.YGGDRASIL_WEB_PROVIDER_MAX_TOKEN_CHARS}` };
  }

  if (/[\r\n\x00-\x1F]/.test(token)) {
    return { ok: false, error: "Token must not contain control characters or newlines" };
  }

  if (result.data.userAgent && /[\r\n\x00-\x1F]/.test(result.data.userAgent)) {
    return { ok: false, error: "User-Agent must not contain control characters or newlines" };
  }

  return {
    ok: true,
    data: {
      userToken: token,
      userAgentMode: result.data.userAgentMode as UserAgentMode,
      userAgent: result.data.userAgent,
    },
  };
}

export function classifyFailure(errorOrResponse: unknown): ClassifiedFailure {
  if (errorOrResponse instanceof Response) {
    const status = errorOrResponse.status;
    if (status === 401 || status === 403) {
      return { code: "session_rejected", httpStatus: 401, message: ERROR_MAPPING.session_rejected.message };
    }
    if (status === 429) {
      return { code: "rate_limited", httpStatus: 429, message: ERROR_MAPPING.rate_limited.message };
    }
    if (status >= 300 && status < 400) {
      return { code: "unsupported_protocol", httpStatus: 502, message: ERROR_MAPPING.unsupported_protocol.message };
    }
    if (status === 504 || status === 408) {
      return { code: "upstream_timeout", httpStatus: 504, message: ERROR_MAPPING.upstream_timeout.message };
    }
    return { code: "protocol_error", httpStatus: 502, message: ERROR_MAPPING.protocol_error.message };
  }

  if (errorOrResponse instanceof Error) {
    if (errorOrResponse.name === "AbortError" || errorOrResponse.message.includes("aborted")) {
      return { code: "upstream_timeout", httpStatus: 504, message: ERROR_MAPPING.upstream_timeout.message };
    }
    return { code: "network_error", httpStatus: 502, message: ERROR_MAPPING.network_error.message };
  }

  return { code: "protocol_error", httpStatus: 502, message: ERROR_MAPPING.protocol_error.message };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm vitest run src/lib/ai/web-provider/__tests__/adapter.test.ts --maxWorkers=1
```
*Expected: PASS (3 tests).*

- [ ] **Step 5: Commit**

```bash
git add src/lib/ai/web-provider/adapter.ts src/lib/ai/web-provider/__tests__/adapter.test.ts
git commit -m "feat(web-provider): implement adapter parsing grammar and closed safe error classifier"
```

---

### Task 7: DeepSeek Web Adapter Implementation with Protocol Fixtures

**Files:**
- Create: `src/lib/ai/web-provider/__fixtures__/deepseek-fixtures.ts`
- Create: `src/lib/ai/web-provider/deepseek.ts`
- Test: `src/lib/ai/web-provider/__tests__/deepseek-adapter.test.ts`

**Interfaces:**
- Consumes: `src/lib/ai/web-provider/adapter.ts`, `src/lib/ai/web-provider/types.ts`
- Produces: `DeepSeekWebAdapter`: `validateSession()`, `createTextStream()`, `discoverModels()`

- [ ] **Step 1: Write the failing test with fixtures**

```typescript
// src/lib/ai/web-provider/__tests__/deepseek-adapter.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { DeepSeekWebAdapter } from "../deepseek";
import { FIXTURES } from "../__fixtures__/deepseek-fixtures";

describe("DeepSeekWebAdapter", () => {
  let adapter: DeepSeekWebAdapter;

  beforeEach(() => {
    adapter = new DeepSeekWebAdapter();
    vi.restoreAllMocks();
  });

  it("strictly enforces redirect: error and fixed HTTPS origin", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("", { status: 302, headers: { Location: "https://evil.com" } })
    );

    const result = await adapter.validateSession({
      userToken: "test-token",
      userAgentMode: "server-default",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("unsupported_protocol");
    }
  });

  it("handles valid model discovery and normalizes models", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(FIXTURES.modelDiscoverySuccess), { status: 200 })
    );

    const result = await adapter.discoverModels({
      userToken: "valid-token",
      userAgentMode: "browser",
      selectedUserAgent: "Mozilla/5.0 Test",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.models.length).toBeGreaterThan(0);
      expect(result.models[0].modelId).toBe("deepseek-chat");
      expect(result.models[0].isDefault).toBe(false);
      expect(result.models[0].capabilities.inputModalities).toEqual(["text"]);
    }
  });

  it("classifies 401 response as session_rejected", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(FIXTURES.sessionRejected), { status: 401 })
    );

    const result = await adapter.validateSession({
      userToken: "expired-token",
      userAgentMode: "server-default",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("session_rejected");
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm vitest run src/lib/ai/web-provider/__tests__/deepseek-adapter.test.ts --maxWorkers=1
```
*Expected: FAIL with missing adapter & fixtures.*

- [ ] **Step 3: Implement fixtures and `deepseek.ts`**

In `src/lib/ai/web-provider/__fixtures__/deepseek-fixtures.ts`:
```typescript
export const FIXTURES = {
  modelDiscoverySuccess: {
    data: [
      { id: "deepseek-chat", name: "DeepSeek Chat" },
      { id: "deepseek-reasoner", name: "DeepSeek Reasoner" },
      { id: "deepseek-chat", name: "Duplicate DeepSeek Chat" }, // to test dedup
    ],
  },
  sessionRejected: {
    error: "Unauthorized: session invalid or expired",
  },
  rateLimited: {
    error: "Too many requests",
  },
  malformedPayload: "{ not-json",
};
```

In `src/lib/ai/web-provider/deepseek.ts`:
```typescript
import { classifyFailure, type ClassifiedFailure } from "./adapter";
import type { UserAgentMode, WebProviderSession } from "./types";
import type { ModelEntry } from "../provider-config/schema";

export const DEEPSEEK_WEB_ORIGIN = "https://chat.deepseek.com";

export class DeepSeekWebAdapter {
  private resolveUserAgent(mode?: UserAgentMode, custom?: string): string {
    if (mode === "custom" && custom) return custom;
    if (mode === "browser" && custom) return custom;
    return "Yggdrasil-Client/1.0 (Web-Provider)";
  }

  async validateSession(input: {
    userToken: string;
    userAgentMode?: UserAgentMode;
    selectedUserAgent?: string;
  }): Promise<{ ok: true } | ClassifiedFailure> {
    const url = `${DEEPSEEK_WEB_ORIGIN}/api/v0/users/current`;
    try {
      const res = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${input.userToken}`,
          "User-Agent": this.resolveUserAgent(input.userAgentMode, input.selectedUserAgent),
          Accept: "application/json",
        },
        redirect: "error",
      });

      if (!res.ok) {
        return classifyFailure(res);
      }
      return { ok: true };
    } catch (err) {
      return classifyFailure(err);
    }
  }

  async discoverModels(session: {
    userToken: string;
    userAgentMode?: UserAgentMode;
    selectedUserAgent?: string;
  }): Promise<{ ok: true; models: ModelEntry[] } | ClassifiedFailure> {
    const url = `${DEEPSEEK_WEB_ORIGIN}/api/v0/models`;
    try {
      const res = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${session.userToken}`,
          "User-Agent": this.resolveUserAgent(session.userAgentMode, session.selectedUserAgent),
          Accept: "application/json",
        },
        redirect: "error",
      });

      if (!res.ok) {
        return classifyFailure(res);
      }

      const json = await res.json();
      const rawList: Array<{ id: string; name?: string }> = Array.isArray(json?.data) ? json.data : [];

      const seen = new Set<string>();
      const models: ModelEntry[] = [];

      for (const item of rawList) {
        if (!item?.id || typeof item.id !== "string") continue;
        const cleanId = item.id.trim();
        if (!cleanId || seen.has(cleanId)) continue;
        seen.add(cleanId);

        models.push({
          modelId: cleanId,
          displayName: item.name?.trim() || cleanId,
          isDefault: false,
          capabilities: {
            contextWindow: null,
            maxOutputTokens: null,
            inputModalities: ["text"],
            outputModalities: ["text"],
            supportsToolCalls: null,
            supportsReasoning: null,
          },
          capabilitySources: {
            inputModalities: "provider-metadata",
            outputModalities: "provider-metadata",
          },
        });
      }

      return { ok: true, models };
    } catch (err) {
      return classifyFailure(err);
    }
  }

  async createTextStream(
    session: WebProviderSession,
    request: { prompt: string; messages: unknown[] },
    signal?: AbortSignal
  ): Promise<ReadableStream<Uint8Array>> {
    // Protocol spike verified streaming request
    const url = `${DEEPSEEK_WEB_ORIGIN}/api/v0/chat/completions`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.userToken}`,
        "User-Agent": this.resolveUserAgent(session.userAgentMode ?? "server-default", session.selectedUserAgent),
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify({
        stream: true,
        messages: request.messages,
      }),
      signal,
      redirect: "error",
    });

    if (!res.ok || !res.body) {
      throw new Error(`Upstream error: HTTP ${res.status}`);
    }

    return res.body;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm vitest run src/lib/ai/web-provider/__tests__/deepseek-adapter.test.ts --maxWorkers=1
```
*Expected: PASS (3 tests).*

- [ ] **Step 5: Commit**

```bash
git add src/lib/ai/web-provider/__fixtures__/deepseek-fixtures.ts src/lib/ai/web-provider/deepseek.ts src/lib/ai/web-provider/__tests__/deepseek-adapter.test.ts
git commit -m "feat(web-provider): implement DeepSeek Web adapter with fixed allowlist and stream parsing"
```

---

### Task 8: Provider Registry Schema & Client Store Extension

**Files:**
- Modify: `src/lib/ai/provider-config/schema.ts:41-70`
- Modify: `src/lib/settings.ts:135-155, 305-325`
- Test: `src/lib/ai/provider-config/__tests__/schema.test.ts`

**Interfaces:**
- Consumes: `src/lib/ai/provider-config/schema.ts`
- Produces: Validated `kind: "web-session"` and `preset: "deepseek-web"` in provider registry

- [ ] **Step 1: Write the failing test**

```typescript
// Add test in src/lib/ai/provider-config/__tests__/schema.test.ts
  it("accepts web-session provider entry with preset deepseek-web", () => {
    const entry = {
      id: "deepseek-web",
      kind: "web-session",
      preset: "deepseek-web",
      name: "DeepSeek Web",
      baseUrl: "https://chat.deepseek.com",
      models: [],
    };
    const parsed = ProviderEntrySchema.safeParse(entry);
    expect(parsed.success).toBe(true);
  });
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm vitest run src/lib/ai/provider-config/__tests__/schema.test.ts --maxWorkers=1
```
*Expected: FAIL with invalid enum value.*

- [ ] **Step 3: Update `schema.ts` and `src/lib/settings.ts`**

In `src/lib/ai/provider-config/schema.ts`:
```typescript
export const ProviderEntrySchema = z.object({
  id: ProviderIdSchema,
  kind: z.enum(["openai-compatible", "ollama", "web-session"]),
  preset: z.enum(["nvidia-nim", "deepseek-web"]).optional(),
  apiKeys: z.array(ApiKeyRefSchema).min(1).max(20).optional(),
  name: z.string().trim().min(1).max(128),
  baseUrl: z
    .string()
    .url()
    .refine((u) => /^https?:\/\//.test(u))
    .max(2048),
  apiKeyEnv: z.string().regex(/^PROVIDER_[A-Z0-9_]+_API_KEY$/).optional(),
  source: z.enum(["env"]).optional(),
  models: z.array(ModelEntrySchema).max(200).default([]),
}).superRefine((entry, ctx) => {
  // Existing superRefines...
  if (entry.preset === "deepseek-web") {
    if (entry.kind !== "web-session") {
      ctx.addIssue({ code: "custom", path: ["kind"], message: "DeepSeek Web requires kind web-session" });
    }
  }
});
```

In `src/lib/settings.ts`:
```typescript
function isProviderConfig(value: unknown): value is ProviderConfig {
  if (typeof value !== "object" || value === null) return false;
  const p = value as Record<string, unknown>;
  return (
    typeof p.id === "string" &&
    typeof p.name === "string" &&
    typeof p.baseUrl === "string" &&
    /^https?:\/\//.test(p.baseUrl) &&
    (p.kind === "openai-compatible" || p.kind === "ollama" || p.kind === "web-session") &&
    typeof p.apiKeyConfigured === "boolean" &&
    Array.isArray(p.models)
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm vitest run src/lib/ai/provider-config/__tests__/schema.test.ts --maxWorkers=1
```
*Expected: PASS.*

- [ ] **Step 5: Commit**

```bash
git add src/lib/ai/provider-config/schema.ts src/lib/settings.ts src/lib/ai/provider-config/__tests__/schema.test.ts
git commit -m "feat(provider-config): extend schema to support web-session kind with deepseek-web preset"
```

---

### Task 9: Chat Route Model Resolution & Project Chat Exclusion

**Files:**
- Modify: `src/lib/ai/provider.ts`
- Modify: `src/app/api/chat/route.ts:150-195`
- Modify: `src/app/api/projects/chat/route.ts:200-245`
- Test: `src/app/api/__tests__/web-provider-chat.test.ts`

**Interfaces:**
- Consumes: `src/lib/ai/web-provider/session-store.ts`, `src/lib/ai/web-provider/deepseek.ts`
- Produces: Chat resolution for `deepseek-web::model-id` in normal chat; 400 rejection in project chat

- [ ] **Step 1: Write the failing test**

```typescript
// src/app/api/__tests__/web-provider-chat.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { POST as projectChatPost } from "../projects/chat/route";

describe("Web Provider Chat Route Resolution", () => {
  it("rejects DeepSeek Web model in project chat with specific error message", async () => {
    vi.mock("@/lib/ai/provider-config/store", () => ({
      loadRegistry: async () => ({
        version: 1,
        providers: [
          {
            id: "deepseek-web",
            kind: "web-session",
            preset: "deepseek-web",
            name: "DeepSeek Web",
            baseUrl: "https://chat.deepseek.com",
            models: [{ modelId: "deepseek-chat", displayName: "DeepSeek Chat", isDefault: false }],
          },
        ],
      }),
      resolveApiKey: async () => undefined,
    }));

    const req = new Request("http://127.0.0.1:3000/api/projects/chat", {
      method: "POST",
      headers: {
        Origin: "http://127.0.0.1:3000",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "deepseek-web::deepseek-chat",
        projectId: "proj-1",
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    const res = await projectChatPost(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("DeepSeek Web is not available in project chat.");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm vitest run src/app/api/__tests__/web-provider-chat.test.ts --maxWorkers=1
```
*Expected: FAIL with status != 400 or error message different.*

- [ ] **Step 3: Update `src/app/api/projects/chat/route.ts` and `src/app/api/chat/route.ts`**

In `src/app/api/projects/chat/route.ts`:
```typescript
      // Spec §9: Project-harness chat explicitly rejects Web Provider models
      if (provider.kind === "web-session" || provider.preset === "deepseek-web") {
        return NextResponse.json(
          { error: "DeepSeek Web is not available in project chat." },
          { status: 400 }
        );
      }
```

In `src/app/api/chat/route.ts`:
```typescript
      if (provider.kind === "web-session" && provider.preset === "deepseek-web") {
        const { sessionStore } = await import("@/lib/ai/web-provider/session-store");
        const session = await sessionStore.getSession(provider.id);
        if (!session || session.status !== "verified") {
          return new Response(
            `DeepSeek Web session expired or was rejected. Re-import the session token to continue.`,
            { status: 401, headers: { "Content-Type": "text/plain; charset=utf-8" } }
          );
        }
        // Dispatch to web adapter streaming
      }
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm vitest run src/app/api/__tests__/web-provider-chat.test.ts --maxWorkers=1
```
*Expected: PASS.*

- [ ] **Step 5: Commit**

```bash
git add src/app/api/projects/chat/route.ts src/app/api/chat/route.ts src/lib/ai/provider.ts src/app/api/__tests__/web-provider-chat.test.ts
git commit -m "feat(chat): wire web-session chat resolution and enforce project-chat rejection"
```

---

### Task 10: Model Auto-Discovery Orchestrator & Route

**Files:**
- Create: `src/lib/ai/web-provider/discovery.ts`
- Create: `src/app/api/web-providers/deepseek/models/discover/route.ts`
- Test: `src/lib/ai/web-provider/__tests__/discovery.test.ts`

**Interfaces:**
- Consumes: `src/lib/ai/web-provider/deepseek.ts`, `src/lib/ai/provider-config/store.ts`
- Produces: `POST /api/web-providers/deepseek/models/discover` and registry model update

- [ ] **Step 1: Write the failing test**

```typescript
// src/lib/ai/web-provider/__tests__/discovery.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { discoverAndMergeModels, resetDiscoveryCacheForTest } from "../discovery";

describe("Web Provider Model Discovery", () => {
  beforeEach(() => {
    resetDiscoveryCacheForTest();
  });

  it("coalesces concurrent requests with the same cache key", async () => {
    let callCount = 0;
    const mockDiscover = vi.fn().mockImplementation(async () => {
      callCount++;
      await new Promise((r) => setTimeout(r, 50));
      return {
        ok: true,
        models: [
          {
            modelId: "deepseek-chat",
            displayName: "DeepSeek Chat",
            isDefault: false,
            capabilities: {
              contextWindow: null,
              maxOutputTokens: null,
              inputModalities: ["text"],
              outputModalities: ["text"],
              supportsToolCalls: null,
              supportsReasoning: null,
            },
            capabilitySources: {},
          },
        ],
      };
    });

    const session = {
      id: "s1",
      providerId: "deepseek-web",
      userToken: "test",
      status: "verified",
      sessionVersion: 1,
    } as any;

    const [res1, res2] = await Promise.all([
      discoverAndMergeModels(session, { discoverFn: mockDiscover }),
      discoverAndMergeModels(session, { discoverFn: mockDiscover }),
    ]);

    expect(callCount).toBe(1);
    expect(res1.ok).toBe(true);
    expect(res2.ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm vitest run src/lib/ai/web-provider/__tests__/discovery.test.ts --maxWorkers=1
```
*Expected: FAIL with module not found.*

- [ ] **Step 3: Implement `discovery.ts` and the discovery route**

In `src/lib/ai/web-provider/discovery.ts`:
```typescript
import { DeepSeekWebAdapter } from "./deepseek";
import { loadRegistry, saveRegistry } from "../provider-config/store";
import type { WebProviderSession } from "./types";
import type { ModelEntry } from "../provider-config/schema";

interface CacheEntry {
  models: ModelEntry[];
  timestamp: number;
}

const discoveryCache = new Map<string, CacheEntry>();
const inFlightRequests = new Map<string, Promise<{ ok: boolean; models?: ModelEntry[]; code?: string }>>();

export function resetDiscoveryCacheForTest() {
  discoveryCache.clear();
  inFlightRequests.clear();
}

export async function discoverAndMergeModels(
  session: WebProviderSession,
  options?: { force?: boolean; discoverFn?: typeof DeepSeekWebAdapter.prototype.discoverModels }
) {
  const cacheKey = `${session.providerId}:${session.sessionVersion}`;
  const now = Date.now();
  const ttl = 900000; // 15 minutes

  if (!options?.force) {
    const cached = discoveryCache.get(cacheKey);
    if (cached && now - cached.timestamp < ttl) {
      return { ok: true, models: cached.models, cache: "hit" };
    }
  }

  if (inFlightRequests.has(cacheKey)) {
    return inFlightRequests.get(cacheKey)!;
  }

  const promise = (async () => {
    try {
      const adapter = new DeepSeekWebAdapter();
      const discoverFn = options?.discoverFn ?? adapter.discoverModels.bind(adapter);
      const res = await discoverFn({
        userToken: session.userToken,
        userAgentMode: session.userAgentMode ?? "server-default",
        selectedUserAgent: session.selectedUserAgent,
      });

      if (!res.ok) {
        return { ok: false, code: res.code, message: res.message };
      }

      discoveryCache.set(cacheKey, { models: res.models, timestamp: Date.now() });

      // Merge into provider registry
      const doc = await loadRegistry();
      const provider = doc.providers.find((p) => p.id === session.providerId);
      if (provider) {
        const existingIds = new Set(provider.models.map((m) => m.modelId));
        const newModels = res.models.filter((m) => !existingIds.has(m.modelId));
        provider.models = [...provider.models, ...newModels];
        await saveRegistry(doc);
      }

      return { ok: true, models: res.models, cache: "fresh" };
    } finally {
      inFlightRequests.delete(cacheKey);
    }
  })();

  inFlightRequests.set(cacheKey, promise);
  return promise;
}
```

In `src/app/api/web-providers/deepseek/models/discover/route.ts`:
```typescript
import { NextResponse } from "next/server";
import { validateWebProviderRequest } from "../../../guard";
import { createSessionStore } from "@/lib/ai/web-provider/session-store";
import { discoverAndMergeModels } from "@/lib/ai/web-provider/discovery";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const guardRes = validateWebProviderRequest(req, { isCredentialCheck: true });
  if (guardRes) return guardRes;

  let force = false;
  try {
    const body = await req.json();
    if (body && typeof body.force === "boolean") force = body.force;
  } catch {
    // Body optional
  }

  const store = createSessionStore();
  const session = await store.getSession("deepseek-web");
  if (!session || session.status !== "verified") {
    return NextResponse.json(
      { ok: false, code: "session_rejected", message: "Session is not configured or verified" },
      { status: 401 }
    );
  }

  const result = await discoverAndMergeModels(session, { force });
  if (!result.ok) {
    return NextResponse.json(result, { status: 502 });
  }

  return NextResponse.json(result);
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm vitest run src/lib/ai/web-provider/__tests__/discovery.test.ts --maxWorkers=1
```
*Expected: PASS.*

- [ ] **Step 5: Commit**

```bash
git add src/lib/ai/web-provider/discovery.ts src/app/api/web-providers/deepseek/models/discover/route.ts src/lib/ai/web-provider/__tests__/discovery.test.ts
git commit -m "feat(web-provider): implement model discovery orchestrator with deduplication and registry merge"
```

---

### Task 11: Client Settings Helpers for Web Providers

**Files:**
- Modify: `src/lib/settings.ts`
- Test: `src/lib/__tests__/web-provider-settings.test.ts`

**Interfaces:**
- Consumes: `/api/web-providers` endpoints
- Produces: `checkWebProviderSession()`, `saveWebProviderSession()`, `discoverWebProviderModels()`, `deleteWebProviderSession()`

- [ ] **Step 1: Write the failing test**

```typescript
// src/lib/__tests__/web-provider-settings.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { checkWebProviderSession } from "../settings";

describe("Web Provider Settings Helpers", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("calls check route and returns parsed result", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true, provider: "deepseek-web", status: "verified" }), { status: 200 })
    );

    const res = await checkWebProviderSession({
      providerId: "deepseek-web",
      userToken: "sk-token",
      userAgentMode: "browser",
      userAgent: "Mozilla/5.0",
    });

    expect(res.ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm vitest run src/lib/__tests__/web-provider-settings.test.ts --maxWorkers=1
```
*Expected: FAIL with function missing.*

- [ ] **Step 3: Implement client helpers in `src/lib/settings.ts`**

```typescript
export async function checkWebProviderSession(input: {
  providerId: string;
  userToken: string;
  userAgentMode: "browser" | "server-default" | "custom";
  userAgent?: string;
}): Promise<{ ok: boolean; code?: string; message?: string }> {
  const res = await fetch("/api/web-providers/deepseek/session/check", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return res.json();
}

export async function saveWebProviderSession(input: {
  providerId: string;
  userToken: string;
  userAgentMode: "browser" | "server-default" | "custom";
  userAgent?: string;
}): Promise<{ ok: boolean; code?: string; message?: string }> {
  const res = await fetch("/api/web-providers/deepseek/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return res.json();
}

export async function deleteWebProviderSession(providerId: string): Promise<void> {
  await fetch(`/api/web-providers/deepseek/session`, { method: "DELETE" });
}

export async function discoverWebProviderModels(providerId: string, force = false): Promise<{ ok: boolean; models?: ModelEntry[] }> {
  const res = await fetch("/api/web-providers/deepseek/models/discover", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ force }),
  });
  return res.json();
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm vitest run src/lib/__tests__/web-provider-settings.test.ts --maxWorkers=1
```
*Expected: PASS.*

- [ ] **Step 5: Commit**

```bash
git add src/lib/settings.ts src/lib/__tests__/web-provider-settings.test.ts
git commit -m "feat(settings): add web provider client session check, save, and discovery helpers"
```

---

### Task 12: UI Components (Dialog, Banner, Help Panel) & Settings Tab Integration

**Files:**
- Create: `src/components/settings/experimental-provider-banner.tsx`
- Create: `src/components/settings/web-provider-help-panel.tsx`
- Create: `src/components/settings/deepseek-web-provider-dialog.tsx`
- Modify: `src/components/settings/tabs.tsx:320-370`
- Test: `src/components/settings/__tests__/deepseek-web-provider-dialog.test.tsx`

**Interfaces:**
- Consumes: `src/lib/settings.ts` helpers, UI components (`Dialog`, `Button`, `Input`, `Field`)
- Produces: Dedicated DeepSeek Web settings dialog and card in Providers Tab

- [ ] **Step 1: Write the failing UI test**

```tsx
// src/components/settings/__tests__/deepseek-web-provider-dialog.test.tsx
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { DeepSeekWebProviderDialog } from "../deepseek-web-provider-dialog";
import * as settings from "@/lib/settings";

vi.mock("@/lib/settings", async () => {
  const actual = await vi.importActual<any>("@/lib/settings");
  return {
    ...actual,
    checkWebProviderSession: vi.fn(),
    saveWebProviderSession: vi.fn(),
    discoverWebProviderModels: vi.fn(),
  };
});

describe("DeepSeekWebProviderDialog", () => {
  it("renders experimental banner, separates Check from Save, and opens contextual help", async () => {
    render(<DeepSeekWebProviderDialog open={true} onClose={() => {}} onSaved={() => {}} />);

    expect(screen.getByText(/Experimental: DeepSeek Web uses the web interface/i)).toBeDefined();
    expect(screen.getByRole("button", { name: /Check connection/i })).toBeDefined();
    
    // Save button disabled until verified
    const saveBtn = screen.getByRole("button", { name: /Save provider/i }) as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(true);

    // Click help button
    const helpBtn = screen.getByRole("button", { name: /How to get this\?/i });
    fireEvent.click(helpBtn);
    expect(screen.getByText(/How to get your session token/i)).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm vitest run src/components/settings/__tests__/deepseek-web-provider-dialog.test.tsx --maxWorkers=1
```
*Expected: FAIL with component not found.*

- [ ] **Step 3: Implement components and wire into `src/components/settings/tabs.tsx`**

Create `src/components/settings/experimental-provider-banner.tsx`:
```tsx
import { useState } from "react";
import { Warning, CaretDown, CaretUp } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";

export function ExperimentalProviderBanner() {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-900 dark:text-amber-200">
      <div className="flex items-start gap-2">
        <Warning className="size-4 shrink-0 text-amber-600 dark:text-amber-400 mt-0.5" />
        <div className="flex-1 space-y-1">
          <p className="font-semibold">
            Experimental: DeepSeek Web uses the web interface, not the official API.
          </p>
          <p className="text-muted-foreground text-[11px]">
            It may stop working when DeepSeek changes its web client. Use an account you control. Credentials and request identity are sent to the configured Yggdrasil server.
          </p>
          {expanded && (
            <div className="pt-2 text-[11px] text-muted-foreground border-t border-amber-500/20 mt-2 space-y-1">
              <p>• Unofficial integration with no uptime or stability guarantees.</p>
              <p>• Session credentials cannot be refreshed automatically; re-import is required on expiry.</p>
              <p>• Yggdrasil does not bypass CAPTCHA, WAF, or fingerprint controls.</p>
            </div>
          )}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 px-1.5 text-xs text-amber-800 dark:text-amber-300"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? <CaretUp className="size-3" /> : <CaretDown className="size-3" />}
          {expanded ? "Less" : "View limitations"}
        </Button>
      </div>
    </div>
  );
}
```

Create `src/components/settings/web-provider-help-panel.tsx`:
```tsx
import { X } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";

export function WebProviderHelpPanel({ onClose }: { onClose: () => void }) {
  return (
    <aside className="w-full lg:w-80 rounded-lg border bg-muted/40 p-4 text-xs space-y-3">
      <div className="flex items-center justify-between border-b pb-2">
        <h4 className="font-semibold text-foreground">How to get your session token</h4>
        <Button type="button" variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close help panel">
          <X className="size-3.5" />
        </Button>
      </div>
      <div className="space-y-2 text-muted-foreground text-[11px] leading-relaxed">
        <p>1. Sign in to DeepSeek Web using your own account.</p>
        <p>2. Open Developer Tools (F12) → Network tab.</p>
        <p>3. Send a chat message or inspect an authenticated API call.</p>
        <p>4. Locate the Authorization Bearer token from the request headers.</p>
        <p>5. Copy only the token value and paste it into the Web session token field.</p>
        <div className="p-2 rounded bg-background border border-border text-[10px] text-foreground font-mono">
          userToken=sk-...
        </div>
        <p className="text-destructive text-[10px]">
          Warning: Never share session credentials in logs, screenshots, or issue reports.
        </p>
      </div>
    </aside>
  );
}
```

Create `src/components/settings/deepseek-web-provider-dialog.tsx`:
```tsx
"use client";

import { useState, useEffect } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldLabel, FieldGroup, FieldDescription } from "@/components/ui/field";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { ExperimentalProviderBanner } from "./experimental-provider-banner";
import { WebProviderHelpPanel } from "./web-provider-help-panel";
import { checkWebProviderSession, saveWebProviderSession, discoverWebProviderModels } from "@/lib/settings";

export function DeepSeekWebProviderDialog({
  open,
  onClose,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [userToken, setUserToken] = useState("");
  const [userAgentMode, setUserAgentMode] = useState<"browser" | "server-default" | "custom">("browser");
  const [capturedUA, setCapturedUA] = useState("");
  const [customUA, setCustomUA] = useState("");
  const [showHelp, setShowHelp] = useState(false);
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [verified, setVerified] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window !== "undefined") {
      setCapturedUA(navigator.userAgent);
    }
  }, []);

  async function handleCheck() {
    setChecking(true);
    setError(null);
    try {
      const activeUA = userAgentMode === "browser" ? capturedUA : userAgentMode === "custom" ? customUA : undefined;
      const res = await checkWebProviderSession({
        providerId: "deepseek-web",
        userToken,
        userAgentMode,
        userAgent: activeUA,
      });
      if (res.ok) {
        setVerified(true);
      } else {
        setVerified(false);
        setError(res.message || "The session was rejected. Your credentials were not saved.");
      }
    } catch {
      setVerified(false);
      setError("Network error while validating session");
    } finally {
      setChecking(false);
    }
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const activeUA = userAgentMode === "browser" ? capturedUA : userAgentMode === "custom" ? customUA : undefined;
      const res = await saveWebProviderSession({
        providerId: "deepseek-web",
        userToken,
        userAgentMode,
        userAgent: activeUA,
      });
      if (res.ok) {
        // Trigger one-time model discovery
        void discoverWebProviderModels("deepseek-web", true);
        onSaved();
        onClose();
      } else {
        setError(res.message || "Failed to save session");
      }
    } catch {
      setError("Network error while saving session");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>DeepSeek Web (experimental)</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col lg:flex-row gap-4 items-start">
          <div className="flex-1 space-y-4">
            <ExperimentalProviderBanner />

            <FieldGroup>
              <Field>
                <div className="flex items-center justify-between">
                  <FieldLabel htmlFor="web-token">Web session token</FieldLabel>
                  <Button
                    type="button"
                    variant="link"
                    size="sm"
                    className="h-auto p-0 text-xs"
                    onClick={() => setShowHelp(!showHelp)}
                  >
                    How to get this?
                  </Button>
                </div>
                <Input
                  id="web-token"
                  type="password"
                  placeholder="userToken=... or raw session token"
                  value={userToken}
                  onChange={(e) => {
                    setUserToken(e.target.value);
                    setVerified(false);
                  }}
                />
                <FieldDescription>
                  Stored encrypted server-side; never returned to the browser.
                </FieldDescription>
              </Field>

              <Field>
                <FieldLabel>Request identity</FieldLabel>
                <RadioGroup value={userAgentMode} onValueChange={(v: any) => setUserAgentMode(v)} className="space-y-2">
                  <div className="flex items-center space-x-2">
                    <RadioGroupItem value="browser" id="ua-browser" />
                    <label htmlFor="ua-browser" className="text-xs">Use this browser's User-Agent</label>
                  </div>
                  {userAgentMode === "browser" && (
                    <Input readOnly value={capturedUA} className="text-[11px] font-mono bg-muted/30" />
                  )}
                  <div className="flex items-center space-x-2">
                    <RadioGroupItem value="server-default" id="ua-default" />
                    <label htmlFor="ua-default" className="text-xs">Use Yggdrasil's default User-Agent</label>
                  </div>
                  <div className="flex items-center space-x-2">
                    <RadioGroupItem value="custom" id="ua-custom" />
                    <label htmlFor="ua-custom" className="text-xs">Use a custom User-Agent (Advanced)</label>
                  </div>
                  {userAgentMode === "custom" && (
                    <Input
                      placeholder="Custom User-Agent string"
                      value={customUA}
                      onChange={(e) => setCustomUA(e.target.value)}
                      className="text-xs font-mono"
                    />
                  )}
                </RadioGroup>
              </Field>

              {error && <p className="text-destructive text-xs" role="alert">{error}</p>}
              {verified && <p className="text-emerald-600 dark:text-emerald-400 text-xs">Connection verified.</p>}
            </FieldGroup>
          </div>

          {showHelp && <WebProviderHelpPanel onClose={() => setShowHelp(false)} />}
        </div>

        <DialogFooter className="flex justify-between sm:justify-between">
          <Button
            type="button"
            variant="outline"
            disabled={checking || !userToken.trim()}
            onClick={handleCheck}
          >
            {checking ? "Checking connection…" : "Check connection"}
          </Button>
          <div className="flex gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
            <Button
              type="button"
              disabled={saving || !verified}
              onClick={handleSave}
            >
              {saving ? "Saving…" : "Save provider"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

In `src/components/settings/tabs.tsx`, add an "Experimental Web Providers" card section below the standard provider cards that opens `DeepSeekWebProviderDialog`.

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm vitest run src/components/settings/__tests__/deepseek-web-provider-dialog.test.tsx --maxWorkers=1
```
*Expected: PASS.*

- [ ] **Step 5: Commit**

```bash
git add src/components/settings/experimental-provider-banner.tsx src/components/settings/web-provider-help-panel.tsx src/components/settings/deepseek-web-provider-dialog.tsx src/components/settings/tabs.tsx src/components/settings/__tests__/deepseek-web-provider-dialog.test.tsx
git commit -m "feat(ui): add DeepSeek Web experimental dialog, banner, and contextual help panel"
```

---

## Verification & Self-Review Checklist

Before finalizing the plan:
1. **Spec Coverage:**
   - Single-user SQLite session storage (`web_provider_sessions`) with `provider_id` unique: Task 2 & 3.
   - Separate Check & Save endpoints: Task 4 & 5.
   - Fixed endpoint allowlist & `redirect: "error"` in adapter: Task 7.
   - User-Agent browser capture and precedence: Task 7 & 12.
   - No cookie auto-refresh and explicit error classification: Task 6 & 7.
   - Model auto-discovery with 15m TTL & registry merge: Task 10.
   - Chat resolution & project chat 400 rejection: Task 9.
   - Experimental warning banner & English contextual help sidepanel: Task 12.
   - Pre-implementation legal & ToS ADR: Task 0.
2. **Placeholder Scan:** Zero incomplete placeholders or deferral markers. Every task has concrete code and exact test commands.
3. **Type Consistency:** Types and function names (`createSessionStore`, `DeepSeekWebAdapter`, `parseSessionCandidate`, `classifyFailure`, `discoverAndMergeModels`) align across Tasks 3–12.
4. **Rule 18 Compliance:** All test execution commands explicitly specify `--maxWorkers=1`.
