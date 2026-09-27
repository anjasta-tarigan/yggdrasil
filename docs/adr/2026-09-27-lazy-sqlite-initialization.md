# ADR: Lazy SQLite initialization (`@/db` has no import-time side effects)

**Date:** 2026-09-27
**Status:** Accepted
**Decision Owner:** Project Lead

## Context

`src/db/index.ts` used to open the SQLite database and run
`setupFtsAndTriggers()` at module-evaluation time. Next.js's production build
collects page data in parallel worker processes, each of which imports route
modules. Any route that transitively reaches `@/db` therefore opened and
**migrated the live production database during the build**.

Two problems followed:

1. **Build aborts.** `ensureColumn` did a non-atomic check-then-`ALTER`
   (`PRAGMA table_info` → `ALTER TABLE … ADD COLUMN`). Concurrent build workers
   both observed a missing column and both ran the `ALTER`; the loser threw
   `SqliteError: duplicate column name: active_stream_id` and the build failed.
2. **Build mutates user data.** A build should be read-only with respect to the
   user's `data/yggdrasil.db`, but eager init ran schema migrations against it.

## Decision

1. **Defer client creation to first use.** `src/db/index.ts` exports `sqlite` as
   a `Proxy` that opens the real `better-sqlite3` client (pragmas, sqlite-vec,
   `setupFtsAndTriggers`) on first property access. `drizzle(sqlite, …)` only
   reads `constructor` and later calls `prepare`/`transaction`, so constructing
   the ORM object does not open the file. Importing `@/db` is side-effect-free.
2. **Make migrations concurrency-safe regardless.** `ensureColumn` wraps its
   check and `ALTER` in a single `BEGIN IMMEDIATE` transaction, and treats a
   `duplicate column name` error as success (another connection already added
   it). This protects the runtime server and any future concurrent accessor.

## Consequences

- Production builds no longer open or mutate the database; page-data collection
  stays read-only, and the duplicate-column abort is gone.
- The first runtime query opens the database and runs migrations exactly once
  per process — unchanged observable behavior for the server.
- `sqlite` is now a `Proxy`. It forwards `prepare`/`transaction` to the real
  client, reports `Database` for `constructor` and `Database.prototype` for the
  prototype, and honors own properties on its target so `vi.spyOn(sqlite, …)`
  still works. New code must not assume `sqlite instanceof Database` via means
  other than the prototype trap, and must not access the client at module scope.
- Do **not** revert to eager initialization: it reintroduces the build-time
  database mutation and the worker race.

## Alternatives considered

- **Guard with `NEXT_PHASE === "phase-production-build"`.** Narrower, but leaves
  a live-database mutation reachable from any non-build import path and couples
  the database module to a build-tool detail. Lazy init removes the side effect
  entirely.
- **Only fix `ensureColumn`.** Would stop the crash but still let a build migrate
  the user's database. Rejected; both defects are fixed.
