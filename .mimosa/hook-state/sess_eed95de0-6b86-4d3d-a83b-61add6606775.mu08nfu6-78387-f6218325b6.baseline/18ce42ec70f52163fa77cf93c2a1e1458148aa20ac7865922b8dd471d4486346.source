/**
 * GTFS CLI: download the canonical Trenord GTFS zip and load it into the
 * schedule database.
 *
 *   npx tsx packages/gtfs/src/cli.ts [--fresh]
 */
import { loadConfig } from '#core/config.ts';
import { log } from '#core/log.ts';
import { loadGtfsZip } from './loader.ts';
import { ensureZip, openTrenoDb } from './setup.ts';

async function main() {
  const cfg = loadConfig();
  const fresh = process.argv.includes('--fresh');
  const zip = await ensureZip(cfg, fresh);
  const db = openTrenoDb(cfg);
  const result = loadGtfsZip(db, zip);
  console.log(JSON.stringify(result, null, 2));
  db.close();
}

main().catch((e) => {
  log.error('gtfs:cli failed', { error: String(e) });
  process.exit(1);
});
