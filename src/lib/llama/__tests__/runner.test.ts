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

vi.mock("@/lib/system-memory", () => ({
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

  it("adopts a pidfile orphan only when /health and /props match (orphan adoption is gated fully)", async () => {
    // Pins the orphan-adoption happy path (spec §Orphan adoption step 1):
    // pidfile alive + /health ok + /props model_path matches → adopt, NO spawn.
    vi.useRealTimers();
    const dir = mkdtempSync(path.join(tmpdir(), "gguf-orphan-ok-"));
    writeFileSync(path.join(dir, "m-7B.gguf"), Buffer.alloc(1024));
    vi.stubEnv("GGUF_MODELS_DIR", dir);
    const modelAbsPath = path.join(dir, "m-7B.gguf");

    // Pidfile claims THIS process's pid (alive for the test's lifetime).
    writeFileSync(path.join(dir, ".llama-server.pid"), String(process.pid));

    spawnMock.mockReturnValue(fakeChild());
    findLlamaServerMock.mockResolvedValue({ path: "/usr/local/bin/llama-server", version: 7488 });
    fetchMock.mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.endsWith("/health")) return new Response('{"status":"ok"}');
      return new Response(JSON.stringify({ model_path: modelAbsPath }));
    });
    loadRegistryMock.mockResolvedValue({ providers: [{ id: "gguf-1", baseUrl: "http://127.0.0.1:2301" }] });

    const baseUrl = await ensureGgufServerRunning(entry(), "m-7B.gguf");

    // Adopted the orphan — no fresh spawn happened.
    expect(baseUrl).toBe("http://127.0.0.1:2301");
    expect(spawnMock).not.toHaveBeenCalled();

    rmSync(dir, { recursive: true, force: true });
    vi.useFakeTimers();
  });
});

describe("stopGgufServer", () => {
  it("never-started stop is a no-op (does not throw)", async () => {
    await expect(stopGgufServer("provider-x", "model.gguf")).resolves.toBeUndefined();
  });

  it("clears planned + child state after stop so status reports unload", async () => {
    vi.useRealTimers();
    const dir = mkdtempSync(path.join(tmpdir(), "gguf-stop-"));
    writeFileSync(path.join(dir, "m-7B.gguf"), Buffer.alloc(1024));
    vi.stubEnv("GGUF_MODELS_DIR", dir);
    const modelAbsPath = path.join(dir, "m-7B.gguf");

    const { child } = makeFakeServer(modelAbsPath);
    spawnMock.mockReturnValue(child);
    findLlamaServerMock.mockResolvedValue({ path: "/usr/local/bin/llama-server", version: 7488 });
    fetchMock
      .mockImplementationOnce(async () => new Response("not ok", { status: 503 }))
      .mockImplementation(async (url: string) => {
        const u = String(url);
        if (u.endsWith("/health")) return new Response('{"status":"ok"}');
        return new Response(JSON.stringify({ model_path: modelAbsPath }));
      });

    await ensureGgufServerRunning(entry(), "m-7B.gguf");
    // Before stop: state is running, planned is set.
    const running = getGgufServerStatus("gguf-1", "m-7B.gguf");
    expect(running.state).toBe("running");
    expect(running.planned).not.toBeNull();

    await stopGgufServer("gguf-1", "m-7B.gguf");
    const stopped = getGgufServerStatus("gguf-1", "m-7B.gguf");
    expect(stopped.state).toBe("unload");
    expect(stopped.pid).toBeNull();
    expect(stopped.planned).toBeNull();

    rmSync(dir, { recursive: true, force: true });
    vi.useFakeTimers();
  });
});

describe("getGgufServerStatus", () => {
  it("reports unload when never started", () => {
    const status = getGgufServerStatus("gguf-1", "m-7B.gguf");
    expect(status.state).toBe("unload");
    expect(status.pid).toBeNull();
  });
});

describe("LlamaRunner crash-loop isolation", () => {
  it("does not retry-spawn after successful health check when child exits", async () => {
    vi.useRealTimers();
    const dir = mkdtempSync(path.join(tmpdir(), "gguf-crash-"));
    writeFileSync(path.join(dir, "m-7B.gguf"), Buffer.alloc(1024));
    vi.stubEnv("GGUF_MODELS_DIR", dir);
    const modelAbsPath = path.join(dir, "m-7B.gguf");

    const { child } = makeFakeServer(modelAbsPath);
    spawnMock.mockReturnValue(child);
    findLlamaServerMock.mockResolvedValue({ path: "/usr/local/bin/llama-server", version: 7488 });
    fetchMock
      .mockImplementationOnce(async () => new Response("not ok", { status: 503 }))
      .mockImplementation(async (url: string) => {
        const u = String(url);
        if (u.endsWith("/health")) return new Response('{"status":"ok"}');
        return new Response(JSON.stringify({ model_path: modelAbsPath }));
      });

    await ensureGgufServerRunning(entry(), "m-7B.gguf");
    // At this point, exit listener should have been removed.
    // Verify: simulate a child exit — should not trigger a second spawn.
    spawnMock.mockClear();
    child.emit("exit", 1);
    // Give any pending setTimeout(0) in handleExit a chance to fire.
    await new Promise((r) => setTimeout(r, 50));
    expect(spawnMock).not.toHaveBeenCalled();

    rmSync(dir, { recursive: true, force: true });
    vi.useFakeTimers();
  });

  it("reassigns to a free port when a foreign server holds 2301 with a matching model but no pidfile claim", async () => {
    // Review Focus line 5: a foreign healthy server on the planned port whose
    // /props happens to name the same model file must NOT be adopted (there is
    // no pidfile claiming it) — the runner must spawn on a fresh free port and
    // persist the updated baseUrl to the registry.
    vi.useRealTimers();
    const dir = mkdtempSync(path.join(tmpdir(), "gguf-reassign-"));
    writeFileSync(path.join(dir, "m-7B.gguf"), Buffer.alloc(1024));
    vi.stubEnv("GGUF_MODELS_DIR", dir);
    const modelAbsPath = path.join(dir, "m-7B.gguf");

    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    findLlamaServerMock.mockResolvedValue({ path: "/usr/local/bin/llama-server", version: 7488 });

    // The foreign-port probe in spawnAndAwait hits /health (ok) and /props
    // (matching model_path). Because there is no pidfile, tryAdopt returns
    // null — but spawnAndAwait's foreign-port branch must still detect "port
    // held by a healthy server we did not spawn" and reassign.
    fetchMock
      .mockImplementation(async (url: string) => {
        const u = String(url);
        if (u.endsWith("/health")) return new Response('{"status":"ok"}');
        // /props reports our model path — this is the same-model case.
        return new Response(JSON.stringify({ model_path: modelAbsPath }));
      });
    loadRegistryMock.mockResolvedValue({ providers: [{ id: "gguf-1", baseUrl: "http://127.0.0.1:2301" }] });

    const baseUrl = await ensureGgufServerRunning(entry(), "m-7B.gguf");

    // The resolved baseUrl must NOT be the foreign server on 2301.
    expect(baseUrl).not.toBe("http://127.0.0.1:2301");
    expect(baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    // spawn must be called with a --port whose value differs from 2301.
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [, , opts] = spawnMock.mock.calls[0];
    expect(opts).not.toMatchObject({ shell: true });
    const spawnedArgs = spawnMock.mock.calls[0][1] as string[];
    const portIdx = spawnedArgs.indexOf("--port");
    expect(portIdx).toBeGreaterThanOrEqual(0);
    expect(spawnedArgs[portIdx + 1]).not.toBe("2301");

    // The runner must persist the reassigned baseUrl into the registry.
    expect(saveRegistryMock).toHaveBeenCalled();
    const doc = saveRegistryMock.mock.calls[0][0];
    const prov = doc.providers.find((p: { id: string }) => p.id === "gguf-1");
    expect(prov.baseUrl).toBe(baseUrl);

    rmSync(dir, { recursive: true, force: true });
    vi.useFakeTimers();
  });
});
