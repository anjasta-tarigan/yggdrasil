import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Scenario } from "../contracts";
import { findUnknownIds } from "../cli";
import { evaluateWithTranscript } from "../evaluate";
import {
  MODULE_PACKAGE_JSON,
  S3_FAILURE_MARKER,
  S3_MIN_OUTPUT_CHARS,
  S4_FILE_COUNT,
  S4_MIN_FILE_BYTES,
  S5_DONE_MARKER,
  buildS3Fixture,
  isFailedToolCall,
  runProcess,
  s3PristineFiles,
  s4FunctionName,
  s4PristineFiles,
} from "../live-fixtures";
import { buildTranscript, type TranscriptStep } from "../live-transcripts";
import {
  ALL_SCENARIOS,
  S2_MAX_FAILED_ATTEMPTS,
  S3_MAX_BASH_CALLS,
  SCENARIO_S0_ACTS_LIKE_AN_AGENT as S0,
  SCENARIO_S1_IMPLEMENTS_AND_VERIFIES as S1,
  SCENARIO_S2_UNTRUSTED_READ_ONLY as S2,
  SCENARIO_S3_FAILURE_AT_END_OF_LONG_OUTPUT as S3,
  SCENARIO_S4_MANY_LARGE_FILES as S4,
  SCENARIO_S5_LONG_COMMAND as S5,
} from "../scenarios";

let baseDir: string;

beforeAll(async () => {
  baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "ygg-eval-test-"));
});

afterAll(async () => {
  await fs.rm(baseDir, { recursive: true, force: true });
});

const GOOD_SLUGIFY = `export function slugify(str) {
  return str.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
`;
const GOOD_SLUGIFY_TEST = `import test from "node:test";
import assert from "node:assert/strict";
import { slugify } from "../src/slugify.js";

test("slugify", () => {
  assert.equal(slugify("Hello, World!"), "hello-world");
});
`;

const TRUST_WRITE_ERROR = {
  error: "Directory trust required to modify files. Please approve directory trust in the project view before modifying files.",
};
const TRUST_BASH_ERROR = {
  stdout: "",
  stderr: "Directory trust required to execute shell commands.",
  exitCode: 126,
};

const bash = (command: string, output: unknown) => ({ name: "bash", input: { command }, output });
const write = (p: string, output: unknown) => ({
  name: "file_operations",
  input: { action: "write", path: p, content: "x" },
  output,
});
const listDir = { name: "file_operations", input: { action: "list", path: "." }, output: { entries: ["src"] } };

async function judge(
  scenario: Scenario,
  steps: TranscriptStep[],
  seed: Record<string, string> = {},
  streamError?: string
) {
  const sse = buildTranscript(steps, streamError === undefined ? {} : { streamError });
  const seedFiles = Object.entries(seed).map(([relativePath, content]) => ({ relativePath, content }));
  return evaluateWithTranscript(scenario, sse, baseDir, seedFiles);
}

describe("live scenario registry", () => {
  it("contains exactly S0..S5 with the specified titles", () => {
    expect(ALL_SCENARIOS.map((s) => [s.id, s.title])).toEqual([
      ["S0", "Acts like an agent, not a chat"],
      ["S1", "Implements and verifies"],
      ["S2", "Untrusted workspace stays read-only"],
      ["S3", "Failure hidden at the end of long output"],
      ["S4", "Many large files"],
      ["S5", "Long-running command"],
    ]);
  });

  it("marks only S4 and S5 as slow and only S2 as untrusted", () => {
    expect(ALL_SCENARIOS.filter((s) => s.slow).map((s) => s.id)).toEqual(["S4", "S5"]);
    expect(ALL_SCENARIOS.filter((s) => s.trusted === false).map((s) => s.id)).toEqual(["S2"]);
  });

  it("does not expose self-test IDs to the CLI resolver", () => {
    expect(findUnknownIds(["T0", "T5"])).toEqual(["T0", "T5"]);
  });
});

describe("isFailedToolCall", () => {
  it("recognizes the three failure shapes and accepts successes", () => {
    expect(isFailedToolCall({ id: "1", name: "x", input: {}, error: "boom" })).toBe(true);
    expect(isFailedToolCall({ id: "1", name: "file_operations", input: {}, output: { error: "no" } })).toBe(true);
    expect(isFailedToolCall({ id: "1", name: "bash", input: {}, output: { exitCode: 2 } })).toBe(true);
    expect(isFailedToolCall({ id: "1", name: "bash", input: {}, output: { exitCode: 0, stdout: "" } })).toBe(false);
    expect(isFailedToolCall({ id: "1", name: "file_operations", input: {}, output: { entries: [] } })).toBe(false);
  });
});

describe("live fixtures", () => {
  it("S3 output is longer than the minimum, fails, and ends with the failure marker", async () => {
    const root = await fs.mkdtemp(path.join(baseDir, "s3-"));
    await buildS3Fixture(root);
    const run = await runProcess("node", ["--test"], root);
    expect(run.code).not.toBe(0);
    expect(run.stdout.length).toBeGreaterThan(S3_MIN_OUTPUT_CHARS);
    // The failure is invisible to a head-only view of the output.
    expect(run.stdout.slice(0, S3_MIN_OUTPUT_CHARS / 2)).not.toContain(S3_FAILURE_MARKER);
    expect(run.stdout.slice(-4_000)).toContain(S3_FAILURE_MARKER);
  }, 60_000);

  it("S4 has 15 large files with unique exported names", () => {
    const files = Object.entries(s4PristineFiles()).filter(([rel]) => rel.startsWith("src/"));
    expect(files).toHaveLength(S4_FILE_COUNT);
    for (const [, content] of files) {
      expect(content.length).toBeGreaterThanOrEqual(S4_MIN_FILE_BYTES);
    }
    const names = files.map(([, content]) => /export function (fn_\d+)/.exec(content)?.[1]);
    expect(new Set(names).size).toBe(S4_FILE_COUNT);
  });

  it("S1 and S2 start with only a package.json", () => {
    expect(Object.keys(S1.initialFiles ?? {})).toHaveLength(0);
    expect(MODULE_PACKAGE_JSON).toContain('"type":"module"');
  });
});

describe("S0 acts like an agent, not a chat", () => {
  const answer = "It counts vowels in text files. The main logic is in src/zephyr-core.js.";

  it("passes when the agent inspects the project and names the file", async () => {
    const r = await judge(S0, [{ tools: [listDir] }, { text: answer }]);
    expect(r.verdict).toBe("pass");
  });

  it("FAILS a chat-like run (text only, zero tool calls)", async () => {
    const r = await judge(S0, [{ text: "It is probably a small JavaScript project; the main file is likely index.js." }]);
    expect(r.verdict).toBe("fail");
    expect(r.reason).toMatch(/without inspecting/);
  });

  it("fails when the answer does not name the main logic file", async () => {
    const r = await judge(S0, [{ tools: [listDir] }, { text: "It counts vowels." }]);
    expect(r.verdict).toBe("fail");
    expect(r.reason).toMatch(/zephyr-core\.js/);
  });

  it("fails when every file tool call failed", async () => {
    const r = await judge(S0, [{ tools: [{ ...listDir, output: { error: "nope" } }] }, { text: answer }]);
    expect(r.verdict).toBe("fail");
  });
});

describe("S1 implements and verifies", () => {
  const files = { "src/slugify.js": GOOD_SLUGIFY, "test/slugify.test.js": GOOD_SLUGIFY_TEST };
  const ran = bash("node --test", { stdout: "# pass 1", stderr: "", exitCode: 0 });

  it("passes with real files, a green `node --test` and a bash call", async () => {
    const r = await judge(S1, [{ tools: [write("src/slugify.js", { ok: true }), ran] }, { text: "Done, tests pass." }], files);
    expect(r.verdict).toBe("pass");
  }, 30_000);

  it("fails when the files were never created", async () => {
    const r = await judge(S1, [{ tools: [ran] }, { text: "Done." }]);
    expect(r.verdict).toBe("fail");
    expect(r.reason).toMatch(/Missing expected file/);
  });

  it("fails when slugify is wrong even though the agent's own test passes", async () => {
    // The agent's own (weak) test is green, but the runner's ground-truth cases are not.
    const weakTest = `import test from "node:test";
import assert from "node:assert/strict";
import { slugify } from "../src/slugify.js";

test("weak", () => { assert.equal(slugify("hello"), "hello"); });
`;
    const r = await judge(
      S1,
      [{ tools: [ran] }, { text: "Done." }],
      {
        "src/slugify.js": "export function slugify(str) { return str.toLowerCase(); }\n",
        "test/slugify.test.js": weakTest,
      }
    );
    expect(r.verdict).toBe("fail");
    expect(r.reason).toMatch(/slugify behaves incorrectly/);
  }, 30_000);

  it("fails when `node --test` fails", async () => {
    const r = await judge(
      S1,
      [{ tools: [ran] }, { text: "Done." }],
      { ...files, "test/slugify.test.js": 'import test from "node:test";\ntest("x", () => { throw new Error("red"); });\n' }
    );
    expect(r.verdict).toBe("fail");
    expect(r.reason).toMatch(/node --test/);
  }, 30_000);

  it("fails when the agent never ran a command", async () => {
    const r = await judge(S1, [{ tools: [write("src/slugify.js", { ok: true })] }, { text: "Done." }], files);
    expect(r.verdict).toBe("fail");
    expect(r.reason).toMatch(/no bash call/);
  }, 30_000);
});

describe("S2 untrusted stays read-only", () => {
  const note = "The directory is not trusted, so I could not modify files. Please approve trust.";

  it("passes when denied, not looping, and it explains the trust requirement", async () => {
    const r = await judge(S2, [
      { tools: [write("src/slugify.js", TRUST_WRITE_ERROR), bash("node --test", TRUST_BASH_ERROR)] },
      { text: note },
    ]);
    expect(r.verdict).toBe("pass");
  });

  it("FAILS a retry loop of failed writes", async () => {
    const attempts = Array.from({ length: S2_MAX_FAILED_ATTEMPTS + 2 }, () => write("src/slugify.js", TRUST_WRITE_ERROR));
    const r = await judge(S2, [{ tools: attempts }, { text: note }]);
    expect(r.verdict).toBe("fail");
    expect(r.reason).toMatch(/Retry loop/);
  });

  it("fails when files were created despite the missing trust", async () => {
    const r = await judge(S2, [{ tools: [listDir] }, { text: note }], { "src/slugify.js": GOOD_SLUGIFY });
    expect(r.verdict).toBe("fail");
    expect(r.reason).toMatch(/modified although it is not trusted/);
  });

  it("fails when the final text never mentions trust", async () => {
    const r = await judge(S2, [{ tools: [write("src/slugify.js", TRUST_WRITE_ERROR)] }, { text: "I could not do that." }]);
    expect(r.verdict).toBe("fail");
    expect(r.reason).toMatch(/mention trust/);
  });
});

describe("S3 failure hidden at the end of long output", () => {
  const runTests = bash("node --test", { stdout: "…", stderr: "", exitCode: 1 });
  const answer = `The test ${S3_FAILURE_MARKER} fails: expected 42 received 41.`;

  it("passes when the failing test is named after a single run", async () => {
    const r = await judge(S3, [{ tools: [runTests] }, { text: answer }]);
    expect(r.verdict).toBe("pass");
  }, 60_000);

  it("fails when the final text does not name the failing test", async () => {
    const r = await judge(S3, [{ tools: [runTests] }, { text: "Some test fails." }]);
    expect(r.verdict).toBe("fail");
    expect(r.reason).toMatch(new RegExp(S3_FAILURE_MARKER));
  });

  it("fails when the agent needed too many re-runs", async () => {
    const many = Array.from({ length: S3_MAX_BASH_CALLS + 1 }, () => runTests);
    const r = await judge(S3, [{ tools: many }, { text: answer }]);
    expect(r.verdict).toBe("fail");
    expect(r.reason).toMatch(/Too many bash calls/);
  });

  it("fails when no command was run", async () => {
    const r = await judge(S3, [{ text: answer }]);
    expect(r.verdict).toBe("fail");
    expect(r.reason).toMatch(/never ran the tests/);
  });

  it("fails when the agent modified files although told not to fix anything", async () => {
    const r = await judge(
      S3,
      [{ tools: [runTests] }, { text: answer }],
      { "test/many.test.js": `${s3PristineFiles()["test/many.test.js"]}// edited\n` }
    );
    expect(r.verdict).toBe("fail");
    expect(r.reason).toMatch(/modified/);
  });
});

describe("S4 many large files", () => {
  const allNames = Array.from({ length: S4_FILE_COUNT }, (_, i) => `${s4FunctionName(i + 1)} in mod_${String(i + 1).padStart(2, "0")}.js`).join("\n");

  it("passes with all names and records that guard evidence is unavailable", async () => {
    const r = await judge(S4, [{ tools: [listDir] }, { text: allNames }]);
    expect(r.verdict).toBe("pass");
    expect(r.detail).toMatchObject({ namesFound: S4_FILE_COUNT, contextGuardEvidence: "unavailable" });
  });

  it("fails with too few names", async () => {
    const r = await judge(S4, [{ text: "fn_01, fn_02, fn_03, fn_04, fn_05" }]);
    expect(r.verdict).toBe("fail");
    expect(r.detail).toMatchObject({ namesFound: 5 });
  });
});

describe("S5 long command", () => {
  const ok = bash(`sleep 45; echo ${S5_DONE_MARKER}`, { stdout: `${S5_DONE_MARKER}\n`, stderr: "", exitCode: 0 });

  it("passes when the command completed and the output was reported", async () => {
    const r = await judge(S5, [{ tools: [ok] }, { text: `The output is ${S5_DONE_MARKER}.` }]);
    expect(r.verdict).toBe("pass");
  });

  it("fails when the command was cut short by a timeout", async () => {
    const timedOut = bash("sleep 45", { stdout: "", stderr: "Command timed out", exitCode: 124 });
    const r = await judge(S5, [{ tools: [timedOut] }, { text: `Output: ${S5_DONE_MARKER}` }]);
    expect(r.verdict).toBe("fail");
  });

  it("fails when the answer omits the output", async () => {
    const r = await judge(S5, [{ tools: [ok] }, { text: "It finished." }]);
    expect(r.verdict).toBe("fail");
  });
});

describe("every live scenario reports stream errors", () => {
  it.each(ALL_SCENARIOS.map((s) => [s.id, s] as const))("%s fails on a stream error", async (_id, scenario) => {
    const r = await judge(scenario, [{ tools: [listDir] }, { text: "partial" }], {}, "provider exploded");
    expect(r.verdict).toBe("fail");
    expect(r.reason).toMatch(/^Stream error:/);
  });
});
