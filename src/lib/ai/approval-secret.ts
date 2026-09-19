import { randomBytes } from "node:crypto";
import type { AppDatabase } from "@/db";
import { getSettingDb, setSettingsDb } from "@/lib/settings-service";

/**
 * High-entropy secret used to HMAC-sign tool-approval requests in the
 * chat route's `streamText()` call (passed as `experimental_toolApprovalSecret`).
 *
 * The AI SDK signs each approval request at issuance and verifies the
 * signature when the approval is replayed, binding approvals to this server
 * and preventing client-forged approval responses from bypassing the
 * human-in-the-loop gate.
 *
 * The secret is persisted in the settings key/value store (key
 * `"tool_approval_secret"`) so it survives process restarts — a new secret
 * on every boot would invalidate in-flight approvals and let a stale client
 * replay an old signature.
 */

/** Settings-store key under which the approval HMAC secret is persisted. */
export const TOOL_APPROVAL_SECRET_KEY = "tool_approval_secret";

/** Number of random bytes (>= 16) used to generate the secret. */
const APPROVAL_SECRET_BYTES = 32;

/**
 * Generate a fresh, cryptographically random secret.
 *
 * Uses `crypto.randomBytes` (Node's CSPRNG). Returns a 64-character
 * lowercase hex string (32 bytes → 256 bits of entropy).
 */
export function generateApprovalSecret(): string {
  return randomBytes(APPROVAL_SECRET_BYTES).toString("hex");
}

/**
 * Resolve the approval secret, generating and persisting it on first use.
 *
 * Reads `"tool_approval_secret"` from the settings store. If it does not
 * exist, one is generated via `generateApprovalSecret()`, persisted, and
 * returned. Subsequent calls return the same value — callers in the chat
 * route never re-roll the secret per request.
 *
 * Always returns a secret or throws. There is deliberately no "no secret"
 * fallback: passing `undefined` to `experimental_toolApprovalSecret` disables
 * approval signing entirely, which would let a client forge approval
 * responses and bypass the human-in-the-loop gate. Failing loudly is the
 * safe outcome; degrading silently is not.
 *
 * The read-modify-write below is fully synchronous (better-sqlite3), so it
 * cannot interleave with a concurrent first-boot request in-process.
 *
 * @param db - Optional database handle (defaults to the production DB).
 *   Tests may inject an in-memory DB to exercise persistence in isolation.
 */
export function resolveApprovalSecret(db?: AppDatabase): string {
  const existing = getSettingDb(TOOL_APPROVAL_SECRET_KEY, db);
  if (typeof existing === "string" && existing.length > 0) {
    return existing;
  }

  // First boot (or secret wiped): generate + persist so every subsequent
  // boot reuses the same key.
  const secret = generateApprovalSecret();
  setSettingsDb({ [TOOL_APPROVAL_SECRET_KEY]: secret }, db);
  return secret;
}
