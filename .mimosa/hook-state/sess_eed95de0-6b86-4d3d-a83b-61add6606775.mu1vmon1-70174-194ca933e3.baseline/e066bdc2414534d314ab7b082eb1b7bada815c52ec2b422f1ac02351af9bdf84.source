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
  console.log('\n' + lines.join('\n'));
  const reports = join(cfg.dataDir, 'reports');
  mkdirSync(reports, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  writeFileSync(join(reports, 'backtest-' + day + '.md'), lines.join('\n') + '\n');
  log.info('backtest: report written', { file: 'data/reports/backtest-' + day + '.md' });
}
void featureRow;
if (process.argv[1] && process.argv[1].endsWith('backtest.ts')) main();
