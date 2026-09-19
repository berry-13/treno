/**
 * Offline backtester: replays scored heuristic-v1 predictions against every
 * model file in data/models/ — improvements measurable in seconds, not days.
 *   npm run backtest
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '#core/config.ts';
import { log } from '#core/log.ts';
import { openTrenoDb } from '#gtfs/setup.ts';
import { featureRow, applyResidual, type FeatureInput, type ResidualModel } from './model.ts';
import { extract } from './train.ts';

const EDGES = [60, 120, 300, 600, 1800, 3600];

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
        replay.fired > 0 && replay.corroborated / replay.fired >= 0.7
          ? 'gate PASS (≥70% precision) — banner may ship visible'
          : 'gate FAIL (<70% precision or no firings yet) — keep the banner behind the model gate',
      );
    } else {
      lines.push('- no rows carry §51 upstream features yet (they started recording 2026-09-18)');
    }
  } catch (e) {
    lines.push('- replay unavailable: ' + String(e));
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
void featureRow;
if (process.argv[1] && process.argv[1].endsWith('backtest.ts')) main();
