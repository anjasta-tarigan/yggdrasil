# Dynamic Custom Tool System (Zero-Rebuild) Design Specification

## 1. Problem Statement & Motivation

Adding a new tool to Yggdrasil currently requires writing TypeScript code inside `src/lib/ai/tools/`, registering it in `src/lib/ai/tools/index.ts`, and performing a full application rebuild (`next build` / server restart). This creates friction for rapid integrations (e.g., custom webhooks, internal microservices, external REST APIs) and prevents the conversational agent from authoring tools dynamically during runtime.

While plugins (`src/lib/plugins/`) support prompt skills, slash commands, and external MCP servers, Yggdrasil lacks a lightweight, native mechanism for executing declarative dynamic tools stored in configuration without managing external subprocesses.

This specification introduces the **Dynamic Custom Tool System** (v1: Declarative HTTP, v2: JS Sandbox), allowing users and agents to register, update, toggle, and execute tools at runtime with zero rebuilds.

---

## 2. Architectural Overview

The system leverages first-class AI SDK v7 primitives (`dynamicTool` and `jsonSchema`) and Yggdrasil's audited `secureFetch` utility, persisting configurations into the SQLite `settings` table.

```
┌─────────────────────────────────────────────────────────────┐
│                    Authoring Surfaces                       │
│  - Agent Tool: `manage_custom_tool` (chat turn authoring)   │
│  - REST API: `/api/custom-tools/*`                          │
│  - Settings UI: Custom Tools Management Tab & Test Drawer    │
└──────────────────────────────┬──────────────────────────────┘
                               │
                Validate at Write Boundary
         (Name uniqueness, jsonSchema try/catch,
          Template variables, Secret preservation)
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│             Storage Layer: SQLite Settings Store            │
│               Key: "customTools" (JSON Array)               │
└──────────────────────────────┬──────────────────────────────┘
                               │
                Request Turn: Read & Build
                               ▼
┌─────────────────────────────────────────────────────────────┐
│          Runtime Builder: `buildCustomToolsForChat`          │
│  - Converts configs to `dynamicTool({ jsonSchema(...) })`   │
│  - Isolated try/catch per tool (skip bad configs safely)    │
│  - Per-call abort signal from AI SDK execution options      │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│              Execution: `executeHttpCustomTool`             │
│  - SSRF-protected `secureFetch` with manual redirect re-chk │
│  - Dual-abort controller (timeout + chat stream signal)     │
│  - Code-point safe truncation (50KB cap)                    │
│  - No-throw contract: returns structured error object       │
└─────────────────────────────────────────────────────────────┘
```

---

## 3. Data Model & Storage

Configurations persist in the SQLite `settings` table under the key `"customTools"`. This maintains architectural symmetry with `subagents`, `cronSchedules`, and `mcpServers` with zero schema migrations.

### 3.1 Type Definitions (`src/lib/ai/custom-tools/types.ts`)

```ts
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type CustomToolExecution =
  | {
      type: "http";
      url: string; // Target URL or template, e.g. "https://api.github.com/repos/{owner}/{repo}/issues"
      method: HttpMethod;
      headers?: Record<string, string>; // Static headers (Authorization, X-API-Key, etc.)
      timeoutMs?: number; // 1,000 - 30,000 ms (default: 10,000 ms applied by service)
      allowLoopback?: boolean; // Allowed ONLY when NODE_ENV !== "production"
    }
  | {
      type: "javascript"; // Reserved for v2 (discriminated union)
      code: string;
      timeoutMs?: number;
    };

export interface CustomToolConfig {
  id: string; // "ctool_<timestamp>_<random>"
  name: string; // Identifier for model, regex: /^[a-zA-Z0-9_-]{1,64}$/
  description: string; // Purpose and usage guidance for LLM
  enabled: boolean; // Toggle flag
  schema: Record<string, unknown>; // JSON Schema object for input validation
  execution: CustomToolExecution;
  createdAt: number;
  updatedAt: number;
}

export type CustomToolSummary = Omit<CustomToolConfig, "execution"> & {
  execution: {
    type: "http";
    url: string;
    method: HttpMethod;
    timeoutMs: number;
    headers?: Record<string, string>; // Values redacted (e.g. "••••••••")
    hasSecrets: boolean;
  };
};
```

### 3.2 Write Boundary Validation (`validateCustomToolConfig`)

Before writing to the SQLite settings store, all incoming configurations are validated:
1. **Name Format & Uniqueness**:
   - Matches `/^[a-zA-Z0-9_-]{1,64}$/`.
   - Cannot collide with `builtinTools`, `PROTECTED_TOOLS`, or existing custom tools (excluding self during update).
2. **Schema Validation via Production Path**:
   - Evaluates `jsonSchema(tool.schema)` inside `try/catch`. If construction throws, the tool is rejected with an actionable error.
   - Enforces top-level `schema.type === "object"`.
3. **URL Template Mapping**:
   - Parses `{var}` placeholders via regex `\{([^}]+)\}`.
   - Every extracted placeholder must exist in `schema.properties`. If missing, write is rejected.
4. **Protocol & Host Restrictions**:
   - Protocol must be `https:` (or `http:` if `allowLoopback` is explicitly enabled and `NODE_ENV !== "production"`).
   - Host must be author-defined in `execution.url`. The model's runtime inputs cannot override the host.
5. **Timeout Constraints**:
   - Default is 10,000 ms if omitted.
   - Clamped between 1,000 ms and 30,000 ms.

### 3.3 Concurrency & Atomic Read-Modify-Write

Since tool configurations are stored as a JSON array in SQLite, concurrent mutations (e.g. agent calling `manage_custom_tool` while user edits in Settings UI) must avoid lost updates:
- All write operations in `service.ts` (`saveCustomTool`, `deleteCustomTool`, `setCustomToolEnabled`) execute inside a synchronous SQLite transaction (`db.transaction(() => { ... })()`).
- Because Yggdrasil uses `better-sqlite3` on a single-threaded Node.js event loop, the transaction ensures atomic read-modify-write semantics, guaranteeing serialized mutations with no lost updates.
- If a write conflicts with validation (e.g. duplicate name created concurrently), the transaction rolls back and returns a descriptive error.

---

## 4. HTTP Execution Engine & Security

### 4.1 Component: `src/lib/ai/custom-tools/http-executor.ts`

```ts
export interface HttpToolExecutionResult {
  ok: boolean;
  status?: number;
  data?: unknown;
  error?: string;
  truncated?: boolean;
}

export async function executeHttpCustomTool(
  execution: Extract<CustomToolExecution, { type: "http" }>,
  input: Record<string, unknown>,
  signal?: AbortSignal
): Promise<HttpToolExecutionResult>;
```

### 4.2 Parameter Mapping
- **Path Interpolation**: Replaces `{var}` in the URL with `encodeURIComponent(String(input[var]))`. Interpolated keys are marked as consumed.
- **Query vs Body**:
  - `GET` / `DELETE`: Non-consumed properties are serialized as URL query parameters (`URLSearchParams`).
  - `POST` / `PUT` / `PATCH`: Non-consumed properties are serialized as JSON body (`JSON.stringify`), setting `Content-Type: application/json` if not already specified.
- **Headers & User-Agent**: Static headers from config are merged. `User-Agent: yggdrasil-tool/0.1` is explicitly set if omitted.

### 4.3 Security & Guardrails
1. **SSRF Defense via `secureFetch`**:
   - All outbound traffic passes through `src/lib/security/ssrf.ts` (`secureFetch`).
   - Private RFC 1918 IPs, link-local metadata (169.254.x.x), and loopback addresses are blocked.
   - Verified redirect safety: `secureFetch` uses `redirect: "manual"` and a `while(true)` loop that runs `assertSafeUrl` per redirect hop.
2. **Loopback Decision**:
   - Localhost (`http://localhost`, `127.0.0.1`) is blocked by default.
   - Only permitted when `allowLoopback: true` AND `process.env.NODE_ENV !== "production"`. In production, loopback is strictly rejected.
3. **Dual Abort Signal Handling**:
   - Creates an internal `AbortController` linked to `timeoutMs`.
   - Attaches an event listener to the outer `signal` (from the chat stream turn) forwarding abort to the internal controller.
   - Cleans up listener in a `finally` block to prevent memory leaks.
   - Differentiates `AbortError`: reports `"Execution timed out after Xms"` vs `"Execution cancelled by user"`.
4. **Code-Point Safe Truncation**:
   - Enforces a 50KB ceiling on output text.
   - Uses code-point slicing (`Array.from(text).slice(0, 50000).join("")`) to prevent broken UTF-16 surrogate pairs.
   - Appends `{ truncated: true }` to the result when clipped.
5. **No-Throw Contract & Non-2xx Error Sanitization**:
   - Network failures, timeouts, SSRF blocks, and non-2xx status codes return `{ ok: false, error: ... }` rather than throwing, keeping the chat stream healthy.
   - Non-2xx error bodies from upstream servers are capped at 4KB (code-point safe) to prevent large HTML error dumps or stack traces from polluting model context.
   - Error payloads are stripped of sensitive authorization tokens before being returned in `data`/`error`.

---

## 5. Runtime Chat Integration

### 5.1 Dynamic Tool Builder (`src/lib/ai/custom-tools/builder.ts`)

```ts
export function buildCustomToolsForChat(
  db?: AppDatabase
): Record<string, Tool> {
  const configs = listCustomTools(db).filter((t) => t.enabled);
  const tools: Record<string, Tool> = {};

  for (const config of configs) {
    if (config.execution.type === "http") {
      const httpExec = config.execution;
      try {
        tools[config.name] = dynamicTool({
          description: config.description,
          inputSchema: jsonSchema(config.schema),
          execute: async (input: unknown, { abortSignal }) => {
            const parsedInput =
              typeof input === "object" && input !== null
                ? (input as Record<string, unknown>)
                : {};
            return executeHttpCustomTool(httpExec, parsedInput, abortSignal);
          },
        });
      } catch (err) {
        console.warn(`[custom-tools] Skipped invalid tool '${config.name}':`, err);
      }
    }
  }

  return tools;
}
```

### 5.2 Merging into `src/app/api/chat/route.ts`

Precedence order:
1. `baseTools` (`chatTools` + `createSandboxTools()`)
2. `subagentTools` (`delegate_<slug>`)
3. `customTools` (dynamic custom tools)
4. `mcp.tools` (external MCP servers)

Collision handling:
```ts
const safeCustomTools = Object.fromEntries(
  Object.entries(customTools).filter(([name]) => {
    if (name in baseTools || name in subagentTools) {
      console.warn(`[custom-tools] Dropping tool '${name}' due to collision with built-in/subagent tool.`);
      return false;
    }
    return true;
  })
);
```

### 5.3 Per-Request Tool Toggles & Turn-Snapshot Semantics

1. **Per-Request Dynamic Evaluation**:
   - `knownToolNames(db?: AppDatabase)` in `src/lib/ai/tool-toggles.ts` is explicitly evaluated **dynamically on every request turn**, appending names from `listCustomTools(db)` to `chatTools`.
   - No module-level static caching: a newly authored or toggled custom tool is immediately reflected in `getDisabledTools()` and `filterToolsForChat()` on the very next turn without requiring a server reboot or rebuild.
2. **Turn-Snapshot Semantics**:
   - `buildCustomToolsForChat()` executes once per chat request turn before streaming begins.
   - If a custom tool is modified or deleted mid-flight while a generation turn is streaming, the active turn safely completes with its turn-start snapshot. The next turn picks up the revised configuration.

---

## 6. Management Surfaces & Security

### 6.1 Agent-Facing Management Tool (`src/lib/ai/tools/management.ts`)

Export `manage_custom_tool` in `builtinTools`:
- **Actions**: `create`, `update`, `delete`, `list`.
- **Action-gated parameter enforcement**:
  - `create`: requires `name`, `description`, `schema`, `execution`.
  - `update`: requires `id` and at least one updated property.
  - `delete`: requires `id`.
  - `list`: lists all tools with redacted headers.
- **Approval Policy**: `delete` and `update` (disabling a tool) trigger `needsApproval: true` in `src/lib/ai/tool-policy.ts`.

### 6.2 Secret Redaction
In `list` actions and API `GET` responses:
- Header values are redacted (`••••••••`).
- A boolean `hasSecrets: true` is included if sensitive keys (`authorization`, `api-key`, `token`, `secret`) are present.
- Raw values remain stored in SQLite and are only accessed during runtime execution.

### 6.3 REST API Endpoints
- `GET /api/custom-tools`: Returns list of custom tools (headers redacted).
- `POST /api/custom-tools`: Creates a new tool.
- `PUT /api/custom-tools/[id]`: Updates a tool.
- `DELETE /api/custom-tools/[id]`: Deletes a tool.
- `POST /api/custom-tools/[id]/test`: Fires an immediate live execution request with user-supplied test parameters.
  - The UI explicitly marks this with a warning: *"This fires a real network request to the target endpoint."*

---

## 7. Settings UI

The Tools settings view (`src/components/settings/`) gains a "Custom Tools" section:
1. **Tool Table**: Lists custom tools with name, method, URL, enabled status, and action buttons (Test, Edit, Delete).
2. **Editor Modal**: Form fields for Name, Description, JSON Schema, Method, URL, Headers, and Timeout.
3. **Execution Test Drawer**: Auto-renders input fields derived from `schema.properties` and executes `POST /api/custom-tools/[id]/test`, displaying HTTP status, response body, latency, and headers.

---

## 8. Deliberate Simplifications & Upgrade Path

- `ponytail: JavaScript execution engine ({ type: "javascript" }) skipped in v1. Add when users require complex local parsing or transformation not representable by HTTP mapping.`
- `ponytail: True dry-run simulation mode skipped. Real execution is fired with explicit UI warning. Add mock response mode in v2 if destructive testing becomes common.`
- `ponytail: SQLite settings table JSON blob used instead of dedicated SQL table. Sufficient for hundreds of tools without migration. Migrate to custom_tools table if tool count exceeds 1,000.`

---

## 9. Testing Strategy

1. **Unit Tests (`src/lib/ai/custom-tools/__tests__/`)**:
   - `validation.test.ts`: Test schema validation, URL template mapping, duplicate name checks, timeout bounds, and loopback enforcement.
   - `service.test.ts`: Test atomic transactions on write, and verify secret redaction in `list` output and API GET (ensuring raw tokens/passwords are never leaked to LLM or client).
   - `http-executor.test.ts`:
     - Test parameter interpolation, GET query params, and POST JSON bodies.
     - Test dual-abort handling: verify distinguishing `"Execution timed out after Xms"` vs `"Execution cancelled by user"`.
     - Test SSRF blocks on private/link-local/loopback IPs.
     - Test 50KB code-point safe truncation on success response and 4KB cap on non-2xx error responses.
   - `builder.test.ts`: Verify `buildCustomToolsForChat` handles invalid tool configs gracefully without throwing.
2. **API Tests (`src/app/api/custom-tools/__tests__/`)**:
   - Test CRUD endpoints, secret redaction, and action-gated validations.
3. **Integration Tests**:
   - Simulate chat route turn with custom tool injected, verifying AI SDK `dynamicTool` invocation, `abortSignal` propagation, and tool-call lifecycle without rebuild.
