/**
 * §51 risk-notice fixture test — NOT committed data, runs against a throwaway
 * SQLite DB under tmp/fixture-risk-data/ (never data/db/treno.db).
 *
 * Encodes known propagation scenarios and checks the generator + both
 * replays against them:
 *   A  should-fire: 3 preceding trains lose >90s each across 2 refreshes,
 *                   actual arrival lands ≥2 min late (TP, persistence-ok)
 *   B  should-not-fire: normal running (TN)
 *   D  should-fire like A, second refresh (TP, persistence demo)
 *   E  single refresh with corridor deviation (fires without persistence)
 *   F  1 delayed preceding train + 1 cancelled train (fires only with severe
 *      weighting, candidate (b))
 *   H  corridor deviation just outside the 20m window at peak hour (fires
 *      only with the adaptive window, candidate (c))
 *
 * Expected on the fixture: precision 100%, recall 100%, 0 false positives,
 * 0 false negatives at the default config. These are SYNTHETIC numbers that
 * only prove the machinery does what its spec says; real §51 numbers come
 * from the live server's nightly 03:30 backtest:
 *   curl http://192.168.1.242:8787/api/backtest
 *
 * Run from the repo root:  npx tsx tmp/risk-notice-fixture.ts
 */
import { rmSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { strict as assert } from 'node:assert';

const REPO = resolve(import.meta.dirname, '..');
const DATA_DIR = join(REPO, 'tmp', 'fixture-risk-data');
process.env.TRENO_DATA_DIR = DATA_DIR; // must precede the dynamic imports below

const { loadConfig } = await import('../packages/core/src/config.ts');
const { openTrenoDb } = await import('../packages/gtfs/src/setup.ts');
const heuristic = await import('../packages/collector/src/heuristic.ts');
const backtest = await import('../packages/collector/src/backtest.ts');

const M = 60_000;
/** 2026-09-10 08:00 Europe/Rome (CEST, UTC+2) — inside the 7–9 peak window */
const T0 = Date.UTC(2026, 8, 10, 6, 0);

rmSync(DATA_DIR, { recursive: true, force: true });
mkdirSync(DATA_DIR, { recursive: true });
const db = openTrenoDb(loadConfig());

const insertRun = db.prepare(
  'INSERT INTO train_runs(run_key, operator, service_date, train_number, origin_stop_id, destination_stop_id, sched_dep_epoch, sched_arr_epoch, created_at) VALUES(?,?,?,?,?,?,?,?,?)');
const insertStop = db.prepare(
  'INSERT INTO train_stop_events(run_id, stop_id, stop_sequence, sched_arr_epoch, sched_dep_epoch, actual_arr_epoch, actual_dep_epoch, cancelled) VALUES(?,?,?,?,?,?,?,?)');
const insertPred = db.prepare(
  'INSERT INTO predictions(model_version, run_id, stop_id, generated_at, sched_arr_epoch, our_p10, our_p50, our_p90, confidence, features_json) VALUES(?,?,?,?,?,?,?,?,?,?)');
const insertOutcome = db.prepare(
  'INSERT INTO prediction_outcomes(prediction_id, actual_arr_epoch, operator_error_sec, our_error_sec, recorded_at) VALUES(?,?,?,?,?)');
const insertTraversal = db.prepare(
  'INSERT INTO segment_observation(segment_id, run_id, service_date, from_stop_id, to_stop_id, entered_at, left_at, runtime_sec, entry_delay_sec, exit_delay_sec, delay_delta_sec, time_of_day_sec, weekday, source, created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');

interface Scenario {
  name: string;
  stops: Array<[stopId: string, schedArrOff: number | null, schedDepOff: number | null, actualDepOff: number | null]>;
  /** [enteredOffsetMin, deltaSec, entryDelaySec] on the approach segment (first>second stop) */
  traversals: Array<[number, number, number]>;
  /** prediction rows: [generatedOffsetMin, p50DelaySec, actualDelaySec, upstreamCount] */
  predictions: Array<[number, number, number, number]>;
  cancelledAtNextStop?: number | null; // offset (min) of a cancelled train's sched_dep at our next stop
}

const SCENARIOS: Scenario[] = [
  {
    name: 'A-should-fire-persistent',
    stops: [['A0', null, -20, -12], ['A1', 6, 6, null], ['A2', 25, null, null]],
    traversals: [[-15, 120, 60], [-10, 150, 80], [-6, 100, 50]],
    predictions: [[-4, 180, 240, 3], [0, 180, 240, 3]],
  },
  {
    name: 'B-normal-running',
    stops: [['B0', null, -20, -12], ['B1', 6, 6, null], ['B2', 25, null, null]],
    traversals: [[-8, 10, 5], [-5, 20, 8], [-2, -5, 2]],
    predictions: [[0, 10, 15, 0]],
  },
  {
    name: 'D-should-fire-second-refresh',
    stops: [['D0', null, -20, -12], ['D1', 6, 6, null], ['D2', 25, null, null]],
    traversals: [[-14, 150, 70], [-9, 130, 60], [-5, 110, 55]],
    predictions: [[-4, 200, 260, 3], [0, 200, 260, 3]],
  },
  {
    name: 'E-single-refresh',
    stops: [['E0', null, -20, -12], ['E1', 6, 6, null], ['E2', 25, null, null]],
    traversals: [[-8, 110, 55], [-5, 125, 60], [-2, 140, 70]],
    predictions: [[0, 150, 210, 3]],
  },
  {
    name: 'F-cancellation-weighting',
    stops: [['F0', null, -20, -12], ['F1', 8, 8, null], ['F2', 26, null, null]],
    traversals: [[-5, 150, 70]],
    predictions: [[0, 120, 90, 1]],
    cancelledAtNextStop: -5,
  },
  {
    name: 'H-adaptive-window',
    stops: [['H0', null, -28, -20], ['H1', 6, 6, null], ['H2', 25, null, null]],
    traversals: [[-25, 130, 60], [-22, 140, 65]],
    predictions: [[0, 130, 70, 2]],
  },
];

let cancelledRunSeq = 0;
for (const sc of SCENARIOS) {
  const [first, second] = [sc.stops[0]!, sc.stops[1]!];
  const dest = sc.stops[sc.stops.length - 1]!;
  const schedArr = T0 + dest[1]! * M;
  const r = insertRun.run('fixture-' + sc.name, 'fixture', '2026-09-10', sc.name.slice(0, 6), first[0], dest[0], T0 + (first[2] ?? 0) * M, schedArr, Date.now());
  const runId = Number(r.lastInsertRowid);
  sc.stops.forEach(([stopId, arrOff, depOff, actualDepOff], idx) => {
    insertStop.run(runId, stopId, idx,
      arrOff != null ? T0 + arrOff * M : null,
      depOff != null ? T0 + depOff * M : null,
      null,
      actualDepOff != null ? T0 + actualDepOff * M : null,
      null);
  });
  sc.traversals.forEach(([enteredMin, delta, entryDelay], tIdx) => {
    const enteredAt = T0 + enteredMin * M;
    // each traversal is a different preceding train → distinct synthetic run_id
    insertTraversal.run(first[0] + '>' + second[0], 900_000 + runId * 10 + tIdx, '2026-09-10', first[0], second[0],
      enteredAt, enteredAt + 10 * M, 600, entryDelay, entryDelay + delta, delta, 8 * 3600, 4, 'fixture', Date.now());
  });
  if (sc.cancelledAtNextStop != null) {
    cancelledRunSeq++;
    const cg = insertRun.run('fixture-cancelled-' + cancelledRunSeq, 'fixture', '2026-09-10', 'C' + cancelledRunSeq, second[0], dest[0], T0 + sc.cancelledAtNextStop * M, schedArr, Date.now());
    insertStop.run(Number(cg.lastInsertRowid), second[0], 0, null, T0 + sc.cancelledAtNextStop * M, null, null, 1);
  }
  for (const [genMin, p50DelaySec, actualDelaySec, upstream] of sc.predictions) {
    const p50 = schedArr + p50DelaySec * 1000;
    const p = insertPred.run('heuristic-v1', runId, dest[0], T0 + genMin * M, schedArr,
      p50 - 300_000, p50, p50 + 420_000, 0.6, JSON.stringify({ upstreamStopDelayedCount: upstream }));
    insertOutcome.run(Number(p.lastInsertRowid), schedArr + actualDelaySec * 1000, null, actualDelaySec - p50DelaySec, Date.now());
  }
}

// ---- 1. generator-level checks ------------------------------------------------
const D = heuristic.DEFAULT_RISK_NOTICE_CONFIG;
const ev = (trains: number, median: number | null, severe = 0, cancelled = 0): heuristic.RiskNoticeEvidence => ({
  trains, severeTrains: severe, cancelledTrains: cancelled, medianRuntimeDeltaSec: median,
  maxRuntimeDeltaSec: median, windowMin: D.evidenceWindowMin, worstSegmentId: null,
});
assert.equal(heuristic.riskNoticeFires(ev(3, 120), 180, D), true, '3 trains, median +120s, p50 +180s must fire');
assert.equal(heuristic.riskNoticeFires(ev(3, 10), 180, D), false, 'on-time corridor must not fire');
assert.equal(heuristic.riskNoticeFires(ev(3, 5), 180, D), false, 'single outlier (median of [500,5,5]) must not fire');
assert.equal(heuristic.riskNoticeFires(ev(3, 120), 30, D), false, 'p50 below minP50MoveSec must not fire');
assert.equal(heuristic.riskNoticeFires(ev(1, 150), 120, { ...D, weightSevereEvidence: true }, null), false, '1 train stays below 2 even with weighting on');
assert.equal(heuristic.riskNoticeFires(ev(1, 150, 0, 1), 120, { ...D, weightSevereEvidence: true }), true, '1 delayed + 1 cancelled counts double → fires (candidate b)');
assert.equal(heuristic.riskNoticeFires(ev(2, 120), 180, { ...D, requirePersistence: true }, null), false, 'persistence unknown → must not fire');
assert.equal(heuristic.riskNoticeFires(ev(2, 120), 180, { ...D, requirePersistence: true }, true), true, 'persisted deviation fires');
assert.equal(heuristic.effectiveEvidenceWindowMin({ ...D, adaptiveWindow: true }, T0), 30, 'peak 08:00 Rome widens 20m → 30m (candidate c)');
assert.equal(heuristic.effectiveEvidenceWindowMin({ ...D, adaptiveWindow: true }, Date.UTC(2026, 8, 10, 11, 0)), 20, 'midday keeps 20m');
assert.equal(heuristic.riskNoticeFromFeatures({ corridorEvidenceTrains: 3, corridorMedianDeltaSec: 120 }, 180, D), true, 'recorded-feature trigger mirrors the rule');
assert.deepEqual(
  heuristic.riskNoticeScope(
    [{ stop_id: 'A0', actual_dep_epoch: T0 - 12 * M }, { stop_id: 'A1' }, { stop_id: 'A2' }],
    T0,
  ),
  { segmentIds: ['A0>A1', 'A1>A2'], nextStopId: 'A1' },
  'scope = one segment behind the first upcoming stop plus the rest ahead');
console.log('generator unit checks: PASS (12)');

// ---- 2. replays on the fixture -----------------------------------------------
const legacy = backtest.replayRiskNotices();
console.log('single-config replay (recorded features):', legacy);
assert.equal(legacy.rowsWithUpstream, 8);
assert.equal(legacy.fired, 6);
assert.equal(legacy.corroborated, legacy.fired, 'every fired notice corroborated');
assert.equal(legacy.caught, legacy.actuallyLate, 'every ≥2-min-late row caught');
assert.equal(legacy.fired > 0 && legacy.corroborated / legacy.fired >= backtest.MIN_PRECISION_TARGET, true, 'gate passes on fixture');

const sweep = backtest.sweepRiskNoticeThresholds({ db });
const d = sweep.defaultCounts;
console.log('corridor replay @ default config:', d, '(featuredRowsOnly:', sweep.featuredRowsOnly + ')');
assert.equal(sweep.rowsEvaluated, 8);
assert.equal(d.fired, 5, 'A×2 + D×2 + E fire at defaults');
assert.equal(d.corroborated, d.fired, 'precision 100% (0 false positives)');
assert.equal(d.caught, d.actuallyLate, 'recall 100% (0 false negatives)');
assert.equal(d.actuallyLate, 5);

const pers = backtest.replayRiskNoticeEvidenceOnDb(db, { ...D, requirePersistence: true });
console.log('persistence toggle:', pers);
assert.equal(pers.fired, 2, 'only 2nd refreshes fire (A2, D2)');
assert.equal(pers.corroborated, pers.fired, 'persistence keeps precision at 100%');
assert.ok(pers.caught < pers.actuallyLate, 'persistence trades recall for precision (the honest tradeoff)');

const wgt = backtest.replayRiskNoticeEvidenceOnDb(db, { ...D, weightSevereEvidence: true });
console.log('severe-weighting toggle:', wgt);
assert.equal(wgt.fired, 6, 'F fires too (cancelled train counts double)');
assert.equal(wgt.corroborated, wgt.fired, 'weighting keeps precision at 100%');

const adp = backtest.replayRiskNoticeEvidenceOnDb(db, { ...D, adaptiveWindow: true });
console.log('adaptive-window toggle:', adp);
assert.equal(adp.fired, 6, 'H fires too (window widened to 30m at peak)');
assert.equal(adp.corroborated, adp.fired, 'adaptive window keeps precision at 100%');

assert.ok(sweep.chosen != null, 'fixture has a gate-passing chosen default');
console.log('sweep grid rows:', sweep.grid.length, '· chosen default:', sweep.chosen!.label, '—', sweep.chosen!.reason);
assert.ok(sweep.grid.length === 27);

db.close();
console.log('\nFIXTURE RESULT: precision 100% · recall 100% · false positives 0 · false negatives 0 (default config)');
console.log('These are synthetic proofs of the rule only. Real §51 numbers arrive with the server\'s next 03:30 backtest:');
console.log('  curl http://192.168.1.242:8787/api/backtest');
