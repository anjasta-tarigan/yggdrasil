import { DevToolsTelemetry } from "@ai-sdk/devtools";

/**
 * Returns a DevToolsTelemetry integration when development mode is active
 * and the AI_SDK_DEVTOOLS_ENABLED env flag is set. Returns undefined in
 * production or when the flag is absent, so no capture overhead is incurred
 * in deployed environments.
 *
 * Registration is global (registerTelemetry), so no streamText() changes
 * are needed — the SDK hooks into every generation call automatically.
 */
export function getDevToolsInstance() {
  const isDev = process.env.NODE_ENV === "development";
  const isEnabled = process.env.AI_SDK_DEVTOOLS_ENABLED === "true";
  if (!isDev || !isEnabled) return undefined;
  return DevToolsTelemetry();
}
