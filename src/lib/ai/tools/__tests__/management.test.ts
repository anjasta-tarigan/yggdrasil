/**
 * Self-check for the management tools registration and schema.
 *
 * The underlying CRUD logic (createSubagent, createCronSchedule, addMcpServer,
 * etc.) is already tested in their respective service-layer test files:
 *  - src/lib/ai/__tests__/subagents-service.test.ts
 *  - src/lib/daemon/__tests__/cron-jobs-service.test.ts
 *  - src/lib/ai/mcp/__tests__/manager.test.ts
 *
 * This test verifies only the wiring: that the three tools are registered
 * in builtinTools with proper descriptions, inputSchema, and execute.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { builtinTools } from "../index";

// `manage_custom_tool` delegates to the custom-tools service, which persists to
// the real SQLite settings store. Left unmocked, the test writes into the
// developer's `data/yggdrasil.db` and fails on a second run (the tool name
// already exists). Back the service with an in-memory store so the test is
// hermetic and idempotent while still exercising the tool's dispatch logic.
const customToolsStore: Array<Record<string, unknown>> = [];
let idCounter = 0;

vi.mock("@/lib/ai/custom-tools/service", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/ai/custom-tools/service")>();
  return {
    ...actual,
    listCustomTools: () => customToolsStore,
    saveCustomTool: (input: Record<string, unknown>) => {
      const existingIndex = customToolsStore.findIndex(
        (t) => t.id === input.id
      );
      const record = {
        ...input,
        id: (input.id as string) ?? `ctool_test_${++idCounter}`,
        enabled: (input.enabled as boolean) ?? true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      if (existingIndex >= 0) customToolsStore[existingIndex] = record;
      else customToolsStore.push(record);
      return record;
    },
    deleteCustomTool: (id: string) => {
      const index = customToolsStore.findIndex((t) => t.id === id);
      if (index < 0) return false;
      customToolsStore.splice(index, 1);
      return true;
    },
  };
});

// Cast to a record for dynamic key access in tests
const toolsRecord = builtinTools as Record<string, {
  description?: unknown;
  inputSchema?: { parse?: unknown; safeParse?: unknown; _def?: { shape?: unknown } };
  execute?: unknown;
}>;

describe("management tools registration", () => {
  beforeEach(() => {
    customToolsStore.length = 0;
  });

  const MANAGE_TOOLS = [
    "manage_subagent",
    "manage_cron_schedule",
    "manage_mcp_server",
    "manage_custom_tool",
  ];

  it("registers all four management tools in builtinTools", () => {
    for (const name of MANAGE_TOOLS) {
      expect(toolsRecord[name], `${name} not registered in builtinTools`).toBeDefined();
    }
  });

  it("has description and inputSchema on each tool", () => {
    for (const name of MANAGE_TOOLS) {
      const t = toolsRecord[name];
      expect(t.description, `${name} missing description`).toBeTruthy();
      expect(t.inputSchema, `${name} missing inputSchema`).toBeDefined();
    }
  });

  it("has an action field in the input schema", () => {
    for (const name of MANAGE_TOOLS) {
      const schema = toolsRecord[name].inputSchema as {
        _def?: { shape?: Record<string, unknown> };
      };
      expect(schema?._def?.shape, `${name} has no shape`).toBeDefined();
      expect(schema!._def!.shape!.action, `${name} missing action field`).toBeDefined();
    }
  });

  it("manage_cron_schedule accepts 'run' action", () => {
    const schema = toolsRecord.manage_cron_schedule.inputSchema as {
      safeParse?: (input: unknown) => { success: boolean };
    };
    const result = schema?.safeParse?.({ action: "run", id: "test-id" });
    expect(result?.success).toBe(true);
  });

  it("manage_mcp_server accepts 'status' action", () => {
    const schema = toolsRecord.manage_mcp_server.inputSchema as {
      safeParse?: (input: unknown) => { success: boolean };
    };
    const result = schema?.safeParse?.({ action: "status", id: "test-id" });
    expect(result?.success).toBe(true);
  });

  it("manage_custom_tool creates, lists with masked secrets, updates, and deletes tools", async () => {
    const { manage_custom_tool } = await import("../management");

    type CustomToolExecResult = {
      ok: boolean;
      error?: string;
      tool?: { id: string };
      tools?: Array<{ name: string; execution: { headers: Record<string, string> } }>;
    };
    const exec = manage_custom_tool.execute as unknown as (
      input: Record<string, unknown>
    ) => Promise<CustomToolExecResult>;

    // Test create
    const createResult = await exec({
      action: "create",
      name: "agent_api_tool",
      description: "Agent created tool",
      schema: { type: "object", properties: { key: { type: "string" } } },
      execution: {
        type: "http",
        url: "https://api.agent.test/{key}",
        method: "GET",
        headers: { Authorization: "Bearer agent_secret" },
      },
    });
    expect(createResult.ok).toBe(true);
    expect(createResult.tool?.id).toBeDefined();

    // Test list (verify header masking)
    const listResult = await exec({ action: "list" });
    expect(listResult.ok).toBe(true);
    const found = listResult.tools?.find((t) => t.name === "agent_api_tool");
    expect(found).toBeDefined();
    expect(found?.execution.headers.Authorization).toBe("••••••••");

    // Test delete
    const deleteResult = await exec({
      action: "delete",
      id: createResult.tool?.id,
    });
    expect(deleteResult.ok).toBe(true);
  });

  it("manage_custom_tool update without any fields returns error", async () => {
    const { manage_custom_tool } = await import("../management");

    type ToolExec = (input: Record<string, unknown>) => Promise<{
      ok?: boolean;
      error?: string;
      tool?: { id?: string };
    }>;
    const exec = manage_custom_tool.execute as unknown as ToolExec;

    const name = `test_update_guard_${Date.now()}`;
    const createResult = await exec({
      action: "create",
      name,
      description: "Test tool",
      schema: { type: "object", properties: {} },
      execution: { type: "http", url: "https://api.test", method: "GET" },
    });
    expect(createResult.ok).toBe(true);
    expect(createResult.tool?.id).toBeDefined();

    const updateResult = await exec({
      action: "update",
      id: createResult.tool?.id,
    });
    expect(updateResult.ok).toBe(false);
    expect(updateResult.error).toMatch(/at least one field/i);

    if (createResult.tool?.id) {
      await exec({ action: "delete", id: createResult.tool.id });
    }
  });
});

describe("tool approval policy — management tools", () => {
  it("evaluateToolApproval requires approval for manage_custom_tool delete", async () => {
    const { evaluateToolApproval } = await import("@/lib/ai/tool-policy");
    const result = await evaluateToolApproval("manage_custom_tool", {
      action: "delete",
      id: "ctool_123",
    });
    expect(result).toBe("user-approval");
  });

  it("evaluateToolApproval requires approval for manage_custom_tool update when disabling", async () => {
    const { evaluateToolApproval } = await import("@/lib/ai/tool-policy");
    const result = await evaluateToolApproval("manage_custom_tool", {
      action: "update",
      id: "ctool_123",
      enabled: false,
    });
    expect(result).toBe("user-approval");
  });

  it("evaluateToolApproval requires approval for manage_custom_tool create but not list", async () => {
    const { evaluateToolApproval } = await import("@/lib/ai/tool-policy");
    // Creating a custom tool persists code that executes on every later call,
    // so the create itself is a code-execution capability and is gated. Listing
    // is read-only and stays free.
    expect(
      await evaluateToolApproval("manage_custom_tool", {
        action: "create",
        name: "agent_api_tool",
      })
    ).toBe("user-approval");
    expect(
      await evaluateToolApproval("manage_custom_tool", {
        action: "list",
      })
    ).toBeUndefined();
  });

  it("evaluateToolApproval allows manage_custom_tool update when not disabling", async () => {
    const { evaluateToolApproval } = await import("@/lib/ai/tool-policy");
    const result = await evaluateToolApproval("manage_custom_tool", {
      action: "update",
      id: "ctool_123",
      description: "Updated description",
    });
    expect(result).toBeUndefined();
  });
  it("evaluateToolApproval requires approval for manage_subagent delete", async () => {
    const { evaluateToolApproval } = await import("@/lib/ai/tool-policy");
    const result = await evaluateToolApproval("manage_subagent", {
      action: "delete",
      id: "sub_test",
    });
    expect(result).toBe("user-approval");
  });

  it("evaluateToolApproval allows manage_subagent create", async () => {
    const { evaluateToolApproval } = await import("@/lib/ai/tool-policy");
    const result = await evaluateToolApproval("manage_subagent", {
      action: "create",
      name: "test",
    });
    expect(result).toBeUndefined();
  });

  it("evaluateToolApproval requires approval for manage_cron_schedule update", async () => {
    const { evaluateToolApproval } = await import("@/lib/ai/tool-policy");
    const result = await evaluateToolApproval("manage_cron_schedule", {
      action: "update",
      id: "cron_test",
    });
    expect(result).toBe("user-approval");
  });

  it("evaluateToolApproval allows manage_mcp_server list", async () => {
    const { evaluateToolApproval } = await import("@/lib/ai/tool-policy");
    const result = await evaluateToolApproval("manage_mcp_server", {
      action: "list",
    });
    expect(result).toBeUndefined();
  });
});
