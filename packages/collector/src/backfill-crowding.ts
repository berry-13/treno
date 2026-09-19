/**
 * One-off crowding backfill (PLAN_complete_partials.md P1, GOAL.md §53):
 * re-parse retained raw MIA snapshots and stamp average_crowding onto the
 * observation rows that were recorded at fetch time.
 *   npx tsx packages/collector/src/backfill-crowding.ts
 *
 * Crowding only ever lived inside the raw payloads (the field was parsed but
 * not persisted before 2026-09-19) — offline reprocessing (GOAL.md §79) is the
 * only way to recover it. Rows are matched on (run_id, ts, source='mia') and
 * only filled when currently NULL, so the script is idempotent and never
 * overwrites live-collected values.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '#core/config.ts';
import { log } from '#core/log.ts';
import { openTrenoDb } from '#gtfs/setup.ts';
import { getRow } from '#core/db.ts';
import { readSnapshotJson } from '#storage/rawStore.ts';
import { runIdBySourceKey } from '#storage/runs.ts';
import { parseMiaTrain } from '#providers/mia.ts';

function main() {
  const cfg = loadConfig();
  const db = openTrenoDb(cfg);
  const stmt = db.prepare(
    'UPDATE train_observations SET crowding_pct=?, crowding_label=? WHERE run_id=? AND ts=? AND source=\'mia\' AND crowding_pct IS NULL',
  );
  const rows = db.prepare(
    'SELECT id, entity_key, fetched_at, path FROM source_snapshots WHERE source=\'mia\' AND changed=1 AND path IS NOT NULL AND error IS NULL ORDER BY fetched_at ASC',
  ).all() as Array<{ id: number; entity_key: string; fetched_at: number; path: string }>;
  let parsed = 0, withCrowding = 0, stamped = 0, skipped = 0;
  for (const r of rows) {
    let json: string;
    try {
      json = readSnapshotJson(cfg.dataDir, r.path);
    } catch {
      skipped++;
      continue;
    }
    const snap = parseMiaTrain(json);
    if (!snap) { skipped++; continue; }
    parsed++;
    if (snap.crowding == null) continue;
    withCrowding++;
    const runId = runIdBySourceKey(db, 'mia', snap.sourceKey);
    if (runId == null) { skipped++; continue; }
    const res = stmt.run(snap.crowding, snap.crowdingLabel, runId, r.fetched_at);
    stamped += Number(res.changes);
    if (parsed % 5000 === 0) log.info('backfill-crowding: progress', { parsed, stamped });
  }
  const finalCount = (getRow<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM train_observations WHERE crowding_pct IS NOT NULL') ?? { n: 0 }).n;
  const report = [
    '# treno crowding backfill',
    '',
    '- generated: ' + new Date().toISOString(),
    '- snapshots parsed: ' + parsed + ' (skipped ' + skipped + ')',
    '- snapshots carrying average_crowding: ' + withCrowding,
    '- observation rows stamped: ' + stamped,
    '- train_observations rows with crowding after backfill: ' + finalCount,
    '',
    'ClickHouse note: the CH crowding columns populate continuously from the',
    'post-2026-09-19 collector deploy onward; pre-deploy history stays in SQLite',
    '(the CH train_observations table is append-only MergeTree, so re-mirroring',
    'stamped rows would duplicate them).',
  ].join('\n');
  mkdirSync(join(cfg.dataDir, 'reports'), { recursive: true });
  writeFileSync(join(cfg.dataDir, 'reports', 'crowding-backfill.md'), report + '\n');
  console.log('\n' + report);
  db.close();
}

if (process.argv[1] && process.argv[1].endsWith('backfill-crowding.ts')) {
  main();
}
