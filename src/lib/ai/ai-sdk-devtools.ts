import { refreshEnv } from "@/env";
import { DevToolsTelemetry } from "@ai-sdk/devtools";

/**
 * Returns a DevToolsTelemetry integration when development mode is active
 * and the AI_SDK_DEVTOOLS_ENABLED env flag is set. Returns undefined in
 * production or when the flag is absent, so no capture overhead is incurred
 * in deployed environments.
 *
 * Uses `refreshEnv()` instead of the module-level `env` singleton so that
 * runtime env changes (e.g. via `vi.stubEnv` in tests or dynamic reconfiguration)
 * are picked up on each call.
 *
 * Registration is global (registerTelemetry), so no streamText() changes
 * are needed — the SDK hooks into every generation call automatically.
 */
export function getDevToolsInstance() {
  const env = refreshEnv();
  const isDev = env.NODE_ENV === "development";
  const isEnabled = env.AI_SDK_DEVTOOLS_ENABLED === "true";
  if (!isDev || !isEnabled) return undefined;
  return DevToolsTelemetry();
}
