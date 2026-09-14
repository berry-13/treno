/**
 * ClickHouse analytical sink (PLAN_docker_clickhouse.md §3). SQLite stays the
 * operational truth; this mirrors inserts into ClickHouse as the permanent
 * analytical archive. Env-gated on TRENO_CLICKHOUSE_URL — when unset every
 * call is a no-op, so local dev and tests run SQLite-only with zero overhead.
 *
 * All mirroring is fire-and-forget: queueing and flushing must never throw
 * into the collector pipeline. Rows are batched per table and flushed every
 * 5s or 500 rows with async_insert, so a failed flush only ever loses mirror
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

const FLUSH_INTERVAL_MS = 5_000;
const FLUSH_ROWS = 500;

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

  get enabled(): boolean {
    return this.client != null;
  }

  constructor() {
    const url = process.env.TRENO_CLICKHOUSE_URL;
    if (!url) return;
    this.client = createClient({ url, request_timeout: 10_000 });
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
    if (q.length >= FLUSH_ROWS) void this.flush(table);
  }

  /** Flush queued rows (all tables, or one). Insert failures drop the batch:
   * SQLite remains the recoverable truth via ch:backfill. */
  async flush(table?: string): Promise<void> {
    if (!this.client) return;
    const tables: ChTable[] = table && isChTable(table) ? [table] : [...this.queues.keys()];
    for (const t of tables) {
      const q = this.queues.get(t);
      if (!q?.length) continue;
      const rows = q.splice(0, q.length);
      try {
        await this.insert(t, rows);
      } catch (e) {
        log.warn('ch flush failed; rows dropped (sqlite remains truth)', { table: t, rows: rows.length, error: String(e) });
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
    await this.flush();
    if (this.timer) clearInterval(this.timer);
    await this.client?.close();
    this.client = null;
  }
}

export const ch = new CHSink();
