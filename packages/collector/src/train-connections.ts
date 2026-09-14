/**
 * Connection-success model (§roadmap #1): learns P(making the transfer)
 * from historical arrival→departure pairs at shared stops, replacing the
 * independence-assuming normal-CDF when it proves itself (AUC ≥ 0.8).
 *   npm run train:connections
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '#core/config.ts';
import { log } from '#core/log.ts';
import { openTrenoDb } from '#gtfs/setup.ts';
import { fitGBM, predictGBM, type GBMForest } from './gbm.ts';

export interface ConnectionsModel {
  trainedAt: number;
  pairs: number;
  positives: number;
  auc: number;
  gbm: GBMForest;
}

/** shared feature row: [bias, buffer/300, aDelay/300, bDelay/300, hourSin, hourCos, peak] */
export function connectionRow(bufferSec: number, aDelaySec: number, bDelaySec: number | null, hour: number): number[] {
  const cap = (v: number, l: number) => Math.max(-l, Math.min(l, v));
  return [
    1,
    Math.max(0, Math.min(bufferSec, 1800)) / 300,
    cap(aDelaySec, 900) / 300,
    cap(bDelaySec ?? 0, 900) / 300,
    Math.sin((2 * Math.PI * hour) / 24),
    Math.cos((2 * Math.PI * hour) / 24),
    (hour >= 7 && hour < 9) || (hour >= 16 && hour < 19) ? 1 : 0,
  ];
}

function auc(scores: number[], labels: number[]): number {
  const order = scores.map((s, i) => [s, labels[i]!] as const).sort((a, b) => a[0] - b[0]);
  let rankSumPos = 0, nPos = 0, nNeg = 0;
  let i = 0;
  while (i < order.length) {
    let j = i;
    while (j + 1 < order.length && order[j + 1]![0] === order[i]![0]) j++;
    const avgRank = (i + j) / 2 + 1; // 1-based average rank for ties
    for (let k = i; k <= j; k++) {
      if (order[k]![1] === 1) { rankSumPos += avgRank; nPos++; } else nNeg++;
    }
    i = j + 1;
  }
  if (nPos === 0 || nNeg === 0) return 0.5;
  return (rankSumPos - (nPos * (nPos + 1)) / 2) / (nPos * nNeg);
}

function main() {
  const db = openTrenoDb(loadConfig());
  db.exec('CREATE INDEX IF NOT EXISTS idx_stop_events_stop ON train_stop_events(stop_id)');
  const pairs = db.prepare(
    `SELECT a.arr_delay_sec a_delay, a.sched_arr_epoch a_sched, a.actual_arr_epoch a_arr,
            b.sched_dep_epoch b_sched, b.actual_dep_epoch b_dep, b.dep_delay_sec b_delay
     FROM train_stop_events a
     JOIN train_stop_events b ON b.stop_id=a.stop_id AND b.run_id != a.run_id
     JOIN train_runs ra ON ra.id=a.run_id
     JOIN train_runs rb ON rb.id=b.run_id AND rb.service_date=ra.service_date
     WHERE a.actual_arr_epoch IS NOT NULL AND b.actual_dep_epoch IS NOT NULL
       AND a.sched_arr_epoch IS NOT NULL AND b.sched_dep_epoch IS NOT NULL
       AND a.arr_delay_sec IS NOT NULL
       AND b.sched_dep_epoch - a.sched_arr_epoch BETWEEN 300000 AND 1800000
     LIMIT 60000`,
  ).all() as Array<{ a_delay: number; a_sched: number; a_arr: number; b_sched: number; b_dep: number; b_delay: number | null }>;
  db.close();
  if (pairs.length < 2000) {
    log.error('train:connections — not enough pairs yet', { have: pairs.length, need: 2000 });
    process.exit(1);
  }
  // time-ordered split by scheduled departure
  pairs.sort((x, y) => x.b_sched - y.b_sched);
  const cut = Math.floor(pairs.length * 0.8);
  const row = (p: (typeof pairs)[number]) => {
    const hour = Number(new Date(p.b_sched).toLocaleString('en-GB', { timeZone: 'Europe/Rome', hour: 'numeric', hour12: false })) || 12;
    return connectionRow((p.b_sched - p.a_sched) / 1000, p.a_delay, p.b_delay, hour);
  };
  const lab = (p: (typeof pairs)[number]): number => (p.a_arr <= p.b_dep - 120_000 ? 1 : 0);
  const Xtr = pairs.slice(0, cut).map(row);
  const ytr = pairs.slice(0, cut).map(lab);
  const gbm = fitGBM(Xtr, ytr, 120, 0.08, 3, 30); // regression on 0/1 → probability
  const va = pairs.slice(cut);
  const scores = va.map((p) => predictGBM(gbm, row(p)));
  const labels = va.map(lab);
  const a = auc(scores, labels);
  const positives = ytr.reduce((s, v) => s + v, 0);
  log.info('train:connections', { pairs: pairs.length, positives, auc: Math.round(a * 1000) / 1000 });
  if (a < 0.8) {
    log.error('train:connections — AUC gate failed, NOT deployed', { auc: a });
    process.exit(2);
  }
  const model: ConnectionsModel = { trainedAt: Date.now(), pairs: pairs.length, positives, auc: Math.round(a * 1000) / 1000, gbm };
  const dir = join(loadConfig().dataDir, 'models');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'connections-v1.json'), JSON.stringify(model));
  log.info('train:connections — deployed', { file: 'connections-v1.json' });
}

if (process.argv[1] && process.argv[1].endsWith('train-connections.ts')) main();
