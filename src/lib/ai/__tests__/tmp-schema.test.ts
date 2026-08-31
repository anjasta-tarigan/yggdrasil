import { describe, it } from "vitest";
import { collectMcpTools } from "@/lib/ai/mcp/manager";

describe("mcp schema check", () => {
  it("prints web_search input schema", async () => {
    const mcp = await collectMcpTools();
    const tool = mcp.tools["parallel-search__web_search"];
    console.log("SCHEMA:", JSON.stringify((tool as { inputSchema?: unknown }).inputSchema, null, 2));
  });
});
