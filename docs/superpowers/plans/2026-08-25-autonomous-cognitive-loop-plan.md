# Autonomous Cognitive Loop & Self-Improvement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an autonomous, self-improving cognitive loop for Yggdrasil featuring a durable SQLite Job Queue (`job_queue`), in-process single-concurrency queue runner with active-chat GPU protection, `node-cron` daemon for sleep/dream maintenance cycles, post-turn verbal reflection with heuristic cost filtering, automatic procedural mistake-prevention rule extraction, and dynamic adaptive prompt synthesis with strict token budgeting.

**Architecture:** A background worker loop processes queued cognitive operations sequentially from SQLite. `node-cron` schedules maintenance passes (Light Sleep session consolidation, Dream Cycle associative graph discovery, and Deep Sleep Ebbinghaus decay). Verbal reflection analyzes user turns to extract facts and mistake-prevention rules, which are dynamically injected into modular system prompt layers with token budgets before each LLM turn.

**Tech Stack:** `node-cron`, `better-sqlite3`, `drizzle-orm`, `ai` (Vercel AI SDK), `zod`, `vitest`, Next.js App Router (TypeScript).

**Spec:** `docs/superpowers/specs/2026-08-25-autonomous-cognitive-loop-design.md`

## Global Constraints

- Isolation: Database, job queue, and runtime storage MUST live strictly within project root (`data/yggdrasil.db`), never escaping to `$HOME` (Rule 06).
- SQLite WAL mode and Synchronous Transactions: In-process database mutations must use `better-sqlite3` synchronous transaction callbacks `db.transaction((tx) => ...)` (Rule 15).
- Error Handling: No silent error swallows; all queue job failures must log structured errors and update `last_error` in SQLite (Rule 02).
- Diff discipline & TDD: Implement each task with a test-driven approach and minimal surgical diffs (Rule 16).
- Concurrency Control: Single-concurrency queue runner (`concurrency: 1`) to protect local inference servers (vLLM / Ollama) from OOM or saturation.

---

## File Structure & Responsibilities

```
src/
├── db/
│   ├── schema.ts                # Adds jobQueue table definition with index on (status, runAt)
│   └── init.ts                  # Adds job_queue DDL and indexing
├── lib/
│   ├── queue/
│   │   ├── types.ts             # Job payload and queue types
│   │   ├── tracker.ts           # Chat-active mutex tracker (isUserChatting) for GPU protection
│   │   ├── queue.ts             # Enqueue, dequeue, complete, fail, and stale job recovery functions
│   │   └── runner.ts            # Single-concurrency in-process worker loop
│   ├── memory/
│   │   ├── reflection.ts        # Verbal reflection LLM engine & procedural rule extractor
│   │   ├── dream.ts             # Associative knowledge graph discovery (top-3 neighbors >= 0.82)
│   │   └── decay.ts             # Ebbinghaus retention curve & pruning
│   ├── daemon/
│   │   └── scheduler.ts         # node-cron daemon scheduling sleep/dream/decay maintenance
│   └── ai/
│       └── prompt.ts            # Modular dynamic system prompt synthesizer with token budgeting
├── app/
│   └── api/
│       ├── chat/
│       │   └── route.ts         # Injects dynamic prompt layers + triggers post-turn reflection job
│       └── daemon/
│           └── route.ts         # Health check and manual trigger status for daemon & queue
```

---

### Task 1: Add `node-cron` Dependency & Update Database Schema for Job Queue

**Files:**
- Modify: `package.json`
- Modify: `src/db/schema.ts`
- Modify: `src/db/init.ts`
- Test: `src/db/__tests__/job-queue-schema.test.ts`

**Interfaces:**
- Produces: `jobQueue` Drizzle table, `node-cron` package dependency, and `idx_job_queue_status_run_at` index in SQLite.

- [ ] **Step 1: Install node-cron dependency**

```bash
pnpm add node-cron
pnpm add -D @types/node-cron
```

- [ ] **Step 2: Write failing test for job queue schema**

Create `src/db/__tests__/job-queue-schema.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../schema";
import { setupFtsAndTriggers } from "../init";

describe("Job Queue Schema", () => {
  let sqlite: Database.Database;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    setupFtsAndTriggers(sqlite);
  });

  it("creates job_queue table with proper columns and index", () => {
    const db = drizzle(sqlite, { schema });

    const tables = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as { name: string }[];
    const tableNames = tables.map((t) => t.name);

    expect(tableNames).toContain("job_queue");

    // Insert a test job
    const now = new Date();
    db.insert(schema.jobQueue)
      .values({
        id: "job_test_1",
        type: "reflect_turn",
        payload: { test: true },
        status: "pending",
        runAt: now,
      })
      .run();

    const [job] = db.select().from(schema.jobQueue).all();
    expect(job.id).toBe("job_test_1");
    expect(job.type).toBe("reflect_turn");
    expect(job.status).toBe("pending");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run src/db/__tests__/job-queue-schema.test.ts`
Expected: FAIL.

- [ ] **Step 4: Update `src/db/schema.ts` and `src/db/init.ts`**

Update `src/db/schema.ts` to export `jobQueue` with `index("idx_job_queue_status_run_at")`.
Update `src/db/init.ts` to include `CREATE TABLE IF NOT EXISTS job_queue` and `CREATE INDEX IF NOT EXISTS idx_job_queue_status_run_at`.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run src/db/__tests__/job-queue-schema.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml src/db/schema.ts src/db/init.ts src/db/__tests__/job-queue-schema.test.ts
git commit -m "feat(db): add job_queue table schema, index, and node-cron dependency"
```

---

### Task 2: Implement SQLite Job Queue Core & Active-Chat Mutex Tracker

**Files:**
- Create: `src/lib/queue/types.ts`
- Create: `src/lib/queue/tracker.ts`
- Create: `src/lib/queue/queue.ts`
- Test: `src/lib/queue/__tests__/queue.test.ts`

**Interfaces:**
- Produces:
  - `chatActiveTracker`: `{ startChat(): void, endChat(): void, isChatActive(): boolean }`
  - `enqueueJob(input: EnqueueJobInput): Promise<string>`
  - `acquireNextJob(): Promise<JobRow | null>`
  - `completeJob(id: string): Promise<void>`
  - `failJob(id: string, error: string): Promise<void>`
  - `recoverStaleJobs(staleThresholdMs?: number): Promise<number>`

- [ ] **Step 1: Write failing test for queue operations and stale recovery**

Create `src/lib/queue/__tests__/queue.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@/db/schema";
import { setupFtsAndTriggers } from "@/db/init";
import {
  enqueueJob,
  acquireNextJob,
  completeJob,
  failJob,
  recoverStaleJobs,
} from "../queue";

describe("SQLite Job Queue Core", () => {
  let sqlite: Database.Database;
  let testDb: any;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    setupFtsAndTriggers(sqlite);
    testDb = drizzle(sqlite, { schema });
  });

  it("enqueues and acquires jobs in runAt order", async () => {
    const id1 = await enqueueJob(
      {
        type: "reflect_turn",
        payload: { num: 1 },
        runAt: new Date(Date.now() - 1000),
      },
      testDb
    );

    const id2 = await enqueueJob(
      {
        type: "sleep_consolidation",
        payload: { num: 2 },
        runAt: new Date(Date.now() + 5000), // Future
      },
      testDb
    );

    const job = await acquireNextJob(testDb);
    expect(job).not.toBeNull();
    expect(job?.id).toBe(id1);
    expect(job?.status).toBe("processing");

    // Second job is in the future, should not be acquired
    const nextJob = await acquireNextJob(testDb);
    expect(nextJob).toBeNull();

    await completeJob(id1, testDb);
  });

  it("recovers stale processing jobs on timeout", async () => {
    const id = await enqueueJob(
      {
        type: "reflect_turn",
        payload: { test: true },
        runAt: new Date(Date.now() - 1000),
      },
      testDb
    );

    const acquired = await acquireNextJob(testDb);
    expect(acquired?.id).toBe(id);

    // Simulate stale lock older than 10 mins
    testDb
      .update(schema.jobQueue)
      .set({ lockedAt: new Date(Date.now() - 15 * 60 * 1000) })
      .run();

    const recoveredCount = await recoverStaleJobs(10 * 60 * 1000, testDb);
    expect(recoveredCount).toBe(1);

    const reacquired = await acquireNextJob(testDb);
    expect(reacquired?.id).toBe(id);
    expect(reacquired?.attempts).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/queue/__tests__/queue.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/lib/queue/types.ts` & `src/lib/queue/tracker.ts`**

Create `src/lib/queue/types.ts` defining `JobType`, `JobPayload`, `JobRow`.
Create `src/lib/queue/tracker.ts` with reference-counted `isUserChatting` active chat tracker.

- [ ] **Step 4: Implement `src/lib/queue/queue.ts`**

Implement `enqueueJob`, `acquireNextJob`, `completeJob`, `failJob`, `recoverStaleJobs` using Drizzle ORM and SQLite transactions.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run src/lib/queue/__tests__/queue.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/queue/
git commit -m "feat(queue): implement SQLite job queue with stale recovery and active chat tracker"
```

---

### Task 3: In-Process Single-Concurrency Queue Runner

**Files:**
- Create: `src/lib/queue/runner.ts`
- Test: `src/lib/queue/__tests__/runner.test.ts`

**Interfaces:**
- Produces: `startQueueRunner(db?: AppDatabase)`, `registerJobHandler(type: JobType, handler: Function)`, `stopQueueRunner()`.

- [ ] **Step 1: Write failing test for the queue runner**

Create `src/lib/queue/__tests__/runner.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@/db/schema";
import { setupFtsAndTriggers } from "@/db/init";
import { enqueueJob } from "../queue";
import {
  registerJobHandler,
  processOneJob,
  startQueueRunner,
  stopQueueRunner,
} from "../runner";
import { chatActiveTracker } from "../tracker";

describe("Queue Runner Loop", () => {
  let sqlite: Database.Database;
  let testDb: any;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    setupFtsAndTriggers(sqlite);
    testDb = drizzle(sqlite, { schema });
  });

  afterEach(() => {
    stopQueueRunner();
  });

  it("processes registered job handlers sequentially", async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    registerJobHandler("reflect_turn", handler);

    const id = await enqueueJob(
      {
        type: "reflect_turn",
        payload: { sample: "data" },
        runAt: new Date(Date.now() - 1000),
      },
      testDb
    );

    const processed = await processOneJob(testDb);
    expect(processed).toBe(true);
    expect(handler).toHaveBeenCalledWith({ sample: "data" });
  });

  it("defers background LLM jobs when user is actively chatting (GPU protection)", async () => {
    chatActiveTracker.startChat();

    const id = await enqueueJob(
      {
        type: "sleep_consolidation",
        payload: { batchSize: 10 },
        runAt: new Date(Date.now() - 1000),
      },
      testDb
    );

    const processed = await processOneJob(testDb);
    expect(processed).toBe(false); // Deferred

    chatActiveTracker.endChat();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/queue/__tests__/runner.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/lib/queue/runner.ts`**

Implement `registerJobHandler`, `processOneJob`, `startQueueRunner`, `stopQueueRunner` with active-chat GPU deferrals and exponential backoff retry.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/lib/queue/__tests__/runner.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/queue/runner.ts src/lib/queue/__tests__/runner.test.ts
git commit -m "feat(queue): implement single-concurrency queue runner with GPU active-chat protection"
```

---

### Task 4: Post-Turn Verbal Reflection & Procedural Rule Extractor

**Files:**
- Create: `src/lib/memory/reflection.ts`
- Test: `src/lib/memory/__tests__/reflection.test.ts`

**Interfaces:**
- Produces:
  - `shouldReflectOnTurn(userPrompt: string, turnIndex: number): boolean` (Heuristic cost filter)
  - `executeTurnReflection(payload: ReflectionPayload, db?: AppDatabase): Promise<ReflectionResult>`

- [ ] **Step 1: Write failing test for reflection heuristic and extraction**

Create `src/lib/memory/__tests__/reflection.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@/db/schema";
import { setupFtsAndTriggers } from "@/db/init";
import {
  shouldReflectOnTurn,
  executeTurnReflection,
} from "../reflection";

describe("Verbal Reflection & Procedural Rule Extraction", () => {
  let sqlite: Database.Database;
  let testDb: any;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    setupFtsAndTriggers(sqlite);
    testDb = drizzle(sqlite, { schema });
  });

  it("filters turns using heuristic cost rules", () => {
    expect(shouldReflectOnTurn("No, you made a mistake with transactions", 1)).toBe(true);
    expect(shouldReflectOnTurn("Actually use Tailwind v4", 1)).toBe(true);
    expect(shouldReflectOnTurn("I prefer dark mode always", 1)).toBe(true);
    expect(shouldReflectOnTurn("Hello there", 1)).toBe(false);
    expect(shouldReflectOnTurn("Hello there", 5)).toBe(true); // 5-turn milestone
  });

  it("extracts procedural mistake-prevention rules and stores in semantic_memories", async () => {
    const mockReflector = vi.fn().mockResolvedValue({
      newFacts: [{ content: "User is building a Next.js app", category: "project_fact", importance: 0.85, tags: ["nextjs"] }],
      correctionDetected: true,
      proceduralRule: {
        situation: "SQLite transactions with better-sqlite3",
        mistake: "Passing async callback to db.transaction()",
        correction: "Always pass synchronous callbacks db.transaction((tx) => ...)",
        tags: ["sqlite", "procedural_rule"],
      },
    });

    await executeTurnReflection(
      {
        sessionId: "s1",
        userPrompt: "No, better-sqlite3 transactions cannot be async!",
        assistantResponse: "I will use async transaction...",
      },
      testDb,
      mockReflector
    );

    const memories = testDb.select().from(schema.semanticMemories).all();
    expect(memories.length).toBe(2);

    const ruleMemory = memories.find((m: any) => m.content.includes("MISTAKE TO AVOID"));
    expect(ruleMemory).toBeDefined();
    expect(ruleMemory.tags).toContain("procedural_rule");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/memory/__tests__/reflection.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/lib/memory/reflection.ts`**

Implement `shouldReflectOnTurn` heuristic filter and `executeTurnReflection` with structured schema extraction using Vercel AI SDK `generateText` with `defaultModel`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/lib/memory/__tests__/reflection.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/memory/reflection.ts src/lib/memory/__tests__/reflection.test.ts
git commit -m "feat(memory): implement verbal reflection engine and procedural rule extraction"
```

---

### Task 5: Autonomous Dream Cycle (Graph Edge Discovery) & Enhanced Decay Sweep

**Files:**
- Create: `src/lib/memory/dream.ts`
- Modify: `src/lib/memory/compaction.ts`
- Test: `src/lib/memory/__tests__/dream.test.ts`

**Interfaces:**
- Produces: `runDreamGraphDiscovery(options?: DreamOptions): Promise<{ edgesCreated: number }>`, and enhanced `runMemoryCompaction` with the Ebbinghaus exponential curve formula.

- [ ] **Step 1: Write failing test for dream cycle graph discovery**

Create `src/lib/memory/__tests__/dream.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@/db/schema";
import { setupFtsAndTriggers } from "@/db/init";
import { addSemanticMemory } from "../semantic-memory";
import { generateEmbedding } from "../embeddings";
import { runDreamGraphDiscovery } from "../dream";

describe("Dream Cycle Graph Discovery", () => {
  let sqlite: Database.Database;
  let testDb: any;

  beforeEach(async () => {
    sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    setupFtsAndTriggers(sqlite);
    testDb = drizzle(sqlite, { schema });

    const emb1 = await generateEmbedding("Drizzle ORM with SQLite database schemas");
    const emb2 = await generateEmbedding("Drizzle ORM with better-sqlite3 database tables");

    await addSemanticMemory({ content: "Concept A: Drizzle schemas", embedding: emb1 }, testDb);
    await addSemanticMemory({ content: "Concept B: Drizzle tables", embedding: emb2 }, testDb);
  });

  it("creates bounded associative links for similar semantic nodes", async () => {
    const result = await runDreamGraphDiscovery({ similarityThreshold: 0.8, db: testDb });
    expect(result.edgesCreated).toBeGreaterThanOrEqual(1);

    const relations = testDb.select().from(schema.memoryRelations).all();
    expect(relations.length).toBeGreaterThanOrEqual(1);
    expect(relations[0].relationType).toBe("associative_link");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/memory/__tests__/dream.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/lib/memory/dream.ts` & update `src/lib/memory/compaction.ts`**

Implement `runDreamGraphDiscovery` (scanning unlinked semantic memories, finding top-3 cosine neighbors $\ge 0.82$, creating bidirectional `memory_relations`).
Update `runMemoryCompaction` with exponential time decay and access count boosts.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/lib/memory/__tests__/dream.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/memory/dream.ts src/lib/memory/compaction.ts src/lib/memory/__tests__/dream.test.ts
git commit -m "feat(memory): implement dream cycle associative graph discovery and Ebbinghaus decay"
```

---

### Task 6: Autonomous Sleep & Maintenance Daemon Scheduler

**Files:**
- Create: `src/lib/daemon/scheduler.ts`
- Test: `src/lib/daemon/__tests__/scheduler.test.ts`

**Interfaces:**
- Produces: `initCognitiveDaemon(): void`, `stopCognitiveDaemon(): void`. Registers cron jobs (15m Light Sleep, 1h Dream Cycle, 24h Deep Decay) that enqueue durable tasks into `jobQueue`.

- [ ] **Step 1: Write failing test for scheduler daemon**

Create `src/lib/daemon/__tests__/scheduler.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@/db/schema";
import { setupFtsAndTriggers } from "@/db/init";
import { initCognitiveDaemon, stopCognitiveDaemon, triggerMaintenancePass } from "../scheduler";

describe("Cognitive Daemon Scheduler", () => {
  let sqlite: Database.Database;
  let testDb: any;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    setupFtsAndTriggers(sqlite);
    testDb = drizzle(sqlite, { schema });
  });

  afterEach(() => {
    stopCognitiveDaemon();
  });

  it("enqueues maintenance jobs on manual and scheduled triggers", async () => {
    await triggerMaintenancePass("light_sleep", testDb);
    const jobs = testDb.select().from(schema.jobQueue).all();
    expect(jobs.length).toBe(1);
    expect(jobs[0].type).toBe("sleep_consolidation");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/daemon/__tests__/scheduler.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/lib/daemon/scheduler.ts`**

Implement `initCognitiveDaemon`, `stopCognitiveDaemon`, and `triggerMaintenancePass` using `node-cron` and `enqueueJob`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/lib/daemon/__tests__/scheduler.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/daemon/
git commit -m "feat(daemon): implement node-cron cognitive maintenance scheduler"
```

---

### Task 7: Dynamic Adaptive System Prompt Synthesizer with Token Budgeting

**Files:**
- Create: `src/lib/ai/prompt.ts`
- Modify: `src/app/api/chat/route.ts`
- Test: `src/lib/ai/__tests__/prompt.test.ts`

**Interfaces:**
- Produces: `synthesizeSystemPrompt(options: PromptSynthesisOptions): Promise<string>`. Assembles the 4-layer system prompt with hard token limits:
  1. Base behavioral rules (~500 tokens).
  2. Matching procedural mistake-prevention rules (max 800 tokens).
  3. Stored user preferences & profile (max 500 tokens).
  4. Active working context & relevant episodic history (max 1200 tokens).

- [ ] **Step 1: Write failing test for prompt synthesizer**

Create `src/lib/ai/__tests__/prompt.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@/db/schema";
import { setupFtsAndTriggers } from "@/db/init";
import { addSemanticMemory } from "@/lib/memory/semantic-memory";
import { addWorkingMemory } from "@/lib/memory/working-memory";
import { synthesizeSystemPrompt } from "../prompt";

describe("Dynamic Adaptive Prompt Synthesizer", () => {
  let sqlite: Database.Database;
  let testDb: any;

  beforeEach(async () => {
    sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    setupFtsAndTriggers(sqlite);
    testDb = drizzle(sqlite, { schema });

    // Seed procedural rule
    await addSemanticMemory(
      {
        content: "[MISTAKE TO AVOID in SQLite]: Never use async callbacks in better-sqlite3 transactions.",
        tags: ["procedural_rule", "sqlite"],
        importance: 0.95,
      },
      testDb
    );

    // Seed working memory
    await addWorkingMemory(
      {
        content: "Active task: building cognitive loop",
        tags: ["temp"],
      },
      testDb
    );
  });

  it("synthesizes all modular layers with procedural rules and working context", async () => {
    const prompt = await synthesizeSystemPrompt({
      userQuery: "How do I configure SQLite transactions?",
      db: testDb,
      sqlite,
    });

    expect(prompt).toContain("You are Yggdrasil");
    expect(prompt).toContain("<learned_rules_and_mistakes_to_avoid>");
    expect(prompt).toContain("Never use async callbacks");
    expect(prompt).toContain("<cognitive_memory_context>");
    expect(prompt).toContain("Active task: building cognitive loop");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/ai/__tests__/prompt.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/lib/ai/prompt.ts` & update `src/app/api/chat/route.ts`**

Implement `synthesizeSystemPrompt` with layer truncation and token budgeting.
Update `src/app/api/chat/route.ts` to call `synthesizeSystemPrompt`, notify `chatActiveTracker`, and enqueue `reflect_turn` in `onFinish`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/lib/ai/__tests__/prompt.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/ai/prompt.ts src/lib/ai/__tests__/prompt.test.ts src/app/api/chat/route.ts
git commit -m "feat(ai): integrate dynamic adaptive prompt synthesizer and chat reflection hook"
```

---

### Task 8: Server Initialization & Full Suite Verification

**Files:**
- Create: `src/lib/bootstrap.ts`
- Modify: `src/app/layout.tsx` or `src/app/api/health/route.ts`
- Test: Full Vitest suite & build check

**Interfaces:**
- Bootstraps queue runner and daemon scheduler on server startup and verifies full system test coverage.

- [ ] **Step 1: Implement `src/lib/bootstrap.ts`**

Create `src/lib/bootstrap.ts` registering handlers (`reflect_turn`, `sleep_consolidation`, `dream_graph_discovery`, `decay_sweep`), starting the queue runner, and initializing `node-cron`.

- [ ] **Step 2: Run all unit and integration tests**

Run: `pnpm test`
Expected: All test files PASS with 0 errors.

- [ ] **Step 3: Run TypeScript type checker**

Run: `pnpm exec tsc --noEmit`
Expected: 0 type errors.

- [ ] **Step 4: Run Next.js production build**

Run: `pnpm build`
Expected: Successful build.

- [ ] **Step 5: Commit**

```bash
git add src/lib/bootstrap.ts src/
git commit -m "feat(system): bootstrap autonomous cognitive daemon and queue runner"
```
