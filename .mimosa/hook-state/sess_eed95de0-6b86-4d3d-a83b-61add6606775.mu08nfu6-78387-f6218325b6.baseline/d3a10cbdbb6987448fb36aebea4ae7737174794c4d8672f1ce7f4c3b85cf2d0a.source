/**
 * One-off backfill: derive segment observations from every run that already
 * has actual stop events (retroactively populates segment_stats from
 * collected history), then refresh the stats table.
 *
 *   npx tsx packages/collector/src/backfill-segments.ts
 */
import { loadConfig } from '#core/config.ts';
import { log } from '#core/log.ts';
import { openTrenoDb } from '#gtfs/setup.ts';
import { getRows } from '#core/db.ts';
import { deriveSegmentObservations, refreshSegmentStats, logSegmentSummary } from '#storage/segments.ts';

async function main() {
  const cfg = loadConfig();
  const db = openTrenoDb(cfg);
  const runs = getRows<{ id: number; service_date: string; source: string | null }>(
    db,
    'SELECT r.id, r.service_date, r.first_seen_source AS source FROM train_runs r WHERE EXISTS (SELECT 1 FROM train_stop_events e WHERE e.run_id = r.id AND e.actual_arr_epoch IS NOT NULL)',
  );
  log.info('backfill: runs with actuals', { runs: runs.length });
  db.exec('BEGIN');
  try {
    let total = 0;
    for (const r of runs) {
      total += deriveSegmentObservations(db, r.id, r.service_date, r.source ?? 'backfill');
    }
    db.exec('COMMIT');
    log.info('backfill: derived', { segmentObservations: total });
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  const stats = refreshSegmentStats(db);
  logSegmentSummary(db);
  log.info('backfill: stats refreshed', stats);
  db.close();
}

main().catch((e) => {
  log.error('backfill: failed', { error: String(e) });
  process.exit(1);
});
