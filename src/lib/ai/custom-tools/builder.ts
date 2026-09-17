// ponytail: HTTP dynamicTool mapping only in v1; add sandboxed JS dynamicTool builder when JS executor is introduced.
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
    if (config.execution?.type === "http") {
      const httpExec = config.execution;
      try {
        if (
          typeof config.schema !== "object" ||
          config.schema === null ||
          Array.isArray(config.schema) ||
          typeof httpExec.url !== "string" ||
          !httpExec.url ||
          typeof httpExec.method !== "string" ||
          !httpExec.method
        ) {
          throw new Error("Invalid schema or execution configuration");
        }

        tools[config.name] = dynamicTool({
          description: config.description,
          inputSchema: jsonSchema(config.schema),
          execute: async (input: unknown, { abortSignal }: { abortSignal?: AbortSignal } = {}) => {
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
