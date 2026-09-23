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
  db.exec(`CREATE TABLE IF NOT EXISTS segment_observation(id INTEGER PRIMARY KEY, segment_id TEXT NOT NULL, run_id INTEGER NOT NULL, service_date TEXT, from_stop_id TEXT NOT NULL, to_stop_id TEXT NOT NULL, entered_at INTEGER, left_at INTEGER, runtime_sec INTEGER, entry_delay_sec INTEGER, exit_delay_sec INTEGER, delay_delta_sec INTEGER, time_of_day_sec INTEGER, weekday INTEGER, source TEXT, created_at INTEGER NOT NULL)`);
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_segobs_run ON segment_observation(run_id, from_stop_id, to_stop_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_segobs_segment ON segment_observation(segment_id, entered_at)');
  db.exec(`CREATE TABLE IF NOT EXISTS segment_stats(segment_id TEXT NOT NULL, bucket TEXT NOT NULL, n INTEGER NOT NULL, rt_p10 REAL, rt_p50 REAL, rt_p90 REAL, dd_p50 REAL, dd_p90 REAL, updated_at INTEGER NOT NULL, PRIMARY KEY(segment_id, bucket))`);
  // historical structural priors (never per-train features): kept separate so
  // the live recompute in refreshSegmentStats can never clobber them and every
  // row stays attributable to its dataset via `source`. rt_* are absolute
  // dwell-adjusted runtimes (for capped blending against live rows); ex_p50 is
  // the median excess over the 2015 schedule — the schedule-relative form used
  // when the prior is a segment's only signal (immune to timetable drift).
  db.exec(`CREATE TABLE IF NOT EXISTS segment_stats_prior(segment_id TEXT NOT NULL, bucket TEXT NOT NULL, n INTEGER NOT NULL, rt_p10 REAL, rt_p50 REAL, rt_p90 REAL, dd_p50 REAL, dd_p90 REAL, source TEXT NOT NULL, imported_at INTEGER NOT NULL, PRIMARY KEY(segment_id, bucket, source))`);
  try { db.exec('ALTER TABLE segment_stats_prior ADD COLUMN ex_p50 REAL'); } catch { /* column exists */ }
  db.exec(`CREATE TABLE IF NOT EXISTS service_alerts(id INTEGER PRIMARY KEY, source TEXT NOT NULL, run_id INTEGER, stop_id TEXT, title TEXT, description TEXT, severity TEXT, start_epoch INTEGER, end_epoch INTEGER, payload_hash TEXT NOT NULL UNIQUE, raw_json TEXT, created_at INTEGER NOT NULL)`);
  db.exec(`CREATE TABLE IF NOT EXISTS atm_stop_observations(id INTEGER PRIMARY KEY, stop_id TEXT NOT NULL, fetched_at INTEGER NOT NULL, wait_messages TEXT, raw_hash TEXT, quality_flags TEXT)`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_atmobs_stop ON atm_stop_observations(stop_id, fetched_at)');
  // WaitMessage v2 (F1): decoded operator prediction + flags
  try { db.exec('ALTER TABLE atm_stop_observations ADD COLUMN etas_json TEXT'); } catch { /* column exists */ }
  // exogenous calendar (strikes, stadium events, holidays) used for point-in-time
  // prediction features; kind: 'strike' | 'stadium' | 'holiday'. scope: 'network'
  // (rail/general strikes) or 'stations' with stations_csv set. Re-importable.
  db.exec(`CREATE TABLE IF NOT EXISTS calendar_events(id INTEGER PRIMARY KEY, source TEXT NOT NULL, external_id TEXT NOT NULL, kind TEXT NOT NULL, title TEXT, start_epoch INTEGER NOT NULL, end_epoch INTEGER NOT NULL, scope TEXT NOT NULL DEFAULT 'network', stations_csv TEXT, created_at INTEGER NOT NULL, UNIQUE(source, external_id))`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_calevent_window ON calendar_events(start_epoch, end_epoch)');
  // migrations for databases created before these columns existed
  try { db.exec('ALTER TABLE predictions ADD COLUMN features_json TEXT'); } catch { /* column exists */ }
  try { db.exec('ALTER TABLE train_observations ADD COLUMN quality_flags TEXT'); } catch { /* column exists */ }
  // §45: stop-event-level flags (IMPOSSIBLE_RUNTIME over consecutive actuals)
  try { db.exec('ALTER TABLE train_stop_events ADD COLUMN quality_flags TEXT'); } catch { /* column exists */ }
  // crowding (GOAL.md §53): train-level in MIA, evolves over the run — the
  // observation time series preserves that evolution
  try { db.exec('ALTER TABLE train_observations ADD COLUMN crowding_pct INTEGER'); } catch { /* column exists */ }
  try { db.exec('ALTER TABLE train_observations ADD COLUMN crowding_label TEXT'); } catch { /* column exists */ }
  // §61 notifications: device registry + per-run watch state (last-notified
  // values implement the rate limits; a rule fires only when its value moved)
  db.exec(`CREATE TABLE IF NOT EXISTS devices(token TEXT PRIMARY KEY, created_at INTEGER NOT NULL, last_seen_at INTEGER)`);
  db.exec(`CREATE TABLE IF NOT EXISTS device_watches(token TEXT NOT NULL, run_id INTEGER NOT NULL, eta_p50_notified INTEGER, cancelled_notified INTEGER DEFAULT 0, risk_notified INTEGER DEFAULT 0, last_notified_at INTEGER DEFAULT 0, PRIMARY KEY(token, run_id))`);
  // §78 source conflicts: materialized disagreement between two sources on
  // the same field of the same run (MIA says +4, ViaggiaTreno says +7 → both
  // observations stay in train_observations AND the disagreement itself is
  // stored here so it can become a feature — delay_source_spread, "sources
  // disagreeing predicts instability"). ts is the triggering (newer)
  // observation's ts, observed_at that observation's upstream observed time;
  // source_a/source_b are ordered canonically (alphabetical) so a pair yields
  // one row shape no matter which source landed first. Detection rule lives in
  // packages/collector/src/conflicts-backfill.ts (shared with the live hook).
  db.exec(`CREATE TABLE IF NOT EXISTS source_conflicts(id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL, ts INTEGER NOT NULL, field TEXT NOT NULL, value_a REAL, value_b REAL, source_a TEXT NOT NULL, source_b TEXT NOT NULL, spread_seconds INTEGER NOT NULL, observed_at INTEGER, FOREIGN KEY(run_id) REFERENCES train_runs(id))`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_conflict_run_ts ON source_conflicts(run_id, ts)');
  // §82 railway reporting points: non-passenger locations providers report
  // trains at ('Bivio Casirate', 'PM Albate', ...) as a first-class entity,
  // separate from passenger stops (gtfs_stops stays their canonical home;
  // matched ones are typed PASSENGER_STATION here — see railLocations.ts).
  // key = slug(location_name), lowercase-hyphenated. lat/lon stay NULL
  // unless known offline (gtfs coords for matched stations) — no geocoding.
  db.exec(`CREATE TABLE IF NOT EXISTS rail_locations(key TEXT PRIMARY KEY, name TEXT, type TEXT CHECK(type IN ('PASSENGER_STATION','JUNCTION','BIVIO','CONTROL_POINT','UNKNOWN_REPORTING_POINT')), lat REAL, lon REAL, first_seen INTEGER, last_seen INTEGER, observation_count INTEGER, updated_at INTEGER)`);
}
