/**
 * Observation, stop-event, state and provider-health writers. Stop events use
 * COALESCE semantics: once an actual arrival/departure is recorded it is never
 * overwritten by a null, while operator predictions always refresh.
 */
import { runStmt, getRow, getRows, type Db } from '#core/db.ts';

export interface ObservationArgs {
  runId: number;
  ts: number; // fetch time (epoch ms)
  source: string;
  observedAt: number | null; // upstream-stated event time
  delaySeconds: number | null;
  locationId: string | null;
  locationName: string | null;
  locationKind: string | null; // station | reporting_point | unknown
  status: string | null;
  rawHash: string | null;
}

export function insertObservation(db: Db, a: ObservationArgs): void {
  runStmt(
    db.prepare('INSERT INTO train_observations(run_id, ts, source, observed_at, delay_seconds, location_id, location_name, location_kind, status, raw_hash) VALUES(?,?,?,?,?,?,?,?,?,?)'),
    [a.runId, a.ts, a.source, a.observedAt, a.delaySeconds, a.locationId, a.locationName, a.locationKind, a.status, a.rawHash],
  );
}

export interface StopEventUpsert {
  runId: number;
  stopId: string;
  stopSequence: number | null;
  schedArrEpoch?: number | null;
  schedDepEpoch?: number | null;
  opPredArrEpoch?: number | null;
  opPredDepEpoch?: number | null;
  actualArrEpoch?: number | null;
  actualDepEpoch?: number | null;
  arrDelaySec?: number | null;
  depDelaySec?: number | null;
  platformSched?: string | null;
  platformActual?: string | null;
  platformIsActual?: boolean | null;
  cancelled?: boolean | null;
  source: string;
}

export function upsertStopEvent(db: Db, e: StopEventUpsert): void {
  // Merge by (run_id, stop_id): different providers use different stop
  // sequence conventions (MIA journey index vs VT progressivo), so the first
  // writer's sequence becomes the row identity and later sources update it.
  const existing = getRow<{ stop_sequence: number; actual_arr_epoch: number | null; platform_actual: string | null }>(
    db, 'SELECT stop_sequence, actual_arr_epoch, platform_actual FROM train_stop_events WHERE run_id=? AND stop_id=?', [e.runId, e.stopId]);
  const seq = existing?.stop_sequence ?? e.stopSequence ?? 0;
  // never regress an actual to null once known
  const actualArr = e.actualArrEpoch ?? existing?.actual_arr_epoch ?? null;
  const platformActual = e.platformActual ?? existing?.platform_actual ?? null;
  runStmt(
    db.prepare(`INSERT INTO train_stop_events(run_id, stop_id, stop_sequence, sched_arr_epoch, sched_dep_epoch, op_pred_arr_epoch, op_pred_dep_epoch, actual_arr_epoch, actual_dep_epoch, arr_delay_sec, dep_delay_sec, platform_sched, platform_actual, platform_is_actual, cancelled, source, updated_at)
VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
ON CONFLICT(run_id, stop_id, stop_sequence) DO UPDATE SET
  op_pred_arr_epoch=excluded.op_pred_arr_epoch,
  op_pred_dep_epoch=excluded.op_pred_dep_epoch,
  actual_arr_epoch=excluded.actual_arr_epoch,
  actual_dep_epoch=excluded.actual_dep_epoch,
  arr_delay_sec=COALESCE(excluded.arr_delay_sec, arr_delay_sec),
  dep_delay_sec=COALESCE(excluded.dep_delay_sec, dep_delay_sec),
  platform_actual=excluded.platform_actual,
  platform_is_actual=excluded.platform_is_actual,
  cancelled=COALESCE(excluded.cancelled, cancelled),
  source=excluded.source,
  updated_at=excluded.updated_at`),
    [e.runId, e.stopId, seq, e.schedArrEpoch ?? null, e.schedDepEpoch ?? null,
     e.opPredArrEpoch ?? null, e.opPredDepEpoch ?? null, actualArr, e.actualDepEpoch ?? null,
     e.arrDelaySec ?? null, e.depDelaySec ?? null, e.platformSched ?? null, platformActual,
     e.platformIsActual == null ? null : (e.platformIsActual ? 1 : 0),
     e.cancelled == null ? null : (e.cancelled ? 1 : 0), e.source, Date.now()],
  );
}

export function saveState(db: Db, runId: number, stateJson: string): void {
  runStmt(
    db.prepare('INSERT INTO train_state(run_id, state_json, updated_at) VALUES(?,?,?) ON CONFLICT(run_id) DO UPDATE SET state_json=excluded.state_json, updated_at=excluded.updated_at'),
    [runId, stateJson, Date.now()],
  );
}

export function loadState(db: Db, runId: number): { state_json: string; updated_at: number } | undefined {
  return getRow(db, 'SELECT state_json, updated_at FROM train_state WHERE run_id=?', [runId]);
}

export interface HealthUpdate {
  ok: boolean;
  latencyMs: number | null;
  error?: string | null;
  changed?: boolean;
  backoffUntil?: number | null;
}

export function updateProviderHealth(db: Db, source: string, u: HealthUpdate): void {
  runStmt(
    db.prepare(`INSERT INTO provider_health(source, ok_count, err_count, last_ok_at, last_err_at, last_error, last_latency_ms, last_change_at, consecutive_errors, paused_until, state)
VALUES(?,?,?,?,?,?,?,?,0,?,'UNKNOWN')
ON CONFLICT(source) DO UPDATE SET
  ok_count=ok_count+excluded.ok_count,
  err_count=err_count+excluded.err_count,
  last_ok_at=CASE WHEN excluded.ok_count>0 THEN excluded.last_ok_at ELSE last_ok_at END,
  last_err_at=CASE WHEN excluded.err_count>0 THEN excluded.last_err_at ELSE last_err_at END,
  last_error=CASE WHEN excluded.err_count>0 THEN excluded.last_error ELSE last_error END,
  last_latency_ms=COALESCE(excluded.last_latency_ms, last_latency_ms),
  last_change_at=CASE WHEN excluded.last_change_at>0 THEN excluded.last_change_at ELSE last_change_at END,
  consecutive_errors=CASE WHEN excluded.ok_count>0 THEN 0 ELSE consecutive_errors+1 END,
  paused_until=excluded.paused_until,
  state=CASE WHEN excluded.ok_count>0 THEN 'HEALTHY' WHEN consecutive_errors+1>=5 THEN 'PAUSED' ELSE 'DEGRADED' END`),
    [source, u.ok ? 1 : 0, u.ok ? 0 : 1, u.ok ? Date.now() : null, u.ok ? null : Date.now(),
     u.ok ? null : (u.error ?? 'unknown error'), u.latencyMs, u.changed ? Date.now() : 0,
     u.backoffUntil ?? 0],
  );
}

export interface ProviderHealthRow {
  source: string; ok_count: number; err_count: number; last_ok_at: number | null;
  last_err_at: number | null; last_error: string | null; last_latency_ms: number | null;
  last_change_at: number | null; consecutive_errors: number; paused_until: number; state: string;
}

export function providerHealth(db: Db): ProviderHealthRow[] {
  return getRows<ProviderHealthRow>(db, 'SELECT * FROM provider_health ORDER BY source');
}

export function recordPrediction(db: Db, p: {
  modelVersion: string; runId: number; stopId: string; generatedAt: number;
  schedArrEpoch: number | null; operatorEtaEpoch: number | null;
  ourP10: number | null; ourP50: number | null; ourP90: number | null; confidence: number | null;
}): number {
  const r = db.prepare('INSERT INTO predictions(model_version, run_id, stop_id, generated_at, sched_arr_epoch, operator_eta_epoch, our_p10, our_p50, our_p90, confidence) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(p.modelVersion, p.runId, p.stopId, p.generatedAt, p.schedArrEpoch, p.operatorEtaEpoch, p.ourP10, p.ourP50, p.ourP90, p.confidence);
  return Number(r.lastInsertRowid);
}

/** When an actual arrival lands, score every recorded prediction for that run+stop. */
export function fillPredictionOutcomes(db: Db, runId: number, stopId: string, actualArrEpoch: number): void {
  const preds = getRows<{ id: number; operator_eta_epoch: number | null; our_p50: number | null }>(
    db,
    'SELECT id, operator_eta_epoch, our_p50 FROM predictions WHERE run_id=? AND stop_id=? AND generated_at<=? AND id NOT IN (SELECT prediction_id FROM prediction_outcomes)',
    [runId, stopId, actualArrEpoch],
  );
  for (const p of preds) {
    const opErr = p.operator_eta_epoch != null ? Math.round((actualArrEpoch - p.operator_eta_epoch) / 1000) : null;
    const ourErr = p.our_p50 != null ? Math.round((actualArrEpoch - p.our_p50) / 1000) : null;
    runStmt(
      db.prepare('INSERT OR REPLACE INTO prediction_outcomes(prediction_id, actual_arr_epoch, operator_error_sec, our_error_sec, recorded_at) VALUES(?,?,?,?,?)'),
      [p.id, actualArrEpoch, opErr, ourErr, Date.now()],
    );
  }
}
