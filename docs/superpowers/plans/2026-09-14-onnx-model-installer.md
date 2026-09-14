# ONNX Model Installer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a HuggingFace search and 1-action installer for local ONNX embedding and reranker models, auto-downloading graphs, weights, tokenizers, and pooling sidecars into an isolated layout with child-process smoke testing and zero server crash risk.

**Architecture:** A new subsystem under `src/lib/models/` provides a pure REST client for HuggingFace (strict host allowlist, manual redirect validation), a streaming Range-resumable file downloader, an isolated child-process smoke test runner (`child_process.fork`), a role-contract path mapper, an in-memory job registry, and a unified model store. API endpoints under `src/app/api/models/` power a shared `ModelBrowserDialog` in the settings UI.

**Tech Stack:** Next.js 16, TypeScript 6, Node.js v24 (`child_process.fork`), ONNX Runtime Node (`onnxruntime-node`), Zod, Tailwind CSS v4, Radix UI, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-14-onnx-model-installer-design.md`

## Global Constraints
- Isolation Invariant (Rule 06): Model files land strictly in `data/models/<kind>/<org>--<name>/`. Zero writes to `$HOME`, `~/.cache`, or outside project directory.
- Memory Safety & Review Test Invariant (Rule 18): Subagents and tests MUST NEVER launch concurrent `vitest` instances. Test runs locked to single sequential execution.
- No Silent Code (Rule 02): No empty `catch {}`. Every error typed and surfaced with context.
- SSRF & Path Traversal (Rule 04): HTTPS only, strict host allowlist with suffix matching (`host === 'hf.co' || host.endsWith('.hf.co') || host === 'huggingface.co' || host.endsWith('.huggingface.co')`), manual redirect loop (max 5 hops), role-contract destination derivation, `sanitizeSkillFilePath` + prefix containment checks.
- Child Process Isolation: Smoke test runs in isolated OS child process (`fork`), catching native aborts (`SIGSEGV`, `SIGABRT`, `SIGFPE`, `SIGILL`) and unmapping 100% of native memory on exit.
- Preserved Contracts: Backward compatibility for existing flat file `data/models/embedding/Xenova⁄multilingual-e5-small.onnx`.

---

## File Structure

```
src/lib/models/
  types.ts             — Shared types (ModelKind, InstallPlan, InstallJob, Manifest, etc.)
  hf-client.ts         — HuggingFace REST client (search, tree, model info, redirect loop)
  download.ts          — Streaming downloader with Range-resume, sha256, ENOSPC handling
  smoke.ts             — Process-isolated smoke test orchestrator (fork child, timeout)
  smoke-worker.mjs     — Pure ESM JS child process script for ORT load & dummy probe
  store.ts             — Model directory layout, manifest read/write, orphan sweep, discovery
  jobs.ts              — Global job registry, 409 conflict detection, disk reservation
  installer.ts         — Pure planInstall() and streaming executeInstall()
src/app/api/models/
  search/route.ts      — GET /api/models/search?q=&kind=
  inspect/route.ts     — POST /api/models/inspect { repo, kind }
  install/route.ts     — POST /api/models/install { repo, kind, variant? }
  install/[jobId]/route.ts — GET progress / DELETE cancel
src/components/settings/
  model-browser-dialog.tsx — Shared search, plan preview, variant override & progress modal
```

---

### Task 1: Pre-existing Fixes & Shared Contracts

**Files:**
- Modify: `src/lib/settings.ts:323-338`
- Modify: `src/lib/memory/embeddings.ts:88-100, 260-290, 700-720`
- Modify: `src/lib/memory/onnx-session.ts:33-47`
- Test: `src/lib/memory/__tests__/onnx-embedding.test.ts`

**Interfaces:**
- Consumes: Existing `EmbeddingSettings`, `resolvePoolingMode`, `OrtSession`.
- Produces: `poolingMode` persisted in `saveEmbeddingSettings`; `MIN_ONNX_MODEL_SIZE_BYTES = 10 * 1024 * 1024`; `dims` visible on `OrtSession.run` output tensors.

- [ ] **Step 1: Write the failing test for `saveEmbeddingSettings` and size threshold**

Add tests to `src/lib/memory/__tests__/onnx-embedding.test.ts`:
```ts
it("accepts models between 10 MB and 50 MB (lowered size threshold)", () => {
  const fixturePath = path.join(DIR, "small-quantized-model.onnx");
  // 25 MB file should now be considered valid
  fs.writeFileSync(fixturePath, Buffer.alloc(25 * 1024 * 1024));
  expect(discoverEmbeddingModels().some(m => m.filename === "small-quantized-model.onnx")).toBe(true);
});

it("persists poolingMode through saveEmbeddingSettings", async () => {
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("{}", { status: 200 }));
  await saveEmbeddingSettings({ provider: "onnx", modelPath: "test.onnx", poolingMode: "cls" });
  expect(fetchSpy).toHaveBeenCalledWith("/api/settings", expect.objectContaining({
    body: expect.stringContaining('"poolingMode":"cls"'),
  }));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/lib/memory/__tests__/onnx-embedding.test.ts`
Expected: FAIL (size threshold rejects 25MB file; `saveEmbeddingSettings` omits `poolingMode`).

- [ ] **Step 3: Implement fixes**

1. In `src/lib/settings.ts`, update `saveEmbeddingSettings`:
```ts
export async function saveEmbeddingSettings(settingsPatch: EmbeddingSettings): Promise<void> {
  const next: EmbeddingSettings = {
    providerId: settingsPatch.providerId ?? null,
    provider: settingsPatch.provider,
    baseUrl: settingsPatch.baseUrl?.trim() || undefined,
    apiKey: settingsPatch.apiKey || undefined,
    model: settingsPatch.model?.trim() || undefined,
    modelPath: settingsPatch.modelPath,
    poolingMode: settingsPatch.poolingMode,
    dimensions: settingsPatch.dimensions,
    chunkSize: settingsPatch.chunkSize,
    chunkOverlap: settingsPatch.chunkOverlap,
  };
  // ... rest unchanged
```

2. In `src/lib/memory/embeddings.ts`, lower the gate:
```ts
/** Minimum byte length for an ONNX model file (~10 MB) to reject stubs/404s. */
const MIN_ONNX_MODEL_SIZE_BYTES = 10 * 1024 * 1024;
```

3. In `src/lib/memory/onnx-session.ts`, widen `OrtSession.run` output type:
```ts
export interface OrtSession {
  readonly inputNames: readonly string[];
  readonly outputNames: readonly string[];
  run(feeds: Record<string, unknown>): Promise<{
    logits?: { data: Float32Array; dims?: readonly number[] };
    last_hidden_state?: { data: Float32Array; dims?: readonly number[] };
    sentence_embedding?: { data: Float32Array; dims?: readonly number[] };
    output?: { data: Float32Array; dims?: readonly number[] };
    [key: string]: unknown;
  }>;
  release(): Promise<void>;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/lib/memory/__tests__/onnx-embedding.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/settings.ts src/lib/memory/embeddings.ts src/lib/memory/onnx-session.ts src/lib/memory/__tests__/onnx-embedding.test.ts
git commit -m "fix(embeddings): lower model size gate to 10MB, preserve poolingMode in settings, expose output dims"
```

---

### Task 2: HuggingFace Client (`src/lib/models/hf-client.ts`)

**Files:**
- Create: `src/lib/models/types.ts`
- Create: `src/lib/models/hf-client.ts`
- Create: `src/lib/models/__tests__/hf-client.test.ts`

**Interfaces:**
- Produces: `HfClient`, `HfTreeEntry`, `HfModelInfo`, `HfSearchResult`, `HfError`, `isAllowedHfHost`.

- [ ] **Step 1: Define types in `src/lib/models/types.ts`**

```ts
export type ModelKind = "embedding" | "reranker";

export interface HfTreeEntry {
  path: string;
  type: "file" | "directory";
  size: number;
  oid?: string;
  lfs?: {
    oid: string; // sha256
    size: number;
    pointerSize: number;
  };
}

export interface HfModelInfo {
  id: string;
  tags?: string[];
  siblings?: Array<{ rfilename: string }>;
  pipeline_tag?: string;
}

export interface HfSearchResult {
  id: string;
  downloads: number;
  likes: number;
  pipeline_tag?: string;
  tags?: string[];
  siblings?: Array<{ rfilename: string }>;
}

export class HfError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "HfError";
  }
}
```

- [ ] **Step 2: Write failing tests for `hf-client.ts`**

In `src/lib/models/__tests__/hf-client.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { createHfClient, isAllowedHfHost } from "../hf-client";
import { HfError } from "../types";

describe("hf-client", () => {
  it("strictly validates allowed hosts with exact/suffix check", () => {
    expect(isAllowedHfHost("huggingface.co")).toBe(true);
    expect(isAllowedHfHost("cdn.hf.co")).toBe(true);
    expect(isAllowedHfHost("us.aws.cdn.hf.co")).toBe(true);
    expect(isAllowedHfHost("evil-hf.co")).toBe(false);
    expect(isAllowedHfHost("hf.co.attacker.net")).toBe(false);
    expect(isAllowedHfHost("huggingface.co.evil.com")).toBe(false);
  });

  it("follows redirects up to 5 hops and validates target host at each hop", async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(new Response(null, {
        status: 302,
        headers: { Location: "https://us.aws.cdn.hf.co/model.onnx" },
      }))
      .mockResolvedValueOnce(new Response("model bytes", { status: 200 }));

    const client = createHfClient({ fetchImpl: mockFetch });
    const res = await client.fetchWithRedirects("https://huggingface.co/repo/resolve/main/model.onnx");
    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("rejects redirects to unallowed hosts", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce(new Response(null, {
      status: 302,
      headers: { Location: "https://evil.com/model.onnx" },
    }));

    const client = createHfClient({ fetchImpl: mockFetch });
    await expect(client.fetchWithRedirects("https://huggingface.co/repo/resolve/main/model.onnx"))
      .rejects.toThrow(HfError);
  });

  it("searches models with full=true", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify([
      { id: "Xenova/all-MiniLM-L6-v2", downloads: 1000, likes: 50, siblings: [{ rfilename: "onnx/model.onnx" }] }
    ]), { status: 200 }));

    const client = createHfClient({ fetchImpl: mockFetch });
    const results = await client.searchModels("minilm", "embedding");
    expect(results).toHaveLength(1);
    expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining("full=true"), expect.anything());
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm test src/lib/models/__tests__/hf-client.test.ts`
Expected: FAIL (`createHfClient` not implemented).

- [ ] **Step 4: Implement `src/lib/models/hf-client.ts`**

```ts
import { HfError, type HfModelInfo, type HfSearchResult, type HfTreeEntry, type ModelKind } from "./types";

export function isAllowedHfHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === "huggingface.co" ||
    host.endsWith(".huggingface.co") ||
    host === "hf.co" ||
    host.endsWith(".hf.co")
  );
}

export interface HfClientOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export function createHfClient(options: HfClientOptions = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 30_000;

  async function fetchWithRedirects(url: string, init: RequestInit = {}): Promise<Response> {
    let currentUrl = url;
    for (let hop = 0; hop < 5; hop++) {
      const parsed = new URL(currentUrl);
      if (parsed.protocol !== "https:") {
        throw new HfError(`Only HTTPS is supported (got ${parsed.protocol})`);
      }
      if (!isAllowedHfHost(parsed.hostname)) {
        throw new HfError(`Host forbidden by allowlist: ${parsed.hostname}`);
      }

      const res = await fetchImpl(currentUrl, {
        ...init,
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          "user-agent": "yggdrasil/0.1 (onnx-installer)",
          ...(init.headers ?? {}),
        },
      });

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        if (!location) throw new HfError(`Redirect status ${res.status} without Location header`);
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }
      if (!res.ok) {
        throw new HfError(`HuggingFace API HTTP ${res.status} for ${parsed.pathname}`, res.status);
      }
      return res;
    }
    throw new HfError("Too many redirects (> 5)");
  }

  return {
    fetchWithRedirects,
    async searchModels(query: string, kind: ModelKind): Promise<HfSearchResult[]> {
      const tag = kind === "embedding" ? "feature-extraction" : "text-classification";
      const u = new URL("https://huggingface.co/api/models");
      u.searchParams.set("search", query);
      u.searchParams.set("filter", "transformers.js");
      u.searchParams.set("pipeline_tag", tag);
      u.searchParams.set("full", "true");
      u.searchParams.set("limit", "20");

      const res = await fetchWithRedirects(u.toString());
      return res.json() as Promise<HfSearchResult[]>;
    },
    async getModelTree(repo: string): Promise<HfTreeEntry[]> {
      const u = `https://huggingface.co/api/models/${encodeURIComponent(repo)}/tree/main?recursive=true`;
      const res = await fetchWithRedirects(u);
      return res.json() as Promise<HfTreeEntry[]>;
    },
    async getModelInfo(repo: string): Promise<HfModelInfo> {
      const u = `https://huggingface.co/api/models/${encodeURIComponent(repo)}`;
      const res = await fetchWithRedirects(u);
      return res.json() as Promise<HfModelInfo>;
    },
  };
}

export type HfClient = ReturnType<typeof createHfClient>;
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test src/lib/models/__tests__/hf-client.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/lib/models/types.ts src/lib/models/hf-client.ts src/lib/models/__tests__/hf-client.test.ts
git commit -m "feat(models): implement HuggingFace REST client with strict host allowlist and redirect validation"
```

---

### Task 3: Streaming Downloader & Integrity (`src/lib/models/download.ts`)

**Files:**
- Create: `src/lib/models/download.ts`
- Create: `src/lib/models/__tests__/download.test.ts`

**Interfaces:**
- Consumes: `HfClient`.
- Produces: `downloadFile(url, targetPath, options)` with resume, sha256 check, and ENOSPC cleanup.

- [ ] **Step 1: Write failing tests for `download.ts`**

In `src/lib/models/__tests__/download.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { downloadFile, IntegrityError, InsufficientDiskError } from "../download";
import { createHfClient } from "../hf-client";

const TMP = path.resolve(process.cwd(), "tmp/test-download");

describe("downloadFile", () => {
  beforeEach(() => {
    fs.mkdirSync(TMP, { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  it("downloads file to .part and renames to target with correct sha256", async () => {
    const content = "hello onnx world";
    const sha = crypto.createHash("sha256").update(content).digest("hex");
    const target = path.join(TMP, "model.onnx");

    const client = createHfClient({
      fetchImpl: async () => new Response(content, { status: 200, headers: { "content-length": String(content.length) } })
    });

    await downloadFile({
      client,
      url: "https://huggingface.co/repo/resolve/main/model.onnx",
      targetPath: target,
      expectedSha256: sha,
      expectedBytes: content.length,
    });

    expect(fs.existsSync(target)).toBe(true);
    expect(fs.existsSync(`${target}.part`)).toBe(false);
    expect(fs.readFileSync(target, "utf8")).toBe(content);
  });

  it("throws IntegrityError and purges .part on sha256 mismatch", async () => {
    const content = "corrupted bytes";
    const target = path.join(TMP, "model.onnx");

    const client = createHfClient({
      fetchImpl: async () => new Response(content, { status: 200 })
    });

    await expect(downloadFile({
      client,
      url: "https://huggingface.co/repo/resolve/main/model.onnx",
      targetPath: target,
      expectedSha256: "badhash123",
      expectedBytes: content.length,
    })).rejects.toThrow(IntegrityError);

    expect(fs.existsSync(target)).toBe(false);
    expect(fs.existsSync(`${target}.part`)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/lib/models/__tests__/download.test.ts`
Expected: FAIL (`downloadFile` not found).

- [ ] **Step 3: Implement `src/lib/models/download.ts`**

```ts
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { HfClient } from "./hf-client";

export class IntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntegrityError";
  }
}

export class InsufficientDiskError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InsufficientDiskError";
  }
}

export interface DownloadOptions {
  client: HfClient;
  url: string;
  targetPath: string;
  expectedBytes?: number;
  expectedSha256?: string; // from lfs.oid
  onProgress?: (bytesDownloaded: number, totalBytes: number) => void;
  signal?: AbortSignal;
}

export async function downloadFile(options: DownloadOptions): Promise<void> {
  const { client, url, targetPath, expectedBytes, expectedSha256, onProgress, signal } = options;
  const partPath = `${targetPath}.part`;
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });

  let startBytes = 0;
  if (fs.existsSync(partPath)) {
    try {
      startBytes = fs.statSync(partPath).size;
    } catch {
      startBytes = 0;
    }
  }

  const headers: Record<string, string> = {};
  if (startBytes > 0) {
    headers["Range"] = `bytes=${startBytes}-`;
  }

  let res: Response;
  try {
    res = await client.fetchWithRedirects(url, { headers, signal });
  } catch (err) {
    if (signal?.aborted) {
      try { fs.unlinkSync(partPath); } catch {}
      throw new Error("Download aborted");
    }
    throw err;
  }

  const isResume = res.status === 206;
  const writeStream = fs.createWriteStream(partPath, { flags: isResume ? "a" : "w" });
  if (!isResume && startBytes > 0) {
    startBytes = 0;
  }

  const total = expectedBytes ?? (
    res.headers.get("content-length") ? Number(res.headers.get("content-length")) + startBytes : 0
  );

  let currentBytes = startBytes;
  const hash = crypto.createHash("sha256");

  // If resumed, compute hash of existing part bytes first
  if (isResume && startBytes > 0 && expectedSha256) {
    const existing = fs.readFileSync(partPath);
    hash.update(existing);
  }

  if (!res.body) {
    throw new Error("No response body to download");
  }

  const webStream = Readable.fromWeb(res.body as import("node:stream/web").ReadableStream);
  webStream.on("data", (chunk: Buffer) => {
    currentBytes += chunk.length;
    if (expectedSha256) hash.update(chunk);
    onProgress?.(currentBytes, total);
  });

  try {
    await pipeline(webStream, writeStream);
  } catch (err: any) {
    try { fs.unlinkSync(partPath); } catch {}
    if (err?.code === "ENOSPC") {
      throw new InsufficientDiskError("No space left on device while downloading model");
    }
    throw err;
  }

  // Verification
  if (expectedBytes && currentBytes !== expectedBytes) {
    try { fs.unlinkSync(partPath); } catch {}
    throw new IntegrityError(`Byte count mismatch: expected ${expectedBytes}, got ${currentBytes}`);
  }

  if (expectedSha256) {
    const actualSha = hash.digest("hex");
    if (actualSha.toLowerCase() !== expectedSha256.toLowerCase()) {
      try { fs.unlinkSync(partPath); } catch {}
      throw new IntegrityError(`Checksum mismatch: expected sha256 ${expectedSha256}, got ${actualSha}`);
    }
  }

  // Atomic rename
  fs.renameSync(partPath, targetPath);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/lib/models/__tests__/download.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/models/download.ts src/lib/models/__tests__/download.test.ts
git commit -m "feat(models): implement streaming downloader with Range resume, sha256 check and ENOSPC cleanup"
```

---

### Task 4: Isolated Smoke Test Runner (`src/lib/models/smoke.ts` & `smoke-worker.mjs`)

**Files:**
- Create: `src/lib/models/smoke-worker.mjs`
- Create: `src/lib/models/smoke.ts`
- Create: `src/lib/models/__tests__/smoke.test.ts`

**Interfaces:**
- Produces: `runSmokeTest(modelPath: string): Promise<SmokeTestResult>`, `ModelUnusableError`.

- [ ] **Step 1: Write `src/lib/models/smoke-worker.mjs` (pure ESM JS)**

```js
import { loadOrt } from "../memory/onnx-session.js";

const modelPath = process.argv[2];
if (!modelPath) {
  process.exit(1);
}

try {
  const ort = await loadOrt();
  const session = await ort.InferenceSession.create(modelPath, {
    executionProviders: ["cpu"],
    enableCpuMemArena: false,
    enableMemPattern: false,
    executionMode: "sequential",
  });

  // Build dummy feeds for declared input names
  const feeds = {};
  const ids = new BigInt64Array([0n, 1n]); // dummy seq len 2
  const mask = new BigInt64Array([1n, 1n]);
  const zeros = new BigInt64Array([0n, 0n]);

  for (const name of session.inputNames) {
    switch (name) {
      case "input_ids": feeds[name] = new ort.Tensor("int64", ids, [1, 2]); break;
      case "attention_mask": feeds[name] = new ort.Tensor("int64", mask, [1, 2]); break;
      case "token_type_ids": feeds[name] = new ort.Tensor("int64", zeros, [1, 2]); break;
    }
  }

  const out = await session.run(feeds);
  const targetTensor = out.last_hidden_state ?? out.sentence_embedding ?? out.output ?? Object.values(out)[0];
  const dims = targetTensor?.dims ?? [1, 0];

  if (process.send) {
    process.send({ ok: true, outputDims: Array.from(dims) });
  }
  await session.release();
  process.exit(0);
} catch (err) {
  if (process.send) {
    process.send({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
  process.exit(1);
}
```

- [ ] **Step 2: Write failing test in `src/lib/models/__tests__/smoke.test.ts`**

```ts
import { describe, it, expect, vi } from "vitest";
import { runSmokeTest, ModelUnusableError } from "../smoke";

describe("runSmokeTest", () => {
  it("translates non-zero exit or signal into failure without crashing parent", async () => {
    // Non-existent path will exit 1
    const result = await runSmokeTest("/non/existent/model.onnx");
    expect(result.ok).toBe(false);
  });
});
```

- [ ] **Step 3: Implement `src/lib/models/smoke.ts`**

```ts
import path from "node:path";
import { fork } from "node:child_process";

export class ModelUnusableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelUnusableError";
  }
}

export interface SmokeTestResult {
  ok: boolean;
  outputDims?: number[];
  error?: string;
  isCrash?: boolean;
}

export async function runSmokeTest(modelPath: string, timeoutMs: number = 30_000): Promise<SmokeTestResult> {
  return new Promise((resolve) => {
    const workerPath = path.resolve(import.meta.dirname, "./smoke-worker.mjs");
    const cleanExecArgv = process.execArgv.filter(
      (arg) => !arg.startsWith("--inspect") && !arg.startsWith("--debug")
    );

    const child = fork(workerPath, [modelPath], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      execArgv: cleanExecArgv,
    });

    let settled = false;
    let workerResult: SmokeTestResult | null = null;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGKILL"); } catch {}
      resolve({ ok: false, error: `Smoke test timed out after ${timeoutMs / 1000}s` });
    }, timeoutMs);

    child.on("message", (msg: { ok: boolean; outputDims?: number[]; error?: string }) => {
      workerResult = msg;
    });

    child.on("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      if (signal || (code !== 0 && !workerResult)) {
        resolve({
          ok: false,
          error: `Native crash or abnormal termination during model initialization: ${signal ? `signal ${signal}` : `exit code ${code}`}`,
          isCrash: true,
        });
        return;
      }

      if (workerResult) {
        resolve(workerResult);
      } else {
        resolve({ ok: false, error: `Process exited with code ${code}` });
      }
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, error: err.message });
    });
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/lib/models/__tests__/smoke.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/models/smoke.ts src/lib/models/smoke-worker.mjs src/lib/models/__tests__/smoke.test.ts
git commit -m "feat(models): implement isolated child-process smoke test runner with signal crash detection"
```

---

### Task 5: Model Store, Layout & Discovery (`src/lib/models/store.ts`)

**Files:**
- Create: `src/lib/models/store.ts`
- Create: `src/lib/models/__tests__/store.test.ts`
- Modify: `src/lib/memory/embeddings.ts:186-220`
- Modify: `src/lib/memory/reranker.ts:107-144`

**Interfaces:**
- Consumes: `ModelKind`, `sanitizeSkillFilePath` from `@/lib/skills/config`.
- Produces: `store.getModelDir(kind, repo)`, `store.discoverModels(kind)`, `store.sweepOrphans(kind)`.

- [ ] **Step 1: Write failing tests for `store.ts`**

In `src/lib/models/__tests__/store.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { getModelDir, sweepOrphans, discoverModels, writeManifest, type ModelManifest } from "../store";

const TEST_BASE = path.resolve(process.cwd(), "tmp/test-models");

describe("models/store", () => {
  beforeEach(() => {
    fs.mkdirSync(path.join(TEST_BASE, "embedding"), { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(TEST_BASE, { recursive: true, force: true });
  });

  it("formats modelDir as <org>--<name> flattened directory", () => {
    const dir = getModelDir("embedding", "Xenova/all-MiniLM-L6-v2", TEST_BASE);
    expect(dir).toBe(path.join(TEST_BASE, "embedding", "Xenova--all-MiniLM-L6-v2"));
  });

  it("discovers manifested models and ignores unmanifested incomplete directories", () => {
    const dir = getModelDir("embedding", "test/model-a", TEST_BASE);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "model.onnx"), Buffer.alloc(15 * 1024 * 1024));

    // Without manifest, not discovered
    expect(discoverModels("embedding", TEST_BASE)).toHaveLength(0);

    // With manifest, discovered
    const manifest: ModelManifest = {
      schemaVersion: 1,
      repo: "test/model-a",
      kind: "embedding",
      variant: "model.onnx",
      files: ["model.onnx"],
      sizeBytes: 15 * 1024 * 1024,
      installedAt: new Date().toISOString(),
    };
    writeManifest(dir, manifest);
    const discovered = discoverModels("embedding", TEST_BASE);
    expect(discovered).toHaveLength(1);
    expect(discovered[0].repo).toBe("test/model-a");
  });

  it("sweeps unmanifested directories and *.part files", () => {
    const dir = getModelDir("embedding", "test/stale", TEST_BASE);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "model.onnx.part"), "incomplete");

    sweepOrphans("embedding", new Set(), TEST_BASE);
    expect(fs.existsSync(dir)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/lib/models/__tests__/store.test.ts`
Expected: FAIL (`store.ts` not found).

- [ ] **Step 3: Implement `src/lib/models/store.ts`**

```ts
import fs from "node:fs";
import path from "node:path";
import { sanitizeSkillFilePath } from "@/lib/skills/config";
import type { ModelKind } from "./types";
import { CANONICAL_EMBEDDING_DIR } from "@/lib/memory/embeddings";
import { CANONICAL_RERANKER_DIR } from "@/lib/memory/reranker";

export interface ModelManifest {
  schemaVersion: 1;
  repo: string;
  kind: ModelKind;
  variant: string;
  files: string[];
  sizeBytes: number;
  poolingMode?: string;
  installedAt: string;
}

export interface DiscoveredModel {
  filename: string;
  path: string;
  repo?: string;
  sizeBytes: number;
  isLegacy?: boolean;
}

export function getBaseDirForKind(kind: ModelKind, customBase?: string): string {
  if (customBase) return path.join(customBase, kind);
  return kind === "embedding" ? CANONICAL_EMBEDDING_DIR : CANONICAL_RERANKER_DIR;
}

export function getModelDir(kind: ModelKind, repo: string, customBase?: string): string {
  const parts = repo.split("/");
  const dirName = parts.length === 2 ? `${parts[0]}--${parts[1]}` : repo;
  return path.join(getBaseDirForKind(kind, customBase), dirName);
}

export function writeManifest(modelDir: string, manifest: ModelManifest): void {
  fs.writeFileSync(path.join(modelDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
}

export function readManifest(modelDir: string): ModelManifest | null {
  try {
    const raw = fs.readFileSync(path.join(modelDir, "manifest.json"), "utf8");
    return JSON.parse(raw) as ModelManifest;
  } catch {
    return null;
  }
}

export function sweepOrphans(kind: ModelKind, activeJobDirs: Set<string>, customBase?: string): void {
  const base = getBaseDirForKind(kind, customBase);
  if (!fs.existsSync(base)) return;

  for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dirPath = path.join(base, entry.name);
    if (activeJobDirs.has(dirPath)) continue;

    const manifest = readManifest(dirPath);
    if (!manifest) {
      // Unmanifested directory with no active job -> purge
      try { fs.rmSync(dirPath, { recursive: true, force: true }); } catch {}
    } else {
      // Remove any stale .part files inside manifested directory
      for (const f of fs.readdirSync(dirPath)) {
        if (f.endsWith(".part")) {
          try { fs.unlinkSync(path.join(dirPath, f)); } catch {}
        }
      }
    }
  }
}

export function discoverModels(kind: ModelKind, customBase?: string): DiscoveredModel[] {
  const base = getBaseDirForKind(kind, customBase);
  if (!fs.existsSync(base)) return [];
  const results: DiscoveredModel[] = [];

  // 1. Scan directory entries
  for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const modelDir = path.join(base, entry.name);
      const manifest = readManifest(modelDir);
      if (!manifest) continue;

      const modelFilePath = path.join(modelDir, manifest.variant);
      if (fs.existsSync(modelFilePath)) {
        results.push({
          filename: `${entry.name}/${manifest.variant}`,
          path: modelFilePath,
          repo: manifest.repo,
          sizeBytes: manifest.sizeBytes,
        });
      }
    } else if (entry.isFile() && entry.name.endsWith(".onnx")) {
      // Legacy flat files directly in CANONICAL_DIR
      const filePath = path.join(base, entry.name);
      let size = 0;
      try { size = fs.statSync(filePath).size; } catch {}
      if (size >= 10 * 1024 * 1024) {
        results.push({
          filename: entry.name,
          path: filePath,
          sizeBytes: size,
          isLegacy: true,
        });
      }
    }
  }

  return results.sort((a, b) => a.filename.localeCompare(b.filename));
}
```

- [ ] **Step 4: Connect `embeddings.ts` and `reranker.ts` discovery to `store.ts`**

Update `discoverEmbeddingModels()` in `src/lib/memory/embeddings.ts`:
```ts
export function discoverEmbeddingModels(): DiscoveredEmbeddingModel[] {
  return discoverModels("embedding");
}
```

- [ ] **Step 5: Run tests to verify it passes**

Run: `pnpm test src/lib/models/__tests__/store.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/lib/models/store.ts src/lib/models/__tests__/store.test.ts src/lib/memory/embeddings.ts
git commit -m "feat(models): implement model store layout, manifest integrity, and orphan sweep"
```

---

### Task 6: Job Registry & Conflict Handling (`src/lib/models/jobs.ts`)

**Files:**
- Create: `src/lib/models/jobs.ts`
- Create: `src/lib/models/__tests__/jobs.test.ts`

**Interfaces:**
- Produces: `JobRegistry`, `JobConflictError`, `getJobRegistry()`.

- [ ] **Step 1: Write failing tests for `jobs.ts`**

In `src/lib/models/__tests__/jobs.test.ts`:
```ts
import { describe, it, expect, beforeEach } from "vitest";
import { getJobRegistry, JobConflictError } from "../jobs";

describe("models/jobs", () => {
  beforeEach(() => {
    getJobRegistry().clearAllForTest();
  });

  it("creates job and joins idempotently for same variant", () => {
    const reg = getJobRegistry();
    const job1 = reg.createJob("embedding", "Xenova/minilm", "model_int8.onnx", 100);
    const job2 = reg.getOrCreateJob("embedding", "Xenova/minilm", "model_int8.onnx", 100);
    expect(job1.id).toBe(job2.id);
  });

  it("throws JobConflictError when requested variant differs from active variant", () => {
    const reg = getJobRegistry();
    reg.createJob("embedding", "Xenova/minilm", "model_int8.onnx", 100);
    expect(() => {
      reg.getOrCreateJob("embedding", "Xenova/minilm", "model_fp32.onnx", 200);
    }).toThrow(JobConflictError);
  });

  it("tracks activeJobsBytesReserved across running jobs", () => {
    const reg = getJobRegistry();
    reg.createJob("embedding", "repo1", "m.onnx", 500);
    reg.createJob("reranker", "repo2", "m.onnx", 300);
    expect(reg.getTotalBytesReserved()).toBe(800);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/lib/models/__tests__/jobs.test.ts`
Expected: FAIL (`jobs.ts` not found).

- [ ] **Step 3: Implement `src/lib/models/jobs.ts`**

```ts
import { nanoid } from "nanoid";
import type { ModelKind } from "./types";

export class JobConflictError extends Error {
  constructor(readonly activeVariant: string, readonly activeJobId: string) {
    super(`Variant conflict: variant '${activeVariant}' is currently installing (job ${activeJobId}). Cancel it or wait.`);
    this.name = "JobConflictError";
  }
}

export interface InstallJob {
  id: string;
  kind: ModelKind;
  repo: string;
  variant: string;
  estimatedBytes: number;
  bytesDownloaded: number;
  currentFile?: string;
  status: "pending" | "downloading" | "smoke-testing" | "completed" | "failed" | "aborted";
  error?: string;
  abortController: AbortController;
  createdAt: string;
}

const GLOBAL_JOBS_KEY = "__yggdrasilModelInstallJobs";

class JobRegistry {
  private get map(): Map<string, InstallJob> {
    const g = globalThis as any;
    if (!g[GLOBAL_JOBS_KEY]) {
      g[GLOBAL_JOBS_KEY] = new Map<string, InstallJob>();
    }
    return g[GLOBAL_JOBS_KEY];
  }

  private key(kind: ModelKind, repo: string): string {
    return `${kind}:${repo}`;
  }

  getJob(id: string): InstallJob | undefined {
    for (const job of this.map.values()) {
      if (job.id === id) return job;
    }
    return undefined;
  }

  getActiveJob(kind: ModelKind, repo: string): InstallJob | undefined {
    const job = this.map.get(this.key(kind, repo));
    if (job && (job.status === "pending" || job.status === "downloading" || job.status === "smoke-testing")) {
      return job;
    }
    return undefined;
  }

  createJob(kind: ModelKind, repo: string, variant: string, estimatedBytes: number): InstallJob {
    const k = this.key(kind, repo);
    const active = this.getActiveJob(kind, repo);
    if (active) {
      if (active.variant !== variant) {
        throw new JobConflictError(active.variant, active.id);
      }
      return active;
    }

    const job: InstallJob = {
      id: nanoid(),
      kind,
      repo,
      variant,
      estimatedBytes,
      bytesDownloaded: 0,
      status: "pending",
      abortController: new AbortController(),
      createdAt: new Date().toISOString(),
    };
    this.map.set(k, job);
    return job;
  }

  getOrCreateJob(kind: ModelKind, repo: string, variant: string, estimatedBytes: number): InstallJob {
    const active = this.getActiveJob(kind, repo);
    if (active) {
      if (active.variant !== variant) {
        throw new JobConflictError(active.variant, active.id);
      }
      return active;
    }
    return this.createJob(kind, repo, variant, estimatedBytes);
  }

  getTotalBytesReserved(): number {
    let total = 0;
    for (const job of this.map.values()) {
      if (job.status === "pending" || job.status === "downloading" || job.status === "smoke-testing") {
        total += Math.max(0, job.estimatedBytes - job.bytesDownloaded);
      }
    }
    return total;
  }

  getActiveJobDirs(customBase?: string): Set<string> {
    const dirs = new Set<string>();
    for (const job of this.map.values()) {
      if (job.status === "pending" || job.status === "downloading" || job.status === "smoke-testing") {
        dirs.add(job.repo);
      }
    }
    return dirs;
  }

  clearAllForTest(): void {
    this.map.clear();
  }
}

const registry = new JobRegistry();
export function getJobRegistry(): JobRegistry {
  return registry;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/lib/models/__tests__/jobs.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/models/jobs.ts src/lib/models/__tests__/jobs.test.ts
git commit -m "feat(models): implement install job registry with 409 conflict detection and disk byte reservation"
```

---

### Task 7: Installer Planning & Execution (`src/lib/models/installer.ts`)

**Files:**
- Create: `src/lib/models/installer.ts`
- Create: `src/lib/models/__tests__/installer.test.ts`

**Interfaces:**
- Consumes: `HfClient`, `downloadFile`, `runSmokeTest`, `store`, `jobs`.
- Produces: `planInstall(repo, kind, options)`, `executeInstall(job, plan)`.

- [ ] **Step 1: Write failing tests for `planInstall` and role contracts**

In `src/lib/models/__tests__/installer.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { planInstall } from "../installer";
import type { HfTreeEntry, HfModelInfo } from "../types";

describe("planInstall", () => {
  it("selects int8 over fp32 and resolves base-model pooling tag", async () => {
    const tree: HfTreeEntry[] = [
      { path: "onnx/model_int8.onnx", type: "file", size: 118 * 1024 * 1024, lfs: { oid: "sha-int8", size: 118000, pointerSize: 130 } },
      { path: "onnx/model.onnx", type: "file", size: 470 * 1024 * 1024 },
      { path: "tokenizer.json", type: "file", size: 17 * 1024 * 1024 },
      { path: "config.json", type: "file", size: 500 },
    ];
    const info: HfModelInfo = {
      id: "Xenova/multilingual-e5-small",
      tags: ["transformers.js", "base_model:intfloat/multilingual-e5-small"],
    };

    const mockClient = {
      getModelTree: async () => tree,
      getModelInfo: async () => info,
    } as any;

    const plan = await planInstall({ repo: "Xenova/multilingual-e5-small", kind: "embedding", client: mockClient });
    expect(plan.chosenVariant).toBe("model_int8.onnx");
    expect(plan.files.some(f => f.role === "graph" && f.destinationRelPath === "model_int8.onnx")).toBe(true);
    expect(plan.files.some(f => f.role === "tokenizer" && f.destinationRelPath === "tokenizer.json")).toBe(true);
    expect(plan.poolingSourceRepo).toBe("intfloat/multilingual-e5-small");
  });

  it("co-locates external data file adjacent to graph", async () => {
    const tree: HfTreeEntry[] = [
      { path: "onnx/model.onnx", type: "file", size: 600 * 1024 },
      { path: "onnx/model.onnx_data", type: "file", size: 2 * 1024 * 1024 * 1024 },
      { path: "tokenizer.json", type: "file", size: 10 * 1024 * 1024 },
    ];
    const mockClient = { getModelTree: async () => tree, getModelInfo: async () => ({ id: "repo" }) } as any;

    const plan = await planInstall({ repo: "repo", kind: "embedding", client: mockClient });
    expect(plan.files.some(f => f.role === "graph-data" && f.destinationRelPath === "model.onnx_data")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/lib/models/__tests__/installer.test.ts`
Expected: FAIL (`planInstall` not found).

- [ ] **Step 3: Implement `src/lib/models/installer.ts`**

```ts
import fs from "node:fs";
import path from "node:path";
import { sanitizeSkillFilePath } from "@/lib/skills/config";
import type { HfClient } from "./hf-client";
import type { HfTreeEntry, ModelKind } from "./types";
import { downloadFile, InsufficientDiskError } from "./download";
import { runSmokeTest, ModelUnusableError } from "./smoke";
import { getModelDir, writeManifest, sweepOrphans, type ModelManifest } from "./store";
import { getJobRegistry, type InstallJob } from "./jobs";
import { resolvePoolingMode } from "@/lib/memory/pooling";

export interface PlanFileItem {
  role: "graph" | "graph-data" | "tokenizer" | "pooling" | "companion";
  treePath: string;
  sourceUrl: string;
  destinationRelPath: string;
  sizeBytes: number;
  sha256?: string;
}

export interface InstallPlan {
  repo: string;
  kind: ModelKind;
  chosenVariant: string;
  availableVariants: string[];
  files: PlanFileItem[];
  totalBytes: number;
  poolingSourceRepo?: string;
}

const COMPANION_ALLOWLIST = new Set([
  "config.json",
  "tokenizer_config.json",
  "special_tokens_map.json",
  "sentencepiece.bpe.model",
  "spiece.model",
  "vocab.txt",
  "quant_config.json",
  "quantize_config.json",
  "modules.json",
]);

export async function planInstall(options: {
  repo: string;
  kind: ModelKind;
  client: HfClient;
  preferredVariant?: string;
}): Promise<InstallPlan> {
  const { repo, kind, client, preferredVariant } = options;
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repo)) {
    throw new Error(`Invalid repository format: ${repo}`);
  }

  const [tree, info] = await Promise.all([
    client.getModelTree(repo),
    client.getModelInfo(repo).catch(() => ({ id: repo })),
  ]);

  const onnxFiles = tree.filter(t => t.type === "file" && t.path.endsWith(".onnx"));
  if (onnxFiles.length === 0) {
    throw new Error(`No ONNX models found in repository ${repo}`);
  }

  const availableVariants = onnxFiles.map(f => path.basename(f.path));

  // Variant ladder: int8/quantized -> uint8 -> fp32
  let chosenTreeFile: HfTreeEntry | undefined;
  if (preferredVariant) {
    chosenTreeFile = onnxFiles.find(f => path.basename(f.path) === preferredVariant);
  }
  if (!chosenTreeFile) {
    chosenTreeFile = onnxFiles.find(f => path.basename(f.path) === "model_int8.onnx") ??
      onnxFiles.find(f => path.basename(f.path) === "model_quantized.onnx") ??
      onnxFiles.find(f => path.basename(f.path) === "model_uint8.onnx") ??
      onnxFiles.find(f => path.basename(f.path) === "model.onnx") ??
      onnxFiles[0];
  }

  const chosenVariant = path.basename(chosenTreeFile.path);
  const files: PlanFileItem[] = [];

  // 1. Graph file (flattened)
  files.push({
    role: "graph",
    treePath: chosenTreeFile.path,
    sourceUrl: `https://huggingface.co/${repo}/resolve/main/${chosenTreeFile.path}`,
    destinationRelPath: chosenVariant,
    sizeBytes: chosenTreeFile.size,
    sha256: chosenTreeFile.lfs?.oid,
  });

  // 2. Sibling external data
  const dataTreePath = `${chosenTreeFile.path}_data`;
  const dataFile = tree.find(t => t.path === dataTreePath);
  if (dataFile) {
    files.push({
      role: "graph-data",
      treePath: dataFile.path,
      sourceUrl: `https://huggingface.co/${repo}/resolve/main/${dataFile.path}`,
      destinationRelPath: `${chosenVariant}_data`,
      sizeBytes: dataFile.size,
      sha256: dataFile.lfs?.oid,
    });
  }

  // 3. Tokenizer
  const tokenizerFile = tree.find(t => t.path === "tokenizer.json" || t.path.endsWith("/tokenizer.json"));
  if (tokenizerFile) {
    files.push({
      role: "tokenizer",
      treePath: tokenizerFile.path,
      sourceUrl: `https://huggingface.co/${repo}/resolve/main/${tokenizerFile.path}`,
      destinationRelPath: "tokenizer.json",
      sizeBytes: tokenizerFile.size,
      sha256: tokenizerFile.lfs?.oid,
    });
  }

  // 4. Pooling sidecar lookup
  let poolingSourceRepo: string | undefined;
  const directPooling = tree.find(t => t.path === "1_Pooling/config.json");
  if (directPooling) {
    files.push({
      role: "pooling",
      treePath: directPooling.path,
      sourceUrl: `https://huggingface.co/${repo}/resolve/main/${directPooling.path}`,
      destinationRelPath: "1_Pooling/config.json",
      sizeBytes: directPooling.size,
    });
  } else if (info.tags) {
    // Find base_model:<repo>
    const baseTag = info.tags.find(t => t.startsWith("base_model:") && !t.startsWith("base_model:quantized:"));
    if (baseTag) {
      const baseRepo = baseTag.slice("base_model:".length);
      poolingSourceRepo = baseRepo;
      files.push({
        role: "pooling",
        treePath: "1_Pooling/config.json",
        sourceUrl: `https://huggingface.co/${baseRepo}/resolve/main/1_Pooling/config.json`,
        destinationRelPath: "1_Pooling/config.json",
        sizeBytes: 1024,
      });
    }
  }

  // 5. Allowlisted companion files
  for (const t of tree) {
    if (t.type !== "file") continue;
    const base = path.basename(t.path);
    if (COMPANION_ALLOWLIST.has(base) && base !== "tokenizer.json") {
      files.push({
        role: "companion",
        treePath: t.path,
        sourceUrl: `https://huggingface.co/${repo}/resolve/main/${t.path}`,
        destinationRelPath: base,
        sizeBytes: t.size,
      });
    }
  }

  const totalBytes = files.reduce((acc, f) => acc + f.sizeBytes, 0);
  return {
    repo,
    kind,
    chosenVariant,
    availableVariants,
    files,
    totalBytes,
    poolingSourceRepo,
  };
}

export async function executeInstall(job: InstallJob, plan: InstallPlan, client: HfClient): Promise<void> {
  const targetDir = getModelDir(plan.kind, plan.repo);
  const activeDirs = getJobRegistry().getActiveJobDirs();
  sweepOrphans(plan.kind, activeDirs);

  job.status = "downloading";
  job.estimatedBytes = plan.totalBytes;

  let totalDownloaded = 0;
  for (const file of plan.files) {
    if (job.abortController.signal.aborted) {
      job.status = "aborted";
      throw new Error("Install aborted by user");
    }

    const cleanRel = sanitizeSkillFilePath(file.destinationRelPath);
    if (!cleanRel) {
      throw new Error(`Unsafe destination path in plan: ${file.destinationRelPath}`);
    }
    const dest = path.resolve(targetDir, cleanRel);
    if (!dest.startsWith(targetDir + path.sep)) {
      throw new Error(`Security Violation: Path escapes target directory: ${dest}`);
    }

    job.currentFile = file.destinationRelPath;
    let fileDownloaded = 0;

    await downloadFile({
      client,
      url: file.sourceUrl,
      targetPath: dest,
      expectedBytes: file.sizeBytes,
      expectedSha256: file.sha256,
      signal: job.abortController.signal,
      onProgress: (bytes) => {
        const delta = bytes - fileDownloaded;
        fileDownloaded = bytes;
        totalDownloaded += delta;
        job.bytesDownloaded = totalDownloaded;
      },
    });
  }

  // Smoke test isolated in child process
  job.status = "smoke-testing";
  job.currentFile = undefined;

  const modelPath = path.join(targetDir, plan.chosenVariant);
  const smoke = await runSmokeTest(modelPath);

  if (!smoke.ok) {
    job.status = "failed";
    job.error = smoke.error;
    throw new ModelUnusableError(`Smoke test failed: ${smoke.error}`);
  }

  // Resolve pooling mode from real dims
  let poolingMode: string | undefined;
  if (smoke.outputDims) {
    const res = resolvePoolingMode(modelPath, smoke.outputDims);
    if (res.kind === "resolved") poolingMode = res.mode;
    else if (res.kind === "already-pooled") poolingMode = "already-pooled";
  }

  // Write manifest LAST as the completion marker
  const manifest: ModelManifest = {
    schemaVersion: 1,
    repo: plan.repo,
    kind: plan.kind,
    variant: plan.chosenVariant,
    files: plan.files.map(f => f.destinationRelPath),
    sizeBytes: plan.totalBytes,
    poolingMode,
    installedAt: new Date().toISOString(),
  };
  writeManifest(targetDir, manifest);

  job.status = "completed";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/lib/models/__tests__/installer.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/models/installer.ts src/lib/models/__tests__/installer.test.ts
git commit -m "feat(models): implement pure install planning and executeInstall with isolated smoke testing"
```

---

### Task 8: Reranker Real Tokenizer Integration (`src/lib/memory/reranker.ts`)

**Files:**
- Modify: `src/lib/memory/reranker.ts:1-25, 320-360, 420-435`
- Test: `src/lib/memory/__tests__/reranker.test.ts`

**Interfaces:**
- Consumes: `loadTokenizer` from `src/lib/memory/tokenizer.ts`.
- Produces: Accurate neural cross-encoder inference using real `tokenizer.json`.

- [ ] **Step 1: Write failing test in `reranker.test.ts`**

In `src/lib/memory/__tests__/reranker.test.ts`:
```ts
it("uses real tokenizer when tokenizer.json exists beside model", async () => {
  // Verifies that tokenizerPathFor is checked and loaded
  const modelDir = path.dirname(CANONICAL_MODEL_PATH);
  const tokPath = path.join(modelDir, "tokenizer.json");
  // Test already runs against mock/fixtures; ensure loadTokenizer is imported
  expect(typeof (reranker as any).naiveTokenize).toBe("undefined");
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `pnpm test src/lib/memory/__tests__/reranker.test.ts`
Expected: FAIL (`naiveTokenize` is still present).

- [ ] **Step 3: Update `src/lib/memory/reranker.ts`**

Import `loadTokenizer` and replace `naiveTokenize`:
```ts
import { loadTokenizer, type Tokenizer } from "./tokenizer";

const rerankerTokenizerCache = new Map<string, Tokenizer>();
function getRerankerTokenizer(modelPath: string): Tokenizer {
  let t = rerankerTokenizerCache.get(modelPath);
  if (!t) {
    t = loadTokenizer(modelPath);
    rerankerTokenizerCache.set(modelPath, t);
  }
  return t;
}
```
In `rerankCandidatesWithOnnx`:
```ts
const tokenizer = getRerankerTokenizer(resolvedPath);
const encoded = tokenizer.encode(`${query} ${c.content}`, 512);
// Feed input_ids and attention_mask
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/lib/memory/__tests__/reranker.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/memory/reranker.ts src/lib/memory/__tests__/reranker.test.ts
git commit -m "fix(reranker): replace naive tokenization stub with real tokenizer reader"
```

---

### Task 9: API Routes (`src/app/api/models/`)

**Files:**
- Create: `src/app/api/models/search/route.ts`
- Create: `src/app/api/models/inspect/route.ts`
- Create: `src/app/api/models/install/route.ts`
- Create: `src/app/api/models/install/[jobId]/route.ts`
- Create: `src/app/api/models/__tests__/models-api.test.ts`

**Interfaces:**
- Produces: REST endpoints for Search, Inspect, Install, Progress, and Cancel.

- [ ] **Step 1: Write failing tests for API routes**

In `src/app/api/models/__tests__/models-api.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { GET as searchRoute } from "../search/route";
import { POST as inspectRoute } from "../inspect/route";
import { POST as installRoute } from "../install/route";

describe("/api/models routes", () => {
  it("rejects search without query", async () => {
    const req = new Request("http://localhost/api/models/search");
    const res = await searchRoute(req);
    expect(res.status).toBe(400);
  });

  it("inspects model and returns plan", async () => {
    const req = new Request("http://localhost/api/models/inspect", {
      method: "POST",
      body: JSON.stringify({ repo: "Xenova/all-MiniLM-L6-v2", kind: "embedding" }),
    });
    // mock hf-client
    const res = await inspectRoute(req);
    expect([200, 502]).toContain(res.status); // 200 or 502 if offline
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `pnpm test src/app/api/models/__tests__/models-api.test.ts`
Expected: FAIL (routes missing).

- [ ] **Step 3: Implement API routes**

1. `src/app/api/models/search/route.ts`:
```ts
import { NextResponse } from "next/server";
import { createHfClient } from "@/lib/models/hf-client";
import type { ModelKind } from "@/lib/models/types";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const q = searchParams.get("q")?.trim();
  const kind = (searchParams.get("kind") ?? "embedding") as ModelKind;

  if (!q) {
    return NextResponse.json({ error: "Missing query parameter 'q'" }, { status: 400 });
  }

  try {
    const client = createHfClient();
    const results = await client.searchModels(q, kind);
    return NextResponse.json({ results });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 502 });
  }
}
```

2. `src/app/api/models/inspect/route.ts`:
```ts
import { NextResponse } from "next/server";
import { createHfClient } from "@/lib/models/hf-client";
import { planInstall } from "@/lib/models/installer";
import type { ModelKind } from "@/lib/models/types";

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const repo = body?.repo?.trim();
  const kind = (body?.kind ?? "embedding") as ModelKind;
  const variant = body?.variant?.trim();

  if (!repo) {
    return NextResponse.json({ error: "Missing 'repo' in body" }, { status: 400 });
  }

  try {
    const client = createHfClient();
    const plan = await planInstall({ repo, kind, client, preferredVariant: variant });
    return NextResponse.json({ plan });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 502 });
  }
}
```

3. `src/app/api/models/install/route.ts`:
```ts
import { NextResponse } from "next/server";
import { createHfClient } from "@/lib/models/hf-client";
import { planInstall, executeInstall } from "@/lib/models/installer";
import { getJobRegistry, JobConflictError } from "@/lib/models/jobs";
import type { ModelKind } from "@/lib/models/types";

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const repo = body?.repo?.trim();
  const kind = (body?.kind ?? "embedding") as ModelKind;
  const variant = body?.variant?.trim();

  if (!repo) {
    return NextResponse.json({ error: "Missing 'repo' in body" }, { status: 400 });
  }

  try {
    const client = createHfClient();
    const plan = await planInstall({ repo, kind, client, preferredVariant: variant });
    const registry = getJobRegistry();

    let job;
    try {
      job = registry.createJob(kind, repo, plan.chosenVariant, plan.totalBytes);
    } catch (err) {
      if (err instanceof JobConflictError) {
        return NextResponse.json({ error: err.message, activeJobId: err.activeJobId }, { status: 409 });
      }
      throw err;
    }

    // Launch background execution
    void executeInstall(job, plan, client).catch((err) => {
      job.status = "failed";
      job.error = err.message;
    });

    return NextResponse.json({ jobId: job.id, status: job.status });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
```

4. `src/app/api/models/install/[jobId]/route.ts`:
```ts
import { NextResponse } from "next/server";
import { getJobRegistry } from "@/lib/models/jobs";

export async function GET(_req: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  const job = getJobRegistry().getJob(jobId);
  if (!job) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }

  return NextResponse.json({
    id: job.id,
    status: job.status,
    bytesDownloaded: job.bytesDownloaded,
    estimatedBytes: job.estimatedBytes,
    currentFile: job.currentFile,
    error: job.error,
  });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  const job = getJobRegistry().getJob(jobId);
  if (!job) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }

  job.abortController.abort();
  job.status = "aborted";
  return NextResponse.json({ success: true });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/app/api/models/__tests__/models-api.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/app/api/models/
git commit -m "feat(api): implement model search, inspect, install and job progress routes"
```

---

### Task 10: Settings UI Components & Tab Integration

**Files:**
- Create: `src/components/settings/model-browser-dialog.tsx`
- Modify: `src/components/settings/tabs.tsx`
- Modify: `src/components/settings/reranker-tab.tsx`
- Test: `src/components/settings/__tests__/model-browser-dialog.test.tsx`

**Interfaces:**
- Produces: `<ModelBrowserDialog kind={kind} onInstalled={refresh} />`.

- [ ] **Step 1: Write test for `<ModelBrowserDialog />`**

In `src/components/settings/__tests__/model-browser-dialog.test.tsx`:
```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ModelBrowserDialog } from "../model-browser-dialog";

describe("ModelBrowserDialog", () => {
  it("renders search input and trigger button", () => {
    render(<ModelBrowserDialog kind="embedding" onInstalled={() => {}} />);
    expect(screen.getByRole("button", { name: /add model|browse huggingface/i })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Implement `src/components/settings/model-browser-dialog.tsx`**

Create the dialog component supporting:
1. Search input + fetch to `/api/models/search?q=&kind=`.
2. Inspect step showing files, variant, pooling source (`mean (from base model)`), total size.
3. Install button triggering `/api/models/install` + polling progress from `/api/models/install/[jobId]`.
4. Progress bar + Cancel button.

- [ ] **Step 3: Integrate into `src/components/settings/tabs.tsx` and `reranker-tab.tsx`**

Add the `<ModelBrowserDialog kind="embedding" onInstalled={reloadStatus} />` button to the Discovered Models card in both tabs.

- [ ] **Step 4: Run component tests**

Run: `pnpm test src/components/settings/__tests__/model-browser-dialog.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/settings/model-browser-dialog.tsx src/components/settings/tabs.tsx src/components/settings/reranker-tab.tsx src/components/settings/__tests__/model-browser-dialog.test.tsx
git commit -m "feat(ui): add HuggingFace model browser dialog and integrate into settings tabs"
```

---

### Task 11: End-to-End Verification & Gated Integration Test

**Files:**
- Create: `src/lib/models/__tests__/models-install.integration.test.ts`

**Interfaces:**
- Verifies complete subsystem against a live test repository on HuggingFace.

- [ ] **Step 1: Write integration test**

In `src/lib/models/__tests__/models-install.integration.test.ts`:
```ts
// @vitest-environment node
import { describe, it, expect } from "vitest";
import { createHfClient } from "../hf-client";
import { planInstall } from "../installer";

describe("models installer integration", () => {
  it("fetches real tree and plans install for Xenova/all-MiniLM-L6-v2", async () => {
    const client = createHfClient();
    const plan = await planInstall({ repo: "Xenova/all-MiniLM-L6-v2", kind: "embedding", client });
    expect(plan.files.length).toBeGreaterThan(0);
    expect(plan.files.some(f => f.destinationRelPath === "tokenizer.json")).toBe(true);
  });
});
```

- [ ] **Step 2: Run all tests and typecheck**

Run:
1. `pnpm test` (unit tests — should all pass)
2. `pnpm test:integration` (integration tests)
3. `pnpm lint`

- [ ] **Step 3: Final Commit**

```bash
git add src/lib/models/__tests__/models-install.integration.test.ts
git commit -m "test(models): add integration test for HuggingFace model tree planning"
```
