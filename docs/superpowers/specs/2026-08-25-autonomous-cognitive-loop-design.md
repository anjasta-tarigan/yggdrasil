# Autonomous Proactive Cognitive Loop & Self-Improvement Architecture Design

## 1. Overview
This document specifies the architecture for turning Yggdrasil into an autonomous, self-improving cognitive agent. It introduces a persistent SQLite-backed Job Queue, in-process single-concurrency queue runner with active-chat pause protection, stale job recovery, a `node-cron` daemon for sleep/dream maintenance cycles, verbal post-turn reflection with heuristic cost control, automatic procedural mistake-prevention rule extraction, and dynamic adaptive prompt synthesis with strict token budgeting.

## 2. Goals
- **Proactive & Autonomous Execution**: Execute background learning without blocking user chat streams or requiring manual user commands.
- **Continuous Self-Improvement**: Learn from user corrections and feedback; store procedural anti-pattern rules to never repeat past mistakes.
- **Local Model & GPU Protection**: Enforce single-concurrency queue processing with an **Active Chat Mutex/Pause** mechanism so background jobs never compete with live user streaming on local inference servers (vLLM / Ollama).
- **Crash & Stale Job Resilience**: Store asynchronous jobs in a durable SQLite `job_queue` table with `locked_at` timeouts and startup crash recovery.
- **Controlled Graph Density & Sleep Cycles**: Run session-scoped consolidation (Light Sleep), bounded associative knowledge graph discovery (Dream Cycle: top-3 neighbors $\ge 0.82$), and Ebbinghaus importance decay (Deep Sleep).
- **Token Budgeting**: Synthesize dynamic prompts with hard token ceilings across 4 modular layers.

## 3. Database Schema Extensions

### 3.1 Job Queue Table (`job_queue`)
```typescript
export const jobQueue = sqliteTable(
  "job_queue",
  {
    id: text("id").primaryKey(),
    type: text("type", {
      enum: [
        "reflect_turn",            // Post-turn verbal reflection & fact/rule extraction
        "sleep_consolidation",     // Cluster episodic turns into semantic memory
        "dream_graph_discovery",   // Discover semantic knowledge graph edges
        "decay_sweep",             // Ebbinghaus importance decay & pruning
      ],
    }).notNull(),
    payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    status: text("status", {
      enum: ["pending", "processing", "completed", "failed"],
    }).notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    lastError: text("last_error"),
    lockedAt: integer("locked_at", { mode: "timestamp" }),
    runAt: integer("run_at", { mode: "timestamp" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(strftime('%s', 'now'))`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(strftime('%s', 'now'))`),
  },
  (table) => ({
    statusRunAtIdx: index("idx_job_queue_status_run_at").on(
      table.status,
      table.runAt
    ),
  })
);
```

## 4. Subsystem Components

### 4.1 SQLite Job Queue & In-Process Runner (`src/lib/queue/`)
- **`enqueueJob(job)`**: Inserts a task into `job_queue` with `run_at` and triggers the worker event loop.
- **Active-Chat Mutex (`chatActiveTracker`)**:
  - Whenever `/api/chat` is streaming, it sets an in-memory flag `isUserChatting = true`.
  - When the queue runner is about to execute a background LLM task (`sleep_consolidation` or `reflect_turn`), it checks `isUserChatting`.
  - If the user is actively chatting, the runner defers the job by bumping `run_at = NOW() + 2 minutes` to protect GPU resources.
- **Stale Job Recovery**:
  - On startup and every heartbeat sweep, queries for jobs in `processing` where `locked_at < NOW() - 10 minutes`.
  - Stale jobs are reset to `pending` with incremented `attempts` (or marked `failed` if `attempts >= maxAttempts`).
- **`startQueueRunner()`**: In-process sequential runner with `concurrency: 1`. Fetches the oldest eligible `pending` job, executes its handler, updates status, and applies exponential backoff on retries.

### 4.2 Post-Turn Verbal Reflection Engine (`src/lib/memory/reflection.ts`)
- **Heuristic Cost Filtering**:
  - Does NOT blindly trigger on every single trivial turn (saving inference budget).
  - Triggers immediately when:
    1. The user's message contains correction indicators (e.g. *"no"*, *"wrong"*, *"actually"*, *"instead"*, *"not that"*), OR
    2. The message contains explicit preference cues (*"I prefer"*, *"always use"*, *"never use"*, *"my project is"*), OR
    3. The session reaches a milestone (every 5 conversational turns).
- **Reflection Analysis**:
  - Evaluates user prompt and previous assistant response.
  - **Fact Extraction**: Extracts new user preferences and project facts into `semantic_memories`.
  - **Correction & Mistake Detection**: If user corrected or criticized previous output, extracts a structured **Procedural Rule** (`situation`, `mistake_to_avoid`, `correct_approach`) stored with tag `procedural_rule`.

### 4.3 Autonomous Sleep & Dream Daemon (`src/lib/daemon/scheduler.ts`)
- **Scheduler**: Powered by `node-cron`, initialized on server startup.
- **Light Sleep (Every 15 minutes)**: Enqueues `sleep_consolidation` to cluster and summarize unconsolidated episodic memories within the same session.
- **Dream Cycle (Every 1 hour)**: Enqueues `dream_graph_discovery`.
  - For each semantic memory without edges, searches for the **top 3 most similar neighbors**.
  - If similarity $\ge 0.82$, creates a bidirectional link in `memory_relations` (preventing $O(N^2)$ dense mesh explosion).
- **Decay Sweep (Every 24 hours)**: Enqueues `decay_sweep` to apply the Ebbinghaus forgetting curve:
  $$\text{Importance}_{\text{new}} = \max\left(0.01, \text{Importance}_{\text{prev}} \times \exp(-\Delta t / 14) + 0.05 \times \ln(1 + \text{accessCount})\right)$$
  - Prunes consolidated low-importance rows ($< 0.05$) and cascades cleanup to `memory_relations`.

### 4.4 Dynamic Adaptive Prompt Synthesis with Token Budgeting (`src/lib/ai/prompt.ts`)
- Synthesizes system prompt with strict token ceilings:
  1. **Layer 1: Base Behavioral Invariants (~500 tokens)**: Proactive search, artifact isolation, task management.
  2. **Layer 2: Learned Procedural Rules (Budget: max 800 tokens)**: Top relevant mistake-prevention rules retrieved via hybrid search on user query.
  3. **Layer 3: User Profile & Preferences (Budget: max 500 tokens)**: Core preferences extracted from semantic memory.
  4. **Layer 4: Cognitive Context (Budget: max 1200 tokens)**: Active unexpired Working Memory + top relevant Episodic turns.

## 5. Security & Isolation Invariants
- **Local Isolation (Rule 06)**: All queue state, memories, and cron logs reside strictly within SQLite (`data/yggdrasil.db`).
- **No Silent Failures (Rule 02)**: Failed queue jobs record structured error logs and update `lastError` in the database.
- **Safe Transactions (Rule 15)**: Multi-step database mutations use synchronous SQLite transactions.
