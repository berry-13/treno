/**
 * Heuristic prediction model v1 (GOAL.md §66) and connection risk (§18).
 *
 * Independent estimate: anchor at the last actual stop event, then sum
 * historical per-segment runtime medians (segment_stats, with live corridor
 * adjustment from the most recent traversals) for the remaining path, falling
 * back to scheduled runtimes where history is thin. Blend with the operator
 * ETA, weighting by observation freshness and history coverage. Uncertainty
 * comes from per-segment runtime spread (p10..p90), skewed late.
 *
 * Never presented as operator data: outputs carry modelVersion + provenance.
 */
import { getRow, getRows, type Db } from '#core/db.ts';
import { statsForSegment, corridorDelta, segmentId } from '#storage/segments.ts';
import type { RunRecord } from '#storage/runs.ts';
import type { FusedState } from './pipeline.ts';
import { stopDepartures } from '#gtfs/schedule.ts';
import { bareTrainNumber } from './discover.ts';
import { romeWallToEpoch, romeYmd, secondsToHms } from '#core/time.ts';

export const HEURISTIC_MODEL_VERSION = 'heuristic-v1';

export interface StopEventLite {
  stop_id: string;
  stop_sequence: number | null;
  sched_arr_epoch: number | null;
  sched_dep_epoch: number | null;
  actual_arr_epoch: number | null;
  actual_dep_epoch: number | null;
}

export interface HeuristicPrediction {
  p10: number;
  p50: number;
  p90: number;
  confidence: number; // 0..1
  modelVersion: string;
  features: {
    anchorKind: 'actual_dep' | 'actual_arr' | 'schedule' | null;
    anchorStopId: string | null;
    anchorEpoch: number | null;
    remainingSegments: number;
    statsCoverage: number; // fraction of remaining segments with history
    corridorAdjustSec: number;
    operatorWeight: number;
    independentP50: number;
    // context features (computed by the pipeline, learned by future models)
    originDepDelaySec: number | null;      // how late this train left its origin
    trainHistoryDelaySec: number | null;   // median recent arrival delay of this train number
    networkDelaySec: number | null;        // mean live delay across the network right now
    operatorEtaDriftSec: number | null;    // operator ETA movement over the last ~5 min
    alertsRun24h: number | null;           // alerts attached to this run (24h)
    alertsRoute24h: number | null;         // alerts at this route's stops (24h)
  };
}

export function predictHeuristic(db: Db, run: RunRecord, state: FusedState, events: StopEventLite[]): HeuristicPrediction | null {
  if (events.length < 2) return null;
  const destArr = events[events.length - 1]!.sched_arr_epoch ?? run.sched_arr_epoch;
  if (destArr == null) return null;
  if (state.status === 'arrived' || state.status === 'cancelled') return null;

  // anchor: last stop with an actual time
  let anchorIdx = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.actual_dep_epoch != null || e.actual_arr_epoch != null) { anchorIdx = i; break; }
  }

  let anchorEpoch: number | null = null;
  let anchorKind: HeuristicPrediction['features']['anchorKind'] = null;
  let dwellSec = 0;
  if (anchorIdx >= 0) {
    const a = events[anchorIdx]!;
    if (a.actual_dep_epoch != null) { anchorEpoch = a.actual_dep_epoch; anchorKind = 'actual_dep'; }
    else { anchorEpoch = a.actual_arr_epoch!; anchorKind = 'actual_arr'; dwellSec = 45; }
  } else {
    // not departed (or no actuals yet): anchor on schedule nudged by the
    // operator's current delay once the train should be underway
    anchorEpoch = run.sched_dep_epoch;
    anchorKind = 'schedule';
    if (anchorEpoch != null && state.operatorDelaySec != null && Date.now() > anchorEpoch) {
      anchorEpoch += state.operatorDelaySec * 1000;
    }
  }
  if (anchorEpoch == null) return null;

  // remaining segments: (anchor..dest) or (first..dest) when not departed
  const fromIdx = anchorIdx >= 0 ? anchorIdx : 0;
  const segments: Array<{ from: StopEventLite; to: StopEventLite; schedSec: number | null }> = [];
  for (let i = fromIdx; i + 1 < events.length; i++) {
    const from = events[i]!;
    const to = events[i + 1]!;
    const fRef = from.sched_dep_epoch ?? from.sched_arr_epoch;
    const tRef = to.sched_arr_epoch ?? to.sched_dep_epoch;
    const schedSec = fRef != null && tRef != null ? Math.round((tRef - fRef) / 1000) : null;
    segments.push({ from, to, schedSec });
  }
  if (segments.length === 0) return null;

  let totalSec = dwellSec;
  let corridorAdjTotal = 0;
  let spreadSq = 0;
  let withStats = 0;
  for (const seg of segments) {
    const segId = segmentId(seg.from.stop_id, seg.to.stop_id);
    const tod = Math.round(((anchorEpoch % 86400_000) + 8640_000) % 86400_000 / 1000);
    const stats = statsForSegment(db, segId, tod);
    const base = stats?.rt_p50 ?? seg.schedSec;
    if (stats) withStats++;
    if (base == null) continue; // no schedule and no history for this pair
    const corridor = corridorDelta(db, segId) ?? 0;
    corridorAdjTotal += corridor;
    totalSec += Math.max(30, base + corridor);
    const spread = stats ? Math.max(20, (stats.rt_p90! - stats.rt_p10!) / 2) : Math.max(45, 0.25 * (seg.schedSec ?? 180));
    spreadSq += spread * spread;
  }
  const independentP50 = anchorEpoch + totalSec * 1000;
  const coverage = segments.length > 0 ? withStats / segments.length : 0;

  // blend weight (GOAL.md §66): trust the operator more when its observation
  // is fresh, less when it is stale or our history is strong
  const opEta = state.destinationOperatorEta;
  let wOp = 0.65;
  if (opEta == null) wOp = 0;
  else {
    const freshestAge = Math.min(...Object.values(state.sources).map((s) => s.ageSec ?? Infinity));
    if (Number.isFinite(freshestAge) && freshestAge > 300) wOp = 0.45;
    if (coverage < 0.34) wOp = Math.max(wOp, 0.8);
    if (coverage >= 0.67) wOp = Math.min(wOp, 0.55);
  }
  const p50 = opEta != null ? Math.round(wOp * opEta + (1 - wOp) * independentP50) : Math.round(independentP50);

  const spreadTotal = Math.min(15 * 60, Math.sqrt(spreadSq) + 40);
  const p10 = Math.round(p50 - 0.8 * spreadTotal * 1000);
  const p90 = Math.round(p50 + 1.2 * spreadTotal * 1000);

  const confBase = state.confidence === 'HIGH' ? 0.75 : state.confidence === 'MEDIUM' ? 0.55 : 0.35;
  const confidence = Math.round((confBase * (0.6 + 0.4 * Math.min(1, coverage)) + (opEta == null ? -0.1 : 0)) * 100) / 100;

  return {
    p10, p50, p90,
    confidence: Math.max(0.05, Math.min(0.95, confidence)),
    modelVersion: HEURISTIC_MODEL_VERSION,
    features: ((): HeuristicPrediction['features'] => {
      const ctx = contextFeatures(db, run);
      const al = alertFeatures(db, run);
      return {
        anchorKind,
        anchorStopId: anchorIdx >= 0 ? events[anchorIdx]!.stop_id : null,
        anchorEpoch,
        remainingSegments: segments.length,
        statsCoverage: Math.round(coverage * 100) / 100,
        corridorAdjustSec: Math.round(corridorAdjTotal),
        operatorWeight: wOp,
        independentP50,
        originDepDelaySec: ctx.originDepDelaySec,
        trainHistoryDelaySec: ctx.trainHistoryDelaySec,
        networkDelaySec: networkDelayNow(db),
        operatorEtaDriftSec: operatorEtaDrift(db, run.id, state.destinationOperatorEta),
        alertsRun24h: al.onRun,
        alertsRoute24h: al.onRoute,
      };
    })(),
  };
}

/** Context features the heuristic doesn't use but future trained models do.
 *  Kept deliberately cheap (single-row lookups). */
function contextFeatures(db: Db, run: RunRecord): { originDepDelaySec: number | null; trainHistoryDelaySec: number | null } {
  const origin = getRow<{ d: number }>(
    db,
    'SELECT (e.actual_dep_epoch - e.sched_dep_epoch) AS d FROM train_stop_events e WHERE e.run_id=? AND e.stop_id=? AND e.actual_dep_epoch IS NOT NULL AND e.sched_dep_epoch IS NOT NULL',
    [run.id, run.origin_stop_id ?? ''],
  );
  const hist = getRows<{ d: number }>(
    db,
    'SELECT e.arr_delay_sec AS d FROM train_stop_events e JOIN train_runs r ON r.id=e.run_id WHERE r.train_number=? AND e.stop_id=r.destination_stop_id AND e.arr_delay_sec IS NOT NULL AND e.actual_arr_epoch>? ORDER BY e.actual_arr_epoch DESC LIMIT 20',
    [run.train_number, Date.now() - 14 * 86400_000],
  );
  let trainHistoryDelaySec: number | null = null;
  if (hist.length >= 3) {
    const ds = hist.map((h) => h.d).sort((a, b) => a - b);
    trainHistoryDelaySec = ds[Math.floor(ds.length / 2)]!;
  }
  return { originDepDelaySec: origin != null ? Math.round(origin.d / 1000) : null, trainHistoryDelaySec };
}

/** how fast the operator's own ETA is moving (projected to 5 min) — a
 *  drifting ETA predicts more drift; position alone doesn't show it */
function operatorEtaDrift(db: Db, runId: number, etaNow: number | null): number | null {
  if (etaNow == null) return null;
  const rows = getRows<{ operator_eta_epoch: number; generated_at: number }>(
    db,
    'SELECT operator_eta_epoch, generated_at FROM predictions WHERE run_id=? AND operator_eta_epoch IS NOT NULL ORDER BY generated_at DESC LIMIT 2',
    [runId],
  );
  if (rows.length < 2) return null;
  const dt = (rows[0]!.generated_at - rows[1]!.generated_at) / 1000;
  if (dt < 30) return null;
  return Math.round(((rows[0]!.operator_eta_epoch - rows[1]!.operator_eta_epoch) / 1000 / dt) * 300);
}

function alertFeatures(db: Db, run: RunRecord): { onRun: number; onRoute: number } {
  const since = Date.now() - 24 * 3600_000;
  const onRun = (getRow<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM service_alerts WHERE run_id=? AND created_at > ?', [run.id, since]) ?? { n: 0 }).n;
  const onRoute = (getRow<{ n: number }>(
    db,
    'SELECT COUNT(*) AS n FROM service_alerts WHERE created_at > ? AND stop_id IN (SELECT stop_id FROM train_stop_events WHERE run_id=?)',
    [since, run.id],
  ) ?? { n: 0 }).n;
  return { onRun: Math.min(onRun, 10), onRoute: Math.min(onRoute, 10) };
}

function networkDelayNow(db: Db): number | null {
  const r = getRow<{ m: number }>(
    db,
    "SELECT AVG(CAST(json_extract(state_json,'$.operatorDelaySec') AS REAL)) AS m FROM train_state WHERE updated_at > ? AND json_extract(state_json,'$.operatorDelaySec') IS NOT NULL",
    [Date.now() - 10 * 60_000],
  );
  return r?.m != null ? Math.round(r.m) : null;
}

/** Expected delay change from now to destination (positive = recovering). */
export function recoveryPrediction(state: FusedState, p50: number): number | null {
  const schedArr = state.schedArrEpoch;
  const current = state.operatorDelaySec;
  if (schedArr == null || current == null) return null;
  const expectedAtDest = (p50 - schedArr) / 1000;
  return Math.round(current - expectedAtDest);
}

// MARK: - connection probability (§18)

function erf(x: number): number {
  // Abramowitz & Stegun 7.1.26
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-ax * ax);
  return sign * y;
}

function normalCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

export interface ConnectionOption {
  trainNumber: string;
  line: string | null;
  destinationName: string | null;
  depEpoch: number;
  transferSec: number;
  probability: number;
  operatorDelaySec: number | null;
}

/**
 * Next departures from the arrival station with P(making it), using our
 * arrival distribution (p10..p90 → σ) and a per-station transfer buffer.
 */
export function connectionOptions(
  db: Db,
  destStopId: string,
  serviceDate: string,
  ourP50: number,
  ourP10: number,
  ourP90: number,
  currentTrainNumber: string | null,
  opts: { transferSec?: number; limit?: number; horizonMin?: number } = {},
): ConnectionOption[] {
  const transferSec = opts.transferSec ?? 240;
  const limit = opts.limit ?? 3;
  const horizonMs = (opts.horizonMin ?? 90) * 60_000;
  const sigmaMs = Math.max(30_000, ((ourP90 - ourP10) / 2) / 1.2816);
  const windowStart = ourP50 - 5 * 60_000;
  const romeMidnight = romeWallToEpoch(serviceDate, 0);
  const fromSec = Math.floor((windowStart - romeMidnight) / 1000);
  const toSec = Math.ceil((ourP50 + horizonMs - romeMidnight) / 1000);
  const deps = stopDepartures(db, destStopId, serviceDate, fromSec, toSec);
  const out: ConnectionOption[] = [];
  for (const d of deps) {
    if (d.train_number == null || d.departure_sec == null) continue;
    const bare = bareTrainNumber(d.train_number) ?? d.train_number;
    // exclude the arriving service continuing its own journey
    if (currentTrainNumber != null && bare === currentTrainNumber) continue;
    const depEpoch = romeWallToEpoch(serviceDate, d.departure_sec);
    if (depEpoch < windowStart) continue;
    // live delay of the connecting service, if tracked
    const live = getRows<{ delay_seconds: number | null }>(
      db,
      'SELECT o.delay_seconds FROM train_observations o JOIN train_runs r ON r.id = o.run_id WHERE r.service_date = ? AND r.train_number = ? ORDER BY o.ts DESC LIMIT 1',
      [serviceDate, bare],
    );
    const opDelay = live[0]?.delay_seconds ?? null;
    const effDep = depEpoch + (opDelay ?? 0) * 1000;
    const z = (effDep - transferSec * 1000 - ourP50) / sigmaMs;
    const probability = Math.max(0.001, Math.min(0.999, normalCdf(z)));
    const destName = d.destination_stop_id != null
      ? (getName(db, d.destination_stop_id) ?? d.destination_stop_id)
      : null;
    out.push({
      trainNumber: bare,
      line: d.train_number,
      destinationName: destName,
      depEpoch: effDep,
      transferSec,
      probability: Math.round(probability * 1000) / 1000,
      operatorDelaySec: opDelay,
    });
    if (out.length >= limit + 2) break;
  }
  return out.slice(0, limit);
}

function getName(db: Db, stopId: string): string | null {
  const r = getRows<{ stop_name: string }>(db, 'SELECT stop_name FROM gtfs_stops WHERE stop_id=?', [stopId]);
  return r[0]?.stop_name ?? null;
}

export function romeYmdOf(epochMs: number): string {
  return romeYmd(epochMs);
}

export { secondsToHms };
