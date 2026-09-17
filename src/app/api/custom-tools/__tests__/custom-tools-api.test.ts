import { describe, it, expect, vi, beforeEach } from "vitest";
import { db } from "@/db";
import { setSettingsDb } from "@/lib/settings-service";
import { CUSTOM_TOOLS_KEY, saveCustomTool } from "@/lib/ai/custom-tools/service";
import type { CustomToolExecution, CustomToolSummary } from "@/lib/ai/custom-tools/types";
import { executeHttpCustomTool } from "@/lib/ai/custom-tools/http-executor";
import { GET, POST } from "../route";
import { GET as GET_ONE, DELETE, PUT } from "../[id]/route";
import { POST as TEST_POST } from "../[id]/test/route";

vi.mock("@/lib/ai/custom-tools/http-executor", () => ({
  executeHttpCustomTool: vi.fn(),
}));

describe("Custom Tools API Routes", () => {
  beforeEach(() => {
    setSettingsDb({ [CUSTOM_TOOLS_KEY]: undefined }, db);
    vi.clearAllMocks();
  });

  it("handles full lifecycle via API", async () => {
    // 1. Create tool
    const postReq = new Request("http://localhost/api/custom-tools", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "api_created_tool",
        description: "Created via API",
        enabled: true,
        schema: { type: "object", properties: { param: { type: "string" } } },
        execution: {
          type: "http",
          url: "https://api.test/resource/{param}",
          method: "GET",
          headers: { Authorization: "Bearer api_secret" },
        },
      }),
    });
    const postRes = await POST(postReq);
    expect(postRes.status).toBe(201);
    const postData = await postRes.json();
    expect(postData.tool.id).toBeDefined();
    expect(postData.tool.execution.headers.Authorization).toBe("••••••••");

    const toolId = postData.tool.id;

    // 2. List tools
    const getRes = await GET();
    expect(getRes.status).toBe(200);
    const getData = await getRes.json();
    expect(getData.tools.some((t: CustomToolSummary) => t.id === toolId)).toBe(true);
    const listedTool = getData.tools.find((t: CustomToolSummary) => t.id === toolId);
    expect(listedTool.execution.headers.Authorization).toBe("••••••••");

    // 3. Get single tool
    const getOneRes = await GET_ONE(new Request(`http://localhost/api/custom-tools/${toolId}`), {
      params: Promise.resolve({ id: toolId }),
    });
    expect(getOneRes.status).toBe(200);
    const getOneData = await getOneRes.json();
    expect(getOneData.tool.id).toBe(toolId);
    expect(getOneData.tool.execution.headers.Authorization).toBe("••••••••");

    // 4. Update tool
    const putReq = new Request(`http://localhost/api/custom-tools/${toolId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "api_created_tool",
        description: "Updated description via API",
        enabled: true,
        schema: { type: "object", properties: { param: { type: "string" } } },
        execution: {
          type: "http",
          url: "https://api.test/resource/{param}",
          method: "GET",
          headers: { Authorization: "Bearer updated_secret" },
        },
      }),
    });
    const putRes = await PUT(putReq, {
      params: Promise.resolve({ id: toolId }),
    });
    expect(putRes.status).toBe(200);
    const putData = await putRes.json();
    expect(putData.tool.description).toBe("Updated description via API");
    expect(putData.tool.execution.headers.Authorization).toBe("••••••••");

    // 5. Test tool execution route
    vi.mocked(executeHttpCustomTool).mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { success: true },
    });
    const testReq = new Request(`http://localhost/api/custom-tools/${toolId}/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ param: "test-val" }),
    });
    const testRes = await TEST_POST(testReq, {
      params: Promise.resolve({ id: toolId }),
    });
    expect(testRes.status).toBe(200);
    const testData = await testRes.json();
    expect(testData).toEqual({
      ok: true,
      status: 200,
      data: { success: true },
      durationMs: expect.any(Number),
    });
    expect(executeHttpCustomTool).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "http",
        url: "https://api.test/resource/{param}",
        headers: { Authorization: "Bearer updated_secret" }, // unmasked secret passed to executor
      }),
      { param: "test-val" }
    );

    // 6. Delete tool
    const delRes = await DELETE(new Request("http://localhost"), {
      params: Promise.resolve({ id: toolId }),
    });
    expect(delRes.status).toBe(200);
    const delData = await delRes.json();
    expect(delData).toEqual({ ok: true, id: toolId });

    // 7. Verify deletion across routes
    const getAfterDel = await GET_ONE(new Request("http://localhost"), {
      params: Promise.resolve({ id: toolId }),
    });
    expect(getAfterDel.status).toBe(404);

    const delAgain = await DELETE(new Request("http://localhost"), {
      params: Promise.resolve({ id: toolId }),
    });
    expect(delAgain.status).toBe(404);
  });

  it("returns 400 on invalid POST or PUT payload", async () => {
    // POST with invalid data
    const postReq = new Request("http://localhost/api/custom-tools", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "" }),
    });
    const postRes = await POST(postReq);
    expect(postRes.status).toBe(400);
    const postData = await postRes.json();
    expect(postData.error).toBeDefined();

    // Create a valid tool first
    const saved = saveCustomTool({
      name: "valid_tool",
      description: "Valid tool",
      enabled: true,
      schema: { type: "object" },
      execution: { type: "http", url: "https://api.test/data", method: "GET" },
    });

    // PUT with invalid data (empty name)
    const putReq = new Request(`http://localhost/api/custom-tools/${saved.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "" }),
    });
    const putRes = await PUT(putReq, {
      params: Promise.resolve({ id: saved.id }),
    });
    expect(putRes.status).toBe(400);
    const putData = await putRes.json();
    expect(putData.error).toBeDefined();
  });

  it("returns 404 when updating a non-existent tool", async () => {
    const putReq = new Request("http://localhost/api/custom-tools/ctool_nonexistent", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "updated_name",
        description: "Desc",
        enabled: true,
        schema: { type: "object" },
        execution: { type: "http", url: "https://api.test", method: "GET" },
      }),
    });
    const putRes = await PUT(putReq, {
      params: Promise.resolve({ id: "ctool_nonexistent" }),
    });
    expect(putRes.status).toBe(404);
    const putData = await putRes.json();
    expect(putData.error).toBe("Tool not found");
  });

  it("test runner handles non-existent tool, non-http execution, and empty input", async () => {
    // 1. Tool not found
    const resNotFound = await TEST_POST(new Request("http://localhost"), {
      params: Promise.resolve({ id: "non_existent_id" }),
    });
    expect(resNotFound.status).toBe(404);
    const notFoundData = await resNotFound.json();
    expect(notFoundData.error).toBe("Tool not found");

    // 2. Non-http execution (e.g. legacy or future tool config in db)
    setSettingsDb(
      {
        [CUSTOM_TOOLS_KEY]: [
          {
            id: "ctool_js",
            name: "js_tool",
            description: "JS tool",
            enabled: true,
            schema: { type: "object" },
            execution: { type: "javascript", script: "return 1;" } as unknown as CustomToolExecution,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        ],
      },
      db
    );
    const resJs = await TEST_POST(new Request("http://localhost"), {
      params: Promise.resolve({ id: "ctool_js" }),
    });
    expect(resJs.status).toBe(400);
    const jsData = await resJs.json();
    expect(jsData.error).toBe("Only http execution is supported in v1.");

    // 3. Empty input body defaults to empty object
    const httpTool = saveCustomTool({
      name: "http_tool_test",
      description: "Http tool test",
      enabled: true,
      schema: { type: "object" },
      execution: { type: "http", url: "https://api.test/ping", method: "GET" },
    });

    vi.mocked(executeHttpCustomTool).mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: "pong",
    });
    const emptyBodyReq = new Request(`http://localhost/api/custom-tools/${httpTool.id}/test`, {
      method: "POST",
    });
    const resEmpty = await TEST_POST(emptyBodyReq, {
      params: Promise.resolve({ id: httpTool.id }),
    });
    expect(resEmpty.status).toBe(200);
    expect(executeHttpCustomTool).toHaveBeenCalledWith(
      expect.objectContaining({ type: "http", url: "https://api.test/ping" }),
      {}
    );
  });
});
