/**
 * One-shot SQLite → ClickHouse backfill (PLAN_docker_clickhouse.md §3).
 *
 *   TRENO_CLICKHOUSE_URL=http://127.0.0.1:8123 npm run ch:backfill
 *
 * Streams every mirrored table into ClickHouse in 10k batches. Idempotence:
 * the append-only log tables (train_observations, predictions,
 * source_snapshots) have no dedup key in ClickHouse, so re-running on a
 * populated server duplicates them — run once against a fresh server, or
 * TRUNCATE the log tables first via the clickhouse client.
 */
import { join } from 'node:path';
import { loadConfig } from '#core/config.ts';
import { openDb, type Db } from '#core/db.ts';
import { ch, CH_EPOCH_MS_COLUMNS, type ChRow, type ChTable } from './clickhouse.ts';

const BATCH = 10_000;

/** Per-table row streams — every SELECT is an inline literal at its prepare() site. */
function tableStreams(db: Db): Array<{ table: ChTable; iter: () => IterableIterator<Record<string, unknown>> }> {
  return [
    { table: 'train_runs', iter: () => db.prepare('SELECT id AS run_id, run_key, train_number, service_date, operator, origin_stop_id, destination_stop_id, sched_dep_epoch, sched_arr_epoch, gtfs_trip_id, route_id, first_seen_source, created_at FROM train_runs').iterate() },
    { table: 'train_observations', iter: () => db.prepare('SELECT ts, run_id, source, observed_at, delay_seconds, location_id, location_name, status, quality_flags FROM train_observations').iterate() },
    { table: 'train_stop_events', iter: () => db.prepare('SELECT run_id, stop_id, stop_sequence, sched_arr_epoch, sched_dep_epoch, op_pred_arr_epoch, op_pred_dep_epoch, actual_arr_epoch, actual_dep_epoch, arr_delay_sec, dep_delay_sec, platform_sched, platform_actual, cancelled, source, updated_at FROM train_stop_events').iterate() },
    { table: 'predictions', iter: () => db.prepare('SELECT id, model_version, run_id, stop_id, generated_at, sched_arr_epoch, operator_eta_epoch, our_p10, our_p50, our_p90, confidence, features_json FROM predictions').iterate() },
    { table: 'prediction_outcomes', iter: () => db.prepare('SELECT prediction_id, actual_arr_epoch, operator_error_sec, our_error_sec, recorded_at FROM prediction_outcomes').iterate() },
    { table: 'service_alerts', iter: () => db.prepare('SELECT id, source, run_id, stop_id, title, description, severity, start_epoch, end_epoch, payload_hash, raw_json, created_at FROM service_alerts').iterate() },
    { table: 'source_snapshots', iter: () => db.prepare('SELECT fetched_at, source, entity_key, http_status, etag, last_modified, payload_hash, relevant_hash, changed, codec, bytes, path, parser_version, error FROM source_snapshots').iterate() },
  ];
}

async function main(): Promise<void> {
  if (!ch.enabled) {
    console.error('TRENO_CLICKHOUSE_URL is not set — nothing to backfill (set it to the ClickHouse HTTP endpoint).');
    process.exit(1);
  }
  if (!(await ch.ping())) {
    console.error('ClickHouse unreachable at TRENO_CLICKHOUSE_URL — aborting.');
    process.exit(1);
  }
  const cfg = loadConfig();
  const db = openDb(join(cfg.dataDir, 'db', 'treno.db'));
  const started = Date.now();
  for (const spec of tableStreams(db)) {
    const epochCols = new Set(CH_EPOCH_MS_COLUMNS[spec.table]);
    let batch: ChRow[] = [];
    let total = 0;
    for (const raw of spec.iter()) {
      const row: ChRow = {};
      for (const [k, v] of Object.entries(raw)) {
        row[k] = epochCols.has(k) ? (v != null ? new Date(v as number) : null) : v;
      }
      if (spec.table === 'train_stop_events' && row.stop_sequence == null) row.stop_sequence = 0;
      batch.push(row);
      if (batch.length >= BATCH) {
        await ch.insert(spec.table, batch);
        total += batch.length;
        batch = [];
      }
    }
    if (batch.length > 0) {
      await ch.insert(spec.table, batch);
      total += batch.length;
    }
    console.log(`${spec.table}: ${total} rows`);
  }
  await ch.close();
  console.log(`backfill complete in ${Math.round((Date.now() - started) / 1000)}s — verify with: clickhouse client -q "SELECT '<table>', count() FROM <table>"`);
}

void main();
