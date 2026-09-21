import { describe, it, expect } from "vitest";
import { ALL_SCENARIOS } from "../scenarios";
import { validateEffort, filterScenarios, findUnknownIds, main } from "../cli";

describe("validateEffort", () => {
  it.each(["xhigh", "high", "medium", "low", "none", "auto"])(
    "accepts valid effort: %s",
    (effort) => {
      expect(validateEffort(effort)).toBe(effort);
    },
  );

  it("returns undefined when no effort is given", () => {
    expect(validateEffort(null)).toBeUndefined();
  });
  it.each(["xhighest", "HIGH", "medium ", "fast", "xhigh "])(
    "rejects invalid effort: %s",
    (effort) => {
      expect(() => validateEffort(effort)).toThrow(/Invalid --effort/);
    },
  );
});

describe("filterScenarios", () => {
  it("returns all scenarios when no IDs are given", () => {
    const result = filterScenarios(ALL_SCENARIOS, []);
    expect(result).toBe(ALL_SCENARIOS);
  });

  it("filters by exact ID", () => {
    const result = filterScenarios(ALL_SCENARIOS, ["S0"]);
    expect(result.map((s) => s.id)).toEqual(["S0"]);
  });

  it("filters case-insensitively", () => {
    const result = filterScenarios(ALL_SCENARIOS, ["s0", "S1", "s2"]);
    expect(result.map((s) => s.id)).toEqual(["S0", "S1", "S2"]);
  });

  it("returns empty array when no IDs match", () => {
    const result = filterScenarios(ALL_SCENARIOS, ["ZZZ"]);
    expect(result).toHaveLength(0);
  });
});

describe("findUnknownIds", () => {
  it("returns empty array when no IDs are given", () => {
    expect(findUnknownIds([])).toEqual([]);
  });

  it("returns empty array when all IDs are known", () => {
    expect(findUnknownIds(["S0", "S1", "S5"])).toEqual([]);
  });

  it("returns unknown IDs", () => {
    expect(findUnknownIds(["S0", "XYZ", "ABC"])).toEqual(["XYZ", "ABC"]);
  });

  it("is case-insensitive", () => {
    expect(findUnknownIds(["s0", "xyz"])).toEqual(["xyz"]);
  });
});

describe("main exit codes", () => {
  it("returns exit code 2 when --only contains unknown IDs", async () => {
    const code = await main(["--only", "XYZ", "--model", "test-model"]);
    expect(code).toBe(2);
  });

  it("returns exit code 0 for --help", async () => {
    const code = await main(["--help"]);
    expect(code).toBe(0);
  });
});

describe("main argument handling", () => {
  it("prints usage for a leading `--` separator (pnpm forwards it) and exits 0", async () => {
    const writes: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      expect(await main(["--", "--help"])).toBe(0);
    } finally {
      process.stdout.write = original;
    }
    expect(writes.join("")).toContain("pnpm eval:harness");
  });

  it("exits 2 when --model is missing for a live run", async () => {
    expect(await main(["--only", "S0"])).toBe(2);
  });

  it("exits 2 for an invalid --effort value, before any HTTP", async () => {
    expect(await main(["--model", "m", "--effort", "ultra"])).toBe(2);
  });
});
