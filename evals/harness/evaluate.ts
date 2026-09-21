/**
 * Offline evaluation: runs a scenario's judge against a hand-written (or
 * captured) SSE transcript, with the ground-truth files pre-seeded on disk.
 *
 * This is the unit-test entry point. The live runner (see `run.ts`) captures
 * a real SSE stream, writes the fixture, and calls the same judge — so the
 * pass/fail logic is identical in both paths.
 */
import * as fs from "node:fs/promises";
import * as pathMod from "node:path";
import type { Scenario, EvaluationResult, GroundTruthFile } from "./contracts";
import { parseUiMessageStream } from "./parse-stream";
import { computeMetrics } from "./metrics";

/**
 * Prepares a fresh fixture directory for a scenario: creates the directory
 * (clearing any prior contents) and seeds it with initial files.
 *
 * If the scenario provides `buildFixture`, that method is called to populate
 * the directory. Otherwise, `initialFiles` are written directly.
 *
 * Returns the absolute path to the fixture root.
 */
export async function prepareFixture(
  scenario: Scenario,
  baseDir: string
): Promise<string> {
  const fixtureRoot = pathMod.resolve(baseDir, scenario.id);
  // Fresh directory per scenario.
  await fs.rm(fixtureRoot, { recursive: true, force: true }).catch((err) => {
    console.error("[eval-harness] prepareFixture: failed to clear stale fixture:", err instanceof Error ? err.message : String(err));
  });
  await fs.mkdir(fixtureRoot, { recursive: true });
  if (scenario.buildFixture) {
    await scenario.buildFixture(fixtureRoot);
  } else if (scenario.initialFiles) {
    for (const file of scenario.initialFiles) {
      const abs = pathMod.join(fixtureRoot, file.relativePath);
      await fs.mkdir(pathMod.dirname(abs), { recursive: true });
      await fs.writeFile(abs, file.content, "utf8");
    }
  }
  return fixtureRoot;
}

/**
 * Evaluates a scenario against its attached transcript (offline mode).
 *
 * The transcript is parsed into chunks → metrics, then the judge runs with
 * the on-disk fixture (pre-seeded with `initialFiles`, but NOT with the
 * expected files — those are the agent's job to create).
 */
export async function evaluateScenario(
  scenario: Scenario,
  baseDir: string
): Promise<EvaluationResult> {
  const fixtureRoot = await prepareFixture(scenario, baseDir);
  const chunks = scenario.transcript
    ? parseUiMessageStream(scenario.transcript)
    : [];
  const metrics = chunks.length > 0 ? computeMetrics(chunks) : null;

  const result = await scenario.judge({
    metrics,
    fixtureRoot,
    expected: scenario.expectedFiles ?? [],
  });

  return {
    ...result,
    metrics: result.metrics ?? metrics,
  };
}

/**
 * Evaluates a scenario against an arbitrary SSE transcript (e.g. one captured
 * from a live server). The fixture is pre-seeded with `initialFiles` only.

 * Pass `seedFiles` to simulate the agent's on-disk output (e.g. a written
 * marker file) so the judge can verify ground truth.
 */
export async function evaluateWithTranscript(
  scenario: Scenario,
  sseText: string,
  baseDir: string,
  seedFiles?: GroundTruthFile[]
): Promise<EvaluationResult> {
  const fixtureRoot = await prepareFixture(scenario, baseDir);
  if (seedFiles) {
    for (const file of seedFiles) {
      const abs = pathMod.join(fixtureRoot, file.relativePath);
      await fs.mkdir(pathMod.dirname(abs), { recursive: true });
      await fs.writeFile(abs, file.content, "utf8");
    }
  }
  const chunks = parseUiMessageStream(sseText);
  const metrics = computeMetrics(chunks);
  const result = await scenario.judge({
    metrics,
    fixtureRoot,
    expected: scenario.expectedFiles ?? [],
  });
  return result;
}

/** Cleans up all fixture directories under `baseDir`. */
export async function cleanupFixtures(baseDir: string): Promise<void> {
  await fs.rm(baseDir, { recursive: true, force: true }).catch((err) => {
    console.error("[eval-harness] cleanupFixtures: failed to remove fixture base:", err instanceof Error ? err.message : String(err));
  });
}

// Re-export for convenience.
export { parseUiMessageStream, computeMetrics };
export type { EvaluationResult, RunMetrics } from "./contracts";
