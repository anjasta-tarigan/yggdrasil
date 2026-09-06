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
 * Overlay stored secrets onto a server config's stdio env map: for every
 * key in `config.env`, a value present in the secrets store wins over the
 * inline value. Returns the config unchanged for non-stdio transports and
 * when there is no env map. A missing key simply leaves the inline value
 * in place; I/O failures propagate — callers must catch and degrade
 * (never fail a connection because secrets could not be read).
 */
export async function resolveSecretsIntoConfig(
  config: McpServerConfig
): Promise<McpServerConfig> {
  if (config.transport !== "stdio" || !config.env) return config;
  const resolvedEnv = { ...config.env };
  for (const key of Object.keys(resolvedEnv)) {
    const stored = await resolveMcpSecret(key);
    if (stored !== undefined) resolvedEnv[key] = stored;
  }
  return { ...config, env: resolvedEnv };
}

/** Placeholder replacing sensitive values in client-facing configs. */
export const MASKED_SECRET_VALUE = "••••••••";

/**
 * Return a deep copy of `config` with sensitive env values replaced by
 * the mask string. Non-sensitive env values (e.g. DEBUG=true,
 * PATH=/usr/bin) are left intact. Request `headers` are always sensitive
 * (Authorization etc.), so every header value is masked. The original
 * object is never mutated.
 */
export function maskMcpServerConfig(
  config: McpServerConfig
): McpServerConfig {
  let masked: McpServerConfig = config;

  if (config.env) {
    const maskedEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(config.env)) {
      maskedEnv[key] = SENSITIVE_KEY_PATTERNS.test(key)
        ? MASKED_SECRET_VALUE
        : value;
    }
    masked = { ...masked, env: maskedEnv };
  }

  if (config.headers) {
    const maskedHeaders: Record<string, string> = {};
    for (const key of Object.keys(config.headers)) {
      maskedHeaders[key] = MASKED_SECRET_VALUE;
    }
    masked = { ...masked, headers: maskedHeaders };
  }

  return masked;
}
