import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

if (typeof window !== "undefined" && process.env.NODE_ENV !== "test") {
  throw new Error("provider-config secrets are server-only");
}

let secretsRoot =
  process.env.YGGDRASIL_PROVIDER_CONFIG_DIR ??
  path.resolve(process.cwd(), "data");

export let SECRETS_PATH = path.join(secretsRoot, "providers.secrets.env");

/** Test-only: repoint the secrets file at a temp directory. */
export function __setSecretsPath(secretsPath: string): void {
  SECRETS_PATH = secretsPath;
}

export function deriveEnvName(providerId: string): string {
  const sanitized = providerId
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "_")
    .replace(/__+/g, "_");
  return `PROVIDER_${sanitized}_API_KEY`;
}

export function parseSecretsEnv(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (key === "") continue;
    let value = line.slice(eq + 1);
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    map.set(key, value);
  }
  return map;
}

export function serializeSecretsEnv(map: Map<string, string>): string {
  let out = "";
  for (const key of [...map.keys()].sort()) {
    const value = map.get(key) ?? "";
    const needsQuotes =
      value.includes("\n") || value.includes("#") || value.includes("=");
    const encoded = needsQuotes
      ? `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
      : value;
    out += `${key}=${encoded}\n`;
  }
  return out;
}

export async function readSecretsMap(): Promise<Map<string, string>> {
  try {
    const text = await readFile(SECRETS_PATH, "utf8");
    return parseSecretsEnv(text);
  } catch {
    // Missing or unreadable secrets file behaves as "no keys configured".
    return new Map();
  }
}

export async function writeSecretsEnv(map: Map<string, string>): Promise<void> {
  await mkdir(path.dirname(SECRETS_PATH), { recursive: true });
  const tmp = `${SECRETS_PATH}.tmp.${process.pid}`;
  await writeFile(tmp, serializeSecretsEnv(map), "utf8");
  await rename(tmp, SECRETS_PATH);
  try {
    await chmod(SECRETS_PATH, 0o600);
  } catch {
    // Best-effort permissions hardening (e.g. unsupported on this platform).
  }
}
