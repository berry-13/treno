/**
 * Offline backtester: replays scored heuristic-v1 predictions against every
 * model file in data/models/ — improvements measurable in seconds, not days.
 *   npm run backtest
 *
 * Also replays the §51 risk notice twice: the recorded-feature single-config
 * replay (the honest-claims gate) and a point-in-time threshold sweep of the
 * parameterized corridor generator (RiskNoticeConfig in heuristic.ts), so
 * conservative thresholds can be picked from real data instead of guesses.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '#core/config.ts';
import { log } from '#core/log.ts';
import { openTrenoDb } from '#gtfs/setup.ts';
import type { Db } from '#core/db.ts';
import { featureRow, applyResidual, type FeatureInput, type ResidualModel } from './model.ts';
import { extract } from './train.ts';
import {
  DEFAULT_RISK_NOTICE_CONFIG, PERSISTENCE_MAX_GAP_MS,
  aggregateRiskNoticeEvidence, effectiveEvidenceWindowMin, riskNoticeFires, riskNoticeScope,
  type RiskEvidenceTraversal, type RiskNoticeConfig, type RiskNoticeEvidence, type RiskNoticeStop,
} from './heuristic.ts';

const EDGES = [60, 120, 300, 600, 1800, 3600];

/** The honest-claims gate. A CONSTANT on purpose: tuning the evidence
 *  thresholds (RiskNoticeConfig) is the legitimate lever an operator has;
 *  moving the gate itself is not, so it lives here, not in any config. */
export const MIN_PRECISION_TARGET = 0.7;

function main() {
  const cfg = loadConfig();
  const dir = join(cfg.dataDir, 'models');
  let files: string[] = [];
  try { files = readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'connections-v1.json'); } catch { /* none */ }
  const models: Array<{ name: string; model: ResidualModel }> = files.map((f) => ({
    name: f.replace('.json', ''),
    model: JSON.parse(readFileSync(join(dir, f), 'utf8')) as ResidualModel,
  }));
  if (models.length === 0) {
    log.error('backtest: no model files');
    process.exit(1);
  }
  const rows = extract(); // scored heuristic-v1 rows (train.ts owns the mapping)
  log.info('backtest: rows', { n: rows.length, models: models.map((m) => m.name) });

  // one bucket per horizon edge: heuristic | operator | each model
  const buckets = EDGES.map(() => ({ heur: [] as number[], op: [] as number[], mods: models.map(() => [] as number[]) }));
  const horizonOf = (r: (typeof rows)[number]) =>
    r.features.schedArrEpoch != null ? Math.max(0, (r.features.schedArrEpoch - r.generatedAt) / 1000) : 3600;
  const bucketIdx = (h: number) => {
    const i = EDGES.findIndex((e) => h <= e);
    return i < 0 ? EDGES.length - 1 : i;
  };

  for (const r of rows) {
    const actualSec = r.features.ourP50 + r.label * 1000;
    const b = bucketIdx(horizonOf(r));
    const cell = buckets[b]!;
    cell.heur.push(Math.abs(r.label));
    if (r.operatorErrorSec != null) cell.op.push(Math.abs(r.operatorErrorSec));
    for (let m = 0; m < models.length; m++) {
      const p = applyResidual(models[m]!.model, r.features, r.features.ourP10, r.features.ourP50, r.features.ourP90);
      cell.mods[m]!.push(Math.abs((actualSec - p.p50) / 1000));
    }
  }

  const fmt = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) + 's (n=' + xs.length + ')' : '—');
  const names = ['≤1m', '≤2m', '≤5m', '≤10m', '≤30m', '≤60m'];
  const lines = [
    '# treno backtest — offline replay of scored predictions',
    '',
    '- generated: ' + new Date().toISOString(),
    '- rows: ' + rows.length + ' · models: ' + models.map((m) => m.name).join(', '),
    '',
    '| bucket | heuristic | operator | ' + models.map((m) => m.name).join(' | ') + ' |',
    '|---|---|---|' + models.map(() => '---').join('|') + '|',
  ];
  buckets.forEach((c, i) => {
    lines.push('| ' + names[i] + ' | ' + fmt(c.heur) + ' | ' + fmt(c.op) + ' | ' + c.mods.map(fmt).join(' | ') + ' |');
  });

  // §51 risk-notice replay: point-in-time replay of the pre-emptive warning
  // (fired when ≥2 upstream trains were ≥5 min late AND our p50 was ≥60s
  // late) against what actually happened — the honest-claims gate before the
  // banner ships visibly. Features come straight from recorded features_json,
  // so no hindsight leaks in.
  lines.push('', '## risk-notice replay (§51)', '');
  try {
    const replay = replayRiskNotices();
    if (replay.rowsWithUpstream > 0) {
      lines.push(
        '- rows with §51 features: ' + replay.rowsWithUpstream,
        '- notices fired: ' + replay.fired,
        '- precision (actual delay ≥1 min): ' + (replay.fired > 0 ? Math.round((replay.corroborated / replay.fired) * 100) + '%' : '—'),
        '- recall on ≥2 min late arrivals: ' + (replay.actuallyLate > 0 ? Math.round((replay.caught / replay.actuallyLate) * 100) + '%' : '—'),
        '',
        replay.fired > 0 && replay.corroborated / replay.fired >= MIN_PRECISION_TARGET
          ? 'gate PASS (≥70% precision) — banner may ship visible'
          : 'gate FAIL (<70% precision or no firings yet) — keep the banner behind the model gate',
      );
    } else {
      lines.push('- no rows carry §51 upstream features yet (they started recording 2026-09-18)');
    }
  } catch (e) {
    lines.push('- replay unavailable: ' + String(e));
  }

  // §51 threshold sweep: the same notice decision replayed point-in-time
  // through the parameterized corridor generator (RiskNoticeConfig) over a
  // small grid, so the next nightly run can pick conservative thresholds
  // from real data. The gate above stays the gate; this table is the tuning
  // input, never a second gate.
  lines.push('', '## risk-notice generator threshold sweep (§51)', '');
  try {
    const sweep = sweepRiskNoticeThresholds();
    lines.push(...renderRiskSweepLines(sweep));
  } catch (e) {
    lines.push('- sweep unavailable: ' + String(e));
  }

  console.log('\n' + lines.join('\n'));
  const reports = join(cfg.dataDir, 'reports');
  mkdirSync(reports, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  writeFileSync(join(reports, 'backtest-' + day + '.md'), lines.join('\n') + '\n');
  log.info('backtest: report written', { file: 'data/reports/backtest-' + day + '.md' });
}

interface ReplayRow {
  features: { upstreamStopDelayedCount?: number | null };
  ourP50: number;
  schedArr: number | null;
  actualDelaySec: number; // actual arrival − schedule
}

/** Notice rule replayed on scored rows. Mirrors the API's riskNotice trigger. */
export function replayRiskNotices(): { rowsWithUpstream: number; fired: number; corroborated: number; actuallyLate: number; caught: number } {
  const db = openTrenoDb(loadConfig());
  const rows = db.prepare(
    `SELECT p.our_p50, p.sched_arr_epoch, p.features_json, o.our_error_sec
     FROM predictions p JOIN prediction_outcomes o ON o.prediction_id = p.id
     WHERE p.features_json IS NOT NULL AND p.our_p50 IS NOT NULL AND o.our_error_sec IS NOT NULL
       AND p.sched_arr_epoch IS NOT NULL`,
  ).all() as Array<{ our_p50: number; sched_arr_epoch: number; features_json: string; our_error_sec: number }>;
  db.close();
  let rowsWithUpstream = 0, fired = 0, corroborated = 0, actuallyLate = 0, caught = 0;
  for (const r of rows) {
    let f: { upstreamStopDelayedCount?: number | null };
    try { f = JSON.parse(r.features_json) as { upstreamStopDelayedCount?: number | null }; } catch { continue; }
    if (f.upstreamStopDelayedCount == null) continue;
    rowsWithUpstream++;
    const actualDelaySec = Math.round((r.our_p50 + r.our_error_sec * 1000 - r.sched_arr_epoch) / 1000);
    const ourDelaySec = Math.round((r.our_p50 - r.sched_arr_epoch) / 1000);
    const wouldFire = f.upstreamStopDelayedCount >= 2 && ourDelaySec >= 60;
    if (actualDelaySec >= 120) {
      actuallyLate++;
      if (wouldFire) caught++;
    }
    if (wouldFire) {
      fired++;
      if (actualDelaySec >= 60) corroborated++;
    }
  }
  return { rowsWithUpstream, fired, corroborated, actuallyLate, caught };
}

// MARK: - §51 corridor-generator replay + threshold sweep

/** Widest window any swept config can ask for (90m grid peak-adaptive 1.5x). */
const MAX_EVIDENCE_WINDOW_MIN = 150;

export interface RiskReplayCounts {
  rows: number;
  fired: number;
  corroborated: number;
  actuallyLate: number;
  caught: number;
}

export interface SweepRowCtx {
  runId: number;
  asOf: number;
  ourP50DelaySec: number;
  actualDelaySec: number;
  scope: { segmentIds: string[]; nextStopId: string | null };
  /** traversals on the scope segments, entered_at within MAX window and at
   *  or before asOf (point-in-time: nothing after the prediction instant) */
  traversals: RiskEvidenceTraversal[];
  /** sched_dep epochs of cancelled trains at the next stop, ≤ asOf */
  cancelledDeps: number[];
  /** previous prediction of the same run within the persistence gap */
  prev: SweepRowCtx | null;
  /** per-window evidence cache (aggregate is config-free) */
  evidenceByWindow: Map<number, RiskNoticeEvidence>;
}

interface StopEventRow {
  run_id: number;
  stop_id: string;
  stop_sequence: number | null;
  sched_arr_epoch: number | null;
  sched_dep_epoch: number | null;
  actual_arr_epoch: number | null;
  actual_dep_epoch: number | null;
  cancelled: number | null;
}

function chunk<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

/**
 * Build the point-in-time evaluation set: every scored prediction row (or,
 * when §51 features exist, exactly the featured rows the single-config
 * replay uses — so both replays are directly comparable), with corridor
 * evidence reconstructed from segment_observation / train_stop_events as of
 * each row's generated_at. Stop events hold final actuals by backtest time;
 * "not yet served at t" is rebuilt by comparing final actuals to t, which
 * matches what the live rule saw as long as actuals are recorded once.
 */
function loadSweepRows(db: Db): { rows: SweepRowCtx[]; featuredRowsOnly: boolean; skippedNoStops: number; totalScored: number } {
  const featured = (getRowCount(db, `FROM predictions p JOIN prediction_outcomes o ON o.prediction_id = p.id
     WHERE p.features_json IS NOT NULL AND json_extract(p.features_json, '$.upstreamStopDelayedCount') IS NOT NULL
       AND p.our_p50 IS NOT NULL AND p.sched_arr_epoch IS NOT NULL AND o.our_error_sec IS NOT NULL`));
  const totalScored = getRowCount(db, `FROM predictions p JOIN prediction_outcomes o ON o.prediction_id = p.id
     WHERE p.our_p50 IS NOT NULL AND p.sched_arr_epoch IS NOT NULL AND o.our_error_sec IS NOT NULL`);
  const featuredRowsOnly = featured > 0;
  const raw = db.prepare(
    `SELECT p.run_id, p.generated_at, p.our_p50, p.sched_arr_epoch, o.our_error_sec
     FROM predictions p JOIN prediction_outcomes o ON o.prediction_id = p.id
     WHERE p.our_p50 IS NOT NULL AND p.sched_arr_epoch IS NOT NULL AND o.our_error_sec IS NOT NULL
       ${featuredRowsOnly ? "AND p.features_json IS NOT NULL AND json_extract(p.features_json, '$.upstreamStopDelayedCount') IS NOT NULL" : ''}
     ORDER BY p.run_id, p.generated_at`,
  ).all() as Array<{ run_id: number; generated_at: number; our_p50: number; sched_arr_epoch: number; our_error_sec: number }>;

  const runIds = [...new Set(raw.map((r) => r.run_id))];
  const stopsByRun = new Map<number, StopEventRow[]>();
  for (const part of chunk(runIds, 400)) {
    const ph = part.map(() => '?').join(',');
    const evs = db.prepare(
      `SELECT run_id, stop_id, stop_sequence, sched_arr_epoch, sched_dep_epoch, actual_arr_epoch, actual_dep_epoch, cancelled
       FROM train_stop_events WHERE run_id IN (${ph})`,
    ).all(...part) as unknown as StopEventRow[];
    for (const e of evs) {
      const list = stopsByRun.get(e.run_id) ?? [];
      list.push(e);
      stopsByRun.set(e.run_id, list);
    }
  }
  for (const [, list] of stopsByRun) {
    list.sort((a, b) => (a.stop_sequence ?? 0) - (b.stop_sequence ?? 0) || (a.sched_arr_epoch ?? 0) - (b.sched_arr_epoch ?? 0));
  }

  // per-run corridor traversals, fetched once over the run's own time span
  const rows: SweepRowCtx[] = [];
  let skippedNoStops = 0;
  let i = 0;
  while (i < raw.length) {
    const runId = raw[i]!.run_id;
    let j = i;
    while (j < raw.length && raw[j]!.run_id === runId) j++;
    const runRows = raw.slice(i, j);
    i = j;
    const stops = stopsByRun.get(runId);
    if (!stops || stops.length === 0) { skippedNoStops += runRows.length; continue; }
    const scopeStops: RiskNoticeStop[] = stops;
    const scopes = runRows.map((r) => riskNoticeScope(scopeStops, r.generated_at));
    const segIds = [...new Set(scopes.flatMap((s) => s.segmentIds))];
    const minAsOf = Math.min(...runRows.map((r) => r.generated_at));
    const maxAsOf = Math.max(...runRows.map((r) => r.generated_at));
    const traversals = segIds.length > 0
      ? (db.prepare(
          `SELECT segment_id, entered_at, delay_delta_sec, entry_delay_sec, exit_delay_sec
           FROM segment_observation WHERE segment_id IN (${segIds.map(() => '?').join(',')})
           AND entered_at >= ? AND entered_at <= ? AND delay_delta_sec IS NOT NULL`,
        ).all(...segIds, minAsOf - MAX_EVIDENCE_WINDOW_MIN * 60_000, maxAsOf) as unknown as RiskEvidenceTraversal[])
      : [];
    for (let k = 0; k < runRows.length; k++) {
      const r = runRows[k]!;
      const scope = scopes[k]!;
      const since = r.generated_at - MAX_EVIDENCE_WINDOW_MIN * 60_000;
      const own = traversals.filter((t) => t.entered_at >= since && t.entered_at <= r.generated_at);
      rows.push({
        runId,
        asOf: r.generated_at,
        ourP50DelaySec: Math.round((r.our_p50 - r.sched_arr_epoch) / 1000),
        actualDelaySec: Math.round((r.our_p50 + r.our_error_sec * 1000 - r.sched_arr_epoch) / 1000),
        scope,
        traversals: own.filter((t) => scope.segmentIds.includes(t.segment_id)),
        cancelledDeps: [],
        prev: null,
        evidenceByWindow: new Map(),
      });
    }
  }

  // cancelled preceding trains at each row's next stop (global fetch, per-row filter)
  const nextStops = [...new Set(rows.map((r) => r.scope.nextStopId).filter((s): s is string => s != null))];
  if (nextStops.length > 0) {
    const minAsOf = Math.min(...rows.map((r) => r.asOf));
    const maxAsOf = Math.max(...rows.map((r) => r.asOf));
    const cancelled = new Map<string, number[]>();
    for (const part of chunk(nextStops, 400)) {
      const ph = part.map(() => '?').join(',');
      const cs = db.prepare(
        `SELECT stop_id, sched_dep_epoch FROM train_stop_events
         WHERE stop_id IN (${ph}) AND cancelled=1 AND actual_dep_epoch IS NULL
           AND sched_dep_epoch >= ? AND sched_dep_epoch <= ?`,
      ).all(...part, minAsOf - MAX_EVIDENCE_WINDOW_MIN * 60_000, maxAsOf) as Array<{ stop_id: string; sched_dep_epoch: number | null }>;
      for (const c of cs) {
        if (c.sched_dep_epoch == null) continue;
        const list = cancelled.get(c.stop_id) ?? [];
        list.push(c.sched_dep_epoch);
        cancelled.set(c.stop_id, list);
      }
    }
    for (const row of rows) {
      if (row.scope.nextStopId == null) continue;
      row.cancelledDeps = (cancelled.get(row.scope.nextStopId) ?? []).filter((d) => d <= row.asOf);
    }
  }

  // consecutive-refresh linkage for the persistence candidate
  for (let k = 1; k < rows.length; k++) {
    const prev = rows[k - 1]!;
    const cur = rows[k]!;
    if (prev.runId === cur.runId && cur.asOf > prev.asOf && cur.asOf - prev.asOf <= PERSISTENCE_MAX_GAP_MS) cur.prev = prev;
  }
  return { rows, featuredRowsOnly, skippedNoStops, totalScored };
}

function getRowCount(db: Db, fromWhere: string): number {
  return Number((db.prepare('SELECT COUNT(*) AS n ' + fromWhere).get() as { n: number }).n);
}

/** Evidence for a row at a window width (cached — the aggregate carries no config). */
function evidenceAt(row: SweepRowCtx, windowMin: number): RiskNoticeEvidence {
  let ev = row.evidenceByWindow.get(windowMin);
  if (!ev) {
    const since = row.asOf - windowMin * 60_000;
    const travs = row.traversals.filter((t) => t.entered_at >= since);
    const canc = row.cancelledDeps.filter((d) => d >= since).length;
    ev = aggregateRiskNoticeEvidence(travs, canc, windowMin);
    row.evidenceByWindow.set(windowMin, ev);
  }
  return ev;
}

/** Would the parameterized generator have fired this row? */
export function sweepRowFires(row: SweepRowCtx, cfg: RiskNoticeConfig): boolean {
  const evidence = evidenceAt(row, effectiveEvidenceWindowMin(cfg, row.asOf));
  let persisted: boolean | null = null;
  if (cfg.requirePersistence && row.prev != null) {
    const prevEv = evidenceAt(row.prev, effectiveEvidenceWindowMin(cfg, row.prev.asOf));
    persisted = prevEv.medianRuntimeDeltaSec != null && prevEv.medianRuntimeDeltaSec >= cfg.minMedianRuntimeDeltaSec;
  }
  return riskNoticeFires(evidence, row.ourP50DelaySec, cfg, persisted);
}

/** Replay counts for one config over the evaluation set. */
export function replayEvidence(rows: SweepRowCtx[], cfg: RiskNoticeConfig): RiskReplayCounts {
  let fired = 0, corroborated = 0, actuallyLate = 0, caught = 0;
  for (const row of rows) {
    const wouldFire = sweepRowFires(row, cfg);
    if (row.actualDelaySec >= 120) {
      actuallyLate++;
      if (wouldFire) caught++;
    }
    if (wouldFire) {
      fired++;
      if (row.actualDelaySec >= 60) corroborated++;
    }
  }
  return { rows: rows.length, fired, corroborated, actuallyLate, caught };
}

/** One config replayed over a db's evaluation set (fixture / ad-hoc use). */
export function replayRiskNoticeEvidenceOnDb(db: Db, cfg: RiskNoticeConfig): RiskReplayCounts {
  return replayEvidence(loadSweepRows(db).rows, cfg);
}

export interface SweepConfigResult {
  config: RiskNoticeConfig;
  label: string;
  counts: RiskReplayCounts;
}

export interface SweepOutcome {
  rowsEvaluated: number;
  /** true: only §51-featured rows (comparable with the single-config replay);
   *  false: no featured rows yet — machinery smoke on all scored rows */
  featuredRowsOnly: boolean;
  skippedNoStops: number;
  totalScored: number;
  defaultConfig: RiskNoticeConfig;
  defaultCounts: RiskReplayCounts;
  grid: SweepConfigResult[];
  toggles: SweepConfigResult[];
  firingFloor: number;
  chosen: { config: RiskNoticeConfig; label: string; reason: string } | null;
  closest: SweepConfigResult | null;
}

function labelFor(cfg: RiskNoticeConfig, suffix = ''): string {
  return `trains≥${cfg.minPrecedingTrains} · win ${cfg.evidenceWindowMin}m · Δmed≥${cfg.minMedianRuntimeDeltaSec}s${suffix}`;
}

/**
 * The sweep: a small grid over the three causal thresholds (count of
 * preceding trains, evidence window, median corridor runtime delta), plus
 * the candidate toggles at default thresholds, plus a chosen default picked
 * by a stated rule — never by relaxing the gate.
 */
export function sweepRiskNoticeThresholds(opts: { db?: Db } = {}): SweepOutcome {
  const ownDb = opts.db ?? openTrenoDb(loadConfig());
  try {
    const loaded = loadSweepRows(ownDb);
    const defaultConfig = { ...DEFAULT_RISK_NOTICE_CONFIG };
    const defaultCounts = replayEvidence(loaded.rows, defaultConfig);

    const grid: SweepConfigResult[] = [];
    for (const minPrecedingTrains of [2, 3, 4]) {
      for (const evidenceWindowMin of [20, 45, 90]) {
        for (const minMedianRuntimeDeltaSec of [60, 90, 120]) {
          const config: RiskNoticeConfig = { ...defaultConfig, minPrecedingTrains, evidenceWindowMin, minMedianRuntimeDeltaSec };
          grid.push({ config, label: labelFor(config), counts: replayEvidence(loaded.rows, config) });
        }
      }
    }
    const toggle = (name: string, patch: Partial<RiskNoticeConfig>): SweepConfigResult => {
      const config: RiskNoticeConfig = { ...defaultConfig, ...patch };
      return { config, label: labelFor(config, ' · ' + name), counts: replayEvidence(loaded.rows, config) };
    };
    const toggles = [
      toggle('persistence', { requirePersistence: true }),
      toggle('severe-weighting', { weightSevereEvidence: true }),
      toggle('adaptive-window', { adaptiveWindow: true }),
      toggle('all-candidates', { requirePersistence: true, weightSevereEvidence: true, adaptiveWindow: true }),
    ];

    const firingFloor = Math.max(1, Math.min(50, Math.round(loaded.rows.length * 0.01)));
    const precision = (r: SweepConfigResult): number | null => (r.counts.fired > 0 ? r.counts.corroborated / r.counts.fired : null);
    const eligible = grid.filter((r) => r.counts.fired >= firingFloor && (precision(r) ?? 0) >= MIN_PRECISION_TARGET);
    let chosen: SweepOutcome['chosen'] = null;
    if (eligible.length > 0) {
      // among gate-passing configs with enough firings: max recall, then the
      // most conservative thresholds (higher delta gate, higher train count,
      // shorter window) so ties resolve toward fewer, better notices
      const best = eligible.reduce((a, b) => {
        const ra = a.counts.actuallyLate > 0 ? a.counts.caught / a.counts.actuallyLate : 0;
        const rb = b.counts.actuallyLate > 0 ? b.counts.caught / b.counts.actuallyLate : 0;
        if (rb > ra) return b;
        if (rb < ra) return a;
        const da = a.config.minMedianRuntimeDeltaSec, dbv = b.config.minMedianRuntimeDeltaSec;
        if (dbv > da) return b;
        if (dbv < da) return a;
        if (b.config.minPrecedingTrains !== a.config.minPrecedingTrains) return b.config.minPrecedingTrains > a.config.minPrecedingTrains ? b : a;
        return b.config.evidenceWindowMin < a.config.evidenceWindowMin ? b : a;
      });
      chosen = {
        config: best.config,
        label: best.label,
        reason: `precision ${Math.round((precision(best) ?? 0) * 100)}% ≥ ${Math.round(MIN_PRECISION_TARGET * 100)}% gate at ${best.counts.fired} firings (floor ${firingFloor}), best recall ${best.counts.actuallyLate > 0 ? Math.round((best.counts.caught / best.counts.actuallyLate) * 100) + '%' : '—'} among gate-passing configs`,
      };
    }
    const closest = grid.filter((r) => r.counts.fired >= firingFloor).reduce<SweepConfigResult | null>((a, b) => {
      if (!a) return b;
      const pa = precision(a) ?? 0, pb = precision(b) ?? 0;
      if (pb > pa) return b;
      if (pb < pa) return a;
      return (precision(b) ?? 0) > (precision(a) ?? 0) ? b : a;
    }, null);

    return {
      rowsEvaluated: loaded.rows.length,
      featuredRowsOnly: loaded.featuredRowsOnly,
      skippedNoStops: loaded.skippedNoStops,
      totalScored: loaded.totalScored,
      defaultConfig,
      defaultCounts,
      grid,
      toggles,
      firingFloor,
      chosen,
      closest,
    };
  } finally {
    if (!opts.db) ownDb.close();
  }
}

/** Markdown rendering for the nightly report. */
export function renderRiskSweepLines(s: SweepOutcome): string[] {
  if (s.rowsEvaluated === 0) {
    return ['- no scored prediction rows to replay (need predictions with outcomes) — sweep skipped'];
  }
  const pct = (n: number, d: number): string => (d > 0 ? Math.round((n / d) * 100) + '%' : '—');
  const lines = [
    '- generator: RiskNoticeConfig corridor rule (heuristic.ts), evidence rebuilt point-in-time from segment_observation / train_stop_events',
    '- rows evaluated: ' + s.rowsEvaluated + (s.featuredRowsOnly
      ? ' (§51-featured rows — same row set as the replay above)'
      : ' — NOTE: no §51-featured rows yet, so this sweep runs on ALL scored rows as a machinery smoke; real numbers come once features record (2026-09-18+)'),
    s.skippedNoStops > 0 ? '- rows skipped (no stop events, cannot locate the corridor): ' + s.skippedNoStops : null,
    '- firing floor for choosing a default: ≥' + s.firingFloor + ' firings',
    `- default config (${labelFor(s.defaultConfig)} · p50≥${s.defaultConfig.minP50MoveSec}s): fired ${s.defaultCounts.fired} · precision ${pct(s.defaultCounts.corroborated, s.defaultCounts.fired)} · recall ${pct(s.defaultCounts.caught, s.defaultCounts.actuallyLate)}`,
    '',
    '| config | fired | precision | recall |',
    '|---|---|---|---|',
  ].filter((l): l is string => l != null);
  const isDefault = (r: SweepConfigResult): boolean =>
    r.config.minPrecedingTrains === s.defaultConfig.minPrecedingTrains
    && r.config.evidenceWindowMin === s.defaultConfig.evidenceWindowMin
    && r.config.minMedianRuntimeDeltaSec === s.defaultConfig.minMedianRuntimeDeltaSec
    && !r.config.requirePersistence && !r.config.weightSevereEvidence && !r.config.adaptiveWindow;
  for (const r of s.grid) {
    lines.push(`| ${r.label}${isDefault(r) ? ' **(default)**' : ''} | ${r.counts.fired} | ${pct(r.counts.corroborated, r.counts.fired)} | ${pct(r.counts.caught, r.counts.actuallyLate)} |`);
  }
  lines.push('', 'candidate toggles at default thresholds:', '', '| config | fired | precision | recall |', '|---|---|---|---|');
  for (const r of s.toggles) {
    lines.push(`| ${r.label} | ${r.counts.fired} | ${pct(r.counts.corroborated, r.counts.fired)} | ${pct(r.counts.caught, r.counts.actuallyLate)} |`);
  }
  lines.push('');
  if (s.chosen) {
    const c = s.chosen;
    const same = JSON.stringify(c.config) === JSON.stringify(s.defaultConfig);
    lines.push(
      `- chosen default for the next nightly run: ${c.label}${same ? ' (unchanged — the current defaults already pass)' : ''} — ${c.reason}`,
      same
        ? '- apply: nothing to change'
        : `- apply: set TRENO_RISK_NOTICE_CONFIG='${JSON.stringify({ minPrecedingTrains: c.config.minPrecedingTrains, evidenceWindowMin: c.config.evidenceWindowMin, minMedianRuntimeDeltaSec: c.config.minMedianRuntimeDeltaSec })}' (collector env) or edit DEFAULT_RISK_NOTICE_CONFIG in packages/collector/src/heuristic.ts`,
    );
  } else if (s.closest) {
    lines.push(
      `- no swept config passes the ≥${Math.round(MIN_PRECISION_TARGET * 100)}% precision gate at ≥${s.firingFloor} firings — banner stays gated; closest: ${s.closest.label} at ${pct(s.closest.counts.corroborated, s.closest.counts.fired)} precision (${s.closest.counts.fired} firings)`,
    );
  } else {
    lines.push(`- no swept config reached the ${s.firingFloor}-firing floor — too little §51-era data to tune yet`);
  }
  lines.push('- the ≥70% gate above stays the only gate; this table tunes thresholds, it never replaces the gate');
  return lines;
}
void featureRow;
if (process.argv[1] && process.argv[1].endsWith('backtest.ts')) main();
