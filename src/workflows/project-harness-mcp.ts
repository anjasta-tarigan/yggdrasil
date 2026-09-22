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
 * (via `collectMcpTools`), and that SDK references the `EventTarget` global at
 * module-evaluation time. The Workflow VM omits `EventTarget`, so the run fails
 * with "EventTarget is not defined" while evaluating the workflow bundle
 * (`@workflow/core` createWorkflowSessionInner) — before any step runs.
 *
 * Two mitigations were tried and did NOT work:
 *   1. Dynamic `import()` of the manager inside the step — the bundler follows
 *      `import()` identically, so the SDK still lands in the workflow bundle.
 *   2. A guarded `EventTarget` polyfill imported first — bundler module-evaluation
 *      order does not reliably run the shim before the SDK's top-level code.
 *
 * Resolution needs an `EventTarget` polyfill injected by the Workflow runtime's VM
 * context, or an SDK change. Until then, MCP tools are not exposed on the durable
 * path (which serves bash, file_operations, web_search, web_fetch,
 * create_artifact, manage_tasks).
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
