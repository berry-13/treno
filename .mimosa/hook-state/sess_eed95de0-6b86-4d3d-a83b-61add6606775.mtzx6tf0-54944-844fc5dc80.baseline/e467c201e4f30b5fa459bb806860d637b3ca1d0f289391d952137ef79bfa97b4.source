import { DatabaseSync, type StatementSync } from 'node:sqlite';

export type Db = DatabaseSync;
export type Stmt = StatementSync;

export function openDb(path: string): Db {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
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
