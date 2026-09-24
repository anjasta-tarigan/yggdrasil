import { eq } from "drizzle-orm";
import { encrypt, decrypt, isEncrypted } from "@/lib/security/encryption";
import { webProviderSessions } from "@/db/schema";
import { db as defaultDb } from "@/db";
import { env } from "@/env";
import { syslog } from "@/lib/observability/log-store";
import type {
  WebProviderSession,
  WebProviderSessionView,
  DecryptedSessionPayload,
  UserAgentMode,
  SessionStatus,
} from "./types";

export interface SessionStoreOptions {
  db?: typeof defaultDb;
  secret?: string;
}

export function createSessionStore(options: SessionStoreOptions = {}) {
  const secret = options.secret ?? process.env.APP_SECRET ?? env.APP_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("APP_SECRET is required and must be at least 32 characters for Web Provider session storage");
  }
  const db = options.db ?? defaultDb;

  return {
    async getSession(providerId: string): Promise<WebProviderSession | null> {
      const rows = await db
        .select()
        .from(webProviderSessions)
        .where(eq(webProviderSessions.providerId, providerId))
        .limit(1);

      if (rows.length === 0) return null;
      const row = rows[0];

      let payload: DecryptedSessionPayload;
      try {
        if (!isEncrypted(row.encryptedPayload)) {
          throw new Error("Missing or invalid encryption envelope");
        }
        const decryptedJson = decrypt(row.encryptedPayload, secret);
        payload = JSON.parse(decryptedJson);
      } catch (err) {
        syslog(
          "warn",
          "session-store",
          `Failed to decrypt session payload for provider ${providerId}: ${err instanceof Error ? err.message : String(err)}`
        );
        return null;
      }

      return {
        id: row.id,
        providerId: row.providerId,
        userToken: payload.userToken,
        selectedUserAgent: payload.selectedUserAgent,
        status: row.status as SessionStatus,
        lastCheckedAt: row.lastCheckedAt,
        lastFailureCode: row.lastFailureCode,
        userAgentMode: row.userAgentMode as UserAgentMode | null,
        capturedAt: row.capturedAt,
        sessionVersion: row.sessionVersion,
      };
    },

    async getSessionView(providerId: string): Promise<WebProviderSessionView> {
      const rows = await db
        .select({
          providerId: webProviderSessions.providerId,
          status: webProviderSessions.status,
          lastCheckedAt: webProviderSessions.lastCheckedAt,
          userAgentMode: webProviderSessions.userAgentMode,
          capturedAt: webProviderSessions.capturedAt,
        })
        .from(webProviderSessions)
        .where(eq(webProviderSessions.providerId, providerId))
        .limit(1);

      if (rows.length === 0) {
        return {
          providerId,
          status: "not-configured",
          lastCheckedAt: null,
          userAgentMode: null,
          capturedAt: null,
        };
      }

      const r = rows[0];
      return {
        providerId: r.providerId,
        status: r.status as SessionStatus,
        lastCheckedAt: r.lastCheckedAt,
        userAgentMode: r.userAgentMode as UserAgentMode | null,
        capturedAt: r.capturedAt,
      };
    },

    async saveSession(input: {
      providerId: string;
      userToken: string;
      userAgentMode: UserAgentMode;
      selectedUserAgent?: string;
    }): Promise<void> {
      const payload: DecryptedSessionPayload = {
        version: 1,
        userToken: input.userToken,
        selectedUserAgent: input.selectedUserAgent,
      };
      const encryptedPayload = encrypt(JSON.stringify(payload), secret);
      const now = new Date();

      db.transaction((tx) => {
        const existing = tx
          .select({ id: webProviderSessions.id, version: webProviderSessions.sessionVersion })
          .from(webProviderSessions)
          .where(eq(webProviderSessions.providerId, input.providerId))
          .limit(1)
          .all();

        if (existing.length > 0) {
          tx
            .update(webProviderSessions)
            .set({
              encryptedPayload,
              status: "verified",
              lastCheckedAt: now,
              lastFailureCode: null,
              userAgentMode: input.userAgentMode,
              capturedAt: now,
              sessionVersion: existing[0].version + 1,
              updatedAt: now,
            })
            .where(eq(webProviderSessions.id, existing[0].id))
            .run();
        } else {
          tx.insert(webProviderSessions).values({
            id: `wps-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
            providerId: input.providerId,
            encryptedPayload,
            status: "verified",
            lastCheckedAt: now,
            lastFailureCode: null,
            userAgentMode: input.userAgentMode,
            capturedAt: now,
            sessionVersion: 1,
            createdAt: now,
            updatedAt: now,
          }).run();
        }
      });
    },

    async updateStatus(
      providerId: string,
      status: SessionStatus,
      failureCode: string | null = null
    ): Promise<void> {
      // Status only: never touches `lastCheckedAt`. A status change says nothing
      // about whether the credential or the discovered model data is still
      // current, so the circuit breaker's disablement must not make stale data
      // look newly discovered (Spec §8.5).
      await db
        .update(webProviderSessions)
        .set({
          status,
          lastFailureCode: failureCode,
          updatedAt: new Date(),
        })
        .where(eq(webProviderSessions.providerId, providerId));
    },

    /**
     * Advances the freshness clock without changing status (Spec §8.5). The
     * chat path's stale TTL reads `lastCheckedAt`, and a successful credential
     * revalidation and a successful model discovery both prove the session is
     * alive, so both call this. Keeping it separate from `updateStatus` means
     * the two writers cannot drift: freshness moves only through this method.
     */
    async touchSessionCheckedAt(providerId: string, at: Date): Promise<void> {
      await db
        .update(webProviderSessions)
        .set({ lastCheckedAt: at, updatedAt: new Date() })
        .where(eq(webProviderSessions.providerId, providerId));
    },

    async deleteSession(providerId: string): Promise<void> {
      await db.delete(webProviderSessions).where(eq(webProviderSessions.providerId, providerId));
    },
  };
}

// Top-level singleton and convenience functions
export const sessionStore =
  typeof window === "undefined" && env.APP_SECRET && env.APP_SECRET.length >= 32
    ? createSessionStore()
    : (null as unknown as ReturnType<typeof createSessionStore>);

function getStore(): ReturnType<typeof createSessionStore> {
  return sessionStore ?? createSessionStore();
}

export async function getWebSession(providerId: string): Promise<WebProviderSession | null> {
  return getStore().getSession(providerId);
}

export async function getWebSessionView(providerId: string): Promise<WebProviderSessionView> {
  return getStore().getSessionView(providerId);
}

export async function saveWebSession(input: {
  providerId: string;
  userToken: string;
  userAgentMode: UserAgentMode;
  selectedUserAgent?: string;
}): Promise<void> {
  return getStore().saveSession(input);
}

export async function updateWebSessionStatus(
  providerId: string,
  status: SessionStatus,
  failureCode: string | null = null
): Promise<void> {
  return getStore().updateStatus(providerId, status, failureCode);
}

export async function touchWebSessionCheckedAt(providerId: string, at: Date): Promise<void> {
  return getStore().touchSessionCheckedAt(providerId, at);
}

export async function deleteWebSession(providerId: string): Promise<void> {
  return getStore().deleteSession(providerId);
}
