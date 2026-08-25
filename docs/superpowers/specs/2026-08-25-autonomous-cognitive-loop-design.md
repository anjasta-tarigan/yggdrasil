# Autonomous Proactive Cognitive Loop & Self-Improvement Architecture Design

## 1. Overview
This document specifies the architecture for turning Yggdrasil into an autonomous, self-improving cognitive agent. It introduces a persistent SQLite-backed Job Queue, in-process single-concurrency queue runner, `node-cron` daemon for sleep/dream maintenance cycles, verbal post-turn reflection, automatic procedural mistake-prevention rule extraction, and dynamic adaptive prompt synthesis.

## 2. Goals
- **Proactive & Autonomous Execution**: Execute background learning without blocking user chat streams or requiring manual user commands.
- **Continuous Self-Improvement**: Learn from user corrections and feedback; store procedural anti-pattern rules to never repeat past mistakes.
- **Local Model Safety**: Enforce single-concurrency queue processing to prevent GPU/CPU saturation on local inference servers (vLLM / Ollama).
- **Crash Resilience**: Store asynchronous jobs in a durable SQLite `job_queue` table with retry backoff.
- **Memory Graph & Sleep Cycles**: Run periodic session consolidation (Light Sleep), associative knowledge graph discovery (Dream Cycle), and Ebbinghaus importance decay (Deep Sleep).

## 3. Database Schema Extensions

### 3.1 Job Queue Table (`job_queue`)
- `id`: Text primary key (`job_...`)
- `type`: Enum (`reflect_turn`, `sleep_consolidation`, `dream_graph_discovery`, `decay_sweep`)
- `payload`: JSON payload
- `status`: Enum (`pending`, `processing`, `completed`, `failed`)
- `attempts`: Integer (default 0)
- `maxAttempts`: Integer (default 3)
- `lastError`: Text (nullable)
- `runAt`: Timestamp (when the job is eligible to run)
- `createdAt`: Timestamp
- `updatedAt`: Timestamp

## 4. Subsystem Components

### 4.1 SQLite Job Queue & In-Process Runner (`src/lib/queue/`)
- **`enqueueJob(job)`**: Inserts a task into `job_queue` with `run_at` and triggers the worker event loop.
- **`startQueueRunner()`**: In-process sequential runner with `concurrency: 1`. Fetches the oldest eligible `pending` job, executes its handler, updates status, and applies exponential backoff on retries.

### 4.2 Post-Turn Verbal Reflection Engine (`src/lib/memory/reflection.ts`)
- **Trigger**: Enqueued on `/api/chat` `onFinish` stream completion.
- **Reflection Analysis**:
  - Evaluates user prompt and previous assistant response.
  - **Fact Extraction**: Extracts new user preferences and project facts into `semantic_memories`.
  - **Correction & Mistake Detection**: If user corrected or criticized previous output, extracts a structured **Procedural Rule** (`situation`, `mistake_to_avoid`, `correct_approach`) stored with tag `procedural_rule`.

### 4.3 Autonomous Sleep & Dream Daemon (`src/lib/daemon/scheduler.ts`)
- **Scheduler**: Powered by `node-cron`, initialized on server startup.
- **Light Sleep (Every 15 minutes)**: Enqueues `sleep_consolidation` to cluster and summarize unconsolidated episodic memories within the same session.
- **Dream Cycle (Every 1 hour)**: Enqueues `dream_graph_discovery` to scan semantic memories, compute cosine similarities ($\ge 0.82$), and create bidirectional associative links in `memory_relations`.
- **Decay Sweep (Every 24 hours)**: Enqueues `decay_sweep` to apply the Ebbinghaus forgetting curve, decaying unaccessed items and pruning consolidated low-importance rows.

### 4.4 Dynamic Adaptive Prompt Synthesis (`src/lib/ai/prompt.ts`)
- Dynamically compiles the system prompt from 4 modular layers:
  1. Base behavioral invariants (proactive web search, strict artifact creation, task planning).
  2. Matching learned procedural rules from past corrections (`<learned_rules_and_mistakes_to_avoid>`).
  3. User profile & persistent semantic preferences (`<user_preferences_and_facts>`).
  4. Active working memory and relevant episodic conversation context (`<cognitive_memory_context>`).

## 5. Security & Isolation Invariants
- **Local Isolation (Rule 06)**: All queue state, memories, and cron logs reside strictly within SQLite (`data/yggdrasil.db`).
- **No Silent Failures (Rule 02)**: Failed queue jobs record structured error logs and update `lastError` in the database.
- **Safe Transactions (Rule 15)**: Multi-step database mutations use synchronous SQLite transactions.
