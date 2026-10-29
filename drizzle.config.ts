import { defineConfig } from "drizzle-kit";

/**
 * Drizzle Kit configuration.
 *
 * NOTE: This project does NOT use `drizzle-kit` migration files
 * (`./drizzle/migrations/`). Schema evolution is handled via inline SQL DDL
 * in `src/db/init.ts` (`setupFtsAndTriggers`), using idempotent
 * `CREATE TABLE IF NOT EXISTS` + `ensureColumn()` migrations that run on
 * every database opening.
 *
 * This config exists for:
 * - `pnpm drizzle-kit studio` — GUI database browsing
 * - Future consideration of formal migrations if the inline approach becomes
 *   untenable for complex schema changes (e.g., column renames, type changes).
 *
 * If formal migrations are adopted, run `pnpm drizzle-kit generate` to
 * populate `./drizzle/migrations/` and wire up `db:generate` / `db:migrate`
 * scripts in `package.json`.
 */
export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle/migrations",
  dialect: "sqlite",
  dbCredentials: {
    url: "./data/yggdrasil.db",
  },
});
