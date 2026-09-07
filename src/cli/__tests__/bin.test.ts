import { describe, it, expect } from "vitest";
import { runCommand } from "../utils/exec";
import path from "node:path";
import { fileURLToPath } from "node:url";

describe("CLI Executable Wrapper", () => {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const binPath = path.resolve(__dirname, "../../../bin/yggdrasil.mjs");

  it("prints help when executed with --help", async () => {
    const res = await runCommand(process.execPath, [binPath, "--help"]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("Yggdrasil System CLI");
    expect(res.stdout).toContain("install");
    expect(res.stdout).toContain("update");
  });
});
