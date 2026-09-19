/**
 * GBM hyperparameter sweep scored by validation MAE on the same time-ordered
 * split `npm run train` uses (PLAN_complete_partials P4). Report-only: it
 * never writes a model file — run `npm run train` (optionually after editing
 * its defaults to the winner) to deploy.
 *   npm run train:sweep
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '#core/config.ts';
import { log } from '#core/log.ts';
import { featureRow } from './model.ts';
import { fitGBM, predictGBM } from './gbm.ts';
import { extract } from './train.ts';

interface Cfg { rounds: number; lr: number; depth: number; minLeaf: number }

const GRID: Cfg[] = (() => {
  const out: Cfg[] = [];
  for (const rounds of [100, 150, 250]) {
    for (const lr of [0.05, 0.08, 0.12]) {
      for (const depth of [3, 4]) {
        for (const minLeaf of [20, 40]) out.push({ rounds, lr, depth, minLeaf });
      }
    }
  }
  return out;
})();

function main() {
  const rows = extract();
  if (rows.length < 3000) {
    log.error('sweep: not enough rows', { have: rows.length });
    process.exit(1);
  }
  // same encoding treatment as train.ts (train-window target encoding) so the
  // sweep measures configurations, not feature drift
  const cut = Math.floor(rows.length * 0.8);
  const train = rows.slice(0, cut);
  const val = rows.slice(cut);
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
  const enc: Record<string, number> = {};
  for (const [rid, e] of routeSum) enc[rid] = (e.s + 20 * globalMean) / (e.n + 20);
  for (const r of rows) r.features.routeEncSec = r.features.routeId != null ? enc[r.features.routeId] ?? 0 : 0;

  const Xtr = train.map((r) => featureRow(r.features));
  const ytr = train.map((r) => r.label);
  const Xva = val.map((r) => featureRow(r.features));
  const yva = val.map((r) => r.label);
  const results: Array<Cfg & { mae: number }> = [];
  for (const c of GRID) {
    const t0 = Date.now();
    const gbm = fitGBM(Xtr, ytr, c.rounds, c.lr, c.depth, c.minLeaf);
    let mae = 0;
    for (let i = 0; i < val.length; i++) {
      mae += Math.abs(yva[i]! - Math.max(-1200, Math.min(1200, predictGBM(gbm, Xva[i]!))));
    }
    results.push({ ...c, mae: mae / val.length });
    log.info('sweep: config done', { ...c, mae: Math.round(mae / val.length), ms: Date.now() - t0 });
  }
  results.sort((a, b) => a.mae - b.mae);
  const lines = [
    '# treno GBM hyperparameter sweep',
    '',
    '- generated: ' + new Date().toISOString(),
    '- rows: ' + rows.length + ' (train ' + train.length + ' / val ' + val.length + ')',
    '',
    '| rounds | lr | depth | minLeaf | val MAE |',
    '|---|---|---|---|---|',
    ...results.map((r) => `| ${r.rounds} | ${r.lr} | ${r.depth} | ${r.minLeaf} | ${Math.round(r.mae)}s |`),
    '',
    'winner: rounds=' + results[0]!.rounds + ' lr=' + results[0]!.lr + ' depth=' + results[0]!.depth + ' minLeaf=' + results[0]!.minLeaf,
    '',
    'Deployment rule: adopt the winner only if `npm run backtest` then shows an',
    'improvement in EVERY horizon bucket vs the current residual-v1.',
  ];
  const dir = join(loadConfig().dataDir, 'reports');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'sweep-' + new Date().toISOString().slice(0, 10) + '.md');
  writeFileSync(file, lines.join('\n') + '\n');
  console.log('\n' + lines.join('\n'));
  log.info('sweep: report written', { file });
}

if (process.argv[1] && process.argv[1].endsWith('train-sweep.ts')) {
  main();
}
