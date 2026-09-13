/**
 * Normalized observation store schema (GOAL.md §30-33). Every realtime value
 * keeps its provenance: which source, when fetched, when observed upstream,
 * and a pointer back to the raw payload snapshot.
 *
 * One inline literal per db.exec call; no dynamic SQL anywhere.
 */
import type { Db } from '#core/db.ts';

export function ensureNormalizedTables(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS source_snapshots(id INTEGER PRIMARY KEY, source TEXT NOT NULL, entity_key TEXT NOT NULL, fetched_at INTEGER NOT NULL, http_status INTEGER, etag TEXT, last_modified TEXT, payload_hash TEXT NOT NULL, relevant_hash TEXT, changed INTEGER NOT NULL DEFAULT 0, codec TEXT, bytes INTEGER, path TEXT, parser_version TEXT, error TEXT)`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_snap_entity ON source_snapshots(source, entity_key, fetched_at)');
  db.exec(`CREATE TABLE IF NOT EXISTS train_runs(id INTEGER PRIMARY KEY, run_key TEXT NOT NULL UNIQUE, operator TEXT NOT NULL, service_date TEXT NOT NULL, train_number TEXT NOT NULL, origin_stop_id TEXT, destination_stop_id TEXT, sched_dep_sec INTEGER, sched_arr_sec INTEGER, sched_dep_epoch INTEGER, sched_arr_epoch INTEGER, gtfs_trip_id TEXT, route_id TEXT, first_seen_source TEXT, created_at INTEGER NOT NULL, last_activity_at INTEGER)`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_runs_date_num ON train_runs(service_date, train_number)');
  db.exec(`CREATE TABLE IF NOT EXISTS train_run_sources(run_id INTEGER NOT NULL, source TEXT NOT NULL, source_key TEXT NOT NULL, last_resolved_at INTEGER, PRIMARY KEY(run_id, source))`);
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_runsources_key ON train_run_sources(source, source_key)');
  db.exec(`CREATE TABLE IF NOT EXISTS train_observations(id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL, ts INTEGER NOT NULL, source TEXT NOT NULL, observed_at INTEGER, delay_seconds INTEGER, location_id TEXT, location_name TEXT, location_kind TEXT, status TEXT, raw_hash TEXT, FOREIGN KEY(run_id) REFERENCES train_runs(id))`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_obs_run_ts ON train_observations(run_id, ts)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_obs_source_ts ON train_observations(source, ts)');
  db.exec(`CREATE TABLE IF NOT EXISTS train_stop_events(run_id INTEGER NOT NULL, stop_id TEXT NOT NULL, stop_sequence INTEGER, sched_arr_epoch INTEGER, sched_dep_epoch INTEGER, op_pred_arr_epoch INTEGER, op_pred_dep_epoch INTEGER, actual_arr_epoch INTEGER, actual_dep_epoch INTEGER, arr_delay_sec INTEGER, dep_delay_sec INTEGER, platform_sched TEXT, platform_actual TEXT, platform_is_actual INTEGER, cancelled INTEGER, source TEXT, updated_at INTEGER, PRIMARY KEY(run_id, stop_id, stop_sequence))`);
  db.exec(`CREATE TABLE IF NOT EXISTS train_state(run_id INTEGER PRIMARY KEY, state_json TEXT NOT NULL, updated_at INTEGER NOT NULL)`);
  db.exec(`CREATE TABLE IF NOT EXISTS provider_health(source TEXT PRIMARY KEY, ok_count INTEGER NOT NULL DEFAULT 0, err_count INTEGER NOT NULL DEFAULT 0, last_ok_at INTEGER, last_err_at INTEGER, last_error TEXT, last_latency_ms INTEGER, last_change_at INTEGER, consecutive_errors INTEGER NOT NULL DEFAULT 0, paused_until INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT 'UNKNOWN')`);
  db.exec(`CREATE TABLE IF NOT EXISTS predictions(id INTEGER PRIMARY KEY, model_version TEXT NOT NULL, run_id INTEGER NOT NULL, stop_id TEXT NOT NULL, generated_at INTEGER NOT NULL, sched_arr_epoch INTEGER, operator_eta_epoch INTEGER, our_p10 INTEGER, our_p50 INTEGER, our_p90 INTEGER, confidence REAL)`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_pred_run ON predictions(run_id, stop_id, generated_at)');
  db.exec(`CREATE TABLE IF NOT EXISTS prediction_outcomes(prediction_id INTEGER PRIMARY KEY, actual_arr_epoch INTEGER, operator_error_sec INTEGER, our_error_sec INTEGER, recorded_at INTEGER NOT NULL)`);
}
