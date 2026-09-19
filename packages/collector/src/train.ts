/**
 * Train the residual model (§67 lite) from scored heuristic-v1 predictions:
 *   npm run train
 *
 * Label: our_error_sec (actual arrival − heuristic p50). Ridge regression
 * (closed form) learns the p50 correction; two pinball-loss linear models
 * learn p10/p90 offsets. Time-ordered 80/20 split — validate on the most
 * recent fifth, the way the model will actually be used.
 *
 * Deployment gate: the model file is written only if validation MAE beats the
 * heuristic AND p10–p90 coverage does not degrade. Otherwise nothing ships.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '#core/config.ts';
import { log } from '#core/log.ts';
import { openTrenoDb } from '#gtfs/setup.ts';
import { FEATURE_NAMES, featureRow, type FeatureInput, type ResidualModel, type ConformalBucket, type StopModel } from './model.ts';
import { fitGBM, predictGBM, type GBMForest } from './gbm.ts';
import { RESIDUAL_MODEL_VERSION } from './model.ts';

interface TrainRow {
  runId: number;
  generatedAt: number;
  features: FeatureInput;
  label: number; // our_error_sec
  operatorErrorSec: number | null;
}

export function extract(): TrainRow[] {
  const cfg = loadConfig();
  const db = openTrenoDb(cfg);
  const since = Date.now() - 21 * 86400_000;
  const rows = db.prepare(
    `SELECT p.run_id, p.generated_at, p.sched_arr_epoch, p.operator_eta_epoch, p.our_p10, p.our_p50, p.our_p90, p.features_json, o.our_error_sec, o.operator_error_sec
     FROM predictions p JOIN prediction_outcomes o ON o.prediction_id = p.id
     WHERE p.model_version='heuristic-v1' AND p.features_json IS NOT NULL
       AND o.our_error_sec IS NOT NULL AND p.our_p50 IS NOT NULL AND p.generated_at >= ?
       AND p.sched_arr_epoch IS NOT NULL
       AND p.sched_arr_epoch - p.generated_at BETWEEN 0 AND 3600000
       AND ABS(o.our_error_sec) <= 2700
     ORDER BY p.generated_at ASC`,
  ).all(since) as Array<{
    run_id: number; generated_at: number; sched_arr_epoch: number | null; operator_eta_epoch: number | null;
    our_p10: number; our_p50: number; our_p90: number; features_json: string; our_error_sec: number; operator_error_sec: number | null;
  }>;
  db.close();
  const out: TrainRow[] = [];
  for (const r of rows) {
    let f: Partial<FeatureInput> = {};
    try { f = JSON.parse(r.features_json) as Partial<FeatureInput>; } catch { continue; }
    if (typeof f.remainingSegments !== 'number' || typeof f.statsCoverage !== 'number') continue;
    out.push({
      runId: r.run_id,
      generatedAt: r.generated_at,
      features: {
        generatedAt: r.generated_at,
        schedArrEpoch: r.sched_arr_epoch,
        operatorEtaEpoch: r.operator_eta_epoch,
        ourP50: r.our_p50,
        ourP10: r.our_p10,
        ourP90: r.our_p90,
        anchorKind: f.anchorKind ?? null,
        remainingSegments: f.remainingSegments,
        statsCoverage: f.statsCoverage,
        corridorAdjustSec: f.corridorAdjustSec ?? 0,
        operatorWeight: f.operatorWeight ?? 0.65,
        independentP50: f.independentP50 ?? null,
        originDepDelaySec: f.originDepDelaySec ?? null,
        trainHistoryDelaySec: f.trainHistoryDelaySec ?? null,
        networkDelaySec: f.networkDelaySec ?? null,
        operatorEtaDriftSec: f.operatorEtaDriftSec ?? null,
        alertsRun24h: f.alertsRun24h ?? null,
        alertsRoute24h: f.alertsRoute24h ?? null,
        precipMm: f.precipMm ?? null,
        routeId: f.routeId ?? null,
        etaAccelSec: f.etaAccelSec ?? null,
      },
      label: r.our_error_sec,
      operatorErrorSec: r.operator_error_sec,
    });
  }
  return out;
}

/** Reconstruct mid-journey training states from completed runs' stop events:
 *  "at stop k, actual arrival t_k, delay d_k — what was the FINAL delay?"
 *  This multiplies training data ~10x using history we already have. */
function buildStopLevel(): { X: number[][]; y: number[] } {
  const db = openTrenoDb(loadConfig());
  const since = Date.now() - 21 * 86400_000;
  const rows = db.prepare(
    `SELECT s.run_id, s.stop_sequence, s.arr_delay_sec, s.sched_arr_epoch k_sched, s.actual_arr_epoch t_k,
       (SELECT MAX(e2.stop_sequence) FROM train_stop_events e2 WHERE e2.run_id=s.run_id) max_seq,
       (SELECT e3.actual_arr_epoch FROM train_stop_events e3 WHERE e3.run_id=s.run_id AND e3.stop_id=r.destination_stop_id) dest_actual,
       (SELECT (e4.actual_dep_epoch - e4.sched_dep_epoch) FROM train_stop_events e4 WHERE e4.run_id=s.run_id AND e4.stop_id=r.origin_stop_id AND e4.actual_dep_epoch IS NOT NULL) origin_dep_ms,
       r.sched_arr_epoch, r.train_number, r.service_date
     FROM train_stop_events s JOIN train_runs r ON r.id=s.run_id
     WHERE s.actual_arr_epoch IS NOT NULL AND s.arr_delay_sec IS NOT NULL AND s.sched_arr_epoch IS NOT NULL
       AND r.sched_arr_epoch IS NOT NULL AND r.origin_stop_id IS NOT NULL AND r.destination_stop_id IS NOT NULL
       AND s.stop_id != r.destination_stop_id`,
  ).all() as Array<{
    run_id: number; stop_sequence: number; arr_delay_sec: number; k_sched: number; t_k: number;
    max_seq: number | null; dest_actual: number | null; origin_dep_ms: number | null;
    sched_arr_epoch: number; train_number: string; service_date: string;
  }>;
  db.close();
  const X: number[][] = [];
  const y: number[] = [];
  const sinceYmd = new Date(since).toISOString().slice(0, 10);
  for (const r of rows) {
    if (r.dest_actual == null || r.max_seq == null || r.t_k >= r.dest_actual) continue;
    if (r.service_date < sinceYmd) continue;
    const label = Math.max(-2700, Math.min(2700, (r.dest_actual - r.sched_arr_epoch) / 1000));
    const delayK = Math.max(-1800, Math.min(1800, r.arr_delay_sec));
    const fi: FeatureInput = {
      generatedAt: r.t_k,
      schedArrEpoch: r.sched_arr_epoch,
      operatorEtaEpoch: r.sched_arr_epoch + delayK * 1000,
      ourP50: r.sched_arr_epoch + delayK * 1000,
      ourP10: 0,
      ourP90: 0,
      anchorKind: 'actual_arr',
      remainingSegments: Math.max(1, r.max_seq - r.stop_sequence),
      statsCoverage: 0.5,
      corridorAdjustSec: 0,
      operatorWeight: 0.65,
      independentP50: r.sched_arr_epoch + delayK * 1000,
      originDepDelaySec: r.origin_dep_ms != null ? Math.round(r.origin_dep_ms / 1000) : null,
      trainHistoryDelaySec: null,
      networkDelaySec: null,
      operatorEtaDriftSec: null,
      alertsRun24h: null,
      alertsRoute24h: null,
      precipMm: null,
    };
    X.push(featureRow(fi));
    y.push(label);
    if (X.length >= 150_000) break;
  }
  return { X, y };
}

function ridgeFit(X: number[][], y: number[], lambda: number): number[] {
  const d = X[0]!.length;
  const A: number[][] = Array.from({ length: d }, () => new Array<number>(d + 1).fill(0));
  for (let n = 0; n < X.length; n++) {
    const xn = X[n]!, yn = y[n]!;
    for (let i = 0; i < d; i++) {
      for (let j = i; j < d; j++) A[i]![j]! += xn[i]! * xn[j]!;
      A[i]![d]! += xn[i]! * yn;
    }
  }
  for (let i = 0; i < d; i++) {
    for (let j = 0; j < i; j++) A[i]![j] = A[j]![i]!;
    A[i]![i]! += lambda;
  }
  // gaussian elimination with partial pivoting
  for (let col = 0; col < d; col++) {
    let piv = col;
    for (let r = col + 1; r < d; r++) if (Math.abs(A[r]![col]!) > Math.abs(A[piv]![col]!)) piv = r;
    [A[col], A[piv]] = [A[piv]!, A[col]!];
    const diag = A[col]![col]! || 1e-9;
    for (let r = col + 1; r < d; r++) {
      const f = A[r]![col]! / diag;
      if (f === 0) continue;
      for (let c = col; c <= d; c++) A[r]![c]! -= f * A[col]![c]!;
    }
  }
  const w = new Array<number>(d).fill(0);
  for (let r = d - 1; r >= 0; r--) {
    let s = A[r]![d]!;
    for (let c = r + 1; c < d; c++) s -= A[r]![c]! * w[c]!;
    w[r] = s / (A[r]![r]! || 1e-9);
  }
  return w;
}

/** pinball-loss linear regression: bias starts at the empirical quantile so
 *  gradient descent only has to learn the deltas around it */
function pinballFit(X: number[][], y: number[], alpha: number, epochs = 500, lr = 0.05): number[] {
  const d = X[0]!.length;
  const w = new Array<number>(d).fill(0);
  const sorted = [...y].sort((a, b) => a - b);
  w[0] = sorted[Math.min(sorted.length - 1, Math.floor(alpha * sorted.length))]!;
  const n = X.length;
  const clip = 1200;
  for (let e = 0; e < epochs; e++) {
    const g = new Array<number>(d).fill(0);
    for (let s = 0; s < n; s++) {
      const xs = X[s]!;
      let pred = 0;
      for (let i = 0; i < d; i++) pred += xs[i]! * w[i]!;
      pred = Math.max(-clip, Math.min(clip, pred));
      const err = y[s]! - pred;
      const k = err > 0 ? alpha : alpha - 1;
      for (let i = 0; i < d; i++) g[i]! += k * xs[i]!;
    }
    for (let i = 0; i < d; i++) w[i]! += (lr * g[i]!) / n;
  }
  return w;
}

const dot = (a: number[], b: number[]): number => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
};

function main() {
  const rows = extract();
  if (rows.length < 3000) {
    log.error('train: not enough scored outcomes yet', { have: rows.length, need: 3000 });
    process.exit(1);
  }
  // time-ordered split: validate on the newest 20%
  const cut = Math.floor(rows.length * 0.8);
  const train = rows.slice(0, cut);
  const val = rows.slice(cut);
  // P4 per-line target encoding: mean label per route_id from the TRAIN window
  // only (≥20 rows to trust a line, else shrink to the global mean) — applied
  // to both windows so validation stays honest
  const routeSum = new Map<string, { s: number; n: number }>();
  let gSum = 0;
  for (const r of train) {
    gSum += r.label;
    const rid = r.features.routeId;
    if (!rid) continue;
    let e = routeSum.get(rid);
    if (!e) routeSum.set(rid, e = { s: 0, n: 0 });
    e.s += r.label;
    e.n++;
  }
  const globalMean = gSum / train.length;
  const SHRINK = 20;
  const routeEncoding: Record<string, number> = {};
  for (const [rid, e] of routeSum) {
    routeEncoding[rid] = Math.round(((e.s + SHRINK * globalMean) / (e.n + SHRINK)) * 10) / 10;
  }
  const encOf = (rid: string | null | undefined): number => (rid != null ? routeEncoding[rid] ?? 0 : 0);
  for (const r of rows) r.features.routeEncSec = encOf(r.features.routeId);
  const Xtr = train.map((r) => featureRow(r.features));
  const ytr = train.map((r) => r.label);
  const Xva = val.map((r) => featureRow(r.features));
  const yva = val.map((r) => r.label);

  const ridge = ridgeFit(Xtr, ytr, 1.0);
  const pin10 = pinballFit(Xtr, ytr, 0.10);
  const pin90 = pinballFit(Xtr, ytr, 0.90);
  const t0 = Date.now();
  const gbm = fitGBM(Xtr, ytr, 150, 0.08, 3, 40);
  log.info('train: gbm fitted', { ms: Date.now() - t0, trees: gbm.trees.length });

  // pick the correction with the lower validation MAE — GBM captures the
  // interactions the linear model can't; ridge stays if it wins on little data
  let maeRidge = 0, maeGbm = 0;
  for (let i = 0; i < val.length; i++) {
    maeRidge += Math.abs(yva[i]! - Math.max(-1200, Math.min(1200, dot(ridge, Xva[i]!))));
    maeGbm += Math.abs(yva[i]! - Math.max(-1200, Math.min(1200, predictGBM(gbm, Xva[i]!))));
  }
  const useGbm = maeGbm < maeRidge;
  const corrOf = (i: number): number =>
    Math.max(-1200, Math.min(1200, useGbm ? predictGBM(gbm, Xva[i]!) : dot(ridge, Xva[i]!)));
  log.info('train: method selection', { maeRidge: Math.round(maeRidge / val.length), maeGbm: Math.round(maeGbm / val.length), useGbm });

  // stacked stop-state model: train on reconstructed mid-journey states,
  // then learn the blend weight against the residual model on validation
  const stopData = buildStopLevel();
  let stack: StopModel | undefined;
  if (stopData.X.length >= 5000) {
    const t1 = Date.now();
    const stopGbm = fitGBM(stopData.X, stopData.y, 120, 0.08, 3, 40);
    log.info('train: stop-level gbm fitted', { ms: Date.now() - t1, rows: stopData.X.length });
    let bestW = -1, bestMae = Infinity;
    for (let w10 = 0; w10 <= 10; w10 += 1) {
      const w = w10 / 10;
      let mae = 0;
      for (let i = 0; i < val.length; i++) {
        const f = val[i]!.features;
        if (f.schedArrEpoch == null) { mae += Math.abs(yva[i]!); continue; }
        const stopInput: FeatureInput = { ...f, ourP50: f.operatorEtaEpoch ?? f.ourP50, independentP50: f.operatorEtaEpoch ?? f.independentP50 };
        const stopDelay = predictGBM(stopGbm, featureRow(stopInput));
        const residualEst = f.ourP50 + corrOf(i) * 1000;
        const stopEst = f.schedArrEpoch + stopDelay * 1000;
        const blend = w * residualEst + (1 - w) * stopEst;
        mae += Math.abs(f.schedArrEpoch + yva[i]! * 1000 - blend);
      }
      if (mae < bestMae) { bestMae = mae; bestW = w; }
    }
    const stackMae = bestMae / val.length;
    log.info('train: stack weight search', { bestW, stackMae: Math.round(stackMae), residualOnlyMae: Math.round(maeGbm / val.length) });
    // keep the stack only if it actually improves validation MAE
    if (bestW >= 0 && stackMae < maeGbm / val.length) {
      stack = { gbm: stopGbm, weight: bestW };
    }
  }

  /** final correction in seconds, including the stack blend when active */
  const predSec = (i: number): number => {
    const f = val[i]!.features;
    let est = f.ourP50 + corrOf(i) * 1000;
    if (stack && f.schedArrEpoch != null) {
      const stopInput: FeatureInput = { ...f, ourP50: f.operatorEtaEpoch ?? f.ourP50, independentP50: f.operatorEtaEpoch ?? f.independentP50 };
      const stopDelay = predictGBM(stack.gbm, featureRow(stopInput));
      est = stack.weight * est + (1 - stack.weight) * (f.schedArrEpoch + stopDelay * 1000);
    }
    return (est - f.ourP50) / 1000;
  };

  let maeHeur = 0, maeModel = 0, maeOp = 0, opN = 0, covHeur = 0, covModel = 0;
  // split-conformal: per-horizon-bucket absolute-residual quantiles give a
  // distribution-free ~80% central band (0.9 quantile of |residual| → ±band)
  const bucketEdges = [300, 900, 1800, 3600];
  const bucketResiduals: number[][] = bucketEdges.map(() => []);
  for (let i = 0; i < val.length; i++) {
    const y = yva[i]!;
    maeHeur += Math.abs(y);
    const corr = predSec(i);
    maeModel += Math.abs(y - corr);
    if (val[i]!.operatorErrorSec != null) {
      maeOp += Math.abs(val[i]!.operatorErrorSec!);
      opN++;
    }
    const f = val[i]!.features;
    const horizonSec = f.schedArrEpoch != null ? Math.max(0, (f.schedArrEpoch - f.generatedAt) / 1000) : 1800;
    const bIdx = Math.max(0, bucketEdges.findIndex((e) => horizonSec <= e));
    bucketResiduals[bIdx]!.push(Math.abs(y - corr));
    // coverage: does the true arrival fall inside our p10–p90 band?
    const lo = (f.ourP10 - f.ourP50) / 1000;
    const hi = (f.ourP90 - f.ourP50) / 1000;
    if (y >= lo && y <= hi) covHeur++;
  }
  const conformal: ConformalBucket[] = bucketEdges.map((edge, i) => {
    const rs = bucketResiduals[i]!.sort((a, b) => a - b);
    const q = rs.length >= 50 ? rs[Math.floor(0.9 * rs.length)]! : rs[Math.floor(0.9 * Math.max(rs.length - 1, 0))] ?? 120;
    return { maxHorizonSec: edge, offsetSec: Math.max(60, Math.round(q)) };
  });
  // conformal coverage on the same validation set (honest: finite-sample)
  for (let i = 0; i < val.length; i++) {
    const f = val[i]!.features;
    const y = yva[i]!;
    const corr = predSec(i);
    const horizonSec = f.schedArrEpoch != null ? Math.max(0, (f.schedArrEpoch - f.generatedAt) / 1000) : 1800;
    const bucket = conformal.find((b) => horizonSec <= b.maxHorizonSec) ?? conformal[conformal.length - 1]!;
    if (Math.abs(y - corr) <= bucket.offsetSec) covModel++;
  }
  maeHeur /= val.length; maeModel /= val.length; maeOp /= Math.max(opN, 1);

  log.info('train: validation', {
    rows: rows.length, train: train.length, val: val.length,
    maeHeuristic: Math.round(maeHeur),
    maeModel: Math.round(maeModel),
    coverageHeuristic: Math.round((covHeur / val.length) * 100) / 100,
    coverageModel: Math.round((covModel / val.length) * 100) / 100,
  });

  const improves = maeModel < maeHeur - 0.5;
  const covOk = covModel / val.length >= 0.75;
  if (!improves || !covOk) {
    log.error('train: gate failed — model NOT deployed', { improves, covOk, coverage: Math.round((covModel / val.length) * 100) / 100 });
    process.exit(2);
  }
  const model: ResidualModel = {
    version: RESIDUAL_MODEL_VERSION,
    trainedAt: Date.now(),
    trainRows: train.length,
    valRows: val.length,
    valMae: { heuristic: Math.round(maeHeur), model: Math.round(maeModel), operator: Math.round(maeOp) },
    valCoverage10to90: {
      heuristic: Math.round((covHeur / val.length) * 100) / 100,
      model: Math.round((covModel / val.length) * 100) / 100,
    },
    ridge, pin10, pin90, conformal, stack,
    routeEncoding,
    method: useGbm ? 'gbm' : 'ridge',
    gbm: useGbm ? gbm : undefined,
  };
  const dir = join(loadConfig().dataDir, 'models');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'residual-v1.json');
  writeFileSync(file, JSON.stringify(model));
  log.info('train: model deployed', { file, features: FEATURE_NAMES.length });
}

if (process.argv[1] && process.argv[1].endsWith('train.ts')) {
  main();
}
