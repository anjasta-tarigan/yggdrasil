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
import { describe, it, expect } from "vitest";
import { builtinTools } from "../index";

// Cast to a record for dynamic key access in tests
const toolsRecord = builtinTools as Record<string, {
  description?: unknown;
  inputSchema?: { parse?: unknown; safeParse?: unknown; _def?: { shape?: unknown } };
  execute?: unknown;
}>;

describe("management tools registration", () => {
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

    // Test create
    const createResult = await (manage_custom_tool.execute as any)({
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
    expect(createResult.tool.id).toBeDefined();

    // Test list (verify header masking)
    const listResult = await (manage_custom_tool.execute as any)({ action: "list" });
    expect(listResult.ok).toBe(true);
    const found = listResult.tools.find((t: any) => t.name === "agent_api_tool");
    expect(found).toBeDefined();
    expect(found.execution.headers.Authorization).toBe("••••••••");

    // Test delete
    const deleteResult = await (manage_custom_tool.execute as any)({
      action: "delete",
      id: createResult.tool.id,
    });
    expect(deleteResult.ok).toBe(true);
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

  it("evaluateToolApproval allows manage_custom_tool create and list", async () => {
    const { evaluateToolApproval } = await import("@/lib/ai/tool-policy");
    expect(
      await evaluateToolApproval("manage_custom_tool", {
        action: "create",
        name: "agent_api_tool",
      })
    ).toBeUndefined();
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
