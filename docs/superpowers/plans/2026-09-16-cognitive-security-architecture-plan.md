# Cognitive Security & Advanced Retrieval Upgrades Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the 4 hardened architectural pillars: (1) Data-at-rest envelope encryption with AES-256-GCM, (2) Deep 2-hop Graph-RAG with 20-candidate budget cap and early-exit on i5-5200U, (3) ONNX hardware telemetry with race-free provider detection and fixed ring buffer, and (4) Calibrated passive contradiction detection with category isolation.

**Architecture:** Build zero-dependency security using Node.js stdlib `node:crypto` into `settings-service.ts`. Extend `search.ts` with bounded 2-hop graph expansion and exponential damping. Instrument `onnx-session.ts` with zero-allocation `Float32Array(50)` telemetry buffers. Integrate atomic contradiction resolution into `addSemanticMemory` for intra-category updates in the $0.78 \le \text{sim} < 0.90$ window.

**Tech Stack:** TypeScript, Node.js stdlib (`node:crypto`), better-sqlite3, drizzle-orm, ONNX Runtime Node.js, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-16-cognitive-security-architecture-design.md`

## Global Constraints

- **No New Dependencies:** Use Node.js `node:crypto` and existing packages only; do not add heavy libraries.
- **Rule 15 SQLite Concurrency:** All multi-row database mutations must run inside `db.transaction(...)`.
- **Hardware Profile (i5-5200U):** Graph-RAG candidates capped at 20 max; early-exit on Hop 2 if budget saturated.
- **Rule 16 Surgical Precision:** Modify only relevant functions; preserve existing FTS5 and vector index contracts.
- **Rule 18 Vitest Safety:** Run tests sequentially with `--maxWorkers=1` to prevent memory contention.

---

### Task 1: Application-Level Envelope Encryption (`node:crypto` AES-256-GCM)

**Files:**
- Create: `src/lib/security/encryption.ts`
- Modify: `src/lib/settings-service.ts`
- Test: `src/lib/security/__tests__/encryption.test.ts`

**Interfaces:**
- Produces:
  - `encrypt(text: string, secret?: string): string`
  - `decrypt(cipherText: string, secret?: string): string`
  - `isEncrypted(value: unknown): boolean`
  - `encryptSecretConfig(config: Record<string, unknown>, secret?: string): Record<string, unknown>`
  - `decryptSecretConfig(config: Record<string, unknown>, secret?: string): Record<string, unknown>`
  - `rotateSecretConfig(encryptedConfig: Record<string, unknown>, oldSecret: string, newSecret: string): Record<string, unknown>`

- [ ] **Step 1: Write the failing tests for envelope encryption**

Create `src/lib/security/__tests__/encryption.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import {
  encrypt,
  decrypt,
  isEncrypted,
  encryptSecretConfig,
  decryptSecretConfig,
  rotateSecretConfig,
} from "../encryption";

describe("Application-Level Envelope Encryption (AES-256-GCM)", () => {
  it("encrypts and decrypts a plain text string roundtrip", () => {
    const plain = "sk-ant-api03-secret-test-key-12345";
    const cipher = encrypt(plain, "test-master-secret-32-bytes-long!!");
    expect(cipher).toMatch(/^enc:v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
    expect(isEncrypted(cipher)).toBe(true);
    expect(isEncrypted(plain)).toBe(false);

    const decrypted = decrypt(cipher, "test-master-secret-32-bytes-long!!");
    expect(decrypted).toBe(plain);
  });

  it("produces unique IVs and distinct ciphertexts for identical inputs", () => {
    const plain = "same-payload";
    const secret = "test-master-secret-32-bytes-long!!";
    const c1 = encrypt(plain, secret);
    const c2 = encrypt(plain, secret);
    expect(c1).not.toBe(c2);
    expect(decrypt(c1, secret)).toBe(plain);
    expect(decrypt(c2, secret)).toBe(plain);
  });

  it("throws authentication error when ciphertext or tag is tampered with", () => {
    const plain = "critical-credentials";
    const secret = "test-master-secret-32-bytes-long!!";
    const cipher = encrypt(plain, secret);
    const parts = cipher.split(":");
    // Tamper with ciphertext payload
    parts[4] = "A" + parts[4].slice(1);
    const tampered = parts.join(":");
    expect(() => decrypt(tampered, secret)).toThrow();
  });

  it("recursively encrypts and decrypts sensitive keys in config objects", () => {
    const config = {
      name: "OpenAI",
      apiKey: "sk-live-secret-openai-key",
      endpoint: "https://api.openai.com/v1",
      models: ["gpt-4o"],
      nested: {
        token: "nested-secret-token",
        publicId: "pub-123",
      },
    };
    const secret = "test-master-secret-32-bytes-long!!";
    const encrypted = encryptSecretConfig(config, secret);
    expect(encrypted.name).toBe("OpenAI");
    expect(isEncrypted(encrypted.apiKey)).toBe(true);
    expect((encrypted.nested as any).publicId).toBe("pub-123");
    expect(isEncrypted((encrypted.nested as any).token)).toBe(true);

    const decrypted = decryptSecretConfig(encrypted, secret);
    expect(decrypted).toEqual(config);
  });

  it("rotates keys cleanly from oldSecret to newSecret", () => {
    const oldSecret = "old-secret-key-for-rotation-32b!";
    const newSecret = "new-secret-key-for-rotation-32b!";
    const config = { apiKey: "my-precious-api-key", provider: "groq" };

    const encOld = encryptSecretConfig(config, oldSecret);
    const encNew = rotateSecretConfig(encOld, oldSecret, newSecret);

    expect(decryptSecretConfig(encNew, newSecret)).toEqual(config);
    expect(() => decryptSecretConfig(encNew, oldSecret)).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/security/__tests__/encryption.test.ts --maxWorkers=1`
Expected: FAIL (Cannot find module `../encryption`)

- [ ] **Step 3: Implement `src/lib/security/encryption.ts` and integrate with `settings-service.ts`**

Create `src/lib/security/encryption.ts`:
```typescript
import crypto from "node:crypto";
import { env } from "@/env";

const ENVELOPE_PREFIX = "enc:v1:";
const HKDF_INFO = "yggdrasil-settings-envelope-v1";
const SENSITIVE_KEY_REGEX = /^(api_?key|token|secret|password|auth_?token|client_?secret)$/i;

function deriveKey(secretInput?: string): Buffer {
  const masterSecret = secretInput || env.APP_SECRET || "yggdrasil-dev-default-seed-do-not-use-in-prod";
  const salt = Buffer.from("yggdrasil-crypto-salt-2026", "utf-8");
  return crypto.hkdfSync("sha256", masterSecret, salt, HKDF_INFO, 32);
}

export function isEncrypted(value: unknown): boolean {
  return typeof value === "string" && value.startsWith(ENVELOPE_PREFIX);
}

export function encrypt(text: string, secret?: string): string {
  const key = deriveKey(secret);
  const iv = crypto.randomBytes(12);
  try {
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([cipher.update(text, "utf-8"), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return `${ENVELOPE_PREFIX}${iv.toString("base64")}:${authTag.toString("base64")}:${ciphertext.toString("base64")}`;
  } finally {
    key.fill(0);
  }
}

export function decrypt(envelope: string, secret?: string): string {
  if (!isEncrypted(envelope)) return envelope;
  const parts = envelope.slice(ENVELOPE_PREFIX.length).split(":");
  if (parts.length !== 3) {
    throw new Error("Invalid encryption envelope structure");
  }
  const [ivB64, authTagB64, cipherB64] = parts;
  const iv = Buffer.from(ivB64, "base64");
  const authTag = Buffer.from(authTagB64, "base64");
  const ciphertext = Buffer.from(cipherB64, "base64");
  const key = deriveKey(secret);

  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString("utf-8");
  } finally {
    key.fill(0);
  }
}

export function encryptSecretConfig(
  obj: Record<string, unknown>,
  secret?: string
): Record<string, unknown> {
  if (!obj || typeof obj !== "object") return obj;
  const result: Record<string, unknown> = Array.isArray(obj) ? [] : {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === "string" && SENSITIVE_KEY_REGEX.test(key) && !isEncrypted(value)) {
      result[key] = encrypt(value, secret);
    } else if (typeof value === "object" && value !== null) {
      result[key] = encryptSecretConfig(value as Record<string, unknown>, secret);
    } else {
      result[key] = value;
    }
  }
  return result;
}

export function decryptSecretConfig(
  obj: Record<string, unknown>,
  secret?: string
): Record<string, unknown> {
  if (!obj || typeof obj !== "object") return obj;
  const result: Record<string, unknown> = Array.isArray(obj) ? [] : {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === "string" && isEncrypted(value)) {
      try {
        result[key] = decrypt(value, secret);
      } catch {
        result[key] = value;
      }
    } else if (typeof value === "object" && value !== null) {
      result[key] = decryptSecretConfig(value as Record<string, unknown>, secret);
    } else {
      result[key] = value;
    }
  }
  return result;
}

export function rotateSecretConfig(
  encryptedConfig: Record<string, unknown>,
  oldSecret: string,
  newSecret: string
): Record<string, unknown> {
  const decrypted = decryptSecretConfig(encryptedConfig, oldSecret);
  return encryptSecretConfig(decrypted, newSecret);
}
```

Update `src/lib/settings-service.ts`:
Apply `encryptSecretConfig` on `setSettingsDb` and `decryptSecretConfig` on `getSettingDb`/`getSettingsDb`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/lib/security/__tests__/encryption.test.ts --maxWorkers=1`
Expected: PASS (5/5 tests passing)

- [ ] **Step 5: Commit Task 1**

```bash
git add src/lib/security/encryption.ts src/lib/security/__tests__/encryption.test.ts src/lib/settings-service.ts
git commit -m "feat(security): implement AES-256-GCM envelope encryption for sensitive settings and keys"
```

---

### Task 2: Deep Multi-Hop Graph-RAG (2-Hop with Early-Exit & 20-Node Budget)

**Files:**
- Modify: `src/lib/memory/search.ts:60-145`
- Test: `src/lib/memory/__tests__/search-graph.test.ts`
- Benchmark: `src/lib/memory/__tests__/search-graph-bench.test.ts`

**Interfaces:**
- Modifies `expandGraphNeighbors(seedHits, scoreMap, sqlite, maxNeighborsPerHit)` to accept `maxHops = 2` and enforce strict 20-candidate global ceiling with early-exit.

- [ ] **Step 1: Write tests for 2-hop graph expansion & benchmark**

Create `src/lib/memory/__tests__/search-graph.test.ts`:
```typescript
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@/db/schema";
import { setupFtsAndTriggers } from "@/db/init";
import { addSemanticMemory } from "../semantic-memory";
import { hybridMemorySearch } from "../search";

describe("Deep Multi-Hop Graph-RAG (2-Hop Expansion)", () => {
  let sqlite: Database.Database;
  let testDb: any;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    setupFtsAndTriggers(sqlite);
    testDb = drizzle(sqlite, { schema });
  });

  function link(fromId: string, toId: string, type: string, strength = 0.9) {
    sqlite
      .prepare(
        "INSERT INTO memory_relations (id, from_memory_id, from_memory_type, to_memory_id, to_memory_type, relation_type, strength) VALUES (?, ?, 'semantic', ?, 'semantic', ?, ?)"
      )
      .run(`rel_${fromId}_${toId}`, fromId, toId, type, strength);
  }

  it("expands to 2nd-degree neighbors through associative chaining with exponential damping", async () => {
    // A -> B -> C chain. Query matches A.
    const a = await addSemanticMemory({ content: "PostgreSQL connection pooling configuration" }, testDb, sqlite);
    const b = await addSemanticMemory({ content: "PgBouncer microservice deployment setup" }, testDb, sqlite);
    const c = await addSemanticMemory({ content: "Transaction max client timeout threshold constraint" }, testDb, sqlite);

    link(a, b, "associative_link", 0.9);
    link(b, c, "associative_link", 0.85);

    const results = await hybridMemorySearch("PostgreSQL connection", {
      db: testDb,
      sqlite,
      enableGraphAugmentation: true,
      limit: 10,
    });

    const ids = results.map((r) => r.id);
    expect(ids).toContain(a);
    expect(ids).toContain(b); // Hop 1
    expect(ids).toContain(c); // Hop 2

    const scoreA = results.find((r) => r.id === a)!.score;
    const scoreB = results.find((r) => r.id === b)!.score;
    const scoreC = results.find((r) => r.id === c)!.score;

    // Direct > Hop 1 > Hop 2
    expect(scoreA).toBeGreaterThan(scoreB);
    expect(scoreB).toBeGreaterThan(scoreC);
  });

  it("halts expansion when total graph candidate ceiling (20) is reached", async () => {
    const seed = await addSemanticMemory({ content: "Primary seed topic" }, testDb, sqlite);
    // Create 25 related nodes
    for (let i = 0; i < 25; i++) {
      const neighbor = await addSemanticMemory({ content: `Connected node ${i}` }, testDb, sqlite);
      link(seed, neighbor, "associative_link", 0.9);
    }

    const results = await hybridMemorySearch("Primary seed", {
      db: testDb,
      sqlite,
      enableGraphAugmentation: true,
      limit: 50,
    });

    // Seed (1) + graph candidates capped at 20 = max 21
    expect(results.length).toBeLessThanOrEqual(21);
  });

  it("handles cyclic relations (A <-> B <-> C <-> A) without infinite recursion", async () => {
    const a = await addSemanticMemory({ content: "Cyclic node Alpha" }, testDb, sqlite);
    const b = await addSemanticMemory({ content: "Cyclic node Beta" }, testDb, sqlite);
    const c = await addSemanticMemory({ content: "Cyclic node Gamma" }, testDb, sqlite);

    link(a, b, "associative_link", 0.9);
    link(b, c, "associative_link", 0.9);
    link(c, a, "associative_link", 0.9);

    const results = await hybridMemorySearch("Cyclic node Alpha", {
      db: testDb,
      sqlite,
      enableGraphAugmentation: true,
    });

    expect(results.length).toBe(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails on 2-hop**

Run: `pnpm vitest run src/lib/memory/__tests__/search-graph.test.ts --maxWorkers=1`
Expected: FAIL (Hop 2 node `c` missing or score propagation assertion failure)

- [ ] **Step 3: Implement 2-hop traversal with early exit in `src/lib/memory/search.ts`**

Update `expandGraphNeighbors` in `src/lib/memory/search.ts`:
- Expand Hop 1 with `maxNeighborsPerHit` (default 3).
- Collect newly reached Hop 1 nodes.
- If total scoreMap size $< 20$, expand Hop 2 for Hop 1 nodes with damping $0.35$.
- Check `visited: Set<string>` on both hops to avoid cycles and redundant queries.
- Exclude `superseded_by` relations.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/lib/memory/__tests__/search-graph.test.ts --maxWorkers=1`
Expected: PASS

- [ ] **Step 5: Commit Task 2**

```bash
git add src/lib/memory/search.ts src/lib/memory/__tests__/search-graph.test.ts
git commit -m "feat(rag): implement deep 2-hop graph augmentation with 20-candidate cap and cycle safety"
```

---

### Task 3: ONNX Hardware Telemetry & Profiling

**Files:**
- Modify: `src/lib/memory/onnx-session.ts`
- Modify: `src/lib/memory/reranker.ts`
- Test: `src/lib/memory/__tests__/onnx-telemetry.test.ts`

**Interfaces:**
- Produces:
  - `recordInferenceLatency(slot: string, durationMs: number): void`
  - `getOnnxSlotTelemetry(slot: string): OnnxTelemetry | null`
  - Extended `RerankerStatus.telemetry?: OnnxTelemetry`

- [ ] **Step 1: Write the failing tests for ONNX telemetry**

Create `src/lib/memory/__tests__/onnx-telemetry.test.ts`:
```typescript
import { describe, it, expect, beforeEach } from "vitest";
import {
  recordInferenceLatency,
  getOnnxSlotTelemetry,
  setOrtLoaderForTest,
  acquireOnnxSession,
  releaseOnnxSession,
  ONNX_SLOT_RERANKER,
} from "../onnx-session";

describe("ONNX Hardware Telemetry & Profiling", () => {
  beforeEach(async () => {
    await releaseOnnxSession(ONNX_SLOT_RERANKER);
  });

  it("calculates rolling p50 and p95 latencies accurately using fixed ring buffer", () => {
    // Record 50 synthetic latencies from 10ms to 59ms
    for (let i = 10; i <= 59; i++) {
      recordInferenceLatency(ONNX_SLOT_RERANKER, i);
    }
    const telemetry = getOnnxSlotTelemetry(ONNX_SLOT_RERANKER);
    expect(telemetry).not.toBeNull();
    expect(telemetry!.totalInferences).toBe(50);
    expect(telemetry!.lastInferenceMs).toBe(59);
    // Median of 10..59 is approx 34-35
    expect(telemetry!.p50LatencyMs).toBeGreaterThanOrEqual(33);
    expect(telemetry!.p50LatencyMs).toBeLessThanOrEqual(36);
    // p95 of 50 items is around the 47th item (approx 56-58)
    expect(telemetry!.p95LatencyMs).toBeGreaterThanOrEqual(55);
  });

  it("records cold start time and captures active execution provider race-free", async () => {
    setOrtLoaderForTest(async () => ({
      InferenceSession: {
        create: async (_path: string, opts?: any) => {
          // Simulate 15ms cold start
          await new Promise((r) => setTimeout(r, 15));
          return {
            inputNames: ["input"],
            outputNames: ["output"],
            run: async () => ({ output: { data: new Float32Array([1]) } }),
            release: async () => {},
          };
        },
      },
      Tensor: class {} as any,
    }));

    await acquireOnnxSession(ONNX_SLOT_RERANKER, "/mock/model.onnx", { executionProviders: ["cpu"] });

    const telemetry = getOnnxSlotTelemetry(ONNX_SLOT_RERANKER);
    expect(telemetry).not.toBeNull();
    expect(telemetry!.activeProvider).toBe("cpu");
    expect(telemetry!.coldStartTimeMs).toBeGreaterThanOrEqual(10);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/memory/__tests__/onnx-telemetry.test.ts --maxWorkers=1`
Expected: FAIL (`recordInferenceLatency` not defined)

- [ ] **Step 3: Implement telemetry buffer in `src/lib/memory/onnx-session.ts` and `reranker.ts`**

In `src/lib/memory/onnx-session.ts`:
- Define `RING_BUFFER_SIZE = 50`.
- Maintain per-slot telemetry state: `activeProvider`, `coldStartTimeMs`, `totalInferences`, `latencies: Float32Array(50)`, `writeIndex: number`.
- Add `recordInferenceLatency(slot: string, durationMs: number)`.
- Compute `p50` and `p95` by copying active slice, sorting, and indexing `Math.floor(n * 0.5)` and `Math.floor(n * 0.95)`.
- In `src/lib/memory/reranker.ts`: Measure `const start = performance.now()` around `session.run(...)` and call `recordInferenceLatency(ONNX_SLOT_RERANKER, performance.now() - start)`.
- Expose `telemetry` in `getRerankerStatus()`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/lib/memory/__tests__/onnx-telemetry.test.ts --maxWorkers=1`
Expected: PASS

- [ ] **Step 5: Commit Task 3**

```bash
git add src/lib/memory/onnx-session.ts src/lib/memory/reranker.ts src/lib/memory/__tests__/onnx-telemetry.test.ts
git commit -m "feat(onnx): add zero-allocation telemetry buffer and race-free hardware profiling"
```

---

### Task 4: Calibrated Passive Semantic Contradiction Detection

**Files:**
- Modify: `src/lib/memory/semantic-memory.ts:240-310`
- Test: `src/lib/memory/__tests__/contradiction.test.ts`

**Interfaces:**
- Updates `addSemanticMemory` to check for conflicting prior memories within the same category/domain in the calibrated $0.78 \le \text{similarity} < 0.90$ window and atomically mark them `superseded_by`.

- [ ] **Step 1: Write the failing tests for calibrated contradiction detection**

Create `src/lib/memory/__tests__/contradiction.test.ts`:
```typescript
import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@/db/schema";
import { setupFtsAndTriggers } from "@/db/init";
import { addSemanticMemory } from "../semantic-memory";

// Mock embedding generator to control cosine similarities deterministically
vi.mock("../embeddings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../embeddings")>();
  return {
    ...actual,
    generateEmbedding: vi.fn(async () => new Float32Array(8).fill(0.1)),
  };
});

describe("Calibrated Passive Semantic Contradiction Detection", () => {
  let sqlite: Database.Database;
  let testDb: any;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    setupFtsAndTriggers(sqlite);
    testDb = drizzle(sqlite, { schema });
  });

  it("automatically supersedes conflicting prior preference in the same category", async () => {
    // Prior memory: User prefers tabs for indentation
    const oldId = await addSemanticMemory(
      {
        content: "User prefers tabs for code indentation",
        importance: 0.8,
        tags: ["preference", "user_preference"],
        embedding: new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]),
      },
      testDb,
      sqlite
    );

    // New conflicting memory: User prefers spaces for code indentation
    // Cosine similarity between [1, 0...] and [0.85, 0.52...] is approx 0.85 (in 0.78..0.90 window)
    const newId = await addSemanticMemory(
      {
        content: "User prefers spaces for code indentation",
        importance: 0.9,
        tags: ["preference", "user_preference"],
        embedding: new Float32Array([0.85, 0.52, 0, 0, 0, 0, 0, 0]),
      },
      testDb,
      sqlite
    );

    expect(newId).not.toBe(oldId);

    // Check old memory is superseded
    const [oldRow] = testDb.select().from(schema.semanticMemories).where(schema.eq(schema.semanticMemories.id, oldId)).all();
    expect(oldRow.importance).toBe(0.1);
    expect(oldRow.metadata?.superseded).toBe(true);
    expect(oldRow.metadata?.supersededBy).toBe(newId);

    // Check superseded_by relation was created
    const relations = testDb.select().from(schema.memoryRelations).all();
    const supersededRel = relations.find((r: any) => r.relationType === "superseded_by");
    expect(supersededRel).toBeDefined();
    expect(supersededRel.fromMemoryId).toBe(oldId);
    expect(supersededRel.toMemoryId).toBe(newId);
  });

  it("does NOT supersede facts from different categories even if words overlap", async () => {
    const codePrefId = await addSemanticMemory(
      {
        content: "Prefers dark theme for coding environment",
        importance: 0.8,
        tags: ["coding", "editor_setting"],
        embedding: new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]),
      },
      testDb,
      sqlite
    );

    const photoPrefId = await addSemanticMemory(
      {
        content: "Prefers dark mode for photography portfolio",
        importance: 0.8,
        tags: ["photography", "design_setting"],
        embedding: new Float32Array([0.85, 0.52, 0, 0, 0, 0, 0, 0]),
      },
      testDb,
      sqlite
    );

    const [codeRow] = testDb.select().from(schema.semanticMemories).where(schema.eq(schema.semanticMemories.id, codePrefId)).all();
    expect(codeRow.importance).toBe(0.8);
    expect(codeRow.metadata?.superseded).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/memory/__tests__/contradiction.test.ts --maxWorkers=1`
Expected: FAIL (Contradiction detection logic not yet in `addSemanticMemory`)

- [ ] **Step 3: Implement category-guarded contradiction resolution in `src/lib/memory/semantic-memory.ts`**

In `addSemanticMemory`:
- After checking for near-duplicates ($\ge 0.90$):
- If `input.embedding` is present and incoming memory has category tags (e.g. `user_preference`, `preference`, or explicit tags):
  - Find prior memories with shared category tags.
  - Calculate cosine similarity. If in range $[0.78, 0.90)$ and core predicate indicates update/opposition:
    - Atomically demote prior row: `importance = 0.1`, metadata marked `{ superseded: true, supersededBy: newId, supersededAt: new Date().toISOString() }`.
    - Insert `memory_relations` edge with `relationType = 'superseded_by'`, `strength = 0.95`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/lib/memory/__tests__/contradiction.test.ts --maxWorkers=1`
Expected: PASS

- [ ] **Step 5: Commit Task 4**

```bash
git add src/lib/memory/semantic-memory.ts src/lib/memory/__tests__/contradiction.test.ts
git commit -m "feat(memory): add category-guarded passive contradiction detection and belief updating"
```

---

### Task 5: Full System Verification & Score Assessment

- [ ] **Step 1: Run complete test suite sequentially**
Run: `pnpm vitest run --maxWorkers=1`
Verify: All 65+ unit tests across the entire repository pass with zero errors.

- [ ] **Step 2: Push changes to `development`**
Run: `git push origin development`
Verify working tree is clean.
