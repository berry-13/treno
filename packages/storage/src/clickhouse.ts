/**
 * ClickHouse analytical sink (PLAN_docker_clickhouse.md §3). SQLite stays the
 * operational truth; this mirrors inserts into ClickHouse as the permanent
 * analytical archive. Env-gated on TRENO_CLICKHOUSE_URL — when unset every
 * call is a no-op, so local dev and tests run SQLite-only with zero overhead.
 *
 * All mirroring is fire-and-forget: queueing and flushing must never throw
 * into the collector pipeline. Rows are batched per table and flushed every
 * 30s or 5000 rows, so a failed flush only ever loses mirror
 * lag — SQLite remains recoverable via ch:backfill.
 *
 * Data-plane only: table DDL lives in deploy/clickhouse-init/01_tables.sql
 * (executed by the ClickHouse container on first start, or via clickhouse
 * client for non-Docker servers), and reads for verification/training go
 * through the clickhouse binary — this module never composes SQL from input,
 * mirroring the SQL-authoring rule in packages/core/src/db.ts.
 */
import { createClient, type ClickHouseClient } from '@clickhouse/client';
import { log } from '#core/log.ts';

export type ChRow = Record<string, unknown>;

// Fewer, larger inserts: every insert is a new MergeTree part, and at 5 s /
// 500 rows the server spent ~32 GiB/day merging ~150 MB/day of rows.
const FLUSH_INTERVAL_MS = 30_000;
const FLUSH_ROWS = 5_000;
// Failed batches are re-queued (not dropped) up to this many rows per table;
// beyond it the oldest rows are dropped and left to ch:backfill.
const MAX_QUEUED_ROWS = 100_000;
const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 5 * 60_000;

/** The only table names accepted by queue()/insert(). */
export const CH_TABLES = [
  'train_runs', 'train_observations', 'train_stop_events', 'predictions',
  'prediction_outcomes', 'service_alerts', 'source_snapshots',
] as const;
export type ChTable = (typeof CH_TABLES)[number];

function isChTable(t: string): t is ChTable {
  return (CH_TABLES as readonly string[]).includes(t);
}

/** Epoch-ms columns per table (DateTime64(3) on the ClickHouse side). */
export const CH_EPOCH_MS_COLUMNS: Record<ChTable, string[]> = {
  train_runs: ['sched_dep_epoch', 'sched_arr_epoch', 'created_at'],
  train_observations: ['ts', 'observed_at'],
  train_stop_events: ['sched_arr_epoch', 'sched_dep_epoch', 'op_pred_arr_epoch', 'op_pred_dep_epoch', 'actual_arr_epoch', 'actual_dep_epoch', 'updated_at'],
  predictions: ['generated_at', 'sched_arr_epoch', 'operator_eta_epoch', 'our_p10', 'our_p50', 'our_p90'],
  prediction_outcomes: ['actual_arr_epoch', 'recorded_at'],
  service_alerts: ['start_epoch', 'end_epoch', 'created_at'],
  source_snapshots: ['fetched_at'],
};

class CHSink {
  private client: ClickHouseClient | null = null;
  private queues = new Map<ChTable, ChRow[]>();
  private timer: NodeJS.Timeout | null = null;
  private flushing = new Set<ChTable>();
  private retry = new Map<ChTable, { failures: number; notBefore: number }>();

  get enabled(): boolean {
    return this.client != null;
  }

  constructor() {
    const url = process.env.TRENO_CLICKHOUSE_URL;
    if (!url) return;
    // best_effort: the client serializes Date as ISO-8601 with a trailing
    // 'Z'; older servers' default 'basic' parser rejects the offset suffix.
    this.client = createClient({
      url,
      request_timeout: 30_000,
      // the server closes idle keep-alive sockets after 10 s; drop ours first
      // so a flush never reuses a socket the server already hung up on
      keep_alive: { enabled: true, idle_socket_ttl: 4_000 },
      clickhouse_settings: { date_time_input_format: 'best_effort' },
    });
    process.on('beforeExit', () => {
      if (this.client) this.client.close();
    });
  }

  /** Fire-and-forget: queue one row for mirrored insert. Never throws. */
  queue(table: string, row: ChRow): void {
    if (!this.client || !isChTable(table)) return;
    let q = this.queues.get(table);
    if (!q) this.queues.set(table, (q = []));
    q.push(row);
    if (!this.timer) this.timer = setInterval(() => void this.flush(), FLUSH_INTERVAL_MS);
    if (q.length >= FLUSH_ROWS && !this.retry.has(table)) void this.flush(table);
  }

  /** Flush queued rows (all tables, or one). A failed batch is put back at
   * the head of its queue and retried with capped exponential backoff; only
   * overflow beyond MAX_QUEUED_ROWS is dropped (SQLite remains the
   * recoverable truth via ch:backfill). One flush per table at a time. */
  async flush(table?: string): Promise<void> {
    if (!this.client) return;
    const tables: ChTable[] = table && isChTable(table) ? [table] : [...this.queues.keys()];
    const now = Date.now();
    for (const t of tables) {
      const q = this.queues.get(t);
      if (!q?.length || this.flushing.has(t)) continue;
      const r = this.retry.get(t);
      if (r && now < r.notBefore) continue;
      const rows = q.splice(0, q.length);
      this.flushing.add(t);
      try {
        await this.insert(t, rows);
        this.retry.delete(t);
      } catch (e) {
        const failures = (r?.failures ?? 0) + 1;
        const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (failures - 1));
        this.retry.set(t, { failures, notBefore: Date.now() + delay });
        const cur = this.queues.get(t) ?? [];
        const merged = rows.concat(cur);
        const dropped = Math.max(0, merged.length - MAX_QUEUED_ROWS);
        this.queues.set(t, dropped > 0 ? merged.slice(dropped) : merged);
        log.warn('ch flush failed; batch re-queued', { table: t, rows: rows.length, failures, retryInMs: delay, dropped, error: String(e) });
      } finally {
        this.flushing.delete(t);
      }
    }
  }

  /** Direct insert (flush path and ch:backfill). Tables must already exist
   * (created by the ch-init compose service / deploy SQL). Plain synchronous
   * inserts: async_insert + request compression proved fragile across
   * server versions, and ≤10k-row JSONEachRow batches don't need them. */
  async insert(table: string, rows: ChRow[]): Promise<void> {
    if (!this.client || rows.length === 0 || !isChTable(table)) return;
    await this.client.insert({
      table,
      values: rows,
      format: 'JSONEachRow',
    });
  }

  async ping(): Promise<boolean> {
    if (!this.client) return false;
    try {
      const r = await this.client.ping();
      return r.success;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    this.retry.clear();
    await this.flush();
    if (this.timer) clearInterval(this.timer);
    await this.client?.close();
    this.client = null;
  }
}

export const ch = new CHSink();
