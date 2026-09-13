/**
 * Retention (GOAL.md §43): raw snapshots age out first, normalized
 * observations later; completed outcomes and segment statistics are permanent.
 *
 *   npm run retain [-- --raw-days=45] [-- --obs-days=365]
 */
import { existsSync, readdirSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '#core/config.ts';
import { log } from '#core/log.ts';
import { openTrenoDb } from '#gtfs/setup.ts';

function arg(name: string, dflt: number): number {
  const a = process.argv.find((x) => x.startsWith('--' + name + '='));
  return a ? Number(a.split('=')[1]) : dflt;
}

function deleteStaleRawFiles(dataDir: string, days: number): number {
  const root = join(dataDir, 'raw');
  if (!existsSync(root)) return 0;
  const cutoff = Date.now() - days * 86400_000;
  let removed = 0;
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(p);
      } else if (statSync(p).mtimeMs < cutoff) {
        unlinkSync(p);
        removed++;
      }
    }
  };
  walk(root);
  // prune empty date partition dirs
  const prune = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const p = join(dir, entry.name);
      prune(p);
      if (readdirSync(p).length === 0) rmSync(p);
    }
  };
  prune(root);
  return removed;
}

async function main() {
  const cfg = loadConfig();
  const rawDays = arg('raw-days', 45);
  const obsDays = arg('obs-days', 365);
  const db = openTrenoDb(cfg);

  const cutoffRaw = Date.now() - rawDays * 86400_000;
  const r1 = db.prepare('DELETE FROM source_snapshots WHERE fetched_at < ?').run(cutoffRaw);
  const files = deleteStaleRawFiles(cfg.dataDir, rawDays);

  const cutoffObs = Date.now() - obsDays * 86400_000;
  const r2 = db.prepare('DELETE FROM train_observations WHERE ts < ?').run(cutoffObs);

  log.info('retain: done', {
    rawDays, snapshotsDeleted: Number(r1.changes), rawFilesDeleted: files,
    obsDays, observationsDeleted: Number(r2.changes),
    keptPermanent: 'predictions/outcomes/segment_stats/trip summaries',
  });
  db.close();
}

main().catch((e) => {
  log.error('retain: failed', { error: String(e) });
  process.exit(1);
});
