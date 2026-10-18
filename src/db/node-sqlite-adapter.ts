import type { DatabaseSync, SQLInputValue, StatementSync } from "node:sqlite";
import { entityKind } from "drizzle-orm/entity";
import { fillPlaceholders, sql, type Query } from "drizzle-orm/sql";
// @ts-expect-error — mapResultRow is exported at runtime but not in utils.d.ts
import { mapResultRow } from "drizzle-orm/utils";
import { NoopCache, type Cache } from "drizzle-orm/cache/core";
import type { WithCacheConfig } from "drizzle-orm/cache/core/types";
import { DefaultLogger, NoopLogger, type Logger } from "drizzle-orm/logger";
import {
  type SelectedFieldsOrdered,
  type SQLiteExecuteMethod,
  SQLitePreparedQuery as PreparedQueryBase,
  type PreparedQueryConfig as PreparedQueryConfigBase,
  SQLiteSession,
  type SQLiteTransactionConfig,
} from "drizzle-orm/sqlite-core";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core/dialect";
import { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core/db";
import { SQLiteTransaction } from "drizzle-orm/sqlite-core";
import { type DrizzleConfig, isConfig } from "drizzle-orm/utils";
import {
  createTableRelationsHelpers,
  extractTablesRelationalConfig,
} from "drizzle-orm/relations";
import type {
  RelationalSchemaConfig,
  TablesRelationalConfig,
} from "drizzle-orm/relations";

type RunResult = { changes: number; lastInsertRowid: number | string | Uint8Array };

/**
 * Convert a value into a type that `node:sqlite`'s `StatementSync` can bind.
 *
 * `better-sqlite3` automatically serializes `Date` objects to timestamps, but
 * `node:sqlite` only accepts `SQLInputValue` (number, string, bigint,
 * Uint8Array, null). We normalize `undefined` → `null` and `Date` → timestamp
 * here, and serialize plain objects to JSON strings, replicating
 * `better-sqlite3`'s implicit coercion behavior.
 */
function toSQLiteValue(value: unknown): SQLInputValue {
  if (value === undefined || value === null) {
    return null;
  }
  if (value instanceof Date) {
    return value.getTime();
  }
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }
  if (typeof value === "object" && !(value instanceof Uint8Array) && !(value instanceof Buffer)) {
    return JSON.stringify(value);
  }
  return value as SQLInputValue;
}

type PreparedQueryConfig = Omit<PreparedQueryConfigBase, "statement" | "run">;

type NodeSqlitePreparedQueryConfig = PreparedQueryConfig & {
  type: "sync";
  run: RunResult;
  all: unknown[] | Promise<unknown[]>;
  get: unknown | Promise<unknown>;
  values: unknown[] | Promise<unknown[]>;
  execute: never;
};

/**
 * A Drizzle-ORM PreparedQuery implementation backed by `node:sqlite`'s
 * `StatementSync`. Mirrors the `better-sqlite3` adapter's behavior:
 * - `.run()` returns `{ changes, lastInsertRowid }`
 * - `.all()` returns rows as objects (or mapped via `mapResultRow` when fields are known)
 * - `.get()` returns a single row as object (or mapped)
 * - `.values()` returns rows as arrays (via `setReturnArrays(true)`)
 */
class NodeSqlitePreparedQuery extends PreparedQueryBase<NodeSqlitePreparedQueryConfig> {
  static readonly [entityKind] = "NodeSqlitePreparedQuery";

  stmt: StatementSync;
  logger: Logger;
  fields: SelectedFieldsOrdered | undefined;
  _isResponseInArrayMode: boolean;
  customResultMapper:
    | ((rows: unknown[][], mapColumnValue?: (value: unknown) => unknown) => unknown)
    | undefined;

  constructor(
    stmt: StatementSync,
    query: Query,
    logger: Logger,
    cache: Cache,
    queryMetadata: { type: "select" | "update" | "delete" | "insert"; tables: string[] } | undefined,
    cacheConfig: WithCacheConfig | undefined,
    fields: SelectedFieldsOrdered | undefined,
    executeMethod: SQLiteExecuteMethod,
    isResponseInArrayMode: boolean,
    customResultMapper?: (
      rows: unknown[][],
      mapColumnValue?: (value: unknown) => unknown,
    ) => unknown,
  ) {
    super("sync", executeMethod, query, cache, queryMetadata, cacheConfig);
    this.stmt = stmt;
    this.logger = logger;
    this.fields = fields;
    this._isResponseInArrayMode = isResponseInArrayMode;
    this.customResultMapper = customResultMapper;
  }

  run(placeholderValues?: Record<string, unknown>): RunResult {
    const params = fillPlaceholders(this.query.params, placeholderValues ?? {});
    this.logger.logQuery(this.query.sql, params);
    const result = this.stmt.run(...(params as unknown[]).map(toSQLiteValue));
    return {
      changes: Number(result.changes ?? 0),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      lastInsertRowid: (result.lastInsertRowid as any) ?? 0,
    };
  }

  all(placeholderValues?: Record<string, unknown>): unknown[] | Promise<unknown[]> {
    const { fields, query, logger, stmt, customResultMapper } = this;
    if (!fields && !customResultMapper) {
      const params = fillPlaceholders(query.params, placeholderValues ?? {});
      logger.logQuery(query.sql, params);
      return stmt.all(...(params as unknown[]).map(toSQLiteValue));
    }
    const rows = this.values(placeholderValues) as unknown[][];
    if (customResultMapper) {
      return customResultMapper(rows) as unknown[];
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const joinsNotNullableMap = (this as any).joinsNotNullableMap as Record<string, boolean> | undefined;
    return rows.map((row) =>
      mapResultRow(fields!, row as unknown[], joinsNotNullableMap),
    );
  }

  get(placeholderValues?: Record<string, unknown>): unknown | Promise<unknown> {
    const params = fillPlaceholders(this.query.params, placeholderValues ?? {});
    this.logger.logQuery(this.query.sql, params);
    const { fields, stmt, customResultMapper } = this;
    if (!fields && !customResultMapper) {
      return stmt.get(...(params as unknown[]).map(toSQLiteValue)) as unknown;
    }
    // Use setReturnArrays(true) to get array-mode results for mapResultRow
    stmt.setReturnArrays(true);
    try {
      const row = stmt.get(...(params as unknown[]).map(toSQLiteValue)) as unknown[] | undefined;
      if (!row) {
        return undefined;
      }
      if (customResultMapper) {
        return customResultMapper([row]);
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const joinsNotNullableMap = (this as any).joinsNotNullableMap as Record<string, boolean> | undefined;
      return mapResultRow(fields!, row, joinsNotNullableMap);
    } finally {
      stmt.setReturnArrays(false);
    }
  }

  values(placeholderValues?: Record<string, unknown>): unknown[] | Promise<unknown[]> {
    const params = fillPlaceholders(this.query.params, placeholderValues ?? {});
    this.logger.logQuery(this.query.sql, params);
    // Use setReturnArrays(true) to get array-mode results (mirrors stmt.raw().all() in better-sqlite3)
    this.stmt.setReturnArrays(true);
    try {
      return this.stmt.all(...(params as unknown[]).map(toSQLiteValue)) as unknown as unknown[][];
    } finally {
      this.stmt.setReturnArrays(false);
    }
  }

  /** @internal */
  isResponseInArrayMode(): boolean {
    return this._isResponseInArrayMode;
  }
}

/**
 * Sync Drizzle session backed by `node:sqlite`'s `DatabaseSync`.
 * Mirrors `BetterSQLiteSession` from `drizzle-orm/better-sqlite3`.
 */
class NodeSqliteSession<TFullSchema extends Record<string, unknown>, TSchema extends TablesRelationalConfig> extends SQLiteSession<
  "sync",
  RunResult,
  TFullSchema,
  TSchema
> {
  static readonly [entityKind] = "NodeSqliteSession";

  client: DatabaseSync;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  dialect: any;
  schema: RelationalSchemaConfig<TSchema> | undefined;
  logger: Logger;
  cache: Cache;
  private _txDepth: number;

  constructor(
    client: DatabaseSync,
    dialect: SQLiteSyncDialect,
    schema: RelationalSchemaConfig<TSchema> | undefined,
    options: { logger?: Logger; cache?: Cache } = {},
  ) {
    super(dialect);
    this.client = client;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.dialect = dialect as any;
    this.schema = schema;
    this.logger = options.logger ?? new NoopLogger();
    this.cache = options.cache ?? new NoopCache();
    this._txDepth = 0;
  }

  prepareQuery(
    query: Query,
    fields: SelectedFieldsOrdered | undefined,
    executeMethod: SQLiteExecuteMethod,
    isResponseInArrayMode: boolean,
    customResultMapper?: (
      rows: unknown[][],
      mapColumnValue?: (value: unknown) => unknown,
    ) => unknown,
    queryMetadata?: { type: "select" | "update" | "delete" | "insert"; tables: string[] },
    cacheConfig?: WithCacheConfig,
  ): NodeSqlitePreparedQuery {
    const stmt = this.client.prepare(query.sql);
    return new NodeSqlitePreparedQuery(
      stmt,
      query,
      this.logger,
      this.cache,
      queryMetadata,
      cacheConfig,
      fields,
      executeMethod,
      isResponseInArrayMode,
      customResultMapper,
    );
  }

  transaction<T>(
    transaction: (tx: NodeSqliteTransaction<TFullSchema, TSchema>) => T,
    config: SQLiteTransactionConfig = {},
  ): T {
    const isNested = this._txDepth > 0;
    const tx = new NodeSqliteTransaction<TFullSchema, TSchema>(
      "sync",
      this.dialect,
      this,
      this.schema,
      this._txDepth,
    );

    if (!isNested) {
      const behavior = config.behavior ?? "deferred";
      const txKeyword =
        behavior === "deferred"
          ? "DEFERRED"
          : behavior === "immediate"
            ? "IMMEDIATE"
            : "EXCLUSIVE";
      this.client.exec(`BEGIN ${txKeyword}`);
    }

    this._txDepth++;
    try {
      const result = transaction(tx);
      // Only commit when the outermost transaction completes
      if (this._txDepth === 1) {
        this.client.exec("COMMIT");
      }
      this._txDepth--;
      return result;
    } catch (err) {
      const wasOutermost = this._txDepth === 1;
      this._txDepth--;
      if (wasOutermost) {
        this.client.exec("ROLLBACK");
      }
      throw err;
    }
  }
}

// run(), all(), get(), values() are inherited from SQLiteSession base class,
// which delegates through prepareOneTimeQuery → prepareQuery → NodeSqlitePreparedQuery.

/**
 * Transaction object returned by `NodeSqliteSession.transaction()`.
 * Supports nested transactions via savepoints (matching better-sqlite3 behavior).
 */
class NodeSqliteTransaction<TFullSchema extends Record<string, unknown>, TSchema extends TablesRelationalConfig> extends SQLiteTransaction<
  "sync",
  RunResult,
  TFullSchema,
  TSchema
> {
  static readonly [entityKind] = "NodeSqliteTransaction";

  client: DatabaseSync;

  constructor(
    resultType: "sync",
    dialect: SQLiteSyncDialect,
    session: NodeSqliteSession<TFullSchema, TSchema>,
    schema: RelationalSchemaConfig<TSchema> | undefined,
    nestedIndex = 0,
  ) {
    super(resultType, dialect, session, schema, nestedIndex);
    this.client = (session as unknown as { client: DatabaseSync }).client;
  }

  transaction<T>(transaction: (tx: NodeSqliteTransaction<TFullSchema, TSchema>) => T): T {
    const savepointName = `sp${this.nestedIndex}`;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this as any).session.run(sql.raw(`savepoint ${savepointName}`));
    try {
      const result = transaction(this);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this as any).session.run(sql.raw(`release savepoint ${savepointName}`));
      return result;
    } catch (err) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this as any).session.run(sql.raw(`rollback to savepoint ${savepointName}`));
      throw err;
    }
  }
}

/**
 * Sync Drizzle database backed by `node:sqlite`.
 * Mirrors `BetterSQLite3Database` from `drizzle-orm/better-sqlite3`.
 */
class NodeSqliteDatabase<TSchema extends Record<string, unknown> = Record<string, never>> extends BaseSQLiteDatabase<
  "sync",
  RunResult,
  TSchema
> {
  static readonly [entityKind] = "NodeSqliteDatabase";
}

/**
 * Factory function mirroring `drizzle-orm/better-sqlite3`'s `drizzle()` API.
 * Accepts either a `DatabaseSync` instance directly, or a config object with
 * `{ client, schema, ... }`.
 */
export function drizzle<TSchema extends Record<string, unknown> = Record<string, never>>(
  ...params:
    | [DatabaseSync]
    | [DatabaseSync, DrizzleConfig<TSchema>]
    | [DrizzleConfig<TSchema> & { client: DatabaseSync }]
    | []
): NodeSqliteDatabase<TSchema> & { $client: DatabaseSync } {
  let client: DatabaseSync;
  let config: DrizzleConfig<TSchema> | undefined;

  if (params[0] === undefined) {
    throw new Error("DatabaseSync instance is required");
  }

  if (typeof params[0] === "object" && params[0] !== null && "schema" in params[0] && "client" in params[0]) {
    client = params[0].client;
    config = params[0];
  } else if (isConfig(params[0])) {
    throw new Error("client is required when passing a config object");
  } else {
    client = params[0] as DatabaseSync;
    config = params[1];
  }

  const dialect = new SQLiteSyncDialect({ casing: config?.casing });
  let logger: Logger | undefined;
  if (config?.logger === true) {
    logger = new DefaultLogger();
  } else if (config?.logger !== false) {
    logger = config?.logger ?? undefined;
  }
  const cache = config?.cache;

  let schema:
    | {
        fullSchema: Record<string, unknown>;
        schema: TablesRelationalConfig;
        tableNamesMap: Record<string, string>;
      }
    | undefined;

  if (config?.schema) {
    const tablesConfig = extractTablesRelationalConfig(
      config.schema as Record<string, unknown>,
      createTableRelationsHelpers,
    );
    schema = {
      fullSchema: config.schema,
      schema: tablesConfig.tables,
      tableNamesMap: tablesConfig.tableNamesMap,
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const session = new NodeSqliteSession<any, TablesRelationalConfig>(
    client,
    dialect,
    schema,
    { logger, cache },
  );
  const db = new NodeSqliteDatabase<TSchema>(
    "sync",
    dialect,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    session as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    schema as any,
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (db as any).$client = client;
  return db as NodeSqliteDatabase<TSchema> & { $client: DatabaseSync };
}

export {
  NodeSqliteSession,
  NodeSqliteTransaction,
  NodeSqliteDatabase,
  NodeSqlitePreparedQuery,
};

export type { RunResult };
