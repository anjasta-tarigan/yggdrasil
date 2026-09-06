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
import { MASKED_SECRET_VALUE, type McpServerConfig } from "./config";

export { MASKED_SECRET_VALUE };

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
 * Overlay stored secrets onto a server config:
 *  - For stdio transports, for every key in `config.env`, a value present in
 *    the secrets store wins over the inline value.
 *  - For http/sse transports, for every key in `config.headers`, a value
 *    present in the secrets store wins over the inline value.
 *
 * Missing keys leave their inline values in place. I/O failures propagate —
 * callers must catch and degrade (never fail a connection because secrets
 * could not be read).
 */
export async function resolveSecretsIntoConfig(
  config: McpServerConfig
): Promise<McpServerConfig> {
  if (config.transport === "stdio" && config.env) {
    const resolvedEnv = { ...config.env };
    for (const key of Object.keys(resolvedEnv)) {
      const stored = await resolveMcpSecret(key);
      if (stored !== undefined) resolvedEnv[key] = stored;
    }
    return { ...config, env: resolvedEnv };
  }

  if (
    (config.transport === "http" || config.transport === "sse") &&
    config.headers
  ) {
    const resolvedHeaders = { ...config.headers };
    for (const key of Object.keys(resolvedHeaders)) {
      const stored = await resolveMcpSecret(key);
      if (stored !== undefined) resolvedHeaders[key] = stored;
    }
    return { ...config, headers: resolvedHeaders };
  }

  return config;
}

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
