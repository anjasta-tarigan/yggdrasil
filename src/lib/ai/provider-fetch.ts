import { createHash } from "node:crypto";
import type { ProviderEntry } from "./provider-config/schema";
import { resolveApiKeys } from "./provider-config/store";

// Bounded process-local cursors, shared by model instances and SDK retries.
const cursors = new Map<string, { fingerprint: string; next: number }>();

export function createRotatingProviderFetch(
  entry: ProviderEntry,
  transport: typeof fetch = fetch,
): typeof fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const base = new URL(entry.baseUrl);
    if (url.origin !== base.origin || !url.pathname.startsWith(`${base.pathname.replace(/\/$/, "")}/`)) {
      throw new Error("Provider credentials cannot be sent outside the configured endpoint");
    }
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    signal?.throwIfAborted();
    const keys = await resolveApiKeys(entry);
    signal?.throwIfAborted();
    if (keys.length === 0) throw new Error(`Provider "${entry.id}" has no configured API keys`);

    const fingerprint = createHash("sha256").update(JSON.stringify(keys)).digest("hex");
    const cursorId = `${entry.id}|${base.href}`;
    const previous = cursors.get(cursorId);
    const next = previous?.fingerprint === fingerprint ? previous.next % keys.length : 0;
    // No await between reading and advancing the cursor: concurrent calls take different turns.
    cursors.delete(cursorId);
    cursors.set(cursorId, { fingerprint, next: (next + 1) % keys.length });
    if (cursors.size > 100) cursors.delete(cursors.keys().next().value!);

    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
    headers.set("Authorization", `Bearer ${keys[next]}`);
    // Do not follow redirects with provider credentials, even within the same origin.
    return transport(input, { ...init, headers, redirect: "error" });
  };
}
