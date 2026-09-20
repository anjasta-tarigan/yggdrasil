import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { FetchTransport, assertLoopbackUrl, runScenarioLive, runAllLive, type HarnessTransport, type HttpResponse } from "../run";
import { SCENARIO_AGENTIC_SUCCESS, SCENARIO_CHAT_FAILURE } from "../scenarios";
import type { Scenario } from "../contracts";
import { TRANSCRIPT_AGENTIC_SUCCESS } from "../transcripts";
import { cleanupFixtures } from "../evaluate";

const baseDir = path.join(os.tmpdir(), `evals-run-${process.pid}-${Date.now()}`);

afterEach(async () => {
  await cleanupFixtures(baseDir);
});

/** A transport that records calls and refuses non-loopback URLs. */
function makeMockTransport(overrides: Partial<HarnessTransport> = {}): {
  transport: HarnessTransport;
  calls: {
    createProject: number;
    setTrusted: number;
    createSession: number;
    chat: number;
    deleteProject: number;
  };
} {
  const calls = { createProject: 0, setTrusted: 0, createSession: 0, chat: 0, deleteProject: 0 };
  const transport: HarnessTransport = {
    async createProject(input) {
      calls.createProject++;
      return { id: `proj_${calls.createProject}`, directoryPath: input.directoryPath };
    },
    async setTrusted() {
      calls.setTrusted++;
    },
    async createSession(_projectId) {
      calls.createSession++;
      return { id: `sess_${calls.createSession}` };
    },
    async chat(_projectId, _sessionId, _body): Promise<HttpResponse> {
      calls.chat++;
      const sse = TRANSCRIPT_AGENTIC_SUCCESS;
      const encoder = new TextEncoder();
      return {
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(sse));
            controller.close();
          },
        }),
      };
    },
    async deleteProject() {
      calls.deleteProject++;
    },
    ...overrides,
  };
  return { transport, calls };
}

describe("assertLoopbackUrl", () => {
  it("accepts http://localhost", () => {
    expect(() => assertLoopbackUrl("http://localhost:3000")).not.toThrow();
  });

  it("accepts http://127.0.0.1:3000", () => {
    expect(() => assertLoopbackUrl("http://127.0.0.1:3000")).not.toThrow();
  });

  it("accepts http://[::1]:3000", () => {
    expect(() => assertLoopbackUrl("http://[::1]:3000")).not.toThrow();
  });

  it("rejects http://app.localhost:3000 (subdomain not loopback)", () => {
    expect(() => assertLoopbackUrl("http://app.localhost:3000")).toThrow(/non-loopback/);
  });

  it("rejects http://example.com", () => {
    expect(() => assertLoopbackUrl("http://example.com")).toThrow(/non-loopback/);
  });

  it("rejects http://10.0.0.1", () => {
    expect(() => assertLoopbackUrl("http://10.0.0.1")).toThrow(/non-loopback/);
  });
});

describe("FetchTransport", () => {
  it("throws on construction with a non-loopback URL", () => {
    expect(() => new FetchTransport("http://example.com")).toThrow(/non-loopback/);
  });

  it("accepts a loopback URL without throwing", () => {
    expect(() => new FetchTransport("http://localhost:3000")).not.toThrow();
  });
});

describe("runScenarioLive (mock transport)", () => {
  it("runs S0 end-to-end: fixture created, chat called, judge applied", async () => {
    const { transport, calls } = makeMockTransport();
    const { result } = await runScenarioLive(SCENARIO_AGENTIC_SUCCESS, transport, { baseDir });

    expect(calls.createProject).toBe(1);
    expect(calls.setTrusted).toBe(1);
    expect(calls.createSession).toBe(1);
    expect(calls.chat).toBe(1);
    expect(calls.deleteProject).toBe(1);
    // The judge checks disk; the mock transcript shows a tool call but no
    // file was actually written → fail (ground truth wins).
    expect(result.verdict).toBe("fail");
    expect(result.metrics).not.toBeNull();
    expect(result.metrics!.toolCalls).toHaveLength(1);
  });

  it("always cleans up the project even when the judge throws", async () => {
    const { transport, calls } = makeMockTransport();
    // Override the scenario's judge with one that rejects.
    const scenario: Scenario = {
      ...SCENARIO_AGENTIC_SUCCESS,
      judge: () => Promise.reject(new Error("judge exploded")),
    };

    await expect(
      runScenarioLive(scenario, transport, { baseDir })
    ).rejects.toThrow("judge exploded");

    // The project must still have been deleted in the finally block.
    expect(calls.deleteProject).toBe(1);
  });

  it("re-throws when the transport's chat call fails", async () => {
    const { transport } = makeMockTransport({
      async chat() {
        throw new Error("connection refused");
      },
    });
    await expect(
      runScenarioLive(SCENARIO_AGENTIC_SUCCESS, transport, { baseDir })
    ).rejects.toThrow("connection refused");
  });


  it("passes when ground truth is seeded via a custom chat transcript", async () => {
    // Custom transport that writes the marker file as part of the "tool
    // execution" — simulating the agent having done the work.
    const { transport } = makeMockTransport({
      async chat(_projectId, _sessionId, _body) {
        // Simulate the agent writing the file.
        const fixtureRoot = path.join(baseDir, SCENARIO_AGENTIC_SUCCESS.id);
        await fs.mkdir(fixtureRoot, { recursive: true });
        await fs.writeFile(path.join(fixtureRoot, "marker.txt"), "hello", "utf8");
        const encoder = new TextEncoder();
        return {
          status: 200,
          headers: { "content-type": "text/event-stream" },
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode(TRANSCRIPT_AGENTIC_SUCCESS));
              controller.close();
            },
          }),
        };
      },
    });
    const { result } = await runScenarioLive(SCENARIO_AGENTIC_SUCCESS, transport, { baseDir });
    expect(result.verdict).toBe("pass");
  });
});

describe("runAllLive (mock transport)", () => {
  it("runs all scenarios and continues past failures", async () => {
    const { transport } = makeMockTransport();
    const results = await runAllLive([SCENARIO_AGENTIC_SUCCESS, SCENARIO_CHAT_FAILURE], transport, { baseDir });
    expect(results).toHaveLength(2);
    // Both fail because the mock doesn't write the marker file.
    expect(results[0].verdict).toBe("fail");
    expect(results[1].verdict).toBe("fail");
  });

  it("produces an error verdict when a scenario's transport throws", async () => {
    const { transport } = makeMockTransport({
      async createProject() {
        throw new Error("server down");
      },
    });
    const results = await runAllLive([SCENARIO_AGENTIC_SUCCESS], transport, { baseDir });
    expect(results).toHaveLength(1);
    expect(results[0].verdict).toBe("error");
    expect(results[0].reason).toContain("server down");
  });

  it("cleans up the base directory after running", async () => {
    const { transport } = makeMockTransport();
    await runAllLive([SCENARIO_AGENTIC_SUCCESS], transport, { baseDir });
    // The base directory should have been removed.
    await expect(fs.stat(baseDir)).rejects.toThrow();
  });
});
