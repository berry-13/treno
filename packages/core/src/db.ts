import { DatabaseSync, type StatementSync } from 'node:sqlite';

export type Db = DatabaseSync;
export type Stmt = StatementSync;

export function openDb(path: string): Db {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  // Cap the WAL file left behind after a checkpoint (it sat at ~790 MB) and
  // give each connection a 64 MiB page cache (default is 2 MiB).
  db.exec('PRAGMA journal_size_limit = 67108864');
  db.exec('PRAGMA cache_size = -65536');
  // Keep planner statistics current on long-lived connections
  // (https://sqlite.org/lang_analyze.html#autoanalyze). analysis_limit keeps
  // the ANALYZE pass bounded on the multi-GB database.
  db.exec('PRAGMA analysis_limit = 400');
  db.exec('PRAGMA optimize = 0x10002');
  return db;
}

/**
 * Run `fn` inside one short write transaction (BEGIN IMMEDIATE ... COMMIT),
 * rolling back if it throws. `fn` must be synchronous: never hold the write
 * lock across an await. If a transaction is already open, `fn` simply joins
 * it. Batching a poll result's inserts this way turns dozens of autocommits
 * (each a WAL append + fsync-ordered page rewrite) into one.
 */
export function withTransaction<T>(db: Db, fn: () => T): T {
  if ((db as { isTransaction?: boolean }).isTransaction === true) return fn();
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw e;
  }
}

/**
 * Execute a prepared statement with a positional parameter array.
 * All SQL is authored as static literals at prepare() sites; data flows only
 * through bound parameters, never string-interpolated into SQL.
 */
export function runStmt(stmt: Stmt, params: Array<null | number | bigint | string | Uint8Array>): void {
  stmt.run(...params);
}

/** Prepare + execute in one step for one-off statements. */
export function execParams(db: Db, sql: string, params: Array<null | number | bigint | string | Uint8Array> = []): void {
  runStmt(db.prepare(sql), params);
}

/** SELECT returning at most one row. */
export function getRow<T>(db: Db, sql: string, params: Array<null | number | bigint | string | Uint8Array> = []): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}

/** SELECT returning all rows. */
export function getRows<T>(db: Db, sql: string, params: Array<null | number | bigint | string | Uint8Array> = []): T[] {
  return db.prepare(sql).all(...params) as T[];
}
