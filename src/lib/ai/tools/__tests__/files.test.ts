// src/lib/ai/tools/__tests__/files.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { file_operations } from "../files";

describe("file_operations Tool", () => {
  let tmpRoot: string;
  let savedWorkspaceDir: string | undefined;

  beforeEach(async () => {
    // The tool is scoped to a dedicated chat workspace (data/workspace by
    // default), not process.cwd(). Point it at a temp dir for the test and
    // keep paths absolute so assertions stay readable.
    savedWorkspaceDir = process.env.YGGDRASIL_WORKSPACE_DIR;
    tmpRoot = path.join(os.tmpdir(), "ygg-fileops-test-" + crypto.randomUUID());
    await fs.mkdir(tmpRoot, { recursive: true });
    process.env.YGGDRASIL_WORKSPACE_DIR = tmpRoot;
  });

  afterEach(async () => {
    if (savedWorkspaceDir === undefined) delete process.env.YGGDRASIL_WORKSPACE_DIR;
    else process.env.YGGDRASIL_WORKSPACE_DIR = savedWorkspaceDir;
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

  it("refuses a blind overwrite and backs up on an explicit overwrite", async () => {
    const filePath = path.join(tmpRoot, "overwrite.txt");
    await fs.writeFile(filePath, "original content", "utf8");

    // A blind write to an existing file is refused (the model should use
    // `edit`, or opt in with overwrite: true).
    const refused = (await file_operations.execute!(
      { action: "write", path: filePath, content: "new content" },
      {} as never
    )) as { error?: string; status?: string };
    expect(refused.status).toBeUndefined();
    expect(refused.error).toMatch(/already exists/i);

    // An explicit overwrite succeeds and leaves a rolling .bak snapshot.
    const written = (await file_operations.execute!(
      { action: "write", path: filePath, content: "new content", overwrite: true },
      {} as never
    )) as { status?: string };
    expect(written.status).toBe("success");

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

  it("accepts glob-style find patterns without erroring", async () => {
    // Models routinely pass "*.ts". fd interprets a bare argument as a REGEX,
    // so "*.ts" is a parse error (a leading "*" quantifier) and the search
    // returns nothing. The tool must treat such a pattern as a glob.
    await fs.mkdir(path.join(tmpRoot, "nested"), { recursive: true });
    await fs.writeFile(path.join(tmpRoot, "nested", "main.ts"), "x", "utf8");
    await fs.writeFile(path.join(tmpRoot, "nested", "meta.json"), "{}", "utf8");

    const res = (await file_operations.execute!(
      { action: "find", pattern: "*.ts", path: tmpRoot },
      {} as never
    )) as { matches: string[]; error?: string };
    expect(res.error).toBeUndefined();
    expect(res.matches.some((m) => m.includes("main.ts"))).toBe(true);
    expect(res.matches.some((m) => m.includes("meta.json"))).toBe(false);
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

  it("treats flag-like patterns as literals and never executes them", async () => {
    const res = (await file_operations.execute!(
      { action: "find", pattern: "--exec", path: tmpRoot },
      {} as never
    )) as { matches?: string[]; error?: string };
    expect(res).toBeDefined();
    // must not throw or execute; worst case is zero literal matches
    if (res.matches) {
      expect(Array.isArray(res.matches)).toBe(true);
    }
  });

  it("never surfaces .aws credentials from find or grep results", async () => {
    await fs.mkdir(path.join(tmpRoot, ".aws"), { recursive: true });
    await fs.writeFile(path.join(tmpRoot, ".aws", "credentials"), "aws_secret_access_key=TOPSECRET", "utf8");
    await fs.writeFile(path.join(tmpRoot, "visible.txt"), "hello world", "utf8");

    const findRes = (await file_operations.execute!(
      { action: "find", pattern: "credentials", path: tmpRoot },
      {} as never
    )) as { matches: string[] };
    expect(findRes.matches.every((m) => !m.includes(".aws/credentials"))).toBe(true);

    const grepRes = (await file_operations.execute!(
      { action: "grep", query: "TOPSECRET", path: tmpRoot },
      {} as never
    )) as { matches: string[] };
    expect(grepRes.matches.length).toBe(0);
  });

  it("resolves jump queries discovered in the workspace tree", async () => {
    await fs.mkdir(path.join(tmpRoot, "target-project", "src"), { recursive: true });

    const res = (await file_operations.execute!(
      { action: "jump", query: "target-project" },
      {} as never
    )) as { resolvedPath?: string; error?: string };
    expect(res.resolvedPath).toContain("target-project");
  });

  it("is scoped to the chat workspace, not the process cwd", async () => {
    // A relative path must resolve inside the workspace root, and a path that
    // escapes it must be rejected — proving the tool does not silently follow
    // process.cwd() (which is the Yggdrasil install tree in production).
    const writeRes = (await file_operations.execute!(
      { action: "write", path: "scoped.txt", content: "hello" },
      {} as never
    )) as { status?: string };
    expect(writeRes.status).toBe("success");
    expect(
      await fs.readFile(path.join(tmpRoot, "scoped.txt"), "utf8")
    ).toBe("hello");

    const escapeRes = (await file_operations.execute!(
      { action: "read", path: "../../etc/hosts" },
      {} as never
    )) as { error?: string };
    expect(escapeRes.error).toMatch(/Security Violation|escapes/i);
  });

  it("creates the workspace root on first use when it does not yet exist", async () => {
    // On a fresh install the dedicated workspace directory has never been
    // created; the tool must create it rather than failing with ENOENT from
    // realpath. Point the override at a not-yet-existing path.
    const freshRoot = path.join(tmpRoot, "not-yet", "workspace");
    process.env.YGGDRASIL_WORKSPACE_DIR = freshRoot;

    const res = (await file_operations.execute!(
      { action: "write", path: "hello.txt", content: "hi" },
      {} as never
    )) as { status?: string; error?: string };
    expect(res.error).toBeUndefined();
    expect(res.status).toBe("success");
    expect(await fs.readFile(path.join(freshRoot, "hello.txt"), "utf8")).toBe("hi");
  });
});
