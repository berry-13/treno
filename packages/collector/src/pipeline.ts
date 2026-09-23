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
import { fillPredictionOutcomes, insertObservation, insertServiceAlert, providerHealth, recordPrediction, saveState, upsertStopEvent } from '#storage/observations.ts';
import { healthSnapshot, resolveTrust, type FusedProvenancePick } from './trust.ts';
import { deriveSegmentObservations } from '#storage/segments.ts';
import { notifyWatchers } from './notifications.ts';
import { recordSourceConflict } from './conflicts-backfill.ts';
import { predictHeuristic, recoveryPrediction, HEURISTIC_MODEL_VERSION } from './heuristic.ts';
import { applyResidual, getResidualModel, routeEncodingFor, type FeatureInput } from './model.ts';
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
    // §45 quality flags: detect anomalous delay jumps vs the previous
    // observation from the same source
    const flags: string[] = [];
    const prev = getRow<{ delay_seconds: number | null }>(
      db,
      'SELECT delay_seconds FROM train_observations WHERE run_id=? AND source=? ORDER BY ts DESC LIMIT 1',
      [runId, s.source],
    );
    if (prev?.delay_seconds != null && s.delaySeconds != null && Math.abs(s.delaySeconds - prev.delay_seconds) > 1200) {
      flags.push('DELAY_JUMP');
    }
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
      qualityFlags: flags,
      crowdingPct: s.source === 'mia' ? s.crowding : null,
      crowdingLabel: s.source === 'mia' ? s.crowdingLabel : null,
    });
    // §78 source conflicts: compare this delay observation against the other
    // rail source's latest inside a 90s window; a >120s disagreement is
    // materialized (5-min dedup). Rule constants live in conflicts-backfill.ts
    // so backfill replays exactly what happens here.
    if (s.delaySeconds != null) {
      recordSourceConflict(db, runId, s.source, meta.fetchedAt, s.observedAt, s.delaySeconds);
    }
  }

  // §50 alerts: persist provider alerts with dedup
  for (const alert of s.alerts.slice(0, 10)) {
    const asObj = typeof alert === 'object' && alert !== null ? alert as Record<string, unknown> : null;
    insertServiceAlert(db, {
      source: s.source,
      runId,
      stopId: null,
      title: asObj ? String(asObj.title ?? asObj.description ?? asObj.testo ?? '') || null : String(alert).slice(0, 120),
      description: asObj ? JSON.stringify(alert).slice(0, 1000) : null,
      severity: asObj && asObj.severity != null ? String(asObj.severity) : null,
      raw: alert,
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

  // §13: derive traversal observations from actual stop times
  deriveSegmentObservations(db, runId, s.serviceDate, s.source);

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
  /** §77 contextual-trust provenance: which source supplied delay/position,
   *  at what trust level and age, plus the quantified cross-source
   *  disagreement on delay (null when only one source reported). */
  provenance?: {
    delay: (FusedProvenancePick & { disagreementSeconds: number | null }) | null;
    position: FusedProvenancePick | null;
  };
  previousStop: { stopId: string; name: string | null; actualArrEpoch: number | null } | null;
  nextStop: { stopId: string; name: string | null; schedArrEpoch: number | null; opPredArrEpoch: number | null } | null;
  destinationOperatorEta: number | null;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  ourEstimate: {
    p10: number;
    p50: number;
    p90: number;
    modelVersion: string;
    confidence: number;
    recoverySec: number | null;
    operatorWeight: number;
    statsCoverage: number;
    corridorAdjustSec: number;
  } | null;
  quality: string[];
  stops: FusedStop[];
}

interface StopEventRow {
  stop_id: string;
  stop_sequence: number | null;
  sched_arr_epoch: number | null;
  sched_dep_epoch: number | null;
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

  // §77 contextual source trust: route the current-delay and position picks
  // through the declarative trust table. Identical outcome to the legacy
  // freshest-wins pick in the healthy, agreeing case (60s agreement window);
  // the value here is quantified disagreement (§78) and graceful degradation
  // when a provider's health state is DEGRADED/PAUSED.
  const health = healthSnapshot(providerHealth(db).map((r) => ({ source: r.source, state: r.state })));
  const delayCandidates = [...latestPerSource.values()]
    .filter((o) => o.delay_seconds != null)
    .map((o) => ({ source: o.source, value: o.delay_seconds as number, observedAt: o.observed_at ?? o.ts }));
  const posCandidates = [...latestPerSource.values()]
    .map((o) => ({ source: o.source, value: { id: o.location_id, name: o.location_name, kind: o.location_kind }, observedAt: o.observed_at ?? o.ts }));
  const delayPick = resolveTrust('current_delay', delayCandidates, health, { agreementSec: 60 });
  const posPick = resolveTrust('position', posCandidates, health);
  const pickAgeSec = (observedAt: number | null): number | null =>
    observedAt != null ? Math.round((now - observedAt) / 1000) : null;
  const provenance: FusedState['provenance'] = {
    delay: delayPick.chosen
      ? {
          source: delayPick.chosen.source,
          trust: delayPick.chosen.trust,
          observedAt: delayPick.chosen.observedAt,
          ageSec: pickAgeSec(delayPick.chosen.observedAt),
          disagreementSeconds: delayPick.disagreementSeconds,
          reason: delayPick.reason,
        }
      : null,
    position: posPick.chosen
      ? {
          source: posPick.chosen.source,
          trust: posPick.chosen.trust,
          observedAt: posPick.chosen.observedAt,
          ageSec: pickAgeSec(posPick.chosen.observedAt),
          reason: posPick.reason,
        }
      : null,
  };

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

  // §45 fused quality flags
  const quality: string[] = [];
  if (spread != null && spread > 300) quality.push('SOURCE_CONFLICT');
  if (Number.isFinite(freshAge) && freshAge > 600) quality.push('STALE_SOURCE');

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
    operatorDelaySec: delayPick.chosen?.value ?? null,
    latestLocation: posPick.chosen ? posPick.chosen.value : null,
    latestObservedAt: posPick.chosen?.observedAt ?? null,
    latestSource: posPick.chosen?.source ?? null,
    sources,
    sourceDelaySpreadSec: spread,
    provenance,
    previousStop: previousStopRow ? { stopId: previousStopRow.stop_id, name: stopName(db, previousStopRow.stop_id), actualArrEpoch: previousStopRow.actual_arr_epoch } : null,
    nextStop: nextStopRow ? { stopId: nextStopRow.stop_id, name: stopName(db, nextStopRow.stop_id), schedArrEpoch: nextStopRow.sched_arr_epoch, opPredArrEpoch: nextStopRow.op_pred_arr_epoch } : null,
    destinationOperatorEta: destOpEta,
    confidence,
    ourEstimate: null,
    quality,
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

/**
 * Fuse state, run the current prediction model, persist both. The recorded
 * model is heuristic-v1 (§66): independent segment-history estimate blended
 * with the operator ETA; the operator ETA is always stored alongside so the
 * benchmark can score both (§34).
 */
export function fuseAndPredict(db: Db, runId: number): FusedState {
  const run = getRow<RunRecord>(db, 'SELECT * FROM train_runs WHERE id=?', [runId]);
  if (!run) throw new Error('fuseAndPredict: missing run ' + String(runId));
  const state = fuseRunState(db, run);

  const events = getRows<StopEventRow>(
    db,
    'SELECT stop_id, stop_sequence, sched_arr_epoch, sched_dep_epoch, actual_arr_epoch, actual_dep_epoch FROM train_stop_events WHERE run_id=? ORDER BY stop_sequence ASC, sched_arr_epoch ASC',
    [runId],
  );
  let prediction = predictHeuristic(db, run, state, events);
  // residual model (trained by `npm run train`) corrects the heuristic when
  // it has proven itself on held-out data; loads lazily, hot-swaps on retrain
  const residual = getResidualModel();
  if (prediction && residual && state.schedArrEpoch != null) {
    const fi: FeatureInput = {
      generatedAt: Date.now(),
      schedArrEpoch: state.schedArrEpoch,
      operatorEtaEpoch: state.destinationOperatorEta,
      ourP50: prediction.p50,
      ourP10: prediction.p10,
      ourP90: prediction.p90,
      anchorKind: prediction.features.anchorKind,
      remainingSegments: prediction.features.remainingSegments,
      statsCoverage: prediction.features.statsCoverage,
      corridorAdjustSec: prediction.features.corridorAdjustSec,
      operatorWeight: prediction.features.operatorWeight,
      independentP50: prediction.features.independentP50,
      originDepDelaySec: prediction.features.originDepDelaySec,
      trainHistoryDelaySec: prediction.features.trainHistoryDelaySec,
      networkDelaySec: prediction.features.networkDelaySec,
      operatorEtaDriftSec: prediction.features.operatorEtaDriftSec,
      alertsRun24h: prediction.features.alertsRun24h,
      alertsRoute24h: prediction.features.alertsRoute24h,
      precipMm: prediction.features.precipMm,
      strikeActive: prediction.features.strikeActive,
      eventHoursToStart: prediction.features.eventHoursToStart,
      holiday: prediction.features.holiday,
      upstreamStopMaxDelaySec: prediction.features.upstreamStopMaxDelaySec,
      upstreamStopDelayedCount: prediction.features.upstreamStopDelayedCount,
      routeId: prediction.features.routeId,
      routeEncSec: residual ? routeEncodingFor(residual, run.route_id) : 0,
      etaAccelSec: prediction.features.etaAccelSec,
      delaySourceSpreadSec: prediction.features.delaySourceSpreadSec,
    };
    const corrected = applyResidual(residual, fi, prediction.p10, prediction.p50, prediction.p90);
    prediction = {
      ...prediction,
      p10: corrected.p10,
      p50: corrected.p50,
      p90: corrected.p90,
      modelVersion: corrected.modelVersion,
    };
  }
  if (prediction) {
    state.ourEstimate = {
      p10: prediction.p10,
      p50: prediction.p50,
      p90: prediction.p90,
      modelVersion: prediction.modelVersion,
      confidence: prediction.confidence,
      recoverySec: recoveryPrediction(state, prediction.p50),
      operatorWeight: prediction.features.operatorWeight,
      statsCoverage: prediction.features.statsCoverage,
      corridorAdjustSec: prediction.features.corridorAdjustSec,
    };
  }
  saveState(db, runId, JSON.stringify(state));

  // §61: thresholded pushes for devices watching this run (no-op without
  // watches / APNs config); risk signal reuses the §51 upstream feature
  notifyWatchers(db, runId, {
    status: state.status,
    trainNumber: state.trainNumber,
    ourEstimate: state.ourEstimate ? { p50: state.ourEstimate.p50 } : null,
    riskNotice: prediction && (prediction.features.upstreamStopDelayedCount ?? 0) >= 2 ? { upstream: true } : null,
  });

  if (prediction && state.destination.stopId) {
    // record at benchmark-useful granularity: always when the estimate moves
    // materially, else at most every 2 minutes (keeps T-1..T-5 horizon rows
    // while cutting prediction volume several-fold)
    const last = getRow<{ our_p50: number | null; operator_eta_epoch: number | null; generated_at: number }>(
      db,
      'SELECT our_p50, operator_eta_epoch, generated_at FROM predictions WHERE run_id=? ORDER BY generated_at DESC LIMIT 1',
      [runId],
    );
    const movedEnough = (a: number | null, b: number | null) =>
      a == null || b == null || Math.abs(a - b) > 30_000;
    const due = last == null
      || movedEnough(last.our_p50, prediction.p50)
      || movedEnough(last.operator_eta_epoch, state.destinationOperatorEta)
      || Date.now() - last.generated_at > 120_000;
    if (due) {
      recordPrediction(db, {
        modelVersion: prediction.modelVersion,
        runId,
        stopId: state.destination.stopId,
        generatedAt: Date.now(),
        schedArrEpoch: state.schedArrEpoch,
        operatorEtaEpoch: state.destinationOperatorEta,
        ourP10: prediction.p10,
        ourP50: prediction.p50,
        ourP90: prediction.p90,
        confidence: prediction.confidence,
        featuresJson: JSON.stringify(prediction.features),
      });
    }
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
