import { env } from "@/env";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { ProviderIdSchema } from "./schema";

if (typeof window !== "undefined" && env.NODE_ENV !== "test") {
  throw new Error("provider-config secrets are server-only");
}

const secretsRoot =
  env.YGGDRASIL_PROVIDER_CONFIG_DIR ??
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

export function derivePoolEnvName(providerId: string, keyId: string): string {
  const ids = [ProviderIdSchema.parse(providerId), ProviderIdSchema.parse(keyId)];
  // Hash the tuple, not sanitized IDs: case, punctuation and tuple boundaries matter.
  const digest = createHash("sha256").update(JSON.stringify(ids)).digest("hex").toUpperCase();
  return `PROVIDER_POOL_${digest}_API_KEY`;
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
      const doubleQuoted = value.startsWith('"');
      value = value.slice(1, -1);
      if (doubleQuoted) value = value.replace(/\\([\\"])/g, "$1");
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
      /[\n#=\\"']/.test(value);
    const encoded = needsQuotes
      ? `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
      : value;
    out += `${key}=${encoded}\n`;
  }
  return out;
}

export async function readSecretsMap(): Promise<Map<string, string>> {
  try {
    const text = await readFile(/* turbopackIgnore: true */ SECRETS_PATH, "utf8");
    return parseSecretsEnv(text);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      // A missing secrets file behaves as "no keys configured".
      return new Map();
    }
    throw error;
  }
}

export async function writeSecretsEnv(map: Map<string, string>): Promise<void> {
  await mkdir(path.dirname(SECRETS_PATH), { recursive: true });
  const tmp = `${SECRETS_PATH}.tmp.${process.pid}`;
  await writeFile(tmp, serializeSecretsEnv(map), "utf8");
  // Restrict the temp file BEFORE rename so it is never world-readable,
  // even briefly, and never leaks permissively if rename throws.
  // (Not `writeFile(..., { mode })`, which the process umask can widen.)
  try {
    await chmod(tmp, 0o600);
  } catch (error) {
    if (process.platform !== "win32") throw error;
    // Windows: chmod may be unsupported; proceed best-effort.
  }
  await rename(tmp, SECRETS_PATH);
}
