/**
 * Management tools — agent-facing CRUD for system entities.
 *
 * Three tools, each wrapping the existing service layer (exactly like
 * the `manage_skill` tool in the skills catalog):
 *
 *  - manage_subagent   — create/update/delete/list subagents. Newly
 *    created ENABLED subagents automatically get a `delegate_<slug>` tool
 *    on the next turn via buildSubagentToolsForChat().
 *
 *  - manage_cron_schedule — create/update/delete/list cron schedules.
 *    Every mutation calls syncCognitiveDaemon() so the daemon re-arms
 *    live without a server restart.
 *
 *  - manage_mcp_server — create/update/delete/list MCP server configs.
 *    MCP tools are already injected per-request via collectMcpTools();
 *    this tool manages WHICH servers exist and whether they're enabled.
 *    A server added here will contribute its tools on the next chat
 *    turn (after the drift-approval flow).
 *
 *  - manage_custom_tool — create/update/delete/list custom dynamic tools.
 *    Custom tools persist in settings and execute HTTP requests defined
 *    by users/agents without rebuilding.
 *
 * Destructive operations (delete, and update-as-disable) are wired
 * through evaluateToolApproval in tool-policy.ts for user confirmation.
 *
 * Storage: all three persist to the SQLite settings table as JSON blobs
 * (keys: "subagents", "cronSchedules", "mcpServers") — the same
 * mechanism the UI uses, so data is shared and survives restarts.
 */
import { tool } from "ai";
import { z } from "zod";

// ── Subagent management ──────────────────────────────────────────────

const SubagentToolKeySchema = z.enum([
  "web_search",
  "web_fetch",
  "memory",
  "sandbox",
  "tasks",
]);

const manageSubagentInputSchema = z.object({
  action: z.enum(["create", "update", "delete", "list"]),
  /** Subagent id (required for update/delete). */
  id: z.string().optional(),
  /** Display name — slugified into delegate_<slug> tool name. */
  name: z.string().optional(),
  /** System instructions for the subagent. */
  instructions: z.string().optional(),
  /** Granted capability groups (non-empty array for create). */
  tools: z.array(SubagentToolKeySchema).optional(),
  /** Default: true for create. */
  enabled: z.boolean().optional(),
  /** Model override, e.g. "openai::gpt-4o". Empty/bare falls back to default. */
  model: z.string().optional(),
  /** Step budget, 1–50. Default: 12. */
  maxSteps: z.number().int().min(1).max(50).optional(),
  /** Short description for the UI / delegation guidance. */
  description: z.string().max(500).optional(),
  /** Routing guidance shown to the main model in the delegate tool description. */
  delegationGuidance: z.string().max(1000).optional(),
});

export const manage_subagent = tool({
  description:
    "Create, update, delete, or list subagents. A subagent is a specialized ToolLoopAgent with its own model, instructions, tool access, and step budget — invoked via a delegation tool (delegate_<slug>) that appears in subsequent turns. Subagent configs persist across restarts.\n\nActions:\n- create: name (required), instructions (required), tools (required array from web_search, web_fetch, memory, sandbox, tasks). Optional: enabled (default true), model, maxSteps (default 12), description, delegationGuidance.\n- update: id (required) + any fields to change.\n- delete: id (required).\n- list: no other params — returns all subagent configs (id, name, tools, enabled, model, maxSteps, description, delegationGuidance, builtIn).",
  inputSchema: manageSubagentInputSchema,
  execute: async ({
    action,
    id,
    name,
    instructions,
    tools,
    enabled,
    model,
    maxSteps,
    description,
    delegationGuidance,
  }) => {
    // Dynamic import avoids pulling the subagent runner on every module load.
    const {
      createSubagent,
      updateSubagent,
      deleteSubagent,
      listSubagents,
      SubagentValidationError,
    } = await import("@/lib/ai/subagents-service");

    try {
      switch (action) {
        case "list":
          return {
            subagents: listSubagents().map((s) => ({
              id: s.id,
              name: s.name,
              tools: s.tools,
              enabled: s.enabled,
              model: s.model,
              maxSteps: s.maxSteps,
              description: s.description,
              delegationGuidance: s.delegationGuidance,
              builtIn: s.builtIn,
            })),
          };

        case "create": {
          if (!name || !instructions || !tools) {
            return {
              error:
                "create requires: name, instructions, tools (array from web_search, web_fetch, memory, sandbox, tasks)",
            };
          }
          const created = await createSubagent({
            name,
            instructions,
            tools,
            enabled,
            model,
            maxSteps,
            description,
            delegationGuidance,
          });
          return {
            created: created.id,
            name: created.name,
            delegationTool: `delegate_${created.id.replace(/^sub_/, "")}`,
          };
        }

        case "update": {
          if (!id) return { error: "update requires: id" };
          const updated = await updateSubagent(id, {
            name: name ?? undefined,
            instructions: instructions ?? undefined,
            tools: tools ?? undefined,
            enabled: enabled ?? undefined,
            model: model ?? undefined,
            maxSteps: maxSteps ?? undefined,
            description: description ?? undefined,
            delegationGuidance: delegationGuidance ?? undefined,
          });
          if (!updated) return { error: `Subagent with id "${id}" not found` };
          return { updated: updated.id, name: updated.name };
        }

        case "delete": {
          if (!id) return { error: "delete requires: id" };
          const removed = deleteSubagent(id);
          if (!removed) return { error: `Subagent with id "${id}" not found` };
          return { deleted: removed.id, name: removed.name };
        }
      }
    } catch (e) {
      if (e instanceof SubagentValidationError) {
        return { error: e.message, issues: e.issues };
      }
      return { error: e instanceof Error ? e.message : String(e) };
    }
  },
});

// ── Cron schedule management ─────────────────────────────────────────

const SCHEDULABLE_JOB_TYPE_VALUES = [
  "sleep_consolidation",
  "dream_graph_discovery",
  "decay_sweep",
  "proactive_event_check",
] as const;

export const manage_cron_schedule = tool({
  description:
    "Create, update, delete, or list cron schedules. Each schedule maps a cron expression (5-field, node-cron syntax, e.g. '0 2 * * *') to a queue job type. When enabled, the cognitive daemon arms it automatically and re-syncs on every mutation (no restart needed).\n\nActions:\n- create: name (required), schedule (required, 5-field cron expression), jobType (required, one of sleep_consolidation, dream_graph_discovery, decay_sweep, proactive_event_check). Optional: enabled (default true), description.\n- update: id (required) + any fields to change.\n- delete: id (required).\n- list: no other params — returns all schedules with nextRunAt projections.\n- run: id (required) — trigger an immediate one-shot execution of the schedule's job.",
  inputSchema: z.object({
    action: z
      .enum(["create", "update", "delete", "list", "run"])
      .describe("Operation to perform"),
    id: z.string().optional().describe("Schedule id (required for update/delete/run)"),
    name: z.string().optional().describe("Human label shown in the daemon status"),
    schedule: z
      .string()
      .optional()
      .describe("5-field cron expression, e.g. '*/15 * * * *' or '0 2 * * *'"),
    jobType: z
      .enum(SCHEDULABLE_JOB_TYPE_VALUES)
      .optional()
      .describe("Queue job type the schedule enqueues when it fires"),
    enabled: z.boolean().optional(),
    description: z.string().max(500).optional(),
  }),
  execute: async ({ action, id, name, schedule, jobType, enabled, description }) => {
    const {
      createCronSchedule,
      updateCronSchedule,
      deleteCronSchedule,
      listCronSchedules,
      runCronScheduleNow,
      getNextRunIso,
      CronValidationError,
    } = await import("@/lib/daemon/cron-jobs-service");
    const { syncCognitiveDaemon } = await import("@/lib/daemon/scheduler");

    try {
      switch (action) {
        case "list": {
          const schedules = listCronSchedules();
          return {
            schedules: schedules.map((s) => ({
              id: s.id,
              name: s.name,
              schedule: s.schedule,
              jobType: s.jobType,
              enabled: s.enabled,
              description: s.description ?? "",
              nextRunAt: s.enabled ? getNextRunIso(s.schedule) : null,
              createdAt: s.createdAt,
              updatedAt: s.updatedAt,
              builtIn: s.builtIn,
            })),
          };
        }

        case "create": {
          if (!name || !schedule || !jobType) {
            return {
              error:
                "create requires: name, schedule (5-field cron), jobType (one of: sleep_consolidation, dream_graph_discovery, decay_sweep, proactive_event_check)",
            };
          }
          const created = await createCronSchedule({
            name,
            schedule,
            jobType: jobType as never,
            enabled,
            description,
          });
          syncCognitiveDaemon();
          return {
            created: created.id,
            name: created.name,
            nextRunAt: created.enabled ? getNextRunIso(created.schedule) : null,
          };
        }

        case "update": {
          if (!id) return { error: "update requires: id" };
          const patch: Record<string, unknown> = {};
          if (name !== undefined) patch.name = name;
          if (schedule !== undefined) patch.schedule = schedule;
          if (jobType !== undefined) patch.jobType = jobType as never;
          if (enabled !== undefined) patch.enabled = enabled;
          if (description !== undefined) patch.description = description;
          const updated = await updateCronSchedule(id, patch);
          if (!updated) return { error: `Schedule with id "${id}" not found` };
          syncCognitiveDaemon();
          return {
            updated: updated.id,
            name: updated.name,
            nextRunAt: updated.enabled ? getNextRunIso(updated.schedule) : null,
          };
        }

        case "delete": {
          if (!id) return { error: "delete requires: id" };
          const removed = deleteCronSchedule(id);
          if (!removed) return { error: `Schedule with id "${id}" not found` };
          syncCognitiveDaemon();
          return { deleted: removed.id, name: removed.name };
        }

        case "run": {
          if (!id) return { error: "run requires: id" };
          const jobId = await runCronScheduleNow(id);
          if (!jobId) return { error: `Schedule with id "${id}" not found or disabled` };
          return { triggered: true, jobId };
        }
      }
    } catch (e) {
      if (e instanceof CronValidationError) {
        return { error: e.message, issues: e.issues };
      }
      return { error: e instanceof Error ? e.message : String(e) };
    }
  },
});

// ── MCP server management ────────────────────────────────────────────

const McpTransportKindSchema = z.enum(["http", "sse", "stdio"]);

export const manage_mcp_server = tool({
  description:
    "Create, update, delete, or list MCP server configurations. MCP tools from enabled servers are automatically injected into the model's tool set on each request (prefixed with the server slug, e.g. 'myserver__web_search'). After adding or enabling a server, its tools appear after the next approval/baseline flow.\n\nActions:\n- create: name (required), transport (required: http|sse|stdio). For http/sse: url (required). For stdio: command (required), optional args[] and env{}. Optional: enabled (default true), allowDuplicates[] (tool names to expose despite built-in conflicts), primaryCapabilities[].\n- update: id (required) + any fields to change.\n- delete: id (required) — also clears the approved baseline.\n- list: no other params — returns all server configs (masked secrets).\n- status: id (required) — test the connection (opens, lists tools, closes).",
  inputSchema: z.object({
    action: z
      .enum(["create", "update", "delete", "list", "status"])
      .describe("Operation to perform"),
    /** Server id (required for update/delete/status). */
    id: z.string().optional(),
    name: z.string().optional().describe("Display name — slugified into tool-name prefix"),
    transport: McpTransportKindSchema.optional().describe("Transport kind"),
    enabled: z.boolean().optional(),
    /** http/sse: endpoint URL. */
    url: z.string().url().optional(),
    /** http/sse: request headers (e.g. Authorization). */
    headers: z.record(z.string(), z.string()).optional(),
    /** stdio: executable command to spawn. */
    command: z.string().optional(),
    /** stdio: argv for the spawned process. */
    args: z.array(z.string()).max(64).optional(),
    /** stdio: environment variables for the spawned process (sensitive keys go to secrets env). */
    env: z.record(z.string(), z.string()).optional(),
    /** Tool names to expose despite built-in precedence (slug-prefixed). */
    allowDuplicates: z.array(z.string().max(128)).max(64).optional(),
    /** Capability tools this server is designated to provide. */
    primaryCapabilities: z
      .array(z.enum(["web_search", "web_fetch"]))
      .max(64)
      .optional(),
  }),
  execute: async (input) => {
    const {
      addMcpServer,
      updateMcpServer,
      deleteMcpServer,
      getMcpServerConfigs,
      testMcpServerConnection,
    } = await import("@/lib/ai/mcp/manager");
    const {
      createMcpServerId,
      sanitizeMcpServerConfig,
    } = await import("@/lib/ai/mcp/config");
    const { maskMcpServerConfig } = await import("@/lib/ai/mcp/secrets");

    try {
      switch (input.action) {
        case "list": {
          const servers = getMcpServerConfigs();
          return {
            servers: servers.map(maskMcpServerConfig),
          };
        }

        case "create": {
          const { name, transport, url, headers, command, args, env, enabled } = input;
          if (!name || !transport) {
            return {
              error: "create requires: name, transport (http|sse|stdio)",
            };
          }
          const newId = createMcpServerId();
          const clean = sanitizeMcpServerConfig({
            id: newId,
            name,
            transport,
            enabled: enabled ?? true,
            url,
            headers,
            command,
            args,
            env,
            allowDuplicates: input.allowDuplicates,
            primaryCapabilities: input.primaryCapabilities,
          });
          if (!clean) {
            return {
              error:
                "Invalid MCP server config. For http/sse: url is required. For stdio: command is required.",
            };
          }
          const created = addMcpServer(clean);
          return {
            created: created.id,
            name: created.name,
          };
        }

        case "update": {
          if (!input.id) return { error: "update requires: id" };
          // Build a partial patch from provided fields (excluding id/action).
          const patch: Record<string, unknown> = {};
          if (input.name !== undefined) patch.name = input.name;
          if (input.transport !== undefined) patch.transport = input.transport;
          if (input.url !== undefined) patch.url = input.url;
          if (input.headers !== undefined) patch.headers = input.headers;
          if (input.command !== undefined) patch.command = input.command;
          if (input.args !== undefined) patch.args = input.args;
          if (input.env !== undefined) patch.env = input.env;
          if (input.enabled !== undefined) patch.enabled = input.enabled;
          if (input.allowDuplicates !== undefined)
            patch.allowDuplicates = input.allowDuplicates;
          if (input.primaryCapabilities !== undefined)
            patch.primaryCapabilities = input.primaryCapabilities;

          const updated = updateMcpServer(input.id, patch);
          if (!updated) return { error: `MCP server with id "${input.id}" not found` };
          return { updated: updated.id, name: updated.name };
        }

        case "delete": {
          if (!input.id) return { error: "delete requires: id" };
          const removed = deleteMcpServer(input.id);
          if (!removed) return { error: `MCP server with id "${input.id}" not found` };
          return { deleted: removed.id, name: removed.name };
        }

        case "status": {
          if (!input.id) return { error: "status requires: id" };
          const servers = getMcpServerConfigs();
          const target = servers.find((s) => s.id === input.id);
          if (!target) return { error: `MCP server with id "${input.id}" not found` };
          const result = await testMcpServerConnection(target);
          return result;
        }
      }
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  },
});

// ── Custom tool management ───────────────────────────────────────────

const manageCustomToolInputSchema = z.object({
  action: z.enum(["create", "update", "delete", "list"]),
  id: z.string().optional(),
  name: z.string().optional(),
  description: z.string().optional(),
  enabled: z.boolean().optional(),
  schema: z.record(z.string(), z.unknown()).optional(),
  execution: z
    .object({
      type: z.literal("http"),
      url: z.string(),
      method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
      headers: z.record(z.string(), z.string()).optional(),
      timeoutMs: z.number().int().min(1000).max(30000).optional(),
      allowLoopback: z.boolean().optional(),
    })
    .optional(),
});

// NOTE: manage_custom_tool only supports HTTP execution in v1; add worker runtime when JS execution is added.
export const manage_custom_tool = tool({
  description:
    "Create, update, delete, or list custom dynamic tools. Custom tools persist in settings and become immediately available on the next chat turn without rebuilding.\n\nActions:\n- create: name, description, schema, execution (required)\n- update: id (required) + any fields to change\n- delete: id (required)\n- list: returns all custom tools with secrets masked.",
  inputSchema: manageCustomToolInputSchema,
  execute: async ({ action, id, name, description, enabled, schema, execution }) => {
    const {
      listCustomTools,
      saveCustomTool,
      deleteCustomTool,
      maskCustomToolSummary,
    } = await import("@/lib/ai/custom-tools/service");

    try {
      if (action === "list") {
        const tools = listCustomTools().map(maskCustomToolSummary);
        return { ok: true, tools };
      }

      if (action === "create") {
        if (!name || !description || !schema || !execution) {
          return { ok: false, error: "'create' action requires name, description, schema, and execution." };
        }
        const saved = saveCustomTool({ name, description, enabled, schema, execution });
        return { ok: true, tool: maskCustomToolSummary(saved) };
      }

      if (action === "update") {
        if (!id) return { ok: false, error: "'update' action requires tool id." };
        const existing = listCustomTools().find((t) => t.id === id);
        if (!existing) return { ok: false, error: `Tool with id '${id}' not found.` };

        const hasUpdateFields =
          name !== undefined ||
          description !== undefined ||
          enabled !== undefined ||
          schema !== undefined ||
          execution !== undefined;
        if (!hasUpdateFields) {
          return {
            ok: false,
            error: "'update' action requires at least one field to update (name, description, enabled, schema, or execution).",
          };
        }

        const updated = saveCustomTool(
          {
            name: name ?? existing.name,
            description: description ?? existing.description,
            enabled: enabled ?? existing.enabled,
            schema: schema ?? existing.schema,
            execution: execution ?? existing.execution,
          },
          id
        );
        return { ok: true, tool: maskCustomToolSummary(updated) };
      }

      if (action === "delete") {
        if (!id) return { ok: false, error: "'delete' action requires tool id." };
        const deleted = deleteCustomTool(id);
        return { ok: deleted, id };
      }

      return { ok: false, error: `Unrecognized action '${action}'.` };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
});

