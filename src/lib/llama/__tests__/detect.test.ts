import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const execFileMock = vi.hoisted(() =>
  vi.fn((...args: unknown[]) => {
    const cb = args[args.length - 1];
    if (typeof cb === "function") cb(null, "", "");
  }),
);

vi.mock("node:child_process", () => ({
  execFile: execFileMock,
}));

vi.mock("@/lib/system-stats", () => ({
  getAvailableMemoryBytes: () => 8 * 1024 * 1024 * 1024,
}));

import { findLlamaServer, scanGgufModels, ensureLlamaDirs } from "@/lib/llama/detect";
import { MIN_LLAMA_SERVER_BUILD } from "@/lib/llama/types";

type ExecCb = (e: Error | null, stdout: string, stderr: string) => void;

describe("findLlamaServer", () => {
  beforeEach(() => execFileMock.mockReset());

  it("returns null when the binary is absent from PATH", async () => {
    execFileMock.mockImplementation((...args: unknown[]) => {
      const cb = args[args.length - 1];
      if (typeof cb !== "function") return;
      (cb as ExecCb)(Object.assign(new Error("not found"), { code: "ENOENT" }), "", "");
    });
    await expect(findLlamaServer()).resolves.toBeNull();
  });

  it("falls back to 'llama' binary when 'llama-server' is absent", async () => {
    execFileMock.mockImplementation((...args: unknown[]) => {
      const argList = args as unknown as [string, string[], ExecCb];
      const [, cmdArgs, cb] = argList;
      if (typeof cb !== "function") return;
      // First call is `which llama-server` → not found.
      // Second call is `which llama` → found at /usr/local/bin/llama.
      if (cmdArgs.length === 1 && cmdArgs[0] === "llama-server") {
        (cb as ExecCb)(Object.assign(new Error("not found"), { code: "ENOENT" }), "", "");
        return;
      }
      if (cmdArgs.length === 1 && cmdArgs[0] === "llama") {
        (cb as ExecCb)(null, "/usr/local/bin/llama\n", "");
        return;
      }
      // Version probe: `llama --version`
      (cb as ExecCb)(null, "version: 7231 (abc1234)\n", "");
    });
    const info = await findLlamaServer();
    expect(info?.path).toBe("/usr/local/bin/llama");
    expect(info?.version).toBe(7231);
  });

  it("parses 'version: 7231 (abc1234)' format", async () => {
    execFileMock.mockImplementation((...args: unknown[]) => {
      const cb = args[args.length - 1];
      if (typeof cb !== "function") return;
      (cb as ExecCb)(null, "version: 7231 (abc1234)\n", "");
    });
    const info = await findLlamaServer(process.execPath);
    expect(info?.version).toBe(7231);
  });

  it("parses 'b7488' format", async () => {
    execFileMock.mockImplementation((...args: unknown[]) => {
      const cb = args[args.length - 1];
      if (typeof cb !== "function") return;
      (cb as ExecCb)(null, "b7488\n", "");
    });
    const info = await findLlamaServer(process.execPath);
    expect(info?.version).toBe(7488);
  });

  it("parses 'build 11200' format", async () => {
    execFileMock.mockImplementation((...args: unknown[]) => {
      const cb = args[args.length - 1];
      if (typeof cb !== "function") return;
      (cb as ExecCb)(null, "version: 0.5.0-dev (build 11200, commit 81bc6b83f)\n", "");
    });
    const info = await findLlamaServer(process.execPath);
    expect(info?.version).toBe(11200);
  });

  it("warn-and-proceeds (version null) on garbage output", async () => {
    execFileMock.mockImplementation((...args: unknown[]) => {
      const cb = args[args.length - 1];
      if (typeof cb !== "function") return;
      (cb as ExecCb)(null, "llama-server forever\n", "");
    });
    const info = await findLlamaServer(process.execPath);
    expect(info?.version).toBeNull();
  });

  it("throws an actionable error below the minimum build", async () => {
    execFileMock.mockImplementation((...args: unknown[]) => {
      const cb = args[args.length - 1];
      if (typeof cb !== "function") return;
      (cb as ExecCb)(null, `version: ${MIN_LLAMA_SERVER_BUILD - 1} (old)\n`, "");
    });
    await expect(findLlamaServer(process.execPath)).rejects.toThrow(/6000\+.*install\.sh/);
  });
});

describe("scanGgufModels", () => {
  it("lists .gguf files fit-first then by name, ignoring non-gguf files", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "gguf-scan-"));
    try {
      writeFileSync(path.join(dir, "z-small.gguf"), Buffer.alloc(1024));
      writeFileSync(path.join(dir, "a-small.gguf"), Buffer.alloc(1024));
      writeFileSync(path.join(dir, "notes.txt"), "nope");
      mkdirSync(path.join(dir, "nested"));
      writeFileSync(path.join(dir, "nested", "deep.gguf"), Buffer.alloc(10));
      const entries = await scanGgufModels(dir);
      expect(entries.map((e) => e.filename)).toEqual(["a-small.gguf", "z-small.gguf"]);
      expect(entries[0].sizeBytes).toBe(1024);
      expect(entries.every((e) => e.fitsMemory)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns [] for a missing directory", async () => {
    await expect(scanGgufModels(path.join(tmpdir(), "gguf-nope-missing"))).resolves.toEqual([]);
  });
});

describe("ensureLlamaDirs", () => {
  it("creates the GGUF and embedding model directories", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "gguf-ensure-"));
    try {
      process.env.GGUF_MODELS_DIR = path.join(dir, "GGUF-chatModel");
      await ensureLlamaDirs();
      // GGUF dir created at the env-var path.
      expect(fs.existsSync(path.join(dir, "GGUF-chatModel"))).toBe(true);
      // Embedding dir created as a sibling of the GGUF dir.
      expect(fs.existsSync(path.join(dir, "embedding"))).toBe(true);
    } finally {
      delete process.env.GGUF_MODELS_DIR;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});