/**
 * Ingest pipeline (GOAL.md §39): provider snapshot → canonical run resolution
 * → normalized observations + stop events → fused current state → prediction
 * records. Raw payload storage happens in the poller; this layer owns
 * everything normalized. State fusion keeps per-source provenance and computes
 * disagreement/confidence explicitly (GOAL.md §10, §46, §77-78).
 */
import { getRow, getRows, runStmt, type Db } from '#core/db.ts';
import { log } from '#core/log.ts';
import { romeWallToEpoch, secondsToHms } from '#core/time.ts';
import { ensureRun, mapSourceKey, resolveRun, type RunRecord } from '#storage/runs.ts';
import { fillPredictionOutcomes, insertObservation, recordPrediction, saveState, upsertStopEvent } from '#storage/observations.ts';
import type { ProviderStopEvent, ProviderTrainSnapshot } from '#providers/types.ts';
import type { SnapshotInfo } from '#storage/rawStore.ts';

export interface IngestMeta {
  fetchedAt: number;
  snapshot: SnapshotInfo;
}

export interface IngestResult {
  runId: number | null;
  serviceDate: string;
  trainNumber: string;
}

/** Locate (or create) the canonical run this provider snapshot belongs to. */
export function resolveRunForSnapshot(db: Db, s: ProviderTrainSnapshot): number {
  const existing = resolveRun(db, s.serviceDate, s.trainNumber, s.originStopId, s.schedDepSec);
  if (existing != null) return existing;
  return ensureRun(db, {
    operator: s.operator ?? 'TRENORD',
    serviceDate: s.serviceDate,
    trainNumber: s.trainNumber,
    originStopId: s.originStopId,
    schedDepSec: s.schedDepSec,
    destinationStopId: s.destinationStopId,
    schedArrSec: s.schedArrSec,
    source: s.source,
  });
}

function locationKind(db: Db, stopId: string | null): string | null {
  if (!stopId) return null;
  const r = getRow<{ stop_id: string }>(db, 'SELECT stop_id FROM gtfs_stops WHERE stop_id=?', [stopId]);
  return r ? 'station' : 'reporting_point';
}

export function ingestSnapshot(db: Db, s: ProviderTrainSnapshot, meta: IngestMeta): IngestResult {
  const runId = resolveRunForSnapshot(db, s);
  mapSourceKey(db, runId, s.source, s.sourceKey);

  // observation row only when the relevant fields changed (GOAL.md §44)
  if (meta.snapshot.changed) {
    insertObservation(db, {
      runId,
      ts: meta.fetchedAt,
      source: s.source,
      observedAt: s.observedAt,
      delaySeconds: s.delaySeconds,
      locationId: s.lastLocationId,
      locationName: s.lastLocationName,
      locationKind: locationKind(db, s.lastLocationId),
      status: s.status,
      rawHash: meta.snapshot.relevantHash,
    });
  }

  const gtfsStops = getRows<{ stop_id: string; stop_sequence: number; sched_arr: number | null; sched_dep: number | null; stop_name: string | null }>(
    db,
    `SELECT st.stop_id, st.stop_sequence, st.arrival_sec AS sched_arr, st.departure_sec AS sched_dep, g.stop_name
     FROM gtfs_stop_times st LEFT JOIN gtfs_stops g ON g.stop_id = st.stop_id
     WHERE st.trip_id = (SELECT gtfs_trip_id FROM train_runs WHERE id=?) ORDER BY st.stop_sequence ASC`,
    [runId],
  );
  const schedByStop = new Map(gtfsStops.map((g) => [g.stop_id, g]));
  // Canonical stop identity v1 (GOAL.md §81): RFI/VT station codes do not
  // always coincide with Trenord GTFS codes for the same physical station —
  // alias any provider stop unknown to GTFS onto the trip's GTFS stop with a
  // matching normalized name.
  const gtfsIds = new Set(gtfsStops.map((g) => g.stop_id));
  const nameKey = (n: string | null | undefined): string | null =>
    n == null ? null : n.toLowerCase().replace(/[^a-z0-9]/g, '');
  const gtfsByName = new Map<string, string>();
  for (const g of gtfsStops) {
    const k = nameKey(g.stop_name);
    if (k && !gtfsByName.has(k)) gtfsByName.set(k, g.stop_id);
  }
  const aliasStopId = (stop: ProviderStopEvent): string | null => {
    if (!stop.stopId) return null;
    if (gtfsIds.has(stop.stopId)) return stop.stopId;
    const byName = nameKey(stop.stopName);
    const aliased = (byName != null ? gtfsByName.get(byName) : undefined) ?? null;
    if (aliased) return aliased;
    return stop.stopId;
  };

  for (const st of s.stops) {
    const stopId = aliasStopId(st);
    if (!stopId) continue;
    const g = schedByStop.get(stopId);
    const schedArrEpoch = st.schedArrEpoch ?? (g?.sched_arr != null ? romeWallToEpoch(s.serviceDate, g.sched_arr) : null);
    const schedDepEpoch = st.schedDepEpoch ?? (g?.sched_dep != null ? romeWallToEpoch(s.serviceDate, g.sched_dep) : null);
    upsertStopEvent(db, {
      runId,
      stopId,
      stopSequence: st.stopSequence ?? g?.stop_sequence ?? null,
      schedArrEpoch,
      schedDepEpoch,
      opPredArrEpoch: st.opPredArrEpoch,
      opPredDepEpoch: st.opPredDepEpoch,
      actualArrEpoch: st.actualArrEpoch,
      actualDepEpoch: st.actualDepEpoch,
      arrDelaySec: st.arrDelaySec,
      depDelaySec: st.depDelaySec,
      platformSched: null,
      platformActual: st.platform,
      platformIsActual: st.platformIsActual,
      cancelled: st.cancelled,
      source: s.source,
    });
    if (st.actualArrEpoch != null) {
      fillPredictionOutcomes(db, runId, stopId, st.actualArrEpoch);
    }
  }

  fuseAndPredict(db, runId);
  return { runId, serviceDate: s.serviceDate, trainNumber: s.trainNumber };
}

export interface FusedStop {
  stopId: string;
  stopName: string | null;
  stopSequence: number | null;
  schedArrEpoch: number | null;
  opPredArrEpoch: number | null;
  actualArrEpoch: number | null;
  arrDelaySec: number | null;
  platformActual: string | null;
  cancelled: number | null;
}

export interface FusedState {
  runId: number;
  runCode: string;
  trainNumber: string;
  serviceDate: string;
  origin: { stopId: string | null; name: string | null };
  destination: { stopId: string | null; name: string | null };
  schedDepEpoch: number | null;
  schedArrEpoch: number | null;
  status: 'scheduled' | 'running' | 'arrived' | 'cancelled' | 'unknown';
  operatorDelaySec: number | null;
  latestLocation: { id: string | null; name: string | null; kind: string | null } | null;
  latestObservedAt: number | null;
  latestSource: string | null;
  sources: Record<string, { observedAt: number | null; fetchedAt: number | null; delaySec: number | null; ageSec: number | null; status: string | null }>;
  sourceDelaySpreadSec: number | null;
  previousStop: { stopId: string; name: string | null; actualArrEpoch: number | null } | null;
  nextStop: { stopId: string; name: string | null; schedArrEpoch: number | null; opPredArrEpoch: number | null } | null;
  destinationOperatorEta: number | null;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  stops: FusedStop[];
}

interface StopEventRow {
  stop_id: string;
  stop_sequence: number | null;
  sched_arr_epoch: number | null;
  op_pred_arr_epoch: number | null;
  actual_arr_epoch: number | null;
  actual_dep_epoch: number | null;
  arr_delay_sec: number | null;
  platform_actual: string | null;
  cancelled: number | null;
}

interface ObsRow {
  source: string;
  ts: number;
  observed_at: number | null;
  delay_seconds: number | null;
  location_id: string | null;
  location_name: string | null;
  location_kind: string | null;
  status: string | null;
}

function stopName(db: Db, stopId: string | null): string | null {
  if (!stopId) return null;
  const r = getRow<{ stop_name: string }>(db, 'SELECT stop_name FROM gtfs_stops WHERE stop_id=?', [stopId]);
  return r?.stop_name ?? null;
}

export function fuseRunState(db: Db, run: RunRecord): FusedState {
  const now = Date.now();
  const events = getRows<StopEventRow>(
    db,
    'SELECT stop_id, stop_sequence, sched_arr_epoch, op_pred_arr_epoch, actual_arr_epoch, actual_dep_epoch, arr_delay_sec, platform_actual, cancelled FROM train_stop_events WHERE run_id=? ORDER BY stop_sequence ASC, sched_arr_epoch ASC',
    [run.id],
  );
  const latestPerSource = new Map<string, ObsRow>();
  for (const src of ['mia', 'viaggiatreno']) {
    const r = getRow<ObsRow>(
      db,
      'SELECT source, ts, observed_at, delay_seconds, location_id, location_name, location_kind, status FROM train_observations WHERE run_id=? AND source=? ORDER BY ts DESC LIMIT 1',
      [run.id, src],
    );
    if (r) latestPerSource.set(src, r);
  }

  const sources: FusedState['sources'] = {};
  let freshest: ObsRow | null = null;
  const delays: number[] = [];
  for (const [src, o] of latestPerSource) {
    const ageSec = Math.round((now - (o.observed_at ?? o.ts)) / 1000);
    sources[src] = { observedAt: o.observed_at, fetchedAt: o.ts, delaySec: o.delay_seconds, ageSec, status: o.status };
    if (o.delay_seconds != null) delays.push(o.delay_seconds);
    if (!freshest || (o.observed_at ?? o.ts) > (freshest.observed_at ?? freshest.ts)) freshest = o;
  }
  const spread = delays.length >= 2 ? Math.max(...delays) - Math.min(...delays) : null;

  const passed = events.filter((e) => e.actual_arr_epoch != null || e.actual_dep_epoch != null);  const previousStopRow = passed.length > 0 ? passed[passed.length - 1]! : null;
  const upcoming = events.filter((e) => e.actual_arr_epoch == null && e.cancelled !== 1 && (e.sched_arr_epoch == null || e.sched_arr_epoch >= (previousStopRow?.actual_arr_epoch ?? 0)));
  const nextStopRow = upcoming[0] ?? null;
  const destEvent = events.length > 0 ? events[events.length - 1]! : null;

  const schedArrEpoch = run.sched_arr_epoch ?? destEvent?.sched_arr_epoch ?? null;
  const destOpEta = destEvent?.op_pred_arr_epoch ?? null;

  // status: provider-native codes take precedence (MIA: N/V/P/A/C; VT: PG/PP/ST)
  let status: FusedState['status'] = 'unknown';
  const allArrived = events.length > 0 && events.every((e) => e.actual_arr_epoch != null || e.cancelled === 1);
  const anyCancelledFlag = events.some((e) => e.cancelled === 1);
  const depEpoch = run.sched_dep_epoch;
  const obsStatus = freshest?.status ?? null;
  if (anyCancelledFlag || obsStatus === 'C' || obsStatus === 'ST') status = 'cancelled';
  else if (allArrived || obsStatus === 'A') status = 'arrived';
  else if (obsStatus === 'V' || passed.length > 0) status = 'running';
  else if (obsStatus === 'N' || obsStatus === 'PG') status = 'scheduled';
  else if (depEpoch != null && now < depEpoch) status = 'scheduled';
  else if (depEpoch != null) status = 'running';

  // confidence heuristic (GOAL.md §46)
  let confidence: FusedState['confidence'] = 'LOW';
  const freshAge = freshest ? Math.round((now - (freshest.observed_at ?? freshest.ts)) / 1000) : Infinity;
  if (Object.keys(sources).length >= 2 && freshAge < 120 && (spread == null || spread <= 120)) confidence = 'HIGH';
  else if (Object.keys(sources).length >= 1 && freshAge < 600 && (spread == null || spread <= 600)) confidence = 'MEDIUM';

  return {
    runId: run.id,
    runCode: run.train_number + '@' + run.service_date,
    trainNumber: run.train_number,
    serviceDate: run.service_date,
    origin: { stopId: run.origin_stop_id, name: stopName(db, run.origin_stop_id) },
    destination: { stopId: run.destination_stop_id, name: stopName(db, run.destination_stop_id) },
    schedDepEpoch: run.sched_dep_epoch,
    schedArrEpoch,
    status,
    operatorDelaySec: freshest?.delay_seconds ?? null,
    latestLocation: freshest ? { id: freshest.location_id, name: freshest.location_name, kind: freshest.location_kind } : null,
    latestObservedAt: freshest?.observed_at ?? (freshest ? freshest.ts : null),
    latestSource: freshest?.source ?? null,
    sources,
    sourceDelaySpreadSec: spread,
    previousStop: previousStopRow ? { stopId: previousStopRow.stop_id, name: stopName(db, previousStopRow.stop_id), actualArrEpoch: previousStopRow.actual_arr_epoch } : null,
    nextStop: nextStopRow ? { stopId: nextStopRow.stop_id, name: stopName(db, nextStopRow.stop_id), schedArrEpoch: nextStopRow.sched_arr_epoch, opPredArrEpoch: nextStopRow.op_pred_arr_epoch } : null,
    destinationOperatorEta: destOpEta,
    confidence,
    stops: events.map((e) => ({
      stopId: e.stop_id,
      stopName: stopName(db, e.stop_id),
      stopSequence: e.stop_sequence,
      schedArrEpoch: e.sched_arr_epoch,
      opPredArrEpoch: e.op_pred_arr_epoch,
      actualArrEpoch: e.actual_arr_epoch,
      arrDelaySec: e.arr_delay_sec,
      platformActual: e.platform_actual,
      cancelled: e.cancelled,
    })),
  };
}

/** Fuse state, persist it, and record the current model's prediction (v0 passthrough). */
export function fuseAndPredict(db: Db, runId: number): FusedState {
  const run = getRow<RunRecord>(db, 'SELECT * FROM train_runs WHERE id=?', [runId]);
  if (!run) throw new Error('fuseAndPredict: missing run ' + String(runId));
  const state = fuseRunState(db, run);
  saveState(db, runId, JSON.stringify(state));

  // v0 model: our estimate = operator ETA (passthrough baseline; GOAL.md §64 step 10-13)
  if (state.destination.stopId && state.destinationOperatorEta != null) {
    recordPrediction(db, {
      modelVersion: 'passthrough-v0',
      runId,
      stopId: state.destination.stopId,
      generatedAt: Date.now(),
      schedArrEpoch: state.schedArrEpoch,
      operatorEtaEpoch: state.destinationOperatorEta,
      ourP10: state.destinationOperatorEta - 60_000,
      ourP50: state.destinationOperatorEta,
      ourP90: state.destinationOperatorEta + 60_000,
      confidence: state.confidence === 'HIGH' ? 0.8 : state.confidence === 'MEDIUM' ? 0.5 : 0.3,
    });
  }
  return state;
}

/** Debug helper for logs. */
export function stateSummaryLine(s: FusedState): string {
  const dep = s.schedDepEpoch != null ? new Date(s.schedDepEpoch).toISOString() : '?';
  const delay = s.operatorDelaySec != null ? (s.operatorDelaySec >= 0 ? '+' : '') + secondsToHms(s.operatorDelaySec) : '?';
  return s.trainNumber + '@' + s.serviceDate + ' ' + s.status + ' dep=' + dep + ' delay=' + delay + ' conf=' + s.confidence;
}

export function touchRunActivity(db: Db, runId: number): void {
  runStmt(db.prepare('UPDATE train_runs SET last_activity_at=? WHERE id=?'), [Date.now(), runId]);
}

export type { ProviderStopEvent };
