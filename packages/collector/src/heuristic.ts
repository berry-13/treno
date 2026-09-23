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
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '#core/config.ts';
import { predictGBM } from './gbm.ts';
import { connectionRow } from './train-connections.ts';
import { statsForSegment, corridorDelta, segmentId, quantile } from '#storage/segments.ts';
import type { RunRecord } from '#storage/runs.ts';
import type { FusedState } from './pipeline.ts';
import { currentPrecipMm, precipSource } from './weather.ts';
import { gaugePrecipMm } from './weather-arpa.ts';
import { eventFeatures, upstreamFeatures } from './events.ts';
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
    precipMm: number | null;               // rain used: ARPA gauge measurement preferred, DWD ICON forecast fallback
    precipSource: string | null;           // 'arpa-gauge' | 'dwd-icon' | null (provenance)
    // exogenous calendar + §51 propagation (point-in-time from calendar_events)
    strikeActive: number | null;           // rail/general strike ongoing or starting within 3h
    eventHoursToStart: number | null;      // signed hours to nearest strike/stadium event (±24)
    holiday: 0 | 1;                        // service day is an Italian holiday
    upstreamStopMaxDelaySec: number | null;   // worst departure delay at the next stop, last 45 min
    upstreamStopDelayedCount: number | null;  // trains leaving the next stop ≥5 min late, last 45 min
    routeId: string | null;                    // line identity (P4 target-encoding key)
    etaAccelSec: number | null;                // 2nd-order operator-ETA movement (sec per 5min²)
    delaySourceSpreadSec: number | null;       // §78: latest materialized MIA-vs-VT delay disagreement at or before now (0 = agreement); stored to features_json for training
    // §51 propagation corridor evidence for the risk-notice generator
    // (point-in-time, default config; recorded so nightly replays can sweep
    // thresholds without recomputing history — append-only, the residual
    // model ignores unknown keys)
    corridorEvidenceTrains: number | null;     // preceding trains observed on the upcoming segments in the evidence window
    corridorSevereTrains: number | null;       // of those, trains >10 min late (double-weight candidate (b))
    corridorCancelledTrains: number | null;    // trains cancelled at the next stop in the window (strongest propagation evidence)
    corridorMedianDeltaSec: number | null;     // median runtime delta across those traversals (the corridor deviation)
    corridorEvidencePersisted: number | null;  // 1/0: same deviation present at the previous refresh too (candidate (a)); null when persistence tracking is off
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
    // prior-only rows carry 2015 drift in rt_p50 (measured worse than the
    // current schedule); their value is the spread, so the point estimate
    // stays anchored on today's GTFS and they do not count as coverage —
    // keeping statsCoverage's meaning identical to pre-backfill for the
    // trained residual model
    const base = stats?.origin === 'prior' && seg.schedSec != null ? seg.schedSec : (stats?.rt_p50 ?? seg.schedSec);
    if (stats && stats.origin !== 'prior') withStats++;
    if (base == null) continue; // no schedule and no history for this pair
    const corridor = corridorDelta(db, segId) ?? 0;
    corridorAdjTotal += corridor;
    totalSec += Math.max(30, base + corridor);
    // spread: live quantiles when we have them; the no-history guess when we
    // don't; prior-only segments take the MAX of guess and prior — 2015
    // minute-quantized spreads undercover on their own (measured 66% vs 83%
    // in an 80% band), so history can only widen uncertainty, never narrow it
    const guessSpread = Math.max(45, 0.25 * (seg.schedSec ?? 180));
    const priorSpread = stats?.origin === 'prior' && stats.rt_p90 != null && stats.rt_p10 != null
      ? Math.max(20, (stats.rt_p90 - stats.rt_p10) / 2)
      : null;
    const spread = stats?.origin === 'live'
      ? Math.max(20, (stats.rt_p90! - stats.rt_p10!) / 2)
      : priorSpread != null ? Math.max(guessSpread, priorSpread) : guessSpread;
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
  // §77 coupling: when the trust resolver reports MIA and ViaggiaTreno
  // disagreeing by >300s on the current delay, the fused input itself is
  // suspect — shave confidence before the clamp below
  const delayDisagreementSec = state.provenance?.delay?.disagreementSeconds ?? null;
  const trustDisagreementPenalty = delayDisagreementSec != null && delayDisagreementSec > 300 ? 0.1 : 0;
  const confidence = Math.round((confBase * (0.6 + 0.4 * Math.min(1, coverage)) + (opEta == null ? -0.1 : 0) - trustDisagreementPenalty) * 100) / 100;

  return {
    p10, p50, p90,
    confidence: Math.max(0.05, Math.min(0.95, confidence)),
    modelVersion: HEURISTIC_MODEL_VERSION,
    features: ((): HeuristicPrediction['features'] => {
      const ctx = contextFeatures(db, run);
      const al = alertFeatures(db, run);
      const ev = eventFeatures(db, run.service_date, events.map((e) => e.stop_id));
      const nextStopId = events[anchorIdx >= 0 ? anchorIdx + 1 : 0]?.stop_id ?? null;
      const up = upstreamFeatures(db, nextStopId);
      const vel = operatorEtaVelocity(db, run.id);
      const corridorEv = liveCorridorEvidence(db, run.id, events);
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
        operatorEtaDriftSec: vel.driftSec,
        alertsRun24h: al.onRun,
        alertsRoute24h: al.onRoute,
        precipMm: gaugePrecipMm() ?? currentPrecipMm(),
        precipSource: gaugePrecipMm() != null ? 'arpa-gauge' : precipSource(),
        strikeActive: ev.strikeActive,
        eventHoursToStart: ev.eventHoursToStart,
        holiday: ev.holiday,
        upstreamStopMaxDelaySec: up.upstreamStopMaxDelaySec,
        upstreamStopDelayedCount: up.upstreamStopDelayedCount,
        routeId: run.route_id,
        etaAccelSec: vel.accelSec,
        delaySourceSpreadSec: latestConflictSpread(db, run.id, Date.now()),
        corridorEvidenceTrains: corridorEv.evidence.trains,
        corridorSevereTrains: corridorEv.evidence.severeTrains,
        corridorCancelledTrains: corridorEv.evidence.cancelledTrains,
        corridorMedianDeltaSec: corridorEv.evidence.medianRuntimeDeltaSec,
        corridorEvidencePersisted: corridorEv.persisted,
      };
    })(),
  };
}

/** §78 point-in-time lookup: the newest source_conflicts row for this run at
 *  or before `atMs` (rows materialized after the prediction instant are
 *  invisible, so training and serving see the same past). null when the two
 *  sources have never disagreed on this run — featureRow maps null to 0. */
export function latestConflictSpread(db: Db, runId: number, atMs: number): number | null {
  const r = getRow<{ spread_seconds: number }>(
    db,
    "SELECT spread_seconds FROM source_conflicts WHERE run_id=? AND field='delay_seconds' AND ts<=? ORDER BY ts DESC LIMIT 1",
    [runId, atMs],
  );
  return r?.spread_seconds ?? null;
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

/** how fast the operator's own ETA is moving (projected to 5 min) and its
 *  acceleration — a drifting ETA predicts more drift, and a turning one
 *  predicts recovery/stall; position alone doesn't show either */
function operatorEtaVelocity(db: Db, runId: number): { driftSec: number | null; accelSec: number | null } {
  const rows = getRows<{ operator_eta_epoch: number; generated_at: number }>(
    db,
    'SELECT operator_eta_epoch, generated_at FROM predictions WHERE run_id=? AND operator_eta_epoch IS NOT NULL ORDER BY generated_at DESC LIMIT 3',
    [runId],
  );
  if (rows.length < 2) return { driftSec: null, accelSec: null };
  const rate = (a: { operator_eta_epoch: number; generated_at: number }, b: { operator_eta_epoch: number; generated_at: number }): number | null => {
    const dt = (a.generated_at - b.generated_at) / 1000;
    if (dt < 30) return null;
    return ((a.operator_eta_epoch - b.operator_eta_epoch) / 1000 / dt) * 300; // sec per 5 min
  };
  const driftSec = rate(rows[0]!, rows[1]!);
  if (driftSec == null) return { driftSec: null, accelSec: null };
  let accelSec: number | null = null;
  if (rows.length >= 3) {
    const d2 = rate(rows[1]!, rows[2]!);
    if (d2 != null) accelSec = Math.round(driftSec - d2);
  }
  return { driftSec: Math.round(driftSec), accelSec };
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

// MARK: - §51 risk-notice generator (configurable)

/**
 * Pre-emptive "delays building ahead of your train" notice (GOAL.md §51).
 *
 * Rule: the run's upcoming corridor segments show ≥ minPrecedingTrains
 * preceding-train traversals inside the evidence window whose MEDIAN runtime
 * delta reaches minMedianRuntimeDeltaSec, and our own p50 already projects
 * ≥ minP50MoveSec of lateness. Every threshold lives in ONE exported config
 * so the nightly replay sweep can measure and the operator can tune each
 * knob independently; the precision gate itself is deliberately NOT here
 * (it is a constant in backtest.ts — tuning evidence thresholds is the
 * legitimate lever, moving the gate is not).
 *
 * Defaults reproduce the shipped live trigger (≥2 traversals losing >90s
 * within 20 min + p50 ≥60s late). One deliberate nuance: the delta gate is
 * the median across traversals rather than a per-train floor, so a corridor
 * where most trains still run on time cannot fire off one outlier — that is
 * the precision direction the gate wants.
 */
export interface RiskNoticeConfig {
  /** minimum preceding trains observed losing time in the evidence window */
  minPrecedingTrains: number;
  /** lookback window for preceding-train evidence, minutes */
  evidenceWindowMin: number;
  /** median runtime delta across evidence traversals must reach this (sec) */
  minMedianRuntimeDeltaSec: number;
  /** our p50 must already project at least this much lateness (sec) */
  minP50MoveSec: number;
  /** (a) require the corridor deviation present in 2 consecutive refreshes */
  requirePersistence: boolean;
  /** (b) a preceding train cancelled or >10 min late counts double */
  weightSevereEvidence: boolean;
  /** (c) widen the evidence window at peak hours (7–9 / 17–19 Rome) */
  adaptiveWindow: boolean;
}

/** Current behavior — the shipped §51 trigger. */
export const DEFAULT_RISK_NOTICE_CONFIG: RiskNoticeConfig = {
  minPrecedingTrains: 2,
  evidenceWindowMin: 20,
  minMedianRuntimeDeltaSec: 90,
  minP50MoveSec: 60,
  requirePersistence: false,
  weightSevereEvidence: false,
  adaptiveWindow: false,
};

/** a preceding train >10 min late (or cancelled) is qualitatively different
 *  evidence than one running 2 min down — candidate (b) weights it double */
const SEVERE_LATE_SEC = 600;
/** peak multiplier for candidate (c): headways are shortest at peak, so the
 *  same number of affected trains accrues faster — a wider window keeps the
 *  per-window train count comparable across the day */
const ADAPTIVE_PEAK_WINDOW_FACTOR = 1.5;
/** two refreshes count as "consecutive" only if they are this close */
export const PERSISTENCE_MAX_GAP_MS = 15 * 60_000;

let liveRiskCfgCache: { raw: string | null; cfg: RiskNoticeConfig } | null = null;

/**
 * Live config = code defaults overridden by TRENO_RISK_NOTICE_CONFIG (JSON),
 * so an operator can act on a sweep result without a code change:
 *   TRENO_RISK_NOTICE_CONFIG='{"minPrecedingTrains":3,"minMedianRuntimeDeltaSec":120}'
 * Unknown keys and malformed JSON fall back to the defaults (never widen).
 */
export function loadRiskNoticeConfig(): RiskNoticeConfig {
  const raw = process.env.TRENO_RISK_NOTICE_CONFIG ?? null;
  if (liveRiskCfgCache && liveRiskCfgCache.raw === raw) return liveRiskCfgCache.cfg;
  const merged: Record<string, number | boolean> = { ...DEFAULT_RISK_NOTICE_CONFIG };
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      for (const [k, v] of Object.entries(parsed)) {
        if (!(k in merged)) continue;
        if (typeof v === typeof merged[k] && (typeof v === 'number' || typeof v === 'boolean')) merged[k] = v;
      }
    } catch { /* malformed override: keep defaults */ }
  }
  const cfg = merged as unknown as RiskNoticeConfig;
  liveRiskCfgCache = { raw, cfg };
  return cfg;
}

/** Rome-local rush hours for candidate (c) (7–9 / 17–19). */
export function isRushHourRome(epochMs: number): boolean {
  const h = Number(new Date(epochMs).toLocaleString('en-GB', { timeZone: 'Europe/Rome', hour: 'numeric', hour12: false })) || 12;
  return (h >= 7 && h < 9) || (h >= 17 && h < 19);
}

/** Window actually applied for a prediction instant (minutes). */
export function effectiveEvidenceWindowMin(cfg: RiskNoticeConfig, asOfMs: number): number {
  return cfg.adaptiveWindow && isRushHourRome(asOfMs)
    ? Math.round(cfg.evidenceWindowMin * ADAPTIVE_PEAK_WINDOW_FACTOR)
    : cfg.evidenceWindowMin;
}

/** Minimal stop shape the §51 scope needs (both live and replay stops fit). */
export interface RiskNoticeStop {
  stop_id: string;
  actual_arr_epoch?: number | null;
  actual_dep_epoch?: number | null;
  cancelled?: number | null;
}

export interface RiskNoticeSegmentScope {
  segmentIds: string[];
  nextStopId: string | null;
}

/**
 * Which corridor the notice looks at: the segments around the first stop the
 * run has not yet served at `asOfMs` — one behind (the approach) plus the
 * next three ahead, mirroring the served API rule. For live calls (asOf =
 * now) the final-actual reconstruction below is a no-op; for replays it
 * recreates the point-in-time "not yet served" set from final actuals.
 */
export function riskNoticeScope(stops: RiskNoticeStop[], asOfMs: number): RiskNoticeSegmentScope {
  const notYetServed = (s: RiskNoticeStop): boolean => {
    if (s.cancelled === 1) return false;
    const a = s.actual_arr_epoch ?? null;
    const d = s.actual_dep_epoch ?? null;
    if (a == null && d == null) return true; // never served (as far as recorded)
    const served = Math.min(...[a, d].filter((x): x is number => x != null));
    return served > asOfMs; // replay only: actual arrived after the prediction instant
  };
  let firstUpcoming = stops.findIndex(notYetServed);
  if (firstUpcoming < 0) return { segmentIds: [], nextStopId: null };
  const segmentIds: string[] = [];
  for (let i = Math.max(0, firstUpcoming - 1); i + 1 < stops.length && i < firstUpcoming + 3; i++) {
    segmentIds.push(segmentId(stops[i]!.stop_id, stops[i + 1]!.stop_id));
  }
  return { segmentIds, nextStopId: stops[firstUpcoming]!.stop_id };
}

/** Aggregated corridor evidence — config-free aggregate so replays can cache
 *  it per window and evaluate many configs cheaply. */
export interface RiskNoticeEvidence {
  /** distinct preceding-train traversals in the window (raw count) */
  trains: number;
  /** of those, traversals by trains >10 min late (entry or exit) */
  severeTrains: number;
  /** trains cancelled at the next stop in the window (never traversed) */
  cancelledTrains: number;
  /** median runtime delta across the traversals (sec) — the corridor deviation */
  medianRuntimeDeltaSec: number | null;
  /** worst single runtime delta (sec) */
  maxRuntimeDeltaSec: number | null;
  /** window the aggregate covers (minutes) */
  windowMin: number;
  /** segment with the worst per-segment median delta */
  worstSegmentId: string | null;
}

export interface RiskEvidenceTraversal {
  segment_id: string;
  entered_at: number;
  delay_delta_sec: number | null;
  entry_delay_sec: number | null;
  exit_delay_sec: number | null;
}

/** Weighted count under candidate (b): severe/cancelled trains count double. */
export function weightedEvidenceTrains(evidence: RiskNoticeEvidence, cfg: RiskNoticeConfig): number {
  return cfg.weightSevereEvidence
    ? evidence.trains + evidence.severeTrains + evidence.cancelledTrains
    : evidence.trains;
}

/** Median runtime delta a traversal set represents (null when empty). */
export function aggregateRiskNoticeEvidence(
  traversals: RiskEvidenceTraversal[],
  cancelledTrains: number,
  windowMin: number,
): RiskNoticeEvidence {
  const seen = traversals.filter((t) => t.delay_delta_sec != null);
  const deltas = seen.map((t) => t.delay_delta_sec!);
  const perSegment = new Map<string, number[]>();
  for (const t of seen) {
    const list = perSegment.get(t.segment_id) ?? [];
    list.push(t.delay_delta_sec!);
    perSegment.set(t.segment_id, list);
  }
  let worstSegmentId: string | null = null;
  let worstMedian = -Infinity;
  for (const [segId, ds] of perSegment) {
    const med = quantile([...ds].sort((a, b) => a - b), 0.5) ?? -Infinity;
    if (med > worstMedian) { worstMedian = med; worstSegmentId = segId; }
  }
  const severe = seen.filter((t) => Math.max(t.entry_delay_sec ?? 0, t.exit_delay_sec ?? 0) >= SEVERE_LATE_SEC).length;
  return {
    trains: seen.length,
    severeTrains: severe,
    cancelledTrains,
    medianRuntimeDeltaSec: deltas.length > 0 ? quantile([...deltas].sort((a, b) => a - b), 0.5) : null,
    maxRuntimeDeltaSec: deltas.length > 0 ? Math.max(...deltas) : null,
    windowMin,
    worstSegmentId,
  };
}

/**
 * The generator's decision. Pure: given the corridor evidence, our projected
 * lateness and a config, should the notice fire? `persisted` (candidate (a))
 * is tri-state — null when persistence is not being checked.
 */
export function riskNoticeFires(
  evidence: RiskNoticeEvidence,
  ourP50DelaySec: number | null,
  cfg: RiskNoticeConfig,
  persisted: boolean | null = null,
): boolean {
  if (weightedEvidenceTrains(evidence, cfg) < cfg.minPrecedingTrains) return false;
  if (evidence.medianRuntimeDeltaSec == null || evidence.medianRuntimeDeltaSec < cfg.minMedianRuntimeDeltaSec) return false;
  if (ourP50DelaySec == null || ourP50DelaySec < cfg.minP50MoveSec) return false;
  if (cfg.requirePersistence && persisted !== true) return false;
  return true;
}

/**
 * Evidence for one prediction instant straight from the tables
 * (point-in-time when asOfMs < now: only traversals entered at or before the
 * instant count). Two cheap queries.
 */
export function precedingTrainEvidence(
  db: Db,
  scope: RiskNoticeSegmentScope,
  opts: { asOfMs: number; cfg: RiskNoticeConfig },
): RiskNoticeEvidence {
  const windowMin = effectiveEvidenceWindowMin(opts.cfg, opts.asOfMs);
  if (scope.segmentIds.length === 0) {
    return { trains: 0, severeTrains: 0, cancelledTrains: 0, medianRuntimeDeltaSec: null, maxRuntimeDeltaSec: null, windowMin, worstSegmentId: null };
  }
  const since = opts.asOfMs - windowMin * 60_000;
  const ph = scope.segmentIds.map(() => '?').join(',');
  const traversals = getRows<RiskEvidenceTraversal>(
    db,
    `SELECT segment_id, entered_at, delay_delta_sec, entry_delay_sec, exit_delay_sec
     FROM segment_observation WHERE segment_id IN (${ph}) AND entered_at >= ? AND entered_at <= ? AND delay_delta_sec IS NOT NULL`,
    [...scope.segmentIds, since, opts.asOfMs],
  );
  let cancelled = 0;
  if (scope.nextStopId != null) {
    const c = getRow<{ n: number }>(
      db,
      'SELECT COUNT(*) AS n FROM train_stop_events WHERE stop_id=? AND cancelled=1 AND actual_dep_epoch IS NULL AND sched_dep_epoch >= ? AND sched_dep_epoch <= ?',
      [scope.nextStopId, since, opts.asOfMs],
    );
    cancelled = c?.n ?? 0;
  }
  return aggregateRiskNoticeEvidence(traversals, cancelled, windowMin);
}

/**
 * Live evaluation state for one run: evidence at the default/live config
 * plus the last-refresh persistence flag (candidate (a)). The §51 features
 * recorded into features_json come from here.
 */
export interface LiveCorridorEvidence {
  evidence: RiskNoticeEvidence;
  persisted: number | null;
}

/** In-memory last-refresh snapshot per run — segment stats history is not
 *  stored per refresh, so persistence is remembered where the corridor is
 *  computed (additive: absent these calls nothing is retained). */
const riskNoticeRefreshMemory = new Map<number, { ts: number; medianDeltaSec: number | null; trains: number }>();

function liveCorridorEvidence(db: Db, runId: number, events: StopEventLite[]): LiveCorridorEvidence {
  const cfg = loadRiskNoticeConfig();
  const now = Date.now();
  const scope = riskNoticeScope(events, now);
  const evidence = precedingTrainEvidence(db, scope, { asOfMs: now, cfg });
  let persisted: number | null = null;
  if (cfg.requirePersistence) {
    const prev = riskNoticeRefreshMemory.get(runId) ?? null;
    if (prev != null && now - prev.ts <= PERSISTENCE_MAX_GAP_MS) {
      persisted = prev.medianDeltaSec != null && prev.medianDeltaSec >= cfg.minMedianRuntimeDeltaSec ? 1 : 0;
    }
  }
  riskNoticeRefreshMemory.set(runId, { ts: now, medianDeltaSec: evidence.medianRuntimeDeltaSec, trains: evidence.trains });
  if (riskNoticeRefreshMemory.size > 4096) {
    for (const [k, v] of riskNoticeRefreshMemory) if (now - v.ts > 30 * 60_000) riskNoticeRefreshMemory.delete(k);
  }
  return { evidence, persisted };
}

/** Feature shape consumed by the live trigger (also what replay reads back). */
export interface RiskNoticeFeatures {
  corridorEvidenceTrains?: number | null;
  corridorSevereTrains?: number | null;
  corridorCancelledTrains?: number | null;
  corridorMedianDeltaSec?: number | null;
  corridorEvidencePersisted?: number | null;
}

/** Live trigger for pipeline/notifications: the parameterized rule applied to
 *  the recorded §51 features of a prediction. */
export function riskNoticeFromFeatures(
  f: RiskNoticeFeatures,
  ourP50DelaySec: number | null,
  cfg: RiskNoticeConfig = loadRiskNoticeConfig(),
): boolean {
  const evidence: RiskNoticeEvidence = {
    trains: f.corridorEvidenceTrains ?? 0,
    severeTrains: f.corridorSevereTrains ?? 0,
    cancelledTrains: f.corridorCancelledTrains ?? 0,
    medianRuntimeDeltaSec: f.corridorMedianDeltaSec ?? null,
    maxRuntimeDeltaSec: null,
    windowMin: cfg.evidenceWindowMin,
    worstSegmentId: null,
  };
  const persisted = f.corridorEvidencePersisted != null ? f.corridorEvidencePersisted === 1 : null;
  return riskNoticeFires(evidence, ourP50DelaySec, cfg, persisted);
}

// MARK: - recovery probability (§17/§62)

/**
 * Piecewise-linear CDF through the three arrival-quantile knots
 * (p10, 0.10), (p50, 0.50), (p90, 0.90).
 *
 * Documented assumption: between the knots the CDF is linear (equivalent to
 * a piecewise-uniform delay distribution carrying 0.4 of mass per inner
 * segment); outside the knots it keeps the adjacent knot-to-knot slope and is
 * clamped to [0, 1] — no invented tail shape beyond one segment's width.
 * Monotone non-decreasing in t by construction.
 */
export function quantileCdf(t: number, p10: number, p50: number, p90: number): number {
  const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
  const lower = Math.max(1, p50 - p10);
  const upper = Math.max(1, p90 - p50);
  if (t <= p10) return clamp01(0.10 - (0.40 * (p10 - t)) / lower);
  if (t <= p50) return 0.10 + (0.40 * (t - p10)) / lower;
  if (t <= p90) return 0.50 + (0.40 * (t - p50)) / upper;
  return clamp01(0.90 + (0.40 * (t - p90)) / upper);
}

export interface RecoveryForecast {
  /** P(delay at the arrival stop ≤ currentDelaySec − recoverBySec), 0..1 */
  probRecover: number;
  /** expected delay at the arrival stop, seconds (the p50 of the distribution) */
  expectedDelaySec: number;
  /** true: probability approximated from the p10/p50/p90 quantile CDF */
  basedOnQuantiles: true;
  /** the recovery threshold the probability refers to, seconds */
  recoverBySec: number;
}

/**
 * §17/§62 flagship: "68% chance of recovering ≥2 min".
 *
 * Given the current delay D (seconds) and our predicted arrival distribution
 * at the final stop (p10/p50/p90 as epochs, ms), P(final_delay ≤ D − 120s)
 * via the piecewise-linear quantile CDF. Suppressed (null) when there is
 * nothing to recover (D ≤ 0) or the distribution is too thin to quote an
 * honest percentage from (p90 − p10 > 1800s, GOAL §16 — no fake numbers).
 */
export function recoveryForecast(
  currentDelaySec: number | null,
  schedArrEpoch: number | null,
  p10: number,
  p50: number,
  p90: number,
  recoverBySec = 120,
): RecoveryForecast | null {
  if (currentDelaySec == null || schedArrEpoch == null) return null;
  if (currentDelaySec <= 0) return null; // on time or early: nothing to recover
  if (p90 - p10 > 1800_000) return null; // spread > 30 min → suppressed (§16)
  const expectedDelaySec = Math.round((p50 - schedArrEpoch) / 1000);
  const threshold = schedArrEpoch + (currentDelaySec - recoverBySec) * 1000;
  return {
    probRecover: Math.round(quantileCdf(threshold, p10, p50, p90) * 100) / 100,
    expectedDelaySec,
    basedOnQuantiles: true,
    recoverBySec,
  };
}

// MARK: - learned connection model (AUC-gated, hot-reloaded)

let connModelCache: { mtime: number; model: { gbm: { base: number; lr: number; trees: unknown[] } } | null } | null = null;

function learnedConnectionProbability(bufferSec: number, aDelaySec: number, bDelaySec: number | null, depEpochMs: number): number | null {
  try {
    const file = join(loadConfig().dataDir, 'models', 'connections-v1.json');
    const mtime = statSync(file).mtimeMs;
    if (!connModelCache || connModelCache.mtime !== mtime) {
      connModelCache = { mtime, model: JSON.parse(readFileSync(file, 'utf8')) };
    }
    const hour = Number(new Date(depEpochMs).toLocaleString('en-GB', { timeZone: 'Europe/Rome', hour: 'numeric', hour12: false })) || 12;
    const row = connectionRow(bufferSec, aDelaySec, bDelaySec, hour);
    return Math.max(0.001, Math.min(0.999, predictGBM(connModelCache.model!.gbm as never, row)));
  } catch {
    return null;
  }
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
  opts: { transferSec?: number; limit?: number; horizonMin?: number; arrDelaySec?: number } = {},
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
    // learned connection model when available (AUC-gated), normal-CDF fallback
    const arrDelaySec = opts.arrDelaySec ?? 0;
    const schedArrMs = ourP50 - arrDelaySec * 1000;
    const learned = learnedConnectionProbability(
      (depEpoch - schedArrMs) / 1000, // planned buffer
      arrDelaySec,
      opDelay,
      effDep,
    );
    let probability: number;
    if (learned != null) {
      probability = learned;
    } else {
      const z = (effDep - transferSec * 1000 - ourP50) / sigmaMs;
      probability = Math.max(0.001, Math.min(0.999, normalCdf(z)));
    }
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
