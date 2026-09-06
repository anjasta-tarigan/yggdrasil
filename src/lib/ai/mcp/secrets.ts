/**
 * MCP secrets storage and configuration masking.
 *
 * Reads and writes secrets to the same env file used by
 * `@/lib/ai/provider-config/secrets` (data/providers.secrets.env),
 * reusing its parse/serialize logic. The `maskMcpServerConfig`
 * function strips sensitive values for client-facing JSON.
 */

import {
  readSecretsMap,
  writeSecretsEnv,
} from "@/lib/ai/provider-config/secrets";
import type { McpServerConfig } from "./config";

/**
 * Keys whose env values are considered sensitive and must be masked
 * in any client-facing representation. Matching is case-insensitive
 * substring — any key containing these substrings is masked.
 */
const SENSITIVE_KEY_PATTERNS = /TOKEN|KEY|SECRET|PASSWORD|URL/i;

/**
 * Write one MCP secret to the shared secrets env file.
 * Reuses the atomic write + chmod-600 logic from provider-config.
 */
export async function writeMcpSecret(
  key: string,
  value: string
): Promise<void> {
  const map = await readSecretsMap();
  map.set(key, value);
  await writeSecretsEnv(map);
}

/**
 * Resolve a single MCP secret by key from the shared secrets env file.
 * Returns undefined when the key is absent.
 */
export async function resolveMcpSecret(
  key: string
): Promise<string | undefined> {
  const map = await readSecretsMap();
  return map.get(key);
}

/**
 * Return a deep copy of `config` with sensitive env values replaced by
 * a mask string ("••••••••"). Non-sensitive values (e.g. DEBUG=true,
 * PATH=/usr/bin) are left intact. The original object is never mutated.
 */
export function maskMcpServerConfig(
  config: McpServerConfig
): McpServerConfig {
  if (!config.env) return config;

  const maskedEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(config.env)) {
    if (SENSITIVE_KEY_PATTERNS.test(key)) {
      maskedEnv[key] = "••••••••";
    } else {
      maskedEnv[key] = value;
    }
  }

  return { ...config, env: maskedEnv };
}
