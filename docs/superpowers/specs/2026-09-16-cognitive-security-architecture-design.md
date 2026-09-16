# Architectural Design: Cognitive Security & Advanced Retrieval Upgrades (Hardened)

- **Date:** 2026-09-16
- **Status:** Approved & Hardened with Audit Feedback
- **Hardware Target:** Intel Core i5-5200U (Broadwell, 2C/4T, AVX2, no AVX-512) & Cross-Platform (Windows/Linux/macOS)
- **Scope:** 4 Critical Subsystems (At-Rest Encryption, 2-Hop Graph-RAG, ONNX Hardware Telemetry, Calibrated Passive Contradiction Resolution)

---

## 1. Executive Summary

This architecture enhances Yggdrasil from a 9.3/10 to a 9.8+/10 personal AI assistant system by closing four architectural gaps with strict resource discipline tuned for constrained environments:
1. **Data-at-Rest Envelope Encryption**: Authenticated AES-256-GCM application-level protection for credentials and sensitive settings using `node:crypto`, featuring CSPRNG 12-byte IVs, HKDF-SHA256 key derivation, key rotation paths, and memory zeroing.
2. **Deep Multi-Hop Graph-RAG**: Controlled 2-hop associative link traversal across `memory_relations` with exponential damping ($S_2 = S_1 \times \text{relStrength} \times 0.35$), cycle prevention, strict 20-node budget cap, early-exit pruning, and linear $O(n \times d)$ traversal complexity.
3. **ONNX Hardware Telemetry & Profiling**: Race-free execution provider detection (DirectML, CoreML, CPU), cold-start timing, and fixed-size circular ring buffer (50 entries, TypedArray, zero GC churn) reporting p50/p95 inference latencies.
4. **Calibrated Passive Semantic Contradiction Detection**: Proactive belief updating restricted to intra-category pairs in the tightened $0.78 \le \text{sim} < 0.90$ band with predicate/subject alignment, eliminating cross-domain false positives.

---

## 2. Pillar 1: Application-Level Envelope Encryption (`node:crypto` AES-256-GCM)

### 2.1 Threat Model & Hardware Constraints
SQLite stores plaintext settings, AI provider credentials, API keys, and custom endpoints in `settings.value`. While the database is local, physical disk access or unintended backups expose secrets. Transparent page encryption (SQLCipher) requires replacing the C SQLite runtime, risking ABI incompatibility with `sqlite-vec` and compilation friction on Windows.

### 2.2 Hardened Cryptographic Specification
- **Module:** `src/lib/security/encryption.ts`
- **Algorithm:** Authenticated AES-256-GCM (Galois/Counter Mode) with 128-bit authentication tag.
- **Key Derivation:** HKDF (RFC 5869) via `crypto.hkdfSync` using SHA-256 with domain separation `info = "yggdrasil-settings-envelope-v1"`, derived from `process.env.APP_SECRET`.
  - Fallback seed in dev: Uses machine-unique identifier hashed with constant salt, with a persistent warning.
- **IV Generation & Uniqueness:** Cryptographically secure pseudo-random 12 bytes (`crypto.randomBytes(12)`). In GCM, a 96-bit random IV allows up to $2^{32}$ encryptions per key with negligible collision risk ($< 2^{-32}$).
- **Memory Residency Safety:** Sensitive buffers (plainkeys, decrypted intermediate buffers) are zeroed using `buffer.fill(0)` in `finally` blocks after cryptographic operations.
- **Envelope Format:**
  `enc:v1:<iv_base64>:<auth_tag_base64>:<ciphertext_base64>`
- **Key Rotation Support:**
  Version tag `v1` supports migration to `v2` via `rotateSecretConfig(payload, oldSecret, newSecret)`:
  ```typescript
  export function rotateSecretConfig(
    encryptedConfig: Record<string, unknown>,
    oldSecret: string,
    newSecret: string
  ): Record<string, unknown>;
  ```
- **Transparent Migration:**
  - In `settings-service.ts`:
    - On read (`getSettingDb` / `getSettingsDb`): Decrypt values if marked `enc:v1:`. If plaintext, return as-is.
    - On write (`setSettingsDb`): Encrypt sensitive provider keys (`apiKey`, `token`, `secret`) before committing to SQLite.
  - Zero disruption to FTS5 or vector indexes because public memory text remains search-indexed while secrets are locked at rest.

---

## 3. Pillar 2: Deep Multi-Hop Graph-RAG (2-Hop Traversal on i5-5200U)

### 3.1 Algorithmic Complexity & Optimization
Direct hybrid retrieval (BM25 + sqlite-vec KNN) retrieves memories with direct lexical or semantic overlap. While 1-hop traversal connects immediate neighbors, complex reasoning requires associative chaining across 2 hops.

To prevent exponential fan-out and $O(n \times d^2)$ CPU overhead on dual-core hardware:
1. **Strict Total Candidate Budget:** Hard ceiling of **20 graph-augmented candidates** globally.
2. **Early-Exit Pruning:** Hop 2 expansion immediately aborts if total candidates have reached the 20-node ceiling.
3. **No Pairwise Candidate Matrix:** Traversal is linear $O(n \times d)$ — scores are propagated strictly along existing database edges without computing candidate-to-candidate Cartesian similarity matrices.

### 3.2 Score Propagation Formulation
- **Module:** `src/lib/memory/search.ts`
- **Hop 1 (Direct Neighbors):**
  - Top 3 strongest relations per seed hit.
  - Score propagation:
    $$S_1 = S_{\text{seed}} \times \text{relStrength} \times 0.5 \times (0.8 + 0.4 \times \text{importance})$$
- **Hop 2 (Chained Associative Neighbors):**
  - Top 2 strongest relations per Hop 1 node (only if candidate count $< 20$).
  - Exponentially damped propagation:
    $$S_2 = S_1 \times \text{relStrength} \times 0.35 \times (0.8 + 0.4 \times \text{importance})$$
- **Invariants & Cycle Safety:**
  - `visited: Set<string>` tracks all expanded IDs across both hops.
  - Relations with `relation_type = 'superseded_by'` and memories flagged `{ superseded: true }` are strictly excluded.
  - Consensus boosting: When a candidate is reached from multiple paths, scores accumulate:
    $$\text{candidate.score} += S_{\text{incoming}} \times 0.3$$

---

## 4. Pillar 3: ONNX Hardware Telemetry & Profiling

### 4.1 Race-Free Provider Detection & Memory Safety
- **Module:** `src/lib/memory/onnx-session.ts` & `src/lib/memory/reranker.ts`
- **Race-Free Initialization:** `activeProvider` is stamped **strictly after** `ort.InferenceSession.create()` resolves successfully and confirms the attached provider, preventing pre-creation state races.
- **Zero-Allocation Ring Buffer:**
  - Uses a fixed `Float32Array(50)` ring buffer with write pointer for rolling latencies (~200 bytes total memory).
  - No array allocations, reallocations, or GC sweeps during query routing.
- **Tracked Telemetry Properties:**
  ```typescript
  export interface OnnxTelemetry {
    activeProvider: "directml" | "coreml" | "cpu";
    coldStartTimeMs: number;
    totalInferences: number;
    lastInferenceMs: number;
    avgLatencyMs: number;
    p50LatencyMs: number;
    p95LatencyMs: number;
    memoryPressure: {
      peakRssMb: number;
      heapUsedMb: number;
      gpuAllocatedBytes?: number | null;
    };
  }
  ```
- **Observability:** Exposed in `getRerankerStatus()` and integrated into the Statistics page diagnostics.

---

## 5. Pillar 4: Calibrated Passive Semantic Contradiction Detection

### 5.1 Elimination of False Positives
The audit demonstrated that a generic $0.65–0.90$ threshold with 2-token overlap triggers false positives across domains (e.g. "prefers dark theme for coding" vs "prefers dark mode for photography").

To guarantee precision:
1. **Category Isolation Guard:** Contradiction checking ONLY executes against prior memories within the **exact same semantic category** (e.g., `user_preference` against `user_preference`, `procedural_rule` against `procedural_rule`). Uncategorized facts must share matching domain tags.
2. **Elevated Similarity Window:** Tightened from $0.65$ to **$0.78 \le \text{similarity} < 0.90$**. Facts below $0.78$ cosine similarity are treated as independent domain facts.
3. **Core Subject Match & Predicate Opposition:**
   - Both memories must share the core subject entity (e.g., `theme`, `indentation`, `orm`, `editor`).
   - The predicate/value must differ or express mutually exclusive choices (e.g., `spaces` vs `tabs`, `light` vs `dark`, `drizzle` vs `prisma`).
4. **Atomic Transactional Invalidation:**
   - Prior memory: `importance = 0.1`, metadata updated `{ superseded: true, supersededBy: newId, supersededAt: ISOString }`.
   - Relation edge created: `from: priorId, to: newId, type: "superseded_by", strength: 0.95`.

---

## 6. Comprehensive Verification Plan

1. **`src/lib/security/__tests__/encryption.test.ts`:**
   - Cryptographic roundtrip (text and JSON).
   - Tamper detection (modified auth tag / ciphertext throws exception).
   - Key rotation verification (`rotateSecretConfig`).
   - Memory zeroing on buffer teardown.
   - Large payload benchmark (>1MB).
2. **`src/lib/memory/__tests__/search-graph.test.ts` & Benchmark:**
   - 2-hop traversal verification reaching indirect neighbors.
   - Strict 20-candidate ceiling test with early-exit assertion.
   - Damping validation ($S_2 < S_1$).
   - Cycle prevention test with mutual loops (A <-> B <-> C).
   - Benchmark with 1000+ relations ensuring $<5\text{ms}$ traversal time on CPU.
3. **`src/lib/memory/__tests__/onnx-telemetry.test.ts`:**
   - Provider fallback simulation (preferred provider error -> CPU fallback).
   - Ring buffer ring wrap-around and exact p50/p95 percentile math.
   - Zero memory leak verification across 200 iterations.
4. **`src/lib/memory/__tests__/contradiction.test.ts`:**
   - Positive case: "I prefer tabs" updated to "I prefer spaces" creates `superseded_by`.
   - Cross-domain negative case: "prefers dark theme for coding" and "prefers dark mode for photography" remain independent.
   - Below-band negative case: $\text{sim} < 0.78$ remains independent.
