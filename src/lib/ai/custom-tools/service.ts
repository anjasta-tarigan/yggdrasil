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

  // ponytail: handle type === 'javascript' summary in v2
  return tool as unknown as CustomToolSummary;
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
        const existingHeaders = existing.execution.headers ?? {};
        const incomingHeaders = execution.headers ?? {};
        const mergedHeaders: Record<string, string> = { ...incomingHeaders };

        for (const [key, value] of Object.entries(mergedHeaders)) {
          if (
            (value === MASKED_HEADER_VALUE || value.includes("••••••••")) &&
            existingHeaders[key] !== undefined
          ) {
            mergedHeaders[key] = existingHeaders[key];
          }
        }

        execution = {
          ...execution,
          headers: mergedHeaders,
        };
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
