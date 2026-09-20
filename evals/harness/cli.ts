#!/usr/bin/env node
/**
 * CLI entry point for the Yggdrasil agentic eval harness.
 *
 * Usage:
 *   pnpm eval:harness --base-url http://localhost:3000 --model server::gpt-4o
 *   pnpm eval:harness --base-url http://localhost:3000 --only S0,S4
 *   pnpm eval:harness --base-url http://localhost:3000 --full --json --out eval-results/
 *   pnpm eval:harness --cleanup-stale
 *   pnpm eval:harness --replay eval-results/S0-sse.txt --base-url http://localhost:3000
 *
 * Flags:
 *   --base-url <url>     Server base URL (must be loopback). Default: http://127.0.0.1:3000
 *   --model <ref>        Model ref (e.g. "server::gpt-4o" or bare "gpt-4o").
 *   --effort <level>     Reasoning effort: low | medium | high.
 *   --only <ids>         Comma-separated scenario IDs to run (e.g. "S0,S4").
 *   --full               Run all scenarios (default when --only is absent).
 *   --out <dir>          Write JSON results to <dir>/<scenario-id>.json.
 *   --json               Print results as JSON to stdout.
 *   --cleanup-stale      Remove stale fixture directories under os.tmpdir().
 *   --replay <file>      Replay a captured SSE transcript file instead of hitting the server.
 *   --help               Show this help message.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { parseArgs } from "node:util";
import type { EvaluationResult } from "./contracts";
import { ALL_SCENARIOS } from "./scenarios";
import { FetchTransport, runScenarioLive, assertLoopbackUrl, type HarnessTransport } from "./run";
import { prepareFixture, cleanupFixtures } from "./evaluate";
import { parseUiMessageStream } from "./parse-stream";
import { computeMetrics } from "./metrics";

const HELP_TEXT = `Yggdrasil Agentic Eval Harness

Usage:
  pnpm eval:harness [options]

Options:
  --base-url <url>     Server base URL (must be loopback). Default: http://127.0.0.1:3000
  --model <ref>        Model ref (e.g. "server::gpt-4o" or bare "gpt-4o").
  --effort <level>     Reasoning effort: low | medium | high.
  --only <ids>         Comma-separated scenario IDs to run (e.g. "S0,S4").
  --full               Run all scenarios (default when --only is absent).
  --out <dir>          Write JSON results to <dir>/<scenario-id>.json.
  --json               Print results as JSON to stdout.
  --cleanup-stale      Remove stale fixture directories under os.tmpdir().
  --replay <file>      Replay a captured SSE transcript file instead of the server.
  --help               Show this help message.

Examples:
  pnpm eval:harness --base-url http://localhost:3000 --model server::gpt-4o --full
  pnpm eval:harness --base-url http://localhost:3000 --only S0,S4 --json --out eval-results/
  pnpm eval:harness --cleanup-stale
  pnpm eval:harness --replay eval-results/S0-sse.txt --base-url http://localhost:3000
`;

interface CliOptions {
  baseUrl: string;
  model: string | null;
  effort: string | null;
  only: string[];
  full: boolean;
  out: string | null;
  json: boolean;
  cleanupStale: boolean;
  replay: string | null;
  help: boolean;
}

function parseCliArgs(argv: string[]): CliOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      "base-url": { type: "string", default: "http://127.0.0.1:3000" },
      model: { type: "string" },
      effort: { type: "string" },
      only: { type: "string" },
      full: { type: "boolean", default: false },
      out: { type: "string" },
      json: { type: "boolean", default: false },
      "cleanup-stale": { type: "boolean", default: false },
      replay: { type: "string" },
      help: { type: "boolean", default: false },
    },
    allowPositionals: true,
    strict: false,
  });

  return {
    baseUrl: (values["base-url"] as string) ?? "http://127.0.0.1:3000",
    model: (values.model as string | undefined) ?? null,
    effort: (values.effort as string | undefined) ?? null,
    only: values.only ? (values.only as string).split(",").map((s) => s.trim()) : [],
    full: values.full === true,
    out: (values.out as string | undefined) ?? null,
    json: values.json === true,
    cleanupStale: values["cleanup-stale"] === true,
    replay: (values.replay as string | undefined) ?? null,
    help: values.help === true,
  };
}

/**
 * Validates the --effort value against the accepted enum.
 */
function validateEffort(effort: string | null): "low" | "medium" | "high" | undefined {
  if (!effort) return undefined;
  const valid = ["low", "medium", "high"] as const;
  if (!valid.includes(effort as (typeof valid)[number])) {
    throw new Error(
      `Invalid --effort "${effort}". Must be one of: ${valid.join(", ")}.`
    );
  }
  return effort as "low" | "medium" | "high";
}

/**
 * Filters scenarios by the --only IDs. If no IDs are given, returns all.
 */
function filterScenarios(scenarios: typeof ALL_SCENARIOS, only: string[]): typeof ALL_SCENARIOS {
  if (only.length === 0) return scenarios;
  const set = new Set(only);
  return scenarios.filter((s) => set.has(s.id));
}

/**
 * Selects scenarios based on --only and --full flags.
 */
function selectScenarios(opts: CliOptions): typeof ALL_SCENARIOS {
  if (opts.only.length > 0) {
    return filterScenarios(ALL_SCENARIOS, opts.only);
  }
  if (opts.full) {
    return ALL_SCENARIOS;
  }
  // Default: run all scenarios.
  return ALL_SCENARIOS;
}

/**
 * Cleans up stale fixture directories under os.tmpdir() that match the
 * ygg-eval-* pattern and are older than 1 hour.
 */
async function cleanupStaleFixtures(): Promise<number> {
  const tmpDir = os.tmpdir();
  const cutoff = Date.now() - 60 * 60 * 1000; // 1 hour ago
  let removed = 0;

  const entries = await fs.readdir(tmpDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!entry.name.startsWith("ygg-eval-")) continue;
    const dirPath = path.join(tmpDir, entry.name);
    try {
      const stat = await fs.stat(dirPath);
      if (stat.mtimeMs < cutoff) {
        await fs.rm(dirPath, { recursive: true, force: true });
        removed++;
      }
    } catch {
      // Directory may have been removed concurrently; skip.
    }
  }

  return removed;
}

/**
 * Writes a single evaluation result to a JSON file in the output directory.
 */
async function writeResult(outDir: string, result: EvaluationResult): Promise<void> {
  await fs.mkdir(outDir, { recursive: true });
  const filePath = path.join(outDir, `${result.scenarioId}.json`);
  await fs.writeFile(filePath, JSON.stringify(result, null, 2), "utf8");
}

/**
 * Runs a single scenario live against the server and returns the result.
 * Also writes the raw SSE transcript to the output directory if provided.
 */
async function runScenarioLiveWithOutput(
  scenario: (typeof ALL_SCENARIOS)[number],
  transport: HarnessTransport,
  opts: CliOptions,
  baseDir: string
): Promise<EvaluationResult> {
  const effort = validateEffort(opts.effort);
  const { result, sseText } = await runScenarioLive(
    scenario,
    transport,
    {
      baseDir,
      model: opts.model ?? undefined,
      effort,
    }
  );

  if (opts.out) {
    await writeResult(opts.out, result);
    // Also save the raw SSE transcript for debugging/replay.
    const ssePath = path.join(opts.out, `${scenario.id}-sse.txt`);
    await fs.mkdir(opts.out, { recursive: true });
    await fs.writeFile(ssePath, sseText, "utf8");
  }

  return result;
}

/**
 * Replays a captured SSE transcript against a scenario's judge (offline mode).
 * The fixture is prepared on disk and the transcript is parsed + judged.
 */
async function replayScenario(
  scenario: (typeof ALL_SCENARIOS)[number],
  sseText: string,
  opts: CliOptions,
  baseDir: string
): Promise<EvaluationResult> {
  const fixtureRoot = await prepareFixture(scenario, baseDir);
  const chunks = parseUiMessageStream(sseText);
  const metrics = computeMetrics(chunks);
  const judgeResult = await scenario.judge({
    metrics,
    fixtureRoot,
    expected: scenario.expectedFiles ?? [],
  });

  const result: EvaluationResult = {
    ...judgeResult,
    metrics: judgeResult.metrics ?? metrics,
  };

  if (opts.out) {
    await writeResult(opts.out, result);
  }

  return result;
}

/**
 * The main entry point. Returns the exit code.
 */
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const opts = parseCliArgs(argv);

  if (opts.help) {
    process.stdout.write(HELP_TEXT);
    return 0;
  }

  if (opts.cleanupStale) {
    const removed = await cleanupStaleFixtures();
    process.stdout.write(`Cleaned up ${removed} stale fixture director${removed === 1 ? "y" : "ies"}.\n`);
    return 0;
  }

  // Validate the base URL is loopback before connecting.
  assertLoopbackUrl(opts.baseUrl);

  const scenarios = selectScenarios(opts);
  if (scenarios.length === 0) {
    process.stderr.write("No scenarios matched the --only filter. Use --help for usage.\n");
    return 1;
  }

  const baseDir = path.join(os.tmpdir(), `ygg-eval-${process.pid}-${Date.now()}`);

  let results: EvaluationResult[];

  if (opts.replay) {
    // Replay mode: read the SSE transcript from a file and judge it.
    const sseText = await fs.readFile(opts.replay, "utf8");
    // Replay applies to the first scenario in the selection (or all if --full).
    results = [];
    for (const scenario of scenarios) {
      const result = await replayScenario(scenario, sseText, opts, baseDir);
      results.push(result);
    }
  } else {
    // Live mode: connect to the server and run scenarios.
    const transport = new FetchTransport(opts.baseUrl);
    results = [];
    for (const scenario of scenarios) {
      try {
        const result = await runScenarioLiveWithOutput(scenario, transport, opts, baseDir);
        results.push(result);
      } catch (err) {
        results.push({
          scenarioId: scenario.id,
          verdict: "error",
          reason: `Runner failed: ${err instanceof Error ? err.message : String(err)}`,
          metrics: null,
          detail: {},
        });
      }
    }
  }

  // Cleanup fixture directory.
  await cleanupFixtures(baseDir).catch(() => {});

  // Output results.
  if (opts.json) {
    process.stdout.write(JSON.stringify(results, null, 2) + "\n");
  } else {
    for (const result of results) {
      const status = result.verdict === "pass" ? "✓ PASS" : result.verdict === "fail" ? "✗ FAIL" : "✗ ERROR";
      process.stdout.write(`${status} ${result.scenarioId}: ${result.reason}\n`);
    }
  }

  // Exit non-zero if any scenario failed or errored.
  const hasFailures = results.some((r) => r.verdict !== "pass");
  return hasFailures ? 1 : 0;
}

// Run when invoked directly.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }
  );
}
