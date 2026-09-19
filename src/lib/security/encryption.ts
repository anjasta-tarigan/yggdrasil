import crypto from "node:crypto";
import { env } from "@/env";

const ENVELOPE_PREFIX = "enc:v1:";
const HKDF_INFO = "yggdrasil-settings-envelope-v1";
const SENSITIVE_KEY_REGEX = /(api_?key|token|secret|password|auth_?token|client_?secret)/i;

let devWarningLogged = false;

// ponytail: HKDF key derivation from static salt + APP_SECRET is sufficient for single-node SQLite; upgrade to external KMS (AWS KMS, HashiCorp Vault) when moving to multi-tenant cloud.
function deriveKey(secretInput?: string): Buffer {
  if (secretInput) {
    const salt = Buffer.from("yggdrasil-crypto-salt-2026", "utf-8");
    return Buffer.from(crypto.hkdfSync("sha256", secretInput, salt, HKDF_INFO, 32));
  }

  if (env.NODE_ENV === "production" && !env.APP_SECRET) {
    throw new Error("APP_SECRET environment variable is required in production for data-at-rest encryption");
  }

  if (!env.APP_SECRET && !devWarningLogged) {
    console.warn(
      "[Security Warning] APP_SECRET is unset; using insecure development seed for data-at-rest encryption. Set APP_SECRET in .env."
    );
    devWarningLogged = true;
  }

  const masterSecret = env.APP_SECRET || "yggdrasil-dev-default-seed-do-not-use-in-prod";
  const salt = Buffer.from("yggdrasil-crypto-salt-2026", "utf-8");
  return Buffer.from(crypto.hkdfSync("sha256", masterSecret, salt, HKDF_INFO, 32));
}

export function isEncrypted(value: unknown): boolean {
  return typeof value === "string" && value.startsWith(ENVELOPE_PREFIX);
}

export function encrypt(text: string, secret?: string): string {
  const key = deriveKey(secret);
  const iv = crypto.randomBytes(12);
  let ciphertext: Buffer | undefined;
  try {
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    ciphertext = Buffer.concat([cipher.update(text, "utf-8"), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return `${ENVELOPE_PREFIX}${iv.toString("base64")}:${authTag.toString("base64")}:${ciphertext.toString("base64")}`;
  } finally {
    key.fill(0);
    ciphertext?.fill(0);
  }
}

export function decrypt(envelope: string, secret?: string): string {
  if (!isEncrypted(envelope)) return envelope;
  const parts = envelope.slice(ENVELOPE_PREFIX.length).split(":");
  if (parts.length !== 3) {
    throw new Error("Invalid encryption envelope structure");
  }
  const [ivB64, authTagB64, cipherB64] = parts;
  const iv = Buffer.from(ivB64, "base64");
  const authTag = Buffer.from(authTagB64, "base64");
  const ciphertext = Buffer.from(cipherB64, "base64");
  const key = deriveKey(secret);

  let decrypted: Buffer | undefined;
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(authTag);
    decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString("utf-8");
  } finally {
    key.fill(0);
    decrypted?.fill(0);
    ciphertext.fill(0);
  }
}

export function encryptSecretConfig(
  obj: Record<string, unknown>,
  secret?: string
): Record<string, unknown> {
  if (!obj || typeof obj !== "object") return obj;
  const result: Record<string, unknown> = Array.isArray(obj) ? ([] as unknown as Record<string, unknown>) : {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === "string" && SENSITIVE_KEY_REGEX.test(key) && !isEncrypted(value)) {
      result[key] = encrypt(value, secret);
    } else if (typeof value === "object" && value !== null) {
      result[key] = encryptSecretConfig(value as Record<string, unknown>, secret);
    } else {
      result[key] = value;
    }
  }
  return result;
}

export function decryptSecretConfig(
  obj: Record<string, unknown>,
  secret?: string
): Record<string, unknown> {
  if (!obj || typeof obj !== "object") return obj;
  const result: Record<string, unknown> = Array.isArray(obj) ? ([] as unknown as Record<string, unknown>) : {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === "string" && isEncrypted(value)) {
      result[key] = decrypt(value, secret);
    } else if (typeof value === "object" && value !== null) {
      result[key] = decryptSecretConfig(value as Record<string, unknown>, secret);
    } else {
      result[key] = value;
    }
  }
  return result;
}

export function rotateSecretConfig(
  encryptedConfig: Record<string, unknown>,
  oldSecret: string,
  newSecret: string
): Record<string, unknown> {
  const decrypted = decryptSecretConfig(encryptedConfig, oldSecret);
  return encryptSecretConfig(decrypted, newSecret);
}
