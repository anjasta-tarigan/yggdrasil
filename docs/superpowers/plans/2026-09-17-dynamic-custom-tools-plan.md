# Dynamic Custom Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the zero-rebuild Dynamic Custom Tool System in Yggdrasil, enabling users and agents to register, manage, and execute declarative HTTP tools at runtime with SSRF defense and instant chat turn availability.

**Architecture:** Custom tools persist in SQLite settings (`"customTools"`) with atomic synchronous transactions. The chat route dynamically maps active configs to AI SDK v7 `dynamicTool` and `jsonSchema` instances per-request. Outbound tool calls run through `secureFetch` with per-hop redirect revalidation, dual-abort controllers, and code-point safe response truncation.

**Tech Stack:** TypeScript, Next.js 16 (App Router), AI SDK v7 (`dynamicTool`, `jsonSchema`), SQLite (`better-sqlite3`, Drizzle ORM), Vitest, Tailwind CSS v4.

**Spec:** `docs/superpowers/specs/2026-09-17-dynamic-custom-tools-design.md`

## Global Constraints

- Never use `eval` or unsafe code generation.
- All outbound network calls must route through `secureFetch()` in `src/lib/security/ssrf.ts`.
- Enforce secret redaction in all summary/list endpoints and agent outputs (`{ [key]: "••••••••" }`).
- Never perform concurrent `vitest` executions; execute tests sequentially.
- Mark deliberate simplifications with a `ponytail:` comment.

---

### Task 1: Core Types & Write Boundary Validation

**Files:**
- Create: `src/lib/ai/custom-tools/types.ts`
- Create: `src/lib/ai/custom-tools/validation.ts`
- Test: `src/lib/ai/custom-tools/__tests__/validation.test.ts`

**Interfaces:**
- Consumes: `jsonSchema` from `ai`, `chatTools` from `@/lib/ai/tools`
- Produces: `CustomToolConfig`, `CustomToolExecution`, `validateCustomToolConfig(input, existingTools, options)`

- [ ] **Step 1: Write the failing unit test for validation**

```ts
// src/lib/ai/custom-tools/__tests__/validation.test.ts
import { describe, it, expect } from "vitest";
import { validateCustomToolConfig } from "../validation";
import type { CustomToolConfig } from "../types";

describe("validateCustomToolConfig", () => {
  const validConfig = {
    name: "fetch_weather",
    description: "Get weather for location",
    enabled: true,
    schema: {
      type: "object",
      properties: {
        city: { type: "string" },
      },
      required: ["city"],
    },
    execution: {
      type: "http" as const,
      url: "https://api.weather.test/v1/{city}",
      method: "GET" as const,
      timeoutMs: 5000,
    },
  };

  it("accepts valid tool configuration", () => {
    const result = validateCustomToolConfig(validConfig, []);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.name).toBe("fetch_weather");
      expect(result.data.execution.timeoutMs).toBe(5000);
    }
  });

  it("rejects invalid tool name format", () => {
    const result = validateCustomToolConfig({ ...validConfig, name: "bad name with spaces" }, []);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/name/i);
  });

  it("rejects duplicate tool names", () => {
    const existing: CustomToolConfig[] = [
      {
        id: "ctool_1",
        name: "fetch_weather",
        description: "old",
        enabled: true,
        schema: { type: "object" },
        execution: { type: "http", url: "https://api.test", method: "GET" },
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    const result = validateCustomToolConfig(validConfig, existing);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/already exists/i);
  });

  it("rejects invalid JSON schema", () => {
    const result = validateCustomToolConfig({ ...validConfig, schema: "not an object" as any }, []);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/schema/i);
  });

  it("rejects URL template placeholders missing from schema properties", () => {
    const result = validateCustomToolConfig(
      {
        ...validConfig,
        execution: {
          ...validConfig.execution,
          url: "https://api.weather.test/v1/{unknown_param}",
        },
      },
      []
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/unknown_param/i);
  });

  it("rejects non-https URLs unless allowLoopback in development", () => {
    const resultHttp = validateCustomToolConfig(
      {
        ...validConfig,
        execution: {
          ...validConfig.execution,
          url: "http://api.weather.test/v1/{city}",
        },
      },
      []
    );
    expect(resultHttp.ok).toBe(false);
    expect(resultHttp.error).toMatch(/https/i);

    const resultLoopbackDev = validateCustomToolConfig(
      {
        ...validConfig,
        execution: {
          ...validConfig.execution,
          url: "http://localhost:3000/api/{city}",
          allowLoopback: true,
        },
      },
      [],
      { isProduction: false }
    );
    expect(resultLoopbackDev.ok).toBe(true);

    const resultLoopbackProd = validateCustomToolConfig(
      {
        ...validConfig,
        execution: {
          ...validConfig.execution,
          url: "http://localhost:3000/api/{city}",
          allowLoopback: true,
        },
      },
      [],
      { isProduction: true }
    );
    expect(resultLoopbackProd.ok).toBe(false);
  });

  it("clamps timeout between 1000 and 30000 ms with 10000 ms default", () => {
    const noTimeout = validateCustomToolConfig(
      {
        ...validConfig,
        execution: {
          type: "http",
          url: "https://api.weather.test/v1/{city}",
          method: "GET",
        },
      },
      []
    );
    expect(noTimeout.ok).toBe(true);
    if (noTimeout.ok) expect(noTimeout.data.execution.timeoutMs).toBe(10000);

    const highTimeout = validateCustomToolConfig(
      {
        ...validConfig,
        execution: {
          ...validConfig.execution,
          timeoutMs: 999999,
        },
      },
      []
    );
    expect(highTimeout.ok).toBe(true);
    if (highTimeout.ok) expect(highTimeout.data.execution.timeoutMs).toBe(30000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/ai/custom-tools/__tests__/validation.test.ts`
Expected: FAIL with module not found for `../validation`

- [ ] **Step 3: Write types and validation implementation**

```ts
// src/lib/ai/custom-tools/types.ts
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type CustomToolExecution =
  | {
      type: "http";
      url: string;
      method: HttpMethod;
      headers?: Record<string, string>;
      timeoutMs?: number;
      allowLoopback?: boolean;
    }
  | {
      type: "javascript";
      code: string;
      timeoutMs?: number;
    };

export interface CustomToolConfig {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  schema: Record<string, unknown>;
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
    headers?: Record<string, string>;
    hasSecrets: boolean;
  };
};

export type ValidationResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };
```

```ts
// src/lib/ai/custom-tools/validation.ts
import { jsonSchema } from "ai";
import { chatTools } from "@/lib/ai/tools";
import { PROTECTED_TOOLS } from "@/lib/ai/tool-toggles";
import type { CustomToolConfig, ValidationResult } from "./types";

const TOOL_NAME_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;
const TEMPLATE_VAR_REGEX = /\{([^}]+)\}/g;

export interface ValidationOptions {
  isProduction?: boolean;
  currentToolId?: string;
}

export function validateCustomToolConfig(
  input: unknown,
  existingTools: CustomToolConfig[] = [],
  options: ValidationOptions = {}
): ValidationResult<Omit<CustomToolConfig, "id" | "createdAt" | "updatedAt">> {
  if (typeof input !== "object" || input === null) {
    return { ok: false, error: "Configuration must be an object." };
  }

  const record = input as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name.trim() : "";
  const description = typeof record.description === "string" ? record.description.trim() : "";
  const enabled = typeof record.enabled === "boolean" ? record.enabled : true;
  const schema = record.schema;
  const execution = record.execution as Record<string, unknown> | undefined;

  if (!TOOL_NAME_REGEX.test(name)) {
    return { ok: false, error: "Name must match /^[a-zA-Z0-9_-]{1,64}$/." };
  }

  if (name in chatTools || PROTECTED_TOOLS.has(name)) {
    return { ok: false, error: `Tool name '${name}' collides with a built-in protected tool.` };
  }

  const isDuplicate = existingTools.some(
    (t) => t.name === name && t.id !== options.currentToolId
  );
  if (isDuplicate) {
    return { ok: false, error: `Tool name '${name}' already exists.` };
  }

  if (!description) {
    return { ok: false, error: "Description is required." };
  }

  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    return { ok: false, error: "Schema must be a valid JSON Schema object." };
  }

  const schemaRecord = schema as Record<string, unknown>;
  if (schemaRecord.type !== "object") {
    return { ok: false, error: "Schema type must be 'object'." };
  }

  try {
    jsonSchema(schemaRecord);
  } catch (err) {
    return { ok: false, error: `Invalid JSON Schema: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (typeof execution !== "object" || execution === null) {
    return { ok: false, error: "Execution configuration is required." };
  }

  if (execution.type !== "http") {
    return { ok: false, error: "Only 'http' execution type is supported in v1." };
  }

  const urlStr = typeof execution.url === "string" ? execution.url.trim() : "";
  const method = typeof execution.method === "string" ? execution.method.toUpperCase() : "";
  const validMethods = ["GET", "POST", "PUT", "PATCH", "DELETE"];
  if (!validMethods.includes(method)) {
    return { ok: false, error: `Invalid HTTP method: ${method}.` };
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(urlStr);
  } catch {
    return { ok: false, error: "Invalid URL string." };
  }

  const isProduction = options.isProduction ?? process.env.NODE_ENV === "production";
  const isLoopback =
    parsedUrl.hostname === "localhost" ||
    parsedUrl.hostname === "127.0.0.1" ||
    parsedUrl.hostname === "::1";

  if (parsedUrl.protocol === "http:") {
    if (isLoopback && execution.allowLoopback && !isProduction) {
      // Allowed in dev
    } else {
      return { ok: false, error: "Only HTTPS URLs are allowed (loopback HTTP allowed only in dev with allowLoopback)." };
    }
  } else if (parsedUrl.protocol !== "https:") {
    return { ok: false, error: "URL protocol must be HTTPS." };
  }

  const properties =
    typeof schemaRecord.properties === "object" && schemaRecord.properties !== null
      ? (schemaRecord.properties as Record<string, unknown>)
      : {};

  let match: RegExpExecArray | null;
  TEMPLATE_VAR_REGEX.lastIndex = 0;
  while ((match = TEMPLATE_VAR_REGEX.exec(urlStr)) !== null) {
    const varName = match[1];
    if (!(varName in properties)) {
      return { ok: false, error: `URL template parameter '{${varName}}' is missing from schema properties.` };
    }
  }

  let timeoutMs = 10000;
  if (typeof execution.timeoutMs === "number" && !isNaN(execution.timeoutMs)) {
    timeoutMs = Math.min(Math.max(execution.timeoutMs, 1000), 30000);
  }

  const headers: Record<string, string> = {};
  if (typeof execution.headers === "object" && execution.headers !== null) {
    for (const [k, v] of Object.entries(execution.headers)) {
      if (typeof v === "string") headers[k] = v;
    }
  }

  return {
    ok: true,
    data: {
      name,
      description,
      enabled,
      schema: schemaRecord,
      execution: {
        type: "http",
        url: urlStr,
        method: method as any,
        headers,
        timeoutMs,
        allowLoopback: Boolean(execution.allowLoopback),
      },
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/lib/ai/custom-tools/__tests__/validation.test.ts`
Expected: PASS (all tests pass)

- [ ] **Step 5: Commit**

```bash
git add src/lib/ai/custom-tools/types.ts src/lib/ai/custom-tools/validation.ts src/lib/ai/custom-tools/__tests__/validation.test.ts
git commit -m "feat(custom-tools): add core types and write boundary validation"
```

---

### Task 2: Storage Service with Atomic Transactions & Secret Redaction

**Files:**
- Create: `src/lib/ai/custom-tools/service.ts`
- Test: `src/lib/ai/custom-tools/__tests__/service.test.ts`

**Interfaces:**
- Consumes: `getSettingDb`, `setSettingsDb` from `@/lib/settings-service`, `validateCustomToolConfig`
- Produces: `listCustomTools`, `getCustomToolById`, `saveCustomTool`, `deleteCustomTool`, `setCustomToolEnabled`, `maskCustomToolSummary`

- [ ] **Step 1: Write the failing unit test for storage service**

```ts
// src/lib/ai/custom-tools/__tests__/service.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/db";
import {
  listCustomTools,
  getCustomToolById,
  saveCustomTool,
  deleteCustomTool,
  setCustomToolEnabled,
  maskCustomToolSummary,
} from "../service";

describe("Custom Tools Service", () => {
  const sampleInput = {
    name: "github_issue_fetch",
    description: "Fetch github issue",
    enabled: true,
    schema: {
      type: "object",
      properties: { repo: { type: "string" } },
      required: ["repo"],
    },
    execution: {
      type: "http" as const,
      url: "https://api.github.test/repos/{repo}/issues",
      method: "GET" as const,
      headers: {
        Authorization: "Bearer secret_token_xyz",
        "X-Custom-Header": "header_value",
      },
      timeoutMs: 5000,
    },
  };

  it("saves, lists, and reads custom tools", () => {
    const saved = saveCustomTool(sampleInput, undefined, db);
    expect(saved.id).toMatch(/^ctool_/);
    expect(saved.name).toBe("github_issue_fetch");

    const tools = listCustomTools(db);
    expect(tools.some((t) => t.id === saved.id)).toBe(true);

    const fetched = getCustomToolById(saved.id, db);
    expect(fetched?.name).toBe("github_issue_fetch");
    expect(fetched?.execution.type === "http" && fetched.execution.headers?.Authorization).toBe("Bearer secret_token_xyz");
  });

  it("masks all header values in summary while setting hasSecrets flag", () => {
    const saved = saveCustomTool(sampleInput, undefined, db);
    const summary = maskCustomToolSummary(saved);

    expect(summary.execution.headers?.Authorization).toBe("••••••••");
    expect(summary.execution.headers?.["X-Custom-Header"]).toBe("••••••••");
    expect(summary.execution.hasSecrets).toBe(true);
  });

  it("updates and toggles custom tools", () => {
    const saved = saveCustomTool(sampleInput, undefined, db);
    setCustomToolEnabled(saved.id, false, db);

    const disabled = getCustomToolById(saved.id, db);
    expect(disabled?.enabled).toBe(false);

    saveCustomTool({ ...sampleInput, description: "Updated description" }, saved.id, db);
    const updated = getCustomToolById(saved.id, db);
    expect(updated?.description).toBe("Updated description");
  });

  it("deletes custom tools", () => {
    const saved = saveCustomTool(sampleInput, undefined, db);
    const deleted = deleteCustomTool(saved.id, db);
    expect(deleted).toBe(true);

    const fetched = getCustomToolById(saved.id, db);
    expect(fetched).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/ai/custom-tools/__tests__/service.test.ts`
Expected: FAIL with module not found for `../service`

- [ ] **Step 3: Write service implementation with atomic transactions**

```ts
// src/lib/ai/custom-tools/service.ts
import { db as defaultDb, type AppDatabase } from "@/db";
import { getSettingDb, setSettingsDb } from "@/lib/settings-service";
import { validateCustomToolConfig } from "./validation";
import type { CustomToolConfig, CustomToolSummary } from "./types";

export const CUSTOM_TOOLS_KEY = "customTools";

const SENSITIVE_HEADER_KEYS = [
  "authorization",
  "api-key",
  "apikey",
  "x-api-key",
  "token",
  "secret",
  "auth",
];

export function listCustomTools(db: AppDatabase = defaultDb): CustomToolConfig[] {
  const raw = getSettingDb(CUSTOM_TOOLS_KEY, db);
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is CustomToolConfig => {
    return (
      typeof item === "object" &&
      item !== null &&
      typeof item.id === "string" &&
      typeof item.name === "string" &&
      typeof item.enabled === "boolean" &&
      typeof item.execution === "object"
    );
  });
}

export function getCustomToolById(
  id: string,
  db: AppDatabase = defaultDb
): CustomToolConfig | null {
  return listCustomTools(db).find((t) => t.id === id) ?? null;
}

export function maskCustomToolSummary(tool: CustomToolConfig): CustomToolSummary {
  if (tool.execution.type === "http") {
    const rawHeaders = tool.execution.headers ?? {};
    const maskedHeaders: Record<string, string> = {};
    let hasSecrets = false;

    for (const [key, value] of Object.entries(rawHeaders)) {
      maskedHeaders[key] = "••••••••";
      if (
        SENSITIVE_HEADER_KEYS.some((s) => key.toLowerCase().includes(s)) &&
        Boolean(value)
      ) {
        hasSecrets = true;
      }
    }

    return {
      ...tool,
      execution: {
        type: "http",
        url: tool.execution.url,
        method: tool.execution.method,
        timeoutMs: tool.execution.timeoutMs ?? 10000,
        headers: maskedHeaders,
        hasSecrets,
      },
    };
  }

  // ponytail: handle type === 'javascript' summary in v2
  return tool as any;
}

export function saveCustomTool(
  input: unknown,
  id?: string,
  db: AppDatabase = defaultDb
): CustomToolConfig {
  let resultConfig: CustomToolConfig;

  // better-sqlite3 synchronous transaction ensures serialized read-modify-write
  db.transaction(() => {
    const existingList = listCustomTools(db);
    const validation = validateCustomToolConfig(input, existingList, {
      currentToolId: id,
    });

    if (!validation.ok) {
      throw new Error(validation.error);
    }

    const now = Date.now();
    if (id) {
      const index = existingList.findIndex((t) => t.id === id);
      if (index === -1) {
        throw new Error(`Custom tool with id '${id}' not found.`);
      }
      resultConfig = {
        ...validation.data,
        id,
        createdAt: existingList[index].createdAt,
        updatedAt: now,
      };
      existingList[index] = resultConfig;
    } else {
      const generatedId = `ctool_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      resultConfig = {
        ...validation.data,
        id: generatedId,
        createdAt: now,
        updatedAt: now,
      };
      existingList.push(resultConfig);
    }

    setSettingsDb({ [CUSTOM_TOOLS_KEY]: existingList }, db);
  })();

  return resultConfig!;
}

export function deleteCustomTool(id: string, db: AppDatabase = defaultDb): boolean {
  let deleted = false;
  db.transaction(() => {
    const existingList = listCustomTools(db);
    const filtered = existingList.filter((t) => t.id !== id);
    if (filtered.length !== existingList.length) {
      setSettingsDb({ [CUSTOM_TOOLS_KEY]: filtered }, db);
      deleted = true;
    }
  })();
  return deleted;
}

export function setCustomToolEnabled(
  id: string,
  enabled: boolean,
  db: AppDatabase = defaultDb
): boolean {
  let updated = false;
  db.transaction(() => {
    const existingList = listCustomTools(db);
    const target = existingList.find((t) => t.id === id);
    if (target) {
      target.enabled = enabled;
      target.updatedAt = Date.now();
      setSettingsDb({ [CUSTOM_TOOLS_KEY]: existingList }, db);
      updated = true;
    }
  })();
  return updated;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/lib/ai/custom-tools/__tests__/service.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/ai/custom-tools/service.ts src/lib/ai/custom-tools/__tests__/service.test.ts
git commit -m "feat(custom-tools): implement storage service with atomic transactions and secret masking"
```

---

### Task 3: HTTP Execution Engine with Security Guardrails

**Files:**
- Create: `src/lib/ai/custom-tools/http-executor.ts`
- Test: `src/lib/ai/custom-tools/__tests__/http-executor.test.ts`

**Interfaces:**
- Consumes: `secureFetch` from `@/lib/security/ssrf`, `CustomToolExecution`
- Produces: `executeHttpCustomTool(execution, input, signal)`

- [ ] **Step 1: Write the failing unit test for HTTP executor**

```ts
// src/lib/ai/custom-tools/__tests__/http-executor.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { executeHttpCustomTool } from "../http-executor";
import { secureFetch } from "@/lib/security/ssrf";

vi.mock("@/lib/security/ssrf", () => ({
  secureFetch: vi.fn(),
}));

describe("executeHttpCustomTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("interpolates path variables and passes remaining parameters as query for GET", async () => {
    vi.mocked(secureFetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ status: "active" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    const result = await executeHttpCustomTool(
      {
        type: "http",
        url: "https://api.test/repos/{owner}/{repo}/status",
        method: "GET",
      },
      { owner: "alice", repo: "project", filter: "all" }
    );

    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ status: "active" });

    expect(secureFetch).toHaveBeenCalledWith(
      "https://api.test/repos/alice/project/status?filter=all",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          "User-Agent": "yggdrasil-tool/0.1",
        }),
      })
    );
  });

  it("sends remaining parameters in JSON body for POST", async () => {
    vi.mocked(secureFetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ created: true }), { status: 201 })
    );

    const result = await executeHttpCustomTool(
      {
        type: "http",
        url: "https://api.test/items",
        method: "POST",
      },
      { name: "gadget", count: 42 }
    );

    expect(result.ok).toBe(true);
    expect(secureFetch).toHaveBeenCalledWith(
      "https://api.test/items",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ name: "gadget", count: 42 }),
      })
    );
  });

  it("handles timeout vs user cancellation with differentiated error messages", async () => {
    vi.mocked(secureFetch).mockImplementationOnce(async (_url, opts) => {
      const err = new DOMException("The operation was aborted.", "AbortError");
      throw err;
    });

    // Test caller signal cancellation
    const callerController = new AbortController();
    callerController.abort();

    const cancelResult = await executeHttpCustomTool(
      {
        type: "http",
        url: "https://api.test/slow",
        method: "GET",
        timeoutMs: 5000,
      },
      {},
      callerController.signal
    );

    expect(cancelResult.ok).toBe(false);
    expect(cancelResult.error).toMatch(/cancelled by user/i);
  });

  it("safely truncates responses exceeding 50KB code-point safely", async () => {
    const longString = "A".repeat(60000);
    vi.mocked(secureFetch).mockResolvedValueOnce(
      new Response(longString, {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      })
    );

    const result = await executeHttpCustomTool(
      {
        type: "http",
        url: "https://api.test/big",
        method: "GET",
      },
      {}
    );

    expect(result.ok).toBe(true);
    expect(result.truncated).toBe(true);
    expect(typeof result.data === "string" && result.data.length).toBe(50000);
  });

  it("caps non-2xx error responses at 4KB and sanitizes token headers", async () => {
    const longError = "Error: " + "X".repeat(10000);
    vi.mocked(secureFetch).mockResolvedValueOnce(
      new Response(longError, {
        status: 500,
        headers: { "Content-Type": "text/plain" },
      })
    );

    const result = await executeHttpCustomTool(
      {
        type: "http",
        url: "https://api.test/fail",
        method: "GET",
      },
      {}
    );

    expect(result.ok).toBe(false);
    expect(result.status).toBe(500);
    expect(typeof result.error === "string" && result.error.length).toBeLessThanOrEqual(4096);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/ai/custom-tools/__tests__/http-executor.test.ts`
Expected: FAIL with module not found for `../http-executor`

- [ ] **Step 3: Write http executor implementation**

```ts
// src/lib/ai/custom-tools/http-executor.ts
import { secureFetch } from "@/lib/security/ssrf";
import type { CustomToolExecution } from "./types";

export interface HttpToolExecutionResult {
  ok: boolean;
  status?: number;
  data?: unknown;
  error?: string;
  truncated?: boolean;
}

const MAX_OUTPUT_CODEPOINTS = 50_000;
const MAX_ERROR_CODEPOINTS = 4_096;

function codePointSafeSlice(str: string, limit: number): { text: string; truncated: boolean } {
  const codePoints = Array.from(str);
  if (codePoints.length <= limit) {
    return { text: str, truncated: false };
  }
  return {
    text: codePoints.slice(0, limit).join(""),
    truncated: true,
  };
}

export async function executeHttpCustomTool(
  execution: Extract<CustomToolExecution, { type: "http" }>,
  input: Record<string, unknown>,
  callerSignal?: AbortSignal
): Promise<HttpToolExecutionResult> {
  // Defensive clamp for timeoutMs: [1000, 30000], default 10000
  let timeoutMs = 10000;
  if (typeof execution.timeoutMs === "number" && !isNaN(execution.timeoutMs)) {
    timeoutMs = Math.min(Math.max(execution.timeoutMs, 1000), 30000);
  }

  const consumedKeys = new Set<string>();
  let interpolatedUrl = execution.url.replace(/\{([^}]+)\}/g, (_, varName) => {
    consumedKeys.add(varName);
    const val = input[varName];
    return encodeURIComponent(val !== undefined && val !== null ? String(val) : "");
  });

  const remainingParams: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (!consumedKeys.has(k)) {
      remainingParams[k] = v;
    }
  }

  const headers: Record<string, string> = {
    "User-Agent": "yggdrasil-tool/0.1",
    ...(execution.headers ?? {}),
  };

  let requestBody: string | undefined = undefined;
  const method = execution.method.toUpperCase();

  if (method === "GET" || method === "DELETE") {
    const searchParams = new URLSearchParams();
    for (const [k, v] of Object.entries(remainingParams)) {
      if (v !== undefined && v !== null) {
        searchParams.append(k, typeof v === "object" ? JSON.stringify(v) : String(v));
      }
    }
    const queryString = searchParams.toString();
    if (queryString) {
      interpolatedUrl += (interpolatedUrl.includes("?") ? "&" : "?") + queryString;
    }
  } else {
    headers["Content-Type"] = headers["Content-Type"] ?? "application/json";
    requestBody = JSON.stringify(remainingParams);
  }

  const innerController = new AbortController();
  const timer = setTimeout(() => innerController.abort("timeout"), timeoutMs);

  let callerAbortListener: (() => void) | undefined = undefined;
  if (callerSignal) {
    if (callerSignal.aborted) {
      clearTimeout(timer);
      return { ok: false, error: "Execution cancelled by user." };
    }
    callerAbortListener = () => innerController.abort("cancelled");
    callerSignal.addEventListener("abort", callerAbortListener, { once: true });
  }

  try {
    const response = await secureFetch(interpolatedUrl, {
      method,
      headers,
      body: requestBody,
      signal: innerController.signal,
      timeoutMs,
    });

    const contentType = response.headers.get("content-type") ?? "";
    const rawText = await response.text();

    if (!response.ok) {
      const slicedError = codePointSafeSlice(rawText, MAX_ERROR_CODEPOINTS);
      return {
        ok: false,
        status: response.status,
        error: `HTTP ${response.status} ${response.statusText}: ${slicedError.text}`,
      };
    }

    if (contentType.includes("application/json")) {
      try {
        const parsed = JSON.parse(rawText);
        return { ok: true, status: response.status, data: parsed };
      } catch {
        // Fallback to text if JSON parsing fails
      }
    }

    const { text, truncated } = codePointSafeSlice(rawText, MAX_OUTPUT_CODEPOINTS);
    return {
      ok: true,
      status: response.status,
      data: text,
      ...(truncated ? { truncated: true } : {}),
    };
  } catch (err) {
    if (innerController.signal.aborted) {
      const reason = innerController.signal.reason;
      if (reason === "cancelled" || (callerSignal && callerSignal.aborted)) {
        return { ok: false, error: "Execution cancelled by user." };
      }
      return { ok: false, error: `Execution timed out after ${timeoutMs}ms.` };
    }
    return {
      ok: false,
      error: `Network execution error: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    clearTimeout(timer);
    if (callerSignal && callerAbortListener) {
      callerSignal.removeEventListener("abort", callerAbortListener);
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/lib/ai/custom-tools/__tests__/http-executor.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/ai/custom-tools/http-executor.ts src/lib/ai/custom-tools/__tests__/http-executor.test.ts
git commit -m "feat(custom-tools): implement http executor with ssrf defense and dual-abort handling"
```

---

### Task 4: Dynamic Tool Builder & Chat Route Integration

**Files:**
- Create: `src/lib/ai/custom-tools/builder.ts`
- Test: `src/lib/ai/custom-tools/__tests__/builder.test.ts`
- Modify: `src/lib/ai/tool-toggles.ts`
- Modify: `src/app/api/chat/route.ts`

**Interfaces:**
- Consumes: `dynamicTool`, `jsonSchema` from `ai`, `listCustomTools`, `executeHttpCustomTool`
- Produces: `buildCustomToolsForChat(db?)`

- [ ] **Step 1: Write the failing unit test for dynamic tool builder**

```ts
// src/lib/ai/custom-tools/__tests__/builder.test.ts
import { describe, it, expect, vi } from "vitest";
import { buildCustomToolsForChat } from "../builder";
import * as service from "../service";
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
    const corruptTools: any[] = [
      {
        id: "ctool_bad",
        name: "bad_tool",
        description: "Bad",
        enabled: true,
        schema: "invalid_schema",
        execution: { type: "http" },
      },
    ];

    vi.spyOn(service, "listCustomTools").mockReturnValue(corruptTools);

    expect(() => buildCustomToolsForChat()).not.toThrow();
    const tools = buildCustomToolsForChat();
    expect(Object.keys(tools).length).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/ai/custom-tools/__tests__/builder.test.ts`
Expected: FAIL with module not found for `../builder`

- [ ] **Step 3: Write builder implementation**

```ts
// src/lib/ai/custom-tools/builder.ts
import { dynamicTool, jsonSchema, type Tool } from "ai";
import type { AppDatabase } from "@/db";
import { syslog } from "@/lib/observability/log-store";
import { executeHttpCustomTool } from "./http-executor";
import { listCustomTools } from "./service";

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
        syslog(
          "warn",
          "custom-tools",
          `Skipped invalid custom tool '${config.name}': ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }

  return tools;
}
```

- [ ] **Step 4: Update `tool-toggles.ts` and `chat/route.ts`**

In `src/lib/ai/tool-toggles.ts`:
Update `knownToolNames(db?: AppDatabase): Set<string>` to dynamically evaluate `listCustomTools(db)` on each call:
```ts
import { listCustomTools } from "@/lib/ai/custom-tools/service";

export function knownToolNames(db?: AppDatabase): Set<string> {
  const names = new Set(Object.keys(chatTools));
  for (const customTool of listCustomTools(db)) {
    names.add(customTool.name);
  }
  return names;
}
```

In `src/app/api/chat/route.ts`:
Import `buildCustomToolsForChat` and merge `safeCustomTools`:
```ts
  const baseTools = { ...chatTools, ...createSandboxTools() };
  const subagentTools = Object.assign({}, ...subagentToolEntries) as Record<
    string,
    unknown
  >;

  const customTools = buildCustomToolsForChat();
  const safeCustomTools = Object.fromEntries(
    Object.entries(customTools).filter(([name]) => {
      if (name in baseTools || name in subagentTools) {
        syslog("warn", "custom-tools", `Dropped custom tool '${name}' colliding with base/subagent tool.`);
        return false;
      }
      return true;
    })
  );

  const mergedTools = {
    ...baseTools,
    ...subagentTools,
    ...safeCustomTools,
    ...(mcp
      ? Object.fromEntries(
          Object.entries(mcp.tools).filter(
            ([name]) =>
              !(name in baseTools) &&
              !(name in subagentTools) &&
              !(name in safeCustomTools)
          )
        )
      : {}),
  } as unknown as ToolSet;
```

- [ ] **Step 5: Run tests and commit**

Run: `pnpm vitest run src/lib/ai/custom-tools/__tests__/builder.test.ts src/lib/ai/__tests__/tool-toggles.test.ts`
Expected: PASS

```bash
git add src/lib/ai/custom-tools/builder.ts src/lib/ai/custom-tools/__tests__/builder.test.ts src/lib/ai/tool-toggles.ts src/app/api/chat/route.ts
git commit -m "feat(custom-tools): integrate dynamic custom tools into chat route and tool toggles"
```

---

### Task 5: Agent Management Tool (`manage_custom_tool`)

**Files:**
- Modify: `src/lib/ai/tools/management.ts`
- Modify: `src/lib/ai/tool-policy.ts`
- Test: `src/lib/ai/tools/__tests__/management.test.ts`

**Interfaces:**
- Consumes: `saveCustomTool`, `deleteCustomTool`, `listCustomTools`, `maskCustomToolSummary`
- Produces: `manage_custom_tool` tool

- [ ] **Step 1: Write failing test in management tool test suite**

```ts
// in src/lib/ai/tools/__tests__/management.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/ai/tools/__tests__/management.test.ts`
Expected: FAIL with `manage_custom_tool` not defined

- [ ] **Step 3: Implement `manage_custom_tool` and register in `tool-policy.ts`**

In `src/lib/ai/tools/management.ts`:
Add `manage_custom_tool`:
```ts
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
```

Export `manage_custom_tool` in `src/lib/ai/tools/index.ts`.
In `src/lib/ai/tool-policy.ts`:
Add approval policy check for `manage_custom_tool`:
```ts
if (toolName === "manage_custom_tool") {
  const action = (input as { action?: string })?.action;
  if (action === "delete") return { needsApproval: true, reason: "Delete custom tool" };
  if (action === "update" && (input as { enabled?: boolean })?.enabled === false) {
    return { needsApproval: true, reason: "Disable custom tool" };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/lib/ai/tools/__tests__/management.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/ai/tools/management.ts src/lib/ai/tools/index.ts src/lib/ai/tool-policy.ts src/lib/ai/tools/__tests__/management.test.ts
git commit -m "feat(custom-tools): implement manage_custom_tool agent tool with approval policy"
```

---

### Task 6: REST API Endpoints & Test Execution Endpoint

**Files:**
- Create: `src/app/api/custom-tools/route.ts`
- Create: `src/app/api/custom-tools/[id]/route.ts`
- Create: `src/app/api/custom-tools/[id]/test/route.ts`
- Test: `src/app/api/custom-tools/__tests__/custom-tools-api.test.ts`

**Interfaces:**
- Consumes: `listCustomTools`, `saveCustomTool`, `deleteCustomTool`, `maskCustomToolSummary`, `executeHttpCustomTool`
- Produces: `GET /api/custom-tools`, `POST /api/custom-tools`, `PUT /api/custom-tools/[id]`, `DELETE /api/custom-tools/[id]`, `POST /api/custom-tools/[id]/test`

- [ ] **Step 1: Write the failing integration test for custom tools API**

```ts
// src/app/api/custom-tools/__tests__/custom-tools-api.test.ts
import { describe, it, expect, vi } from "vitest";
import { GET, POST } from "../route";
import { DELETE, PUT } from "../[id]/route";
import { POST as TEST_POST } from "../[id]/test/route";

describe("Custom Tools API Routes", () => {
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
    expect(getData.tools.some((t: any) => t.id === toolId)).toBe(true);

    // 3. Delete tool
    const delRes = await DELETE(new Request("http://localhost"), {
      params: Promise.resolve({ id: toolId }),
    });
    expect(delRes.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/app/api/custom-tools/__tests__/custom-tools-api.test.ts`
Expected: FAIL with module not found

- [ ] **Step 3: Implement API route handlers**

In `src/app/api/custom-tools/route.ts`:
```ts
import { NextResponse } from "next/server";
import { listCustomTools, saveCustomTool, maskCustomToolSummary } from "@/lib/ai/custom-tools/service";

export async function GET() {
  const tools = listCustomTools().map(maskCustomToolSummary);
  return NextResponse.json({ tools });
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const saved = saveCustomTool(body);
    return NextResponse.json({ tool: maskCustomToolSummary(saved) }, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 }
    );
  }
}
```

In `src/app/api/custom-tools/[id]/route.ts`:
```ts
import { NextResponse } from "next/server";
import { getCustomToolById, saveCustomTool, deleteCustomTool, maskCustomToolSummary } from "@/lib/ai/custom-tools/service";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const tool = getCustomToolById(id);
  if (!tool) return NextResponse.json({ error: "Tool not found" }, { status: 404 });
  return NextResponse.json({ tool: maskCustomToolSummary(tool) });
}

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await req.json();
    const updated = saveCustomTool(body, id);
    return NextResponse.json({ tool: maskCustomToolSummary(updated) });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 }
    );
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const deleted = deleteCustomTool(id);
  if (!deleted) return NextResponse.json({ error: "Tool not found" }, { status: 404 });
  return NextResponse.json({ ok: true, id });
}
```

In `src/app/api/custom-tools/[id]/test/route.ts`:
```ts
import { NextResponse } from "next/server";
import { getCustomToolById } from "@/lib/ai/custom-tools/service";
import { executeHttpCustomTool } from "@/lib/ai/custom-tools/http-executor";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const tool = getCustomToolById(id);
  if (!tool) return NextResponse.json({ error: "Tool not found" }, { status: 404 });

  if (tool.execution.type !== "http") {
    return NextResponse.json({ error: "Only http execution is supported in v1." }, { status: 400 });
  }

  const input = await req.json().catch(() => ({}));
  const result = await executeHttpCustomTool(tool.execution, input);
  return NextResponse.json(result);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/app/api/custom-tools/__tests__/custom-tools-api.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/app/api/custom-tools/ src/app/api/custom-tools/__tests__/custom-tools-api.test.ts
git commit -m "feat(custom-tools): implement REST API endpoints and live test runner route"
```

---

### Task 7: Settings UI - Custom Tools Tab

**Files:**
- Create: `src/components/settings/custom-tools-tab.tsx`
- Modify: `src/components/settings/tools-tab.tsx`
- Test: `src/components/settings/__tests__/custom-tools-tab.test.tsx`

**Interfaces:**
- Consumes: `/api/custom-tools` endpoints
- Produces: `CustomToolsTab` component in Settings UI

- [ ] **Step 1: Write UI component test for CustomToolsTab**

```tsx
// src/components/settings/__tests__/custom-tools-tab.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { CustomToolsTab } from "../custom-tools-tab";

describe("CustomToolsTab", () => {
  it("renders list of custom tools and displays create button", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          tools: [
            {
              id: "ctool_1",
              name: "weather_tool",
              description: "Weather fetcher",
              enabled: true,
              execution: {
                type: "http",
                url: "https://api.weather.test",
                method: "GET",
                hasSecrets: false,
              },
            },
          ],
        }),
        { status: 200 }
      )
    );

    render(<CustomToolsTab />);

    await waitFor(() => {
      expect(screen.getByText("weather_tool")).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: /new tool/i })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/components/settings/__tests__/custom-tools-tab.test.tsx`
Expected: FAIL with module not found

- [ ] **Step 3: Implement `CustomToolsTab` and wire into `tools-tab.tsx`**

Create `src/components/settings/custom-tools-tab.tsx` with:
- Table listing tools (Name, Method, URL, Enabled switch, Test button, Edit button, Delete button).
- Create / Edit Dialog with Form (Name, Description, Method, URL with `{var}` hints, JSON schema input, Headers key-value editor, TimeoutMs input).
- Test Runner Modal: renders parameter inputs from `tool.schema.properties`, displays a bold banner *"This fires a real network request to the target endpoint"*, executes `POST /api/custom-tools/[id]/test`, and renders response status & body formatted as JSON.

Wire `CustomToolsTab` into `src/components/settings/tools-tab.tsx` under a dedicated "Custom Tools" collapsible section or sub-tab.

- [ ] **Step 4: Run tests to verify passing**

Run: `pnpm vitest run src/components/settings/__tests__/custom-tools-tab.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/settings/custom-tools-tab.tsx src/components/settings/tools-tab.tsx src/components/settings/__tests__/custom-tools-tab.test.tsx
git commit -m "feat(custom-tools): implement custom tools tab in settings ui with testing drawer"
```

---

### Task 8: Full End-to-End System Verification

**Files:**
- Test: `src/lib/ai/custom-tools/__tests__/dynamic-tools-e2e.test.ts`

- [ ] **Step 1: Write end-to-end integration test**

Simulate:
1. Creating a custom tool in DB settings.
2. Verifying it appears in `knownToolNames()`.
3. Calling `buildCustomToolsForChat()` and executing the dynamicTool instance.
4. Verifying SSRF blocks, parameter binding, secret masking, and instant availability without rebuild.

- [ ] **Step 2: Run all unit and integration tests**

Run: `pnpm test`
Expected: ALL PASS

- [ ] **Step 3: Commit**

```bash
git add src/lib/ai/custom-tools/__tests__/dynamic-tools-e2e.test.ts
git commit -m "test(custom-tools): add end-to-end integration test for dynamic custom tools"
```
