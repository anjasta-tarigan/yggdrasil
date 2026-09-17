import { describe, it, expect, vi } from "vitest";
import { buildCustomToolsForChat } from "../builder";
import * as service from "../service";
import * as executor from "../http-executor";
import type { CustomToolConfig } from "../types";

describe("buildCustomToolsForChat", () => {
  it("builds valid dynamicTool instances for enabled custom tools", () => {
    const mockTools: CustomToolConfig[] = [
      {
        id: "ctool_1",
        name: "test_tool_a",
        description: "Tool A description",
        enabled: true,
        schema: { type: "object", properties: { q: { type: "string" } } },
        execution: { type: "http", url: "https://api.test", method: "GET" },
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: "ctool_2",
        name: "disabled_tool",
        description: "Disabled",
        enabled: false,
        schema: { type: "object" },
        execution: { type: "http", url: "https://api.test", method: "GET" },
        createdAt: 1,
        updatedAt: 1,
      },
    ];

    vi.spyOn(service, "listCustomTools").mockReturnValue(mockTools);

    const tools = buildCustomToolsForChat();
    expect("test_tool_a" in tools).toBe(true);
    expect("disabled_tool" in tools).toBe(false);
    expect(tools.test_tool_a.description).toBe("Tool A description");
  });

  it("safely skips invalid tool configurations without throwing", () => {
    const corruptTools = [
      {
        id: "ctool_bad",
        name: "bad_tool",
        description: "Bad",
        enabled: true,
        schema: "invalid_schema" as unknown as CustomToolConfig["schema"],
        execution: { type: "http" } as unknown as CustomToolConfig["execution"],
        createdAt: 1,
        updatedAt: 1,
      },
    ];

    vi.spyOn(service, "listCustomTools").mockReturnValue(corruptTools);

    expect(() => buildCustomToolsForChat()).not.toThrow();
    const tools = buildCustomToolsForChat();
    expect(Object.keys(tools).length).toBe(0);
  });

  it("executes the tool via executeHttpCustomTool with input and abortSignal", async () => {
    const mockTools: CustomToolConfig[] = [
      {
        id: "ctool_exec",
        name: "exec_tool",
        description: "Exec tool description",
        enabled: true,
        schema: { type: "object", properties: { q: { type: "string" } } },
        execution: { type: "http", url: "https://api.test/search", method: "GET" },
        createdAt: 1,
        updatedAt: 1,
      },
    ];

    vi.spyOn(service, "listCustomTools").mockReturnValue(mockTools);
    const execSpy = vi
      .spyOn(executor, "executeHttpCustomTool")
      .mockResolvedValue({ ok: true, data: { result: "ok" } });

    const tools = buildCustomToolsForChat();
    const abortController = new AbortController();
    const execTool = tools.exec_tool as {
      execute: (
        input: unknown,
        options?: { abortSignal?: AbortSignal }
      ) => Promise<unknown>;
    };
    const res = await execTool.execute(
      { q: "searchTerm" },
      { abortSignal: abortController.signal }
    );

    expect(res).toEqual({ ok: true, data: { result: "ok" } });
    expect(execSpy).toHaveBeenCalledWith(
      mockTools[0].execution,
      { q: "searchTerm" },
      abortController.signal
    );
  });
});
