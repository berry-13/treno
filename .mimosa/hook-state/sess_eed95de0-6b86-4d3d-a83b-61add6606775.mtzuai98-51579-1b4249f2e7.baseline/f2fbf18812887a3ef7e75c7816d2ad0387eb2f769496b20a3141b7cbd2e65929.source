/**
 * Shared GTFS setup: locate/download the canonical zip and open the database
 * with schedule tables ensured. Used by the CLI and by the collector startup.
 */
import { existsSync, readFileSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, type Config } from '#core/config.ts';
import { openDb, type Db } from '#core/db.ts';
import { log } from '#core/log.ts';
import { ensureGtfsTables, loadGtfsZip } from './loader.ts';
import { ensureNormalizedTables } from '#storage/schema.ts';

const STALE_MS = 12 * 3600 * 1000;

export function dbPath(cfg: Config): string {
  return join(cfg.dataDir, 'db', 'treno.db');
}

export function openTrenoDb(cfg: Config): Db {
  mkdirSync(join(cfg.dataDir, 'db'), { recursive: true });
  const db = openDb(dbPath(cfg));
  ensureGtfsTables(db);
  ensureNormalizedTables(db);
  return db;
}

export async function ensureZip(cfg: Config, fresh: boolean): Promise<Uint8Array> {
  const dir = join(cfg.dataDir, 'gtfs');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'trenord_gtfs.zip');
  let needDownload = fresh || !existsSync(path);
  if (!needDownload) {
    const st = statSync(path);
    if (Date.now() - st.mtimeMs > STALE_MS) needDownload = true;
  }
  if (needDownload) {
    log.info('gtfs: downloading feed', { url: cfg.gtfsUrl });
    const res = await fetch(cfg.gtfsUrl, { headers: { 'user-agent': cfg.userAgent, accept: 'application/zip, */*' } });
    if (!res.ok) throw new Error('gtfs download failed: HTTP ' + String(res.status));
    const buf = new Uint8Array(await res.arrayBuffer());
    writeFileSync(path, buf);
    return buf;
  }
  return new Uint8Array(readFileSync(path));
}

/** Make sure a schedule is present and fresh enough; loads the feed if needed. */
export async function ensureScheduleLoaded(cfg: Config, db: Db): Promise<void> {
  const zip = await ensureZip(cfg, false);
  loadGtfsZip(db, zip);
}

export { loadConfig };
