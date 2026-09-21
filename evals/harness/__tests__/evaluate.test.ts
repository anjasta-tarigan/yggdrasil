import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import {
  SCENARIO_T0_AGENTIC_SUCCESS,
  SCENARIO_T1_CHAT_FAILURE,
  SCENARIO_T4_MULTI_STEP,
  SCENARIO_T2_STREAM_ERROR,
  SCENARIO_T3_RETRY_LOOP,
  SCENARIO_T5_WRONG_CONTENT,
} from "../selftest-scenarios";
import { ALL_SCENARIOS } from "../scenarios";
import { evaluateScenario, evaluateWithTranscript, prepareFixture, cleanupFixtures } from "../evaluate";

const baseDir = path.join(os.tmpdir(), `evals-harness-${process.pid}-${Date.now()}`);

afterEach(async () => {
  await cleanupFixtures(baseDir);
});

describe("prepareFixture", () => {
  it("writes initialFiles into the fixture directory", async () => {
    const root = await prepareFixture(SCENARIO_T4_MULTI_STEP, baseDir);
    const note = await fs.readFile(path.join(root, "note.txt"), "utf8");
    expect(note).toBe("ready");
  });

  it("does not pre-create expected files", async () => {
    const root = await prepareFixture(SCENARIO_T0_AGENTIC_SUCCESS, baseDir);
    // marker.txt is an *expected* file, not an *initial* file.
    await expect(fs.readFile(path.join(root, "marker.txt"), "utf8")).rejects.toThrow();
  });
});

describe("Scenario judges (offline, transcript-driven)", () => {
  it("T0 agentic-success: file written on disk → pass", async () => {
    // Simulate the agent having written the file (ground truth on disk).
    const root = await prepareFixture(SCENARIO_T0_AGENTIC_SUCCESS, baseDir);
    await fs.writeFile(path.join(root, "marker.txt"), "hello", "utf8");
    const result = await SCENARIO_T0_AGENTIC_SUCCESS.judge({
      metrics: null,
      fixtureRoot: root,
      expected: SCENARIO_T0_AGENTIC_SUCCESS.expectedFiles ?? [],
    });
    expect(result.verdict).toBe("pass");
  });

  it("T0 agentic-success: file missing on disk → fail (ground truth wins)", async () => {
    const root = await prepareFixture(SCENARIO_T0_AGENTIC_SUCCESS, baseDir);
    const result = await SCENARIO_T0_AGENTIC_SUCCESS.judge({
      metrics: null,
      fixtureRoot: root,
      expected: SCENARIO_T0_AGENTIC_SUCCESS.expectedFiles ?? [],
    });
    expect(result.verdict).toBe("fail");
    expect(result.reason).toContain("marker.txt");
  });

  it("T0 agentic-success: file present with wrong content → fail", async () => {
    const root = await prepareFixture(SCENARIO_T0_AGENTIC_SUCCESS, baseDir);
    await fs.writeFile(path.join(root, "marker.txt"), "world", "utf8");
    const result = await SCENARIO_T0_AGENTIC_SUCCESS.judge({
      metrics: null,
      fixtureRoot: root,
      expected: SCENARIO_T0_AGENTIC_SUCCESS.expectedFiles ?? [],
    });
    expect(result.verdict).toBe("fail");
    expect(result.reason).toContain("mismatch");
  });

  it("T1 chat-failure: no file, no tool calls → fail", async () => {
    const root = await prepareFixture(SCENARIO_T1_CHAT_FAILURE, baseDir);
    const result = await SCENARIO_T1_CHAT_FAILURE.judge({
      metrics: {
        steps: 1,
        toolCalls: [],
        erroredToolCalls: [],
        hadError: false,
        errorText: null,
        finishReason: "stop",
        totalText: "I cannot write files.",
        usage: null,
        reasoningEffort: "low",
        repeatedToolCalls: [],
      },
      fixtureRoot: root,
      expected: SCENARIO_T1_CHAT_FAILURE.expectedFiles ?? [],
    });
    expect(result.verdict).toBe("fail");
    expect(result.detail.toolCallCount).toBe(0);
  });

  it("T2 stream-error: hadError → fail", async () => {
    const root = await prepareFixture(SCENARIO_T2_STREAM_ERROR, baseDir);
    const result = await SCENARIO_T2_STREAM_ERROR.judge({
      metrics: {
        steps: 1,
        toolCalls: [],
        erroredToolCalls: [],
        hadError: true,
        errorText: "The agent timed out (first chunk timeout (90000ms)).",
        finishReason: "error",
        totalText: "",
        usage: null,
        reasoningEffort: null,
        repeatedToolCalls: [],
      },
      fixtureRoot: root,
      expected: SCENARIO_T2_STREAM_ERROR.expectedFiles ?? [],
    });
    expect(result.verdict).toBe("fail");
    expect(result.reason).toContain("timed out");
  });

  it("T3 retry-loop: repeated tool calls → fail", async () => {
    const root = await prepareFixture(SCENARIO_T3_RETRY_LOOP, baseDir);
    await fs.writeFile(path.join(root, "marker.txt"), "hello", "utf8");
    const result = await SCENARIO_T3_RETRY_LOOP.judge({
      metrics: {
        steps: 2,
        toolCalls: [],
        erroredToolCalls: [],
        hadError: false,
        errorText: null,
        finishReason: "stop",
        totalText: "Done.",
        usage: null,
        reasoningEffort: "high",
        repeatedToolCalls: [
          { id: "tc_2", name: "file_operations", input: { action: "write", path: "marker.txt", content: "hello" } },
        ],
      },
      fixtureRoot: root,
      expected: SCENARIO_T3_RETRY_LOOP.expectedFiles ?? [],
    });
    expect(result.verdict).toBe("fail");
    expect(result.reason.toLowerCase()).toContain("retry loop");
  });

  it("T4 multi-step: file written + read call observed → pass", async () => {
    const root = await prepareFixture(SCENARIO_T4_MULTI_STEP, baseDir);
    await fs.writeFile(path.join(root, "marker.txt"), "hello", "utf8");
    const result = await SCENARIO_T4_MULTI_STEP.judge({
      metrics: {
        steps: 2,
        toolCalls: [
          { id: "tc_1", name: "file_operations", input: { action: "read", path: "note.txt" } },
          { id: "tc_2", name: "file_operations", input: { action: "write", path: "marker.txt", content: "hello" } },
        ],
        erroredToolCalls: [],
        hadError: false,
        errorText: null,
        finishReason: "stop",
        totalText: "Done.",
        usage: null,
        reasoningEffort: "high",
        repeatedToolCalls: [],
      },
      fixtureRoot: root,
      expected: SCENARIO_T4_MULTI_STEP.expectedFiles ?? [],
    });
    expect(result.verdict).toBe("pass");
  });

  it("T4 multi-step: file written but no read call → fail", async () => {
    const root = await prepareFixture(SCENARIO_T4_MULTI_STEP, baseDir);
    await fs.writeFile(path.join(root, "marker.txt"), "hello", "utf8");
    const result = await SCENARIO_T4_MULTI_STEP.judge({
      metrics: {
        steps: 1,
        toolCalls: [
          { id: "tc_1", name: "file_operations", input: { action: "write", path: "marker.txt", content: "hello" } },
        ],
        erroredToolCalls: [],
        hadError: false,
        errorText: null,
        finishReason: "stop",
        totalText: "Done.",
        usage: null,
        reasoningEffort: "high",
        repeatedToolCalls: [],
      },
      fixtureRoot: root,
      expected: SCENARIO_T4_MULTI_STEP.expectedFiles ?? [],
    });
    expect(result.verdict).toBe("fail");
    expect(result.reason).toContain("read tool call");
  });

  it("T5 wrong-content: file on disk with 'world' → fail", async () => {
    const root = await prepareFixture(SCENARIO_T5_WRONG_CONTENT, baseDir);
    await fs.writeFile(path.join(root, "marker.txt"), "world", "utf8");
    const result = await SCENARIO_T5_WRONG_CONTENT.judge({
      metrics: null,
      fixtureRoot: root,
      expected: SCENARIO_T5_WRONG_CONTENT.expectedFiles ?? [],
    });
    expect(result.verdict).toBe("fail");
    expect(result.reason).toContain("mismatch");
  });
});

describe("evaluateScenario (full offline pipeline)", () => {
  it("T0 agentic-success → fail (file not written, transcript-only)", async () => {
    // The transcript shows a tool call, but the judge checks disk — no file.
    const result = await evaluateScenario(SCENARIO_T0_AGENTIC_SUCCESS, baseDir);
    expect(result.verdict).toBe("fail");
    expect(result.metrics).not.toBeNull();
    expect(result.metrics!.toolCalls).toHaveLength(1);
  });

  it("T0 agentic-success → pass when ground truth is seeded", async () => {
    // Pre-seed the expected file as the "agent's work" would leave it.
    const root = await prepareFixture(SCENARIO_T0_AGENTIC_SUCCESS, baseDir);
    await fs.writeFile(path.join(root, "marker.txt"), "hello", "utf8");
    const result = await SCENARIO_T0_AGENTIC_SUCCESS.judge({
      metrics: null,
      fixtureRoot: root,
      expected: SCENARIO_T0_AGENTIC_SUCCESS.expectedFiles ?? [],
    });
    expect(result.verdict).toBe("pass");
  });

  it("T1 chat-failure → fail (no file, no tool calls)", async () => {
    const result = await evaluateScenario(SCENARIO_T1_CHAT_FAILURE, baseDir);
    expect(result.verdict).toBe("fail");
    expect(result.metrics!.toolCalls).toHaveLength(0);
  });

  it("T2 stream-error → fail (transcript has error chunk)", async () => {
    const result = await evaluateScenario(SCENARIO_T2_STREAM_ERROR, baseDir);
    expect(result.verdict).toBe("fail");
    expect(result.metrics!.hadError).toBe(true);
  });

  it("T3 retry-loop → fail (duplicate tool calls in transcript)", async () => {
    const result = await evaluateScenario(SCENARIO_T3_RETRY_LOOP, baseDir);
    expect(result.verdict).toBe("fail");
    expect(result.metrics!.repeatedToolCalls).toHaveLength(1);
  });

  it("T4 multi-step → pass when note.txt seeded + marker.txt written", async () => {
    const result = await evaluateWithTranscript(
      SCENARIO_T4_MULTI_STEP,
      SCENARIO_T4_MULTI_STEP.transcript!,
      baseDir,
      [{ relativePath: "marker.txt", content: "hello" }]
    );
    expect(result.verdict).toBe("pass");
  });

  it("T5 wrong-content → fail (file content mismatch on disk)", async () => {
    const result = await evaluateWithTranscript(
      SCENARIO_T5_WRONG_CONTENT,
      SCENARIO_T5_WRONG_CONTENT.transcript!,
      baseDir,
      [{ relativePath: "marker.txt", content: "world" }]
    );
    expect(result.verdict).toBe("fail");
  });

  it("ALL_SCENARIOS contains all six live scenarios in order", () => {
    expect(ALL_SCENARIOS).toHaveLength(6);
    const ids = ALL_SCENARIOS.map((s) => s.id);
    expect(ids).toEqual(["S0", "S1", "S2", "S3", "S4", "S5"]);
  });

});
