/**
 * §45 quality-flag backfill: reprocess every observation and stop-event row
 * in the local DB through the full rule set and overwrite quality_flags in
 * place.
 *
 *   npm run quality:backfill            # recompute + report per-flag counts
 *   npm run quality:backfill -- --verify  # run twice, assert the 2nd pass updates 0 rows
 *
 * Deterministic: flags are a pure function of the stored rows, so repeating
 * the backfill rewrites identical values (obsUpdated=0 / stopUpdated=0 on the
 * second pass — what --verify asserts). SQLite-only by design: the
 * ClickHouse train_observations mirror is an append-only MergeTree, so
 * re-mirroring historical rows would duplicate them; CH keeps receiving
 * insert-time flags (OUT_OF_ORDER / STALE_SOURCE / DELAY_JUMP) for new rows
 * from the collector deploy onward.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '#core/config.ts';
import { log } from '#core/log.ts';
import { openTrenoDb } from '#gtfs/setup.ts';
import { countFlagsInDb, QUALITY_FLAGS, recomputeAllQuality } from '#storage/quality.ts';

function main(): void {
  const verify = process.argv.includes('--verify');
  const db = openTrenoDb(loadConfig());
  log.info('quality-backfill: starting');
  const s = recomputeAllQuality(db, {
    onProgress: (done, total) => log.info('quality-backfill: progress', { done, total }),
  });

  const counts = countFlagsInDb(db);
  let verifyLine = '- verify: not requested';
  if (verify) {
    const second = recomputeAllQuality(db);
    const idempotent = second.obsUpdated === 0 && second.stopUpdated === 0;
    verifyLine = '- verify: second pass updated ' + second.obsUpdated + ' obs / '
      + second.stopUpdated + ' stop rows — ' + (idempotent ? 'IDEMPOTENT' : 'NOT IDEMPOTENT');
  }

  const pct = (n: number): string => (s.obsRows > 0 ? ((100 * n) / s.obsRows).toFixed(2) : '0') + '%';
  const lines = [
    '# treno data-quality backfill (GOAL.md §45)',
    '',
    '- generated: ' + new Date().toISOString(),
    '- runs processed: ' + s.runs,
    '- train_observations rows: ' + s.obsRows + ' (flagged: ' + s.obsFlaggedRows + ', ' + pct(s.obsFlaggedRows) + '; updated this pass: ' + s.obsUpdated + ')',
    '- train_stop_events rows: ' + s.stopRows + ' (flagged: ' + s.stopFlaggedRows + '; updated this pass: ' + s.stopUpdated + ')',
    '- elapsed: ' + Math.round(s.elapsedMs / 1000) + 's',
    '',
    '## per-flag counts (train_observations)',
    '',
    ...QUALITY_FLAGS.map((f) => '- ' + f + ': ' + (counts.obsFlagCounts[f] ?? 0)),
    '',
    '## per-flag counts (train_stop_events)',
    '',
    ...QUALITY_FLAGS.map((f) => '- ' + f + ': ' + (counts.stopFlagCounts[f] ?? 0)),
    '',
    verifyLine,
    '',
    'Flags are stored as a JSON string array in quality_flags (the same format',
    'the insert path writes). Anomalies are flagged, never discarded.',
  ];
  const report = lines.join('\n');
  const cfg = loadConfig();
  mkdirSync(join(cfg.dataDir, 'reports'), { recursive: true });
  writeFileSync(join(cfg.dataDir, 'reports', 'quality-backfill.md'), report + '\n');
  console.log('\n' + report);
  db.close();
}

if (process.argv[1] && process.argv[1].endsWith('quality-backfill.ts')) {
  main();
}
