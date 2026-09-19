import { db as defaultDb, type AppDatabase } from "@/db";
import { getSettingDb, setSettingsDb } from "@/lib/settings-service";
import { validateCustomToolConfig } from "./validation";
import type { CustomToolConfig, CustomToolSummary } from "./types";

export const CUSTOM_TOOLS_KEY = "customTools";
export const MASKED_HEADER_VALUE = "••••••••";

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
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      return false;
    }
    const candidate = item as Record<string, unknown>;
    const execution = candidate.execution;
    // `execution` must be a plain object with a string `type`. Checking only
    // `typeof execution === "object"` let `null` and arrays through, and
    // maskCustomToolSummary then dereferenced execution.type → 500.
    return (
      typeof candidate.id === "string" &&
      typeof candidate.name === "string" &&
      typeof candidate.enabled === "boolean" &&
      typeof execution === "object" &&
      execution !== null &&
      !Array.isArray(execution) &&
      typeof (execution as Record<string, unknown>).type === "string"
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
      maskedHeaders[key] = MASKED_HEADER_VALUE;
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

  // Unknown execution types must never be returned unmasked: casting through
  // `unknown` here handed callers the raw config (unmasked headers, no
  // hasSecrets flag). Fail loudly instead so a new type is wired up
  // deliberately rather than silently leaking secrets.
  throw new Error(
    `Cannot build a summary for unsupported custom tool execution type: ${String(
      (tool.execution as { type?: unknown }).type
    )}`
  );
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
      const existing = existingList[index];

      let execution = validation.data.execution;
      if (execution.type === "http" && existing.execution.type === "http") {
        // Distinguish "headers omitted" from "headers replaced". The editor
        // sends the complete header list, so a removed row must actually be
        // removed; but a caller that omits `headers` entirely (partial update)
        // must keep the stored set. Validation normalises both to an object,
        // so read presence from the raw input.
        const rawExecution =
          typeof input === "object" && input !== null
            ? (input as Record<string, unknown>).execution
            : undefined;
        const headersProvided =
          typeof rawExecution === "object" &&
          rawExecution !== null &&
          Object.prototype.hasOwnProperty.call(rawExecution, "headers");

        if (headersProvided) {
          const existingHeaders = existing.execution.headers ?? {};
          const incomingHeaders = execution.headers ?? {};
          // Start from the incoming set (so deletions stick) and restore any
          // masked placeholder from the stored config — the client never sees
          // raw secret values, so a round-tripped mask means "unchanged".
          const mergedHeaders: Record<string, string> = {};
          for (const [key, value] of Object.entries(incomingHeaders)) {
            if (
              value === MASKED_HEADER_VALUE &&
              existingHeaders[key] !== undefined
            ) {
              mergedHeaders[key] = existingHeaders[key];
            } else {
              mergedHeaders[key] = value;
            }
          }

          execution = {
            ...execution,
            headers: mergedHeaders,
          };
        } else {
          // `headers` omitted entirely: keep the stored set rather than the
          // empty object validation synthesised.
          execution = {
            ...execution,
            headers: existing.execution.headers ?? {},
          };
        }
      }

      resultConfig = {
        ...validation.data,
        execution,
        id,
        createdAt: existing.createdAt,
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
  });

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
  });
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
  });
  return updated;
}
