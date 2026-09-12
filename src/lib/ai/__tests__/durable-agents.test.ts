import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { WorkflowAgent } from "@ai-sdk/workflow";
import { tool, type UIMessage } from "ai";
import { z } from "zod";
import type { SubagentConfig } from "@/lib/ai/subagents-service";

// ─── Hoisted mock variables (available in vi.mock factories) ────────────────
const mockResolveModel = vi.hoisted(() => vi.fn());
const mockBuildSubagentTools = vi.hoisted(() => vi.fn());
const mockGetWritable = vi.hoisted(() => vi.fn());

// ─── Module mocks (hoisted above imports by vitest) ─────────────────────────
vi.mock("@/lib/ai/subagent-runner", () => ({
  resolveModel: mockResolveModel,
  buildSubagentTools: mockBuildSubagentTools,
}));

vi.mock("workflow", () => ({
  getWritable: mockGetWritable,
}));

// ─── Imports (resolved against the mocks above) ─────────────────────────────
import { createDurableAgent } from "@/lib/ai/durable-agents";
import { chatWorkflow } from "@/workflows/chat-workflow";

// ─── Test data ──────────────────────────────────────────────────────────────
const testTools = {
  test_action: tool({
    description: "A test action tool",
    inputSchema: z.object({ input: z.string() }),
    execute: async ({ input }: { input: string }) => `result: ${input}`,
  }),
  test_query: tool({
    description: "A test query tool",
    inputSchema: z.object({ query: z.string() }),
    execute: async ({ query }: { query: string }) => `query: ${query}`,
  }),
} as const;

const testConfig: SubagentConfig = {
  id: "test-id",
  name: "TestAgent",
  instructions: "You are a test agent.",
  tools: ["sandbox", "tasks"],
  enabled: true,
  maxSteps: 10,
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-01-01T00:00:00Z",
};

// ─── createDurableAgent ─────────────────────────────────────────────────────
describe("createDurableAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveModel.mockResolvedValue({ modelId: "test-model" });
    mockBuildSubagentTools.mockReturnValue(testTools);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns a WorkflowAgent instance", async () => {
    const agent = await createDurableAgent(testConfig);
    expect(agent).toBeInstanceOf(WorkflowAgent);
  });

  it("has tools matching the config's tool set", async () => {
    const agent = await createDurableAgent(testConfig);
    const toolNames = Object.keys(agent.tools);
    expect(toolNames).toContain("test_action");
    expect(toolNames).toContain("test_query");
  });

  it("wraps tool execute functions with 'use step' directive", async () => {
    const agent = await createDurableAgent(testConfig);
    const tools = agent.tools as Record<string, { execute: Function }>;
    for (const [name, t] of Object.entries(tools)) {
      expect(typeof t.execute, `tool "${name}" should have execute fn`).toBe(
        "function"
      );
      // The 'use step' directive must appear in the function source so the
      // workflow compiler detects it as a durable step boundary.
      // esbuild (used by vitest) may normalise quote style (single→double),
      // so we match either quote form with a backreference.
      const source = t.execute.toString();
      expect(source).toMatch(/(['"])use step\1/);
    }
  });

  it("calls resolveModel with the config", async () => {
    await createDurableAgent(testConfig);
    expect(mockResolveModel).toHaveBeenCalledWith(testConfig);
  });

  it("calls buildSubagentTools with the config", async () => {
    await createDurableAgent(testConfig);
    expect(mockBuildSubagentTools).toHaveBeenCalledWith(testConfig);
  });

  it("preserves tool properties through the durableTool wrapper", async () => {
    const agent = await createDurableAgent(testConfig);
    const wrapped = agent.tools as Record<string, { description?: string; inputSchema?: unknown }>;
    expect(wrapped.test_action.description).toBe("A test action tool");
    expect(wrapped.test_query.inputSchema).toBeDefined();
  });

  it("does not return the same tool reference (wraps in a new object)", async () => {
    const agent = await createDurableAgent(testConfig);
    const wrapped = agent.tools as Record<string, unknown>;
    expect(wrapped.test_action).not.toBe(testTools.test_action);
    expect(wrapped.test_query).not.toBe(testTools.test_query);
  });
});

// ─── chatWorkflow ───────────────────────────────────────────────────────────
describe("chatWorkflow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveModel.mockResolvedValue({ modelId: "test-model" });
    mockBuildSubagentTools.mockReturnValue(testTools);
    mockGetWritable.mockReturnValue(new WritableStream());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls createDurableAgent and then agent.stream()", async () => {
    const streamSpy = vi
      .spyOn(WorkflowAgent.prototype, "stream")
      .mockResolvedValue({
        messages: [],
        steps: [],
        toolCalls: [],
        toolResults: [],
        finishReason: "stop",
        totalUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        output: undefined,
      } as never);

    const messages: UIMessage[] = [
      { id: "msg-1", role: "user", parts: [{ type: "text", text: "Hello" }] },
    ];

    await chatWorkflow(messages);

    // createDurableAgent internally resolves the model via resolveModel.
    // With the default config, resolveModel receives a config named "DurableAgent".
    expect(mockResolveModel).toHaveBeenCalledWith(
      expect.objectContaining({ name: "DurableAgent" })
    );

    // agent.stream is called with converted messages, a writable, and stopWhen.
    expect(streamSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.any(Array),
        writable: expect.any(WritableStream),
      })
    );

    streamSpy.mockRestore();
  });
});
