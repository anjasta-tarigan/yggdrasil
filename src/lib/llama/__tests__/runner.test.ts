import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";

// Hoist mocks so they're available before imports.
const spawnMock = vi.hoisted(() => vi.fn());
const fetchMock = vi.hoisted(() => vi.fn());
const acquireLockMock = vi.hoisted(() => vi.fn());
const loadRegistryMock = vi.hoisted(() => vi.fn());
const saveRegistryMock = vi.hoisted(() => vi.fn());

const execFileMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
  execFile: execFileMock,
  ChildProcess: class {},
  default: { spawn: spawnMock, execFile: execFileMock, ChildProcess: class {} },
}));

const findLlamaServerMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/llama/detect", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/llama/detect")>()),
  findLlamaServer: findLlamaServerMock,
  modelsDirPath: vi.fn(() => process.env.GGUF_MODELS_DIR ?? path.resolve(process.cwd(), "data", "models", "GGUF-chatModel")),
}));

vi.mock("@/lib/ai/provider-config/store", () => ({
  acquireRegistryLock: acquireLockMock,
  loadRegistry: loadRegistryMock,
  saveRegistry: saveRegistryMock,
}));

vi.mock("@/lib/system-stats", () => ({
  getAvailableMemoryBytes: () => 8 * 1024 * 1024 * 1024,
}));

import {
  ensureGgufServerRunning,
  stopGgufServer,
  getGgufServerStatus,
  __resetGgufRunnersForTest,
} from "@/lib/llama/runner";
import type { ProviderEntry } from "@/lib/ai/provider-config/schema";


function entry(over: Partial<ProviderEntry> & { gguf?: Record<string, unknown> } = {}): ProviderEntry {
  return {
    id: "gguf-1",
    kind: "gguf-model",
    name: "GGUF",
    baseUrl: "http://127.0.0.1:2301",
    models: [],
    apiKeys: [],
    ...over,
  } as ProviderEntry;
}

function fakeChild(): EventEmitter & {
  pid: number; kill: ReturnType<typeof vi.fn>; stdout: EventEmitter; stderr: EventEmitter;
} {
  const child = new EventEmitter() as EventEmitter & {
    pid: number; kill: ReturnType<typeof vi.fn>; stdout: EventEmitter; stderr: EventEmitter;
  };
  child.pid = 4242;
  child.kill = vi.fn().mockReturnValue(true);
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

// A fake server that responds to /health and /props.
function makeFakeServer(modelPath: string) {
  const child = fakeChild();
  return { child, modelPath };
}

beforeEach(() => {
  __resetGgufRunnersForTest();
  spawnMock.mockReset();
  findLlamaServerMock.mockReset();
  findLlamaServerMock.mockResolvedValue(null);
  fetchMock.mockReset();
  acquireLockMock.mockReset();
  acquireLockMock.mockResolvedValue(vi.fn());
  loadRegistryMock.mockReset();
  loadRegistryMock.mockResolvedValue({ providers: [] });
  saveRegistryMock.mockReset();
  saveRegistryMock.mockResolvedValue(undefined);
  vi.useFakeTimers();
  vi.unstubAllGlobals();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("ensureGgufServerRunning", () => {
  it("rejects path-traversal modelIds before touching the filesystem", async () => {
    await expect(ensureGgufServerRunning(entry(), "../evil.gguf")).rejects.toThrow(/path traversal/i);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("rejects non-.gguf modelIds", async () => {
    await expect(ensureGgufServerRunning(entry(), "model.bin")).rejects.toThrow(/\.gguf/);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("coalesces concurrent ensure calls into a single spawn", async () => {
    // This test uses real timers because the health-polling path relies on
    // AbortSignal.timeout (which internally uses setTimeout) and async fetch
    // mocks that don't compose well with fake timers.
    vi.useRealTimers();

    // Use a temp models dir so stat() on the model path works.
    const dir = mkdtempSync(path.join(tmpdir(), "gguf-runner-"));
    writeFileSync(path.join(dir, "m-7B.gguf"), Buffer.alloc(1024));
    vi.stubEnv("GGUF_MODELS_DIR", dir);
    const modelAbsPath = path.join(dir, "m-7B.gguf");

    const { child } = makeFakeServer(modelAbsPath);
    spawnMock.mockReturnValue(child);
    findLlamaServerMock.mockResolvedValue({ path: "/usr/local/bin/llama-server", version: 7488 });
    // First /health check (foreign-port probe) fails, then subsequent ones succeed.
    fetchMock
      .mockImplementationOnce(async () => new Response("not ok", { status: 503 }))
      .mockImplementation(async (url: string) => {
        const u = String(url);
        if (u.endsWith("/health")) return new Response('{"status":"ok"}');
        return new Response(JSON.stringify({ model_path: modelAbsPath }));
      });

    const promise = Promise.all([
      ensureGgufServerRunning(entry(), "m-7B.gguf"),
      ensureGgufServerRunning(entry(), "m-7B.gguf"),
    ]);
    // Give real timers a moment to settle.
    await new Promise((r) => setTimeout(r, 1500));
    const [a, b] = await promise;
    expect(a).toBe(b);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0][2]).not.toMatchObject({ shell: true });

    rmSync(dir, { recursive: true, force: true });
    vi.useFakeTimers();
  });

  it("rejects reserved extraFlags before spawn", async () => {
    const e = entry({
      gguf: { extraFlags: ["--host", "0.0.0.0"] },
    });
    await expect(ensureGgufServerRunning(e, "m-7B.gguf")).rejects.toThrow(/reserved/i);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("rejects when llama-server binary is not installed", async () => {
    findLlamaServerMock.mockResolvedValue(null);
    const dir = mkdtempSync(path.join(tmpdir(), "gguf-runner-"));
    writeFileSync(path.join(dir, "m-7B.gguf"), Buffer.alloc(1024));
    vi.stubEnv("GGUF_MODELS_DIR", dir);
    await expect(ensureGgufServerRunning(entry(), "m-7B.gguf")).rejects.toThrow(/llama-server/);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("stopGgufServer", () => {
  it("never-started stop is a no-op (does not throw)", async () => {
    await expect(stopGgufServer("provider-x", "model.gguf")).resolves.toBeUndefined();
  });
});

describe("getGgufServerStatus", () => {
  it("reports unload when never started", () => {
    const status = getGgufServerStatus("gguf-1", "m-7B.gguf");
    expect(status.state).toBe("unload");
    expect(status.pid).toBeNull();
  });
});
