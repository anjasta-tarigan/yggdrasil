import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { projectFileOpsStep } from "../project-harness-steps";

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
