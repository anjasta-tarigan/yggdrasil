import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { projectFileOpsStep } from "../project-harness-steps";
import { runProjectProcess } from "@/lib/project-harness-tools";

/**
 * Unit tests for the durable project-harness step implementations.
 *
 * These steps carry their own copy of the file_operations logic (the step
 * bundle cannot import `project-harness-tools.ts`), so each behavioural fix in
 * the fallback tool must be mirrored here and proven independently.
 */
describe("projectFileOpsStep", () => {
  let testDir: string;
  let canonicalRoot: string;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), "ygg-steps-test-"));
    canonicalRoot = await fs.realpath(testDir);
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it("treats $& and other replacement patterns in newString as literal text", async () => {
    // A string replacement passed to String.replace lets `$&`, `$$`, `` $` ``
    // and `$'` act as substitution patterns. The durable step must use a
    // replacer function so code written into a file is byte-exact.
    await fs.writeFile(
      path.join(canonicalRoot, "subst.ts"),
      "const re = PLACEHOLDER;\n"
    );

    const res = await projectFileOpsStep(
      {
        action: "edit",
        path: "subst.ts",
        oldString: "PLACEHOLDER",
        newString: "/a$&b/ && cost$$",
      },
      { context: { canonicalRoot, trusted: true } }
    );
    expect(res.status).toBe("success");

    const written = await fs.readFile(path.join(canonicalRoot, "subst.ts"), "utf8");
    expect(written).toContain("const re = /a$&b/ && cost$$;");
  });
});

describe("project process runner", () => {
  it("times out and does not expose server environment secrets", async () => {
    process.env.PROJECT_STEP_SECRET = "must-not-leak";
    try {
      const result = await runProjectProcess(
        process.execPath,
        ["-e", "process.stdout.write(process.env.PROJECT_STEP_SECRET ?? 'unset'); setTimeout(() => {}, 2000)"],
        process.cwd(),
        { timeoutMs: 500 }
      );

      expect(result.code).toBe(124);
      expect(result.stderr).toContain("timed out");
      expect(result.stdout).toContain("unset");
    } finally {
      delete process.env.PROJECT_STEP_SECRET;
    }
  });

  it("bounds output and marks truncation", async () => {
    const result = await runProjectProcess(
      process.execPath,
      ["-e", "process.stdout.write('x'.repeat(10000))"],
      process.cwd(),
      { maxOutputChars: 50 }
    );

    expect(result.stdout.length).toBeLessThan(150);
    expect(result.stdout).toContain("output truncated");
  });
});
