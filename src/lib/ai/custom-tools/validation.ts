// ponytail: Only HTTP execution supported in v1; add sandboxed worker runtime when non-HTTP types needed.
import { jsonSchema } from "ai";
import { env, refreshEnv } from "@/env";
import { chatTools } from "@/lib/ai/tools";
import { PROTECTED_TOOLS } from "@/lib/ai/tool-toggles";
import { SANDBOX_TOOL_NAMES } from "@/lib/ai/tool-names";
import type { CustomToolConfig, HttpMethod, ValidationResult } from "./types";

const TOOL_NAME_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;

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

  if (
    name in chatTools ||
    PROTECTED_TOOLS.has(name) ||
    (SANDBOX_TOOL_NAMES as readonly string[]).includes(name)
  ) {
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
  } catch (err) {
    console.debug(`[validation] Error: ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false, error: "Invalid URL string." };
  }

  // Read NODE_ENV through the validated env schema (Rule 06) rather than
  // process.env. Re-parse under test so suites can stub NODE_ENV, matching the
  // SSRF guard in src/lib/security/ssrf.ts. Both security gates must agree on
  // what "production" means; if they diverge, a loopback http: allowance could
  // survive into production.
  const currentEnv = env.NODE_ENV === "test" ? refreshEnv() : env;
  const isProduction = options.isProduction ?? currentEnv.NODE_ENV === "production";
  const isLoopback =
    parsedUrl.hostname === "localhost" ||
    parsedUrl.hostname === "127.0.0.1" ||
    parsedUrl.hostname === "::1" ||
    parsedUrl.hostname === "[::1]";

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

  const matches = Array.from(urlStr.matchAll(/\{([^}]+)\}/g));
  for (const match of matches) {
    const varName = match[1];
    if (!(varName in properties)) {
      return { ok: false, error: `URL template parameter '{${varName}}' is missing from schema properties.` };
    }
  }

  // Spec §3.2.4: the model's runtime inputs must NOT be able to override the
  // host. A placeholder in the authority (e.g. `https://{host}/path`) would
  // let a model-supplied value rewrite the origin and redirect the request to
  // an attacker-chosen server — SSRF with a legitimate-looking config. Replace
  // each placeholder with an inert sentinel and assert none lands in the
  // hostname, and that none spans the authority delimiter.
  if (matches.length > 0) {
    const sentinel = "yggdrasil-placeholder";
    const probe = urlStr.replace(/\{[^}]+\}/g, sentinel);
    let probeUrl: URL;
    try {
      probeUrl = new URL(probe);
    } catch {
      return { ok: false, error: "URL template is not a valid URL." };
    }
    if (probeUrl.hostname.includes(sentinel)) {
      return {
        ok: false,
        error:
          "URL template parameters may not appear in the host — the model's inputs must not be able to change the request target.",
      };
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
        method: method as HttpMethod,
        headers,
        timeoutMs,
        allowLoopback: Boolean(execution.allowLoopback),
      },
    },
  };
}
