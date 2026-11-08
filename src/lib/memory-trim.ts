import { syslog } from "@/lib/observability/log-store";

/**
 * Best-effort return of memory to the OS after heavy work.
 *
 * Two limits worth knowing:
 *  - V8 only exposes `global.gc` when Node runs with `--expose-gc`, which the
 *    launcher env sets. Without the flag this is a silent no-op.
 *  - `global.gc()` is a full stop-the-world collection: on a multi-GB heap it
 *    stalls the event loop for hundreds of ms. Call this at job boundaries
 *    (after a background job, after releasing a native session) — never inside
 *    a request path.
 *
 * glibc arena memory is handled by MALLOC_ARENA_MAX=2 in the launcher env;
 * pure JS cannot call malloc_trim(0) without FFI.
 */
export function trimMemory(context: string): void {
  if (typeof global.gc !== "function") return;
  try {
    global.gc();
  } catch (err) {
    syslog("debug", "memory-trim", `gc failed (${context}): ${err instanceof Error ? err.message : String(err)}`);
  }
}
