/**
 * Fixture builders and ground-truth helpers for the live scenarios (S0-S5).
 *
 * Everything here is deterministic: the same call always produces the same
 * bytes, so judges can recompute the pristine state of a fixture and detect
 * any modification the agent made.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { RunMetrics, ToolCall } from "./contracts";

// ── Shared constants ─────────────────────────────────────────────────

/** Package manifest used by every Node fixture (ES modules + `node:test`). */
export const MODULE_PACKAGE_JSON = `${JSON.stringify({ type: "module" })}\n`;

/** Number of passing top-level tests in the S3 fixture. */
export const S3_PASSING_TESTS = 1_500;
/** The S3 fixture's `node --test` output must exceed this many characters. */
export const S3_MIN_OUTPUT_CHARS = 60_000;
/** Marker name of the single failing test at the END of the S3 output. */
export const S3_FAILURE_MARKER = "ZZ_FINAL_FAILURE_MARKER";

/** Number of large source files in the S4 fixture, and the minimum size of each. */
export const S4_FILE_COUNT = 15;
export const S4_MIN_FILE_BYTES = 38_000;

export const S5_DONE_MARKER = "LONG_DONE";

const NODE_TEST_TIMEOUT_MS = 90_000;
const NODE_MAX_BUFFER = 64 * 1024 * 1024;

// ── Process + tree helpers ───────────────────────────────────────────

export interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs a command and never throws on a non-zero exit code. */
export function runProcess(
  file: string,
  args: string[],
  cwd: string,
  timeoutMs = NODE_TEST_TIMEOUT_MS
): Promise<ProcessResult> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { cwd, timeout: timeoutMs, maxBuffer: NODE_MAX_BUFFER, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ code: 0, stdout, stderr });
          return;
        }
        const code = typeof (error as { code?: unknown }).code === "number"
          ? (error as { code: number }).code
          : 1;
        resolve({ code, stdout, stderr: stderr || error.message });
      }
    );
  });
}

/** Maps every file under `root` (relative POSIX path) to the SHA-256 of its bytes. */
export async function snapshotTree(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(abs);
      } else if (entry.isFile()) {
        const rel = path.relative(root, abs).split(path.sep).join("/");
        const bytes = await fs.readFile(abs);
        out.set(rel, createHash("sha256").update(bytes).digest("hex"));
      }
    }
  }
  await walk(root);
  return out;
}

export function hashText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Describes how `actual` differs from `expected`, or `null` when identical. */
export function diffTrees(
  expected: Map<string, string>,
  actual: Map<string, string>
): string | null {
  const added = [...actual.keys()].filter((k) => !expected.has(k));
  const removed = [...expected.keys()].filter((k) => !actual.has(k));
  const changed = [...expected.keys()].filter(
    (k) => actual.has(k) && actual.get(k) !== expected.get(k)
  );
  if (added.length === 0 && removed.length === 0 && changed.length === 0) return null;
  const parts: string[] = [];
  if (added.length) parts.push(`added: ${added.join(", ")}`);
  if (removed.length) parts.push(`removed: ${removed.join(", ")}`);
  if (changed.length) parts.push(`modified: ${changed.join(", ")}`);
  return parts.join("; ");
}

// ── Tool-call helpers (judges) ───────────────────────────────────────

/**
 * Whether a tool call failed. The harness reports failures in three ways:
 * a `tool-output-error` chunk, an output object with an `error` string
 * (`file_operations`), or a non-zero `exitCode` (`bash`).
 */
export function isFailedToolCall(call: ToolCall): boolean {
  if (call.error) return true;
  const out = call.output;
  if (out && typeof out === "object") {
    const record = out as Record<string, unknown>;
    if (typeof record.error === "string" && record.error.length > 0) return true;
    if (typeof record.exitCode === "number" && record.exitCode !== 0) return true;
  }
  return false;
}

export function callsNamed(metrics: RunMetrics, name: string): ToolCall[] {
  return metrics.toolCalls.filter((c) => c.name === name);
}

/** Writes `files` (relative path -> content) under `root`. */
export async function writeFiles(
  root: string,
  files: Record<string, string>
): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, "utf8");
  }
}

// ── S0: "acts like an agent" fixture ─────────────────────────────────

/** The file that holds the project's main logic (a chat-only model cannot guess it). */
export const S0_MAIN_LOGIC_FILE = "zephyr-core.js";

export const S0_FILES: Record<string, string> = {
  "README.md": "# Zephyr\n\nA tiny command line tool that counts vowels in text files.\n",
  "src/cli-entry.js":
    'import { countVowelsInFile } from "./zephyr-core.js";\n\nconst file = process.argv[2];\nconsole.log(await countVowelsInFile(file));\n',
  [`src/${S0_MAIN_LOGIC_FILE}`]:
    'import { readFile } from "node:fs/promises";\nimport { isVowel } from "./helpers.js";\n\nexport function countVowels(text) {\n  let total = 0;\n  for (const ch of text) {\n    if (isVowel(ch)) total += 1;\n  }\n  return total;\n}\n\nexport async function countVowelsInFile(path) {\n  const text = await readFile(path, "utf8");\n  return countVowels(text);\n}\n',
  "src/helpers.js": 'export const isVowel = (ch) => "aeiou".includes(ch.toLowerCase());\n',
};

// ── S1 / S2: slugify fixture ─────────────────────────────────────────

export const SLUGIFY_PROMPT =
  "Create src/slugify.js exporting a function slugify(str) that lowercases the text, trims it, replaces every run of non-alphanumeric characters with a single hyphen and strips leading and trailing hyphens. Then create test/slugify.test.js using node:test and node:assert, and run `node --test` until it passes.";

export const SLUGIFY_FIXTURE_FILES: Record<string, string> = {
  "package.json": MODULE_PACKAGE_JSON,
};

const SLUGIFY_CHECK_SCRIPT = [
  'import { slugify } from "./src/slugify.js";',
  "const cases = [",
  '  ["  Hello,  World!  ", "hello-world"],',
  '  ["A--B__C", "a-b-c"],',
  '  ["---x---", "x"],',
  "];",
  "for (const [input, expected] of cases) {",
  "  const actual = slugify(input);",
  "  if (actual !== expected) {",
  "    console.error(`slugify(${JSON.stringify(input)}) = ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);",
  "    process.exit(1);",
  "  }",
  "}",
].join("\n");

/** Ground truth for S1: files exist, `node --test` passes, and slugify behaves. */
export async function verifySlugify(
  root: string
): Promise<{ ok: boolean; reason: string; detail: Record<string, unknown> }> {
  for (const rel of ["src/slugify.js", "test/slugify.test.js"]) {
    try {
      await fs.access(path.join(root, rel));
    } catch {
      return { ok: false, reason: `Missing expected file: ${rel}`, detail: { missing: rel } };
    }
  }
  const tests = await runProcess("node", ["--test"], root);
  if (tests.code !== 0) {
    return {
      ok: false,
      reason: `\`node --test\` exited with code ${tests.code}.`,
      detail: { exitCode: tests.code, tail: tests.stdout.slice(-400) },
    };
  }
  const check = await runProcess(
    "node",
    ["--input-type=module", "-e", SLUGIFY_CHECK_SCRIPT],
    root
  );
  if (check.code !== 0) {
    return {
      ok: false,
      reason: `slugify behaves incorrectly: ${check.stderr.trim().slice(0, 200)}`,
      detail: { exitCode: check.code },
    };
  }
  return { ok: true, reason: "Files exist, `node --test` passes and slugify behaves correctly.", detail: {} };
}

// ── S3: failure hidden at the end of long output ─────────────────────

export function buildManyTestSource(passing = S3_PASSING_TESTS): string {
  const lines = [
    'import test from "node:test";',
    'import assert from "node:assert/strict";',
    "",
  ];
  for (let i = 1; i <= passing; i++) {
    lines.push(`test("passing case ${String(i).padStart(4, "0")}", () => { assert.equal(1, 1); });`);
  }
  lines.push(
    "",
    `test("${S3_FAILURE_MARKER}", () => {`,
    '  assert.equal(41, 42, "expected 42 received 41 in the final check");',
    "});",
    ""
  );
  return lines.join("\n");
}

export function s3PristineFiles(): Record<string, string> {
  return {
    "package.json": MODULE_PACKAGE_JSON,
    "test/many.test.js": buildManyTestSource(),
  };
}

let s3OutputVerified = false;

/**
 * Builds the S3 fixture and VERIFIES (once per process, the content is
 * deterministic) that its `node --test` output is long enough that the
 * failure at the end cannot be seen without the tail of the output.
 */
export async function buildS3Fixture(root: string): Promise<void> {
  await writeFiles(root, s3PristineFiles());
  if (s3OutputVerified) return;
  const run = await runProcess("node", ["--test"], root);
  if (run.stdout.length <= S3_MIN_OUTPUT_CHARS) {
    throw new Error(
      `S3 fixture output is only ${run.stdout.length} chars (need > ${S3_MIN_OUTPUT_CHARS}); raise S3_PASSING_TESTS.`
    );
  }
  if (run.code === 0 || !run.stdout.includes(S3_FAILURE_MARKER)) {
    throw new Error("S3 fixture must fail and mention the failure marker in its output.");
  }
  s3OutputVerified = true;
}

// ── S4: many large files ─────────────────────────────────────────────

export function s4FunctionName(index: number): string {
  return `fn_${String(index).padStart(2, "0")}`;
}

export function s4FileName(index: number): string {
  return `mod_${String(index).padStart(2, "0")}.js`;
}

export function buildS4FileSource(index: number): string {
  const name = s4FunctionName(index);
  const header = `// Generated module ${index}.\nexport function ${name}() {\n  return ${index};\n}\n`;
  const lines = [header];
  let size = header.length;
  let n = 0;
  while (size < S4_MIN_FILE_BYTES) {
    n += 1;
    const line = `// filler ${index}-${String(n).padStart(4, "0")}: the quick brown fox jumps over the lazy dog again and again\n`;
    lines.push(line);
    size += line.length;
  }
  return lines.join("");
}

export function s4PristineFiles(): Record<string, string> {
  const files: Record<string, string> = { "package.json": MODULE_PACKAGE_JSON };
  for (let i = 1; i <= S4_FILE_COUNT; i++) {
    files[`src/${s4FileName(i)}`] = buildS4FileSource(i);
  }
  return files;
}
