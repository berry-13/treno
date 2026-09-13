/**
 * Collector entrypoint.
 *
 *   npx tsx packages/collector/src/index.ts [--watch=4307,2222] [--duration=SEC] [--once]
 *
 * Loads the schedule if needed, then runs the adaptive polling loop forever
 * (or for --duration seconds / a single pass with --once).
 */
import { loadConfig } from '#core/config.ts';
import { log } from '#core/log.ts';
import { ensureScheduleLoaded, openTrenoDb } from '#gtfs/setup.ts';
import { Collector } from './poller.ts';

function parseArgs(): { watch: string[]; durationSec: number | null; once: boolean } {
  const watch: string[] = [];
  let durationSec: number | null = null;
  let once = false;
  for (const a of process.argv.slice(2)) {
    if (a.startsWith('--watch=')) {
      for (const n of a.slice(8).split(',')) {
        const t = n.trim();
        if (t !== '') watch.push(t);
      }
    } else if (a.startsWith('--duration=')) {
      durationSec = Number(a.slice(11));
    } else if (a === '--once') {
      once = true;
    }
  }
  return { watch, durationSec, once };
}

async function main() {
  const { watch, durationSec, once } = parseArgs();
  const cfg = loadConfig();
  log.info('collector: starting', { dataDir: cfg.dataDir, watch, ua: cfg.userAgent });
  const db = openTrenoDb(cfg);
  await ensureScheduleLoaded(cfg, db);

  const collector = new Collector(db, cfg, watch);
  if (once) {
    await collector.runOnce();
    await new Promise((r) => setTimeout(r, 30_000));
    await collector.runOnce();
    log.info('collector: once pass complete', { tracked: collector.trackedCount() });
    db.close();
    return;
  }
  collector.start();
  const shutdown = () => {
    log.info('collector: shutting down', { tracked: collector.trackedCount() });
    collector.stop();
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  if (durationSec != null) {
    setTimeout(shutdown, durationSec * 1000);
  }
}

main().catch((e) => {
  log.error('collector: fatal', { error: String(e) });
  process.exit(1);
});
