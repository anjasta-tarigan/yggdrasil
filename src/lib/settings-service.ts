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

/**
 * Atomically read-modify-write a single setting inside one transaction.
 *
 * Callers that do `getSettingDb(key)` then `setSettingsDb({ [key]: … })` open a
 * classic lost-update race: two concurrent requests read the same value, both
 * mutate, and the second write silently drops the first's change. This helper
 * performs the read and write within a single SQLite transaction so concurrent
 * mutators are serialized by the database.
 *
 * `mutator` receives the *decrypted* current value (or `undefined`) and returns
 * the new value to persist (or `undefined` to delete the key).
 */
export function mutateSetting<T = unknown>(
  key: string,
  mutator: (current: T | undefined) => T | undefined,
  db: AppDatabase = defaultDb
): void {
  db.transaction((tx) => {
    const [row] = tx.select().from(settings).where(eq(settings.key, key)).all();
    let current: T | undefined;
    if (row?.value !== undefined && row.value !== null) {
      const raw = row.value;
      current =
        typeof raw === "string" && isEncrypted(raw)
          ? (decrypt(raw) as T)
          : (decryptSecretConfig(raw as Record<string, unknown>) as T);
    }
    const next = mutator(current);
    const encrypted = encryptSecretConfig({ [key]: next })[key];
    const now = new Date();
    if (next === undefined) {
      tx.delete(settings).where(eq(settings.key, key)).run();
    } else if (row) {
      tx.update(settings).set({ value: encrypted, updatedAt: now }).where(eq(settings.key, key)).run();
    } else {
      tx.insert(settings).values({ key, value: encrypted, updatedAt: now }).run();
    }
  });
}
