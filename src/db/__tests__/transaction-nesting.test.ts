import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  withTransaction,
  txDepthMap,
} from "@/db/compat";
import { drizzle } from "@/db/node-sqlite-adapter";

/**
 * Regression for the transaction-depth split bug: the Drizzle session and the
 * compat `.transaction()` must share one depth entry, otherwise a drizzle
 * transaction that opens an inner compat transaction ("cannot start a
 * transaction within a transaction") throws even though nesting is supported.
 */
describe("transaction depth shared between drizzle and compat layers", () => {
  it("allows a drizzle transaction to open an inner compat transaction", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ygg-tx-nest-"));
    const dbPath = path.join(dir, "nested.db");
    const client = new DatabaseSync(dbPath, { allowExtension: true });
    client.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");

    // Mirror src/db/index.ts: the proxy fronts the real client, and the compat
    // layer keys depth on the proxy so the Drizzle session (proxy) and the
    // compat layer (real client) share one depth entry.
    const proxy = new Proxy({} as DatabaseSync, {
      get(_t, prop) {
        if (prop === "constructor") return DatabaseSync;
        const value = Reflect.get(client, prop);
        return typeof value === "function" ? value.bind(client) : value;
      },
      getPrototypeOf() {
        return DatabaseSync.prototype;
      },
    });

    const compat = withTransaction(withTransaction(client), proxy);
    // `compat` is the real client with .transaction added; the proxy forwards it.
    const db = drizzle(proxy);

    // Outer = drizzle transaction; inner = compat transaction (as real code
    // triggers when vector-index desync runs inside addSemanticMemory).
    db.transaction(() => {
      const rowsBefore = client.prepare("SELECT COUNT(*) AS n FROM t").get() as { n: number };
      expect(rowsBefore.n).toBe(0);

      // This inner compat transaction must NOT throw
      // "cannot start a transaction within a transaction".
      // compat.transaction(fn) returns a callable TransactionFn (it mirrors
      // better-sqlite3's `db.transaction(fn)`), so the caller must invoke it.
      const inner = (proxy as unknown as {
        transaction: (fn: () => void) => () => void;
      }).transaction(() => {
        client.exec("INSERT INTO t (v) VALUES ('inner')");
      });
      inner();

      client.exec("INSERT INTO t (v) VALUES ('outer')");
    });

    const n = client.prepare("SELECT COUNT(*) AS n FROM t").get() as { n: number };
    expect(n.n).toBe(2);

    // Depth must be back to zero after the outermost commit.
    expect(txDepthMap.get(proxy)).toBe(0);
    expect(txDepthMap.get(client)).toBeUndefined();

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
