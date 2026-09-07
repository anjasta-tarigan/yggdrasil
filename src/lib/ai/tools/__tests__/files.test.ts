// src/lib/ai/tools/__tests__/files.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { file_operations } from "../files";

describe("file_operations Tool", () => {
  let tmpRoot: string;
  let origCwd: string;

  beforeEach(async () => {
    origCwd = process.cwd();
    tmpRoot = path.join(os.tmpdir(), "ygg-fileops-test-" + crypto.randomUUID());
    await fs.mkdir(tmpRoot, { recursive: true });
    process.chdir(tmpRoot);
  });

  afterEach(async () => {
    process.chdir(origCwd);
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("writes and reads a text file cleanly", async () => {
    const filePath = path.join(tmpRoot, "hello.txt");
    const writeRes = await file_operations.execute!(
      { action: "write", path: filePath, content: "Line 1\nLine 2" },
      {} as never
    );
    expect(writeRes).toHaveProperty("path");
    expect(writeRes).toHaveProperty("bytesWritten");

    const readRes = (await file_operations.execute!(
      { action: "read", path: filePath },
      {} as never
    )) as { content: string };
    expect(readRes.content).toContain("Line 1");
    expect(readRes.content).toContain("Line 2");
  });

  it("creates a .bak snapshot when overwriting an existing file", async () => {
    const filePath = path.join(tmpRoot, "overwrite.txt");
    await fs.writeFile(filePath, "original content", "utf8");

    await file_operations.execute!(
      { action: "write", path: filePath, content: "new content" },
      {} as never
    );

    const files = await fs.readdir(tmpRoot);
    const backupFile = files.find((f) => f.startsWith("overwrite.txt.bak."));
    expect(backupFile).toBeDefined();

    const backupContent = await fs.readFile(path.join(tmpRoot, backupFile!), "utf8");
    expect(backupContent).toBe("original content");
  });

  it("performs surgical exact-string edits", async () => {
    const filePath = path.join(tmpRoot, "edit.txt");
    await fs.writeFile(filePath, "const port = 3000;\nconsole.log(port);", "utf8");

    await file_operations.execute!(
      {
        action: "edit",
        path: filePath,
        oldString: "const port = 3000;",
        newString: "const port = 2302;",
      },
      {} as never
    );

    const updated = await fs.readFile(filePath, "utf8");
    expect(updated).toContain("const port = 2302;");
  });

  it("rejects edits if oldString does not exist or is ambiguous", async () => {
    const filePath = path.join(tmpRoot, "ambiguous.txt");
    await fs.writeFile(filePath, "repeat\nrepeat", "utf8");

    const resMissing = (await file_operations.execute!(
      { action: "edit", path: filePath, oldString: "missing", newString: "x" },
      {} as never
    )) as { error?: string };
    expect(resMissing.error).toContain("was not found");

    const resAmbiguous = (await file_operations.execute!(
      { action: "edit", path: filePath, oldString: "repeat", newString: "x" },
      {} as never
    )) as { error?: string };
    expect(resAmbiguous.error).toContain("matched 2 times");
  });

  it("detects binary files and does not dump raw bytes", async () => {
    const binPath = path.join(tmpRoot, "sample.bin");
    const binBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0a, 0x1a, 0x0a]);
    await fs.writeFile(binPath, binBuffer);

    const res = (await file_operations.execute!(
      { action: "read", path: binPath },
      {} as never
    )) as { isBinary: boolean };
    expect(res.isBinary).toBe(true);
  });

  it("handles malicious command injection characters safely as literal strings", async () => {
    const evilQuery = "'; rm -rf / ; $(whoami) | touch pwned";
    const res = await file_operations.execute!(
      { action: "grep", query: evilQuery, path: tmpRoot },
      {} as never
    );
    expect(res).toBeDefined();
    // Verify no command ran
    expect(await fs.stat(path.join(tmpRoot, "pwned")).catch(() => false)).toBe(false);
  });

  it("lists directory tree with proper indentation and limits", async () => {
    await fs.mkdir(path.join(tmpRoot, "sub1", "sub2"), { recursive: true });
    await fs.writeFile(path.join(tmpRoot, "sub1", "file.txt"), "hello", "utf8");

    const res = (await file_operations.execute!(
      { action: "list", path: tmpRoot, depth: 2, showHidden: false },
      {} as never
    )) as { listing: string };
    expect(res.listing).toContain("sub1");
  });

  it("finds files matching pattern", async () => {
    await fs.writeFile(path.join(tmpRoot, "find-me.ts"), "export const x = 1;", "utf8");

    const res = (await file_operations.execute!(
      { action: "find", pattern: "find-me", path: tmpRoot },
      {} as never
    )) as { matches: string[] };
    expect(res.matches.some((m) => m.includes("find-me.ts"))).toBe(true);
  });

  it("blocks reading and writing sensitive files", async () => {
    const envPath = path.join(tmpRoot, ".env");
    const writeRes = (await file_operations.execute!(
      { action: "write", path: envPath, content: "SECRET=123" },
      {} as never
    )) as { error?: string };
    expect(writeRes.error).toContain("Security Violation");

    const readRes = (await file_operations.execute!(
      { action: "read", path: envPath },
      {} as never
    )) as { error?: string };
    expect(readRes.error).toContain("Security Violation");
  });
});
