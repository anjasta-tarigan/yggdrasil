import { collectMcpTools } from "@/lib/ai/mcp/manager";

/**
 * A serializable description of an MCP tool, safe to return from a durable step
 * (the live tool object carries an `execute` closure and cannot cross the
 * boundary). The workflow can present the names/descriptions to the model or,
 * later, rehydrate them as durable tool-call steps; the descriptor itself is
 * plain data.
 */
export interface McpToolDescriptor {
  name: string;
  description: string | undefined;
  inputSchema: unknown;
}

/**
 * Discovers MCP tools inside a durable step.
 *
 * MCP discovery performs I/O (it connects to each enabled server and asks for its
 * tool list), which the Workflow runtime forbids in the workflow function
 * (`fetch-in-workflow`). A step runs in the step bundle, which has full Node.js
 * access, so discovery belongs here.
 *
 * ⚠️ BLOCKED at runtime (not wired into the durable harness).
 *
 * Importing this module into a workflow graph pulls `@modelcontextprotocol/sdk`
 * (via `collectMcpTools`), and that SDK evaluates code touching the `EventTarget`
 * global at load time. The Workflow VM has no `EventTarget`, so the run fails with
 * "EventTarget is not defined" from `@workflow/core` `createWorkflowSessionInner`.
 * A dynamic import does not help (the bundler follows `import()` identically).
 * Resolution needs either an `EventTarget` polyfill in the step bundle or an SDK
 * change; until then, MCP tools are not exposed on the durable path (which serves
 * bash, file_operations, web_search, web_fetch, create_artifact, manage_tasks).
 *
 * Returns plain descriptors, not live tool objects, because the latter cannot be
 * serialized back across the step boundary.
 */
export async function discoverMcpToolsStep(): Promise<McpToolDescriptor[]> {
  "use step";
  const collection = await collectMcpTools();
  try {
    await collection.close();
  } catch {
    // best-effort close; ignore transport errors
  }
  return Object.entries(collection.tools).map(([name, tool]) => ({
    name,
    description: (tool as { description?: string }).description,
    inputSchema: (tool as { inputSchema?: unknown }).inputSchema,
  }));
}
