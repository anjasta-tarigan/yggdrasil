# Architectural Design: Cognitive Security & Advanced Retrieval Upgrades

- **Date:** 2026-09-16
- **Status:** Approved
- **Scope:** 4 Critical Subsystems (At-Rest Encryption, 2-Hop Graph-RAG, ONNX Hardware Telemetry, Passive Contradiction Resolution)

---

## 1. Executive Summary

This architecture enhances Yggdrasil from a 9.3/10 to a 9.8+/10 personal AI assistant system by closing four architectural gaps:
1. **Data-at-Rest Envelope Encryption**: AES-256-GCM application-level cryptographic protection for credentials and sensitive settings using Node.js standard library `node:crypto`.
2. **Deep Multi-Hop Graph-RAG**: Controlled 2-hop associative and causal link traversal across `memory_relations` with exponential damping, cycle prevention, and graph consensus score boosting.
3. **ONNX Hardware Telemetry & Profiling**: Observability into active execution providers (DirectML, CoreML, CPU), initialization cold-start timing, and rolling p50/p95 inference latencies.
4. **Passive Semantic Contradiction Detection**: Proactive belief updating on the write-path in `addSemanticMemory` that detects conflicting prior knowledge without requiring explicit verbal user correction signals.

---

## 2. Pillar 1: Application-Level Envelope Encryption (`node:crypto` AES-256-GCM)

### 2.1 Problem & Threat Model
SQLite stores plaintext settings, AI provider credentials, API keys, and custom endpoints in `settings.value`. While the database is local, physical disk access or unintended backups expose secrets. Transparent page encryption (SQLCipher) requires replacing the C SQLite runtime, risking ABI incompatibility with `sqlite-vec` and compilation friction on Windows.

### 2.2 Design & Cryptographic Specification
- **Module:** `src/lib/security/encryption.ts`
- **Algorithm:** Authenticated AES-256-GCM (Galois/Counter Mode) with 128-bit authentication tag.
- **Key Derivation:** HKDF (RFC 5869) via `crypto.hkdfSync` using SHA-256, derived from `APP_SECRET` (with a secure fallback in development to a machine-unique seed).
- **Initialization Vector (IV):** 12 bytes cryptographically secure pseudo-random bytes (`crypto.randomBytes(12)`) per encryption call.
- **Envelope Format:**
  `enc:v1:<iv_base64>:<auth_tag_base64>:<ciphertext_base64>`
- **API Surface:**
  ```typescript
  export function encrypt(text: string): string;
  export function decrypt(cipherText: string): string;
  export function isEncrypted(value: unknown): boolean;
  export function encryptSecretConfig(config: Record<string, unknown>): Record<string, unknown>;
  export function decryptSecretConfig(config: Record<string, unknown>): Record<string, unknown>;
  ```
- **Transparent Migration:**
  - In `settings-service.ts`:
    - On read (`getSettingDb` / `getSettingsDb`): Decrypt values if marked `enc:v1:`. If plaintext, return as-is.
    - On write (`setSettingsDb`): Encrypt sensitive provider keys (`apiKey`, `token`, `secret`) or entire secret settings before committing to SQLite.
  - Zero disruption to FTS5 or vector indexes because public memory text remains search-indexed while secrets are locked at rest.

---

## 3. Pillar 2: Deep Multi-Hop Graph-RAG (2-Hop Traversal)

### 3.1 Problem
Direct hybrid retrieval (BM25 + sqlite-vec KNN) retrieves memories with direct lexical or semantic overlap. While 1-hop traversal connects immediate neighbors, complex reasoning requires associative chaining across 2 hops (e.g., *Query mentions Topic A* $\rightarrow$ *A links to Project B* $\rightarrow$ *B links to Constraint C*).

### 3.2 Algorithm & Score Propagation
- **Module:** `src/lib/memory/search.ts`
- **Hop 1 (Direct Neighbors):**
  - Up to 3 strongest relations per seed hit.
  - Propagation score:
    $$S_1 = S_{\text{seed}} \times \text{relStrength} \times 0.5 \times (0.8 + 0.4 \times \text{importance})$$
- **Hop 2 (Chained Associative Neighbors):**
  - Up to 2 strongest relations per Hop 1 node.
  - Chained propagation with exponential damping:
    $$S_2 = S_1 \times \text{relStrength} \times 0.35 \times (0.8 + 0.4 \times \text{importance})$$
- **Invariants & Protections:**
  1. **Cycle Prevention:** A `visited: Set<string>` tracks all expanded IDs across both hops.
  2. **Invalidation Filter:** Relations with `relation_type = 'superseded_by'` and memories flagged `{ superseded: true }` are strictly excluded.
  3. **Consensus Boosting:** When a candidate is reached from multiple paths, scores accumulate:
     $$\text{candidate.score} += S_{\text{incoming}} \times 0.3$$
  4. **Budget Cap:** Total graph-augmented candidates capped at 20 nodes to prevent activation explosion.

---

## 4. Pillar 3: ONNX Hardware Telemetry & Profiling

### 4.1 Problem
ONNX execution provider fallback (e.g., DirectML on Windows, CoreML on macOS falling back to CPU) operates silently in logs. The UI and operators have no visibility into active execution hardware, cold-start initialization latency, or inference response distributions.

### 4.2 Telemetry Store & Metrics
- **Module:** `src/lib/memory/onnx-session.ts` & `src/lib/memory/reranker.ts`
- **Tracked Metrics:**
  - `activeProvider`: `"directml"` | `"coreml"` | `"cpu"`
  - `coldStartTimeMs`: Duration in milliseconds taken by `InferenceSession.create()`
  - `totalRuns`: Cumulative inference count
  - `rollingLatencies`: Fixed ring buffer of the last 50 inference execution durations
  - `p50Ms` / `p95Ms`: 50th and 95th percentile execution latencies
- **Diagnostic API Integration:**
  Exposed via `getRerankerStatus()` and `SystemStats` so the Statistics page and diagnostics API report exact hardware telemetry without performance penalty.

---

## 5. Pillar 4: Passive Semantic Contradiction Detection

### 5.1 Problem
Belief updating previously relied solely on verbal correction triggers in conversational reflection (`"no, actually..."`). When users or automated background jobs insert new facts directly via tools or background consolidation, conflicting prior knowledge remained active alongside the new fact.

### 5.2 Resolution Logic in `addSemanticMemory`
- **Module:** `src/lib/memory/semantic-memory.ts`
- **Similarity Zones on Write:**
  1. **Equivalence ($\text{similarity} \ge 0.90$):** Duplicate fact. Merge tags, sources, update timestamps.
  2. **Contradiction Zone ($0.65 \le \text{similarity} < 0.90$):**
     - Compare candidate with stored memories sharing the same category/domain or high token overlap ($\ge 2$ significant thematic tokens).
     - Check semantic opposition or temporal supersession (e.g., contrasting preferences, changed versions, revised paths).
     - When contradiction is identified:
       1. Insert `memory_relations` edge: `prior_id --(superseded_by, strength=0.95)--> new_id`.
       2. Demote prior memory: `importance = 0.1`, metadata marked `{ superseded: true, supersededBy: new_id, supersededAt: timestamp }`.
  3. **Independence ($\text{similarity} < 0.65$):** Stored as a new standalone semantic memory.
- **Transaction Safety:** Executed inside SQLite transaction so duplicate resolution, contradiction marking, and new insertion commit atomically.

---

## 6. Verification & Test Plan

1. **Unit Tests for Encryption (`src/lib/security/__tests__/encryption.test.ts`):**
   - Roundtrip string encryption and decryption.
   - Tamper detection (modified ciphertext/auth tag throws error).
   - Secret masking in config objects with transparent plaintext fallback.
2. **Unit Tests for 2-Hop Graph-RAG (`src/lib/memory/__tests__/search-graph.test.ts`):**
   - Verify 2-hop propagation reaches indirect second-degree neighbors.
   - Verify damping factor ensures 2-hop score is strictly lower than 1-hop score.
   - Verify cycles (A -> B -> A) do not cause infinite loops.
   - Verify superseded memories are never expanded.
3. **Unit Tests for ONNX Telemetry (`src/lib/memory/__tests__/onnx-telemetry.test.ts`):**
   - Verify cold-start duration recording.
   - Verify rolling latency calculation and p50/p95 metric accuracy.
4. **Unit Tests for Passive Contradiction Detection (`src/lib/memory/__tests__/contradiction.test.ts`):**
   - Verify updating a preference ("I prefer tabs" -> "I prefer spaces") creates a `superseded_by` relation and demotes importance without verbal reflection cues.
