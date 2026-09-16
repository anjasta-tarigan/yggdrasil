import { eq } from "drizzle-orm";
import { db as defaultDb, type AppDatabase } from "@/db";
import { settings } from "@/db/schema";
import {
  encryptSecretConfig,
  decryptSecretConfig,
  decrypt,
  isEncrypted,
} from "@/lib/security/encryption";

/**
 * Server-side settings store backed by the SQLite `settings` table.
 *
 * Values are arbitrary JSON documents keyed by name. Known keys:
 *  - "providers": ProviderConfig[] (user-added AI providers)
 *  - "embedding": { model?: string } (embedding model override)
 *
 * This is the single source of truth for runtime configuration; the
 * browser client hydrates from it and never persists settings locally.
 */

/** Read one setting value; undefined when the key does not exist. */
export function getSettingDb(
  key: string,
  db: AppDatabase = defaultDb
): unknown {
  const [row] = db.select().from(settings).where(eq(settings.key, key)).all();
  if (row?.value === undefined || row.value === null) {
    return row?.value;
  }
  if (typeof row.value === "string" && isEncrypted(row.value)) {
    return decrypt(row.value);
  }
  if (typeof row.value === "object") {
    return decryptSecretConfig(row.value as Record<string, unknown>);
  }
  return row.value;
}

/** Read every setting as a plain object. */
export function getSettingsDb(
  db: AppDatabase = defaultDb
): Record<string, unknown> {
  const rows = db.select().from(settings).all();
  const raw: Record<string, unknown> = {};
  for (const row of rows) {
    raw[row.key] = row.value;
  }
  return decryptSecretConfig(raw);
}

/**
 * Upsert any number of settings atomically. Passing `undefined` as a
 * value deletes that key.
 */
export function setSettingsDb(
  patch: Record<string, unknown>,
  db: AppDatabase = defaultDb
): void {
  const encryptedPatch = encryptSecretConfig(patch);
  const now = new Date();
  db.transaction((tx) => {
    for (const [key, value] of Object.entries(encryptedPatch)) {
      if (value === undefined) {
        tx.delete(settings).where(eq(settings.key, key)).run();
        continue;
      }
      const [existing] = tx
        .select()
        .from(settings)
        .where(eq(settings.key, key))
        .all();
      if (existing) {
        tx.update(settings)
          .set({ value, updatedAt: now })
          .where(eq(settings.key, key))
          .run();
      } else {
        tx.insert(settings)
          .values({ key, value, updatedAt: now })
          .run();
      }
    }
  });
}
