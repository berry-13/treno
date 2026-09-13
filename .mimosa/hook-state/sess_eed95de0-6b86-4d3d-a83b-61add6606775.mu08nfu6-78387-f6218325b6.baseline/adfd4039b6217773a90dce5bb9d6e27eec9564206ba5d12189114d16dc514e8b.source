/**
 * Benchmark pipeline (GOAL.md §34): scores every recorded prediction against
 * its outcome at horizons T-1..T-30, comparing:
 *   A schedule only · B operator ETA · C our model
 * Metrics: MAE, median AE, RMSE, P90/P95 abs error, signed bias, interval
 * coverage. Writes a markdown report to data/reports/.
 *
 *   npm run bench [-- --days=30]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '#core/config.ts';
import { getRows, type Db } from '#core/db.ts';
import { romeHms, secondsToHms } from '#core/time.ts';
import { openTrenoDb } from '#gtfs/setup.ts';

interface ScoredRow {
  model_version: string;
  generated_at: number;
  actual_arr_epoch: number;
  sched_arr_epoch: number | null;
  operator_eta_epoch: number | null;
  our_p10: number | null;
  our_p50: number | null;
  our_p90: number | null;
}

const HORIZONS: Array<{ label: string; minSec: number; maxSec: number }> = [
  { label: 'T-1', minSec: 0, maxSec: 60 },
  { label: 'T-2', minSec: 60, maxSec: 120 },
  { label: 'T-5', minSec: 120, maxSec: 300 },
  { label: 'T-10', minSec: 300, maxSec: 600 },
  { label: 'T-20', minSec: 600, maxSec: 1200 },
  { label: 'T-30', minSec: 1200, maxSec: 1800 },
  { label: 'T-30+', minSec: 1800, maxSec: Number.MAX_SAFE_INTEGER },
];

interface Metrics { n: number; mae: number; medae: number; rmse: number; p90: number; p95: number; bias: number }

function metrics(errsSec: number[]): Metrics {
  const abs = errsSec.map(Math.abs).sort((a, b) => a - b);
  const q = (p: number) => abs.length > 0 ? abs[Math.min(abs.length - 1, Math.floor(abs.length * p))]! : 0;
  const n = errsSec.length;
  const mae = n > 0 ? abs.reduce((s, v) => s + v, 0) / n : 0;
  const medae = n > 0 ? abs[Math.floor(n / 2)]! : 0;
  const rmse = n > 0 ? Math.sqrt(errsSec.reduce((s, v) => s + v * v, 0) / n) : 0;
  const bias = n > 0 ? errsSec.reduce((s, v) => s + v, 0) / n : 0;
  return { n, mae, medae, rmse, p90: q(0.9), p95: q(0.95), bias };
}

function fmtSec(s: number): string {
  const r = Math.round(s);
  const m = Math.floor(Math.abs(r) / 60);
  const sec = Math.abs(r) % 60;
  return (r < 0 ? '-' : '') + m + 'm' + String(sec).padStart(2, '0') + 's';
}

export function runBenchmark(db: Db, days = 30) {
  const since = Date.now() - days * 86400_000;
  const rows = getRows<ScoredRow>(
    db,
    'SELECT p.model_version, p.generated_at, o.actual_arr_epoch, p.sched_arr_epoch, p.operator_eta_epoch, p.our_p10, p.our_p50, p.our_p90 FROM predictions p JOIN prediction_outcomes o ON o.prediction_id = p.id WHERE p.generated_at >= ?',
    [since],
  );

  // horizon → { sched, oper, ours:<model> } → errors
  interface Cell { sched: number[]; oper: number[]; oursByModel: Map<string, number[]> }
  const table = new Map<string, Cell>();
  const modelNames = new Set<string>();
  let coverageIn = 0, coverageN = 0;
  for (const r of rows) {
    const horizonSec = (r.actual_arr_epoch - r.generated_at) / 1000;
    if (horizonSec < 0) continue;
    const h = HORIZONS.find((x) => horizonSec >= x.minSec && horizonSec < x.maxSec);
    if (!h) continue;
    let cell = table.get(h.label);
    if (!cell) { cell = { sched: [], oper: [], oursByModel: new Map() }; table.set(h.label, cell); }
    if (r.sched_arr_epoch != null) cell.sched.push((r.actual_arr_epoch - r.sched_arr_epoch) / 1000);
    if (r.operator_eta_epoch != null) cell.oper.push((r.actual_arr_epoch - r.operator_eta_epoch) / 1000);
    if (r.our_p50 != null) {
      modelNames.add(r.model_version);
      let arr = cell.oursByModel.get(r.model_version);
      if (!arr) { arr = []; cell.oursByModel.set(r.model_version, arr); }
      arr.push((r.actual_arr_epoch - r.our_p50) / 1000);
    }
    if (r.our_p10 != null && r.our_p90 != null) {
      coverageN++;
      if (r.actual_arr_epoch >= r.our_p10 && r.actual_arr_epoch <= r.our_p90) coverageIn++;
    }
  }

  const models = new Map(rows.map((r) => [r.model_version, 1]));
  const lines: string[] = [];
  lines.push('# treno benchmark — vs operator ETA (GOAL.md §34)');
  lines.push('');
  lines.push('- generated: ' + new Date().toISOString());
  lines.push('- window: last ' + String(days) + ' days · scored predictions: ' + String(rows.length));
  lines.push('- models recorded: ' + [...models.keys()].join(', '));
  lines.push('- our p10–p90 interval coverage: ' + (coverageN > 0 ? Math.round(1000 * coverageIn / coverageN) / 10 + '%' : 'n/a') + ' (target ~80%)');
  lines.push('');
  for (const h of HORIZONS) {
    const cell = table.get(h.label);
    if (!cell) continue;
    lines.push('## ' + h.label + ' before arrival');
    lines.push('');
    lines.push('| model | n | MAE | medAE | RMSE | P90 | P95 | bias |');
    lines.push('|---|---|---|---|---|---|---|---|');
    const entries: Array<[string, number[]]> = [
      ['schedule only', cell.sched],
      ['operator ETA', cell.oper],
    ];
    for (const m of [...modelNames].sort()) {
      entries.push(['ours: ' + m, cell.oursByModel.get(m) ?? []]);
    }
    for (const [name, errs] of entries) {
      if (errs.length === 0) continue;
      const m = metrics(errs);
      lines.push('| ' + name + ' | ' + m.n + ' | ' + fmtSec(m.mae) + ' | ' + fmtSec(m.medae) + ' | ' + fmtSec(m.rmse) + ' | ' + fmtSec(m.p90) + ' | ' + fmtSec(m.p95) + ' | ' + fmtSec(m.bias) + ' |');
    }
    lines.push('');
  }
  const verdict = (() => {
    const agg = { oper: [] as number[] };
    const oursAgg = new Map<string, number[]>();
    for (const cell of table.values()) {
      agg.oper.push(...cell.oper);
      for (const [m, errs] of cell.oursByModel) {
        let a = oursAgg.get(m);
        if (!a) { a = []; oursAgg.set(m, a); }
        a.push(...errs);
      }
    }
    const bestModel = [...oursAgg.entries()].filter(([, e]) => e.length >= 30).sort((a, b) => metrics(a[1]).mae - metrics(b[1]).mae)[0];
    if (!bestModel) {
      return 'no model has ≥30 scored outcomes yet (scored rows: ' + String(agg.oper.length) + ') — keep the collector running; no accuracy claim.';
    }
    const mo = metrics(agg.oper), mu = metrics(bestModel[1]);
    const better = mu.mae < mo.mae;
    return 'best model ' + bestModel[0] + ' (n=' + String(bestModel[1].length) + '): operator MAE ' + fmtSec(mo.mae) + ' vs ours ' + fmtSec(mu.mae) + ' → ' + (better ? 'ours ahead by ' + Math.round((1 - mu.mae / mo.mae) * 100) + '%' : 'operator ahead — do NOT claim better accuracy (§34)');
  })();
  lines.push('## Verdict');
  lines.push('');
  lines.push(verdict);
  return { text: lines.join('\n'), scored: rows.length };
}

async function main() {
  const cfg = loadConfig();
  const db = openTrenoDb(cfg);
  const days = Number(process.argv.find((a) => a.startsWith('--days='))?.slice(8) ?? 30);
  const { text, scored } = runBenchmark(db, days);
  const dir = join(cfg.dataDir, 'reports');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'benchmark-' + new Date().toISOString().slice(0, 10) + '.md');
  writeFileSync(file, text);
  console.log(text);
  console.log('\nreport written to ' + file + ' (' + String(scored) + ' scored predictions)');
  console.log('note: wall clock now ' + romeHms(Date.now()) + ' Rome; session time ' + secondsToHms(Math.round(process.uptime())));
  db.close();
}

if (process.argv[1] && process.argv[1].endsWith('bench.ts')) {
  main().catch((e) => { console.error('bench failed:', String(e)); process.exit(1); });
}
