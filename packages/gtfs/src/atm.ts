/**
 * ATM Milano static GTFS loader (GOAL.md §26, PLAN_next_frontiers F1).
 * Loads the Comune di Milano feed into SEPARATE prefixed tables (atm_stops,
 * atm_routes, atm_trips, atm_stop_times, atm_calendar_dates) — the rail tables
 * stay pure Trenord-GTFS (GOAL §8) and the two networks never mix rows.
 *
 * Downloading lives in providers/atm.ts (fetchAtmGtfsZip — the official
 * fixed literal open-data URL); this module only parses and loads bytes.
 * Runs as `npm run gtfs:atm`, or automatically from the collector
 * maintenance tick — a failed download degrades to rail-only.
 */
import { createHash } from 'node:crypto';
import { unzipSync, strFromU8 } from 'fflate';
import { getRow, getRows, runStmt, type Db } from '#core/db.ts';
import { log } from '#core/log.ts';
import { table } from './csv.ts';

function hmsToSec(v: string | undefined): number | null {
  if (!v) return null;
  const parts = v.split(':');
  if (parts.length < 2) return null;
  const h = Number(parts[0]); const m = Number(parts[1]); const s = parts.length > 2 ? Number(parts[2]) : 0;
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return h * 3600 + m * 60 + (Number.isFinite(s) ? s : 0);
}

export function ensureAtmTables(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS atm_feed_versions(
  id INTEGER PRIMARY KEY, sha256 TEXT NOT NULL, loaded_at INTEGER NOT NULL, counts_json TEXT)`);
  db.exec(`CREATE TABLE IF NOT EXISTS atm_stops(
  stop_id TEXT PRIMARY KEY, stop_name TEXT, stop_lat REAL, stop_lon REAL)`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_atm_stops_name ON atm_stops(stop_name)');
  db.exec(`CREATE TABLE IF NOT EXISTS atm_routes(
  route_id TEXT PRIMARY KEY, route_short_name TEXT, route_long_name TEXT, route_type INTEGER)`);
  db.exec(`CREATE TABLE IF NOT EXISTS atm_trips(
  trip_id TEXT PRIMARY KEY, route_id TEXT, service_id TEXT)`);
  db.exec(`CREATE TABLE IF NOT EXISTS atm_stop_times(
  trip_id TEXT NOT NULL, stop_sequence INTEGER NOT NULL, stop_id TEXT NOT NULL,
  arrival_sec INTEGER, departure_sec INTEGER,
  PRIMARY KEY(trip_id, stop_sequence)) WITHOUT ROWID`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_atm_st_times_stop ON atm_stop_times(stop_id, departure_sec)');
  db.exec(`CREATE TABLE IF NOT EXISTS atm_calendar_dates(
  service_id TEXT NOT NULL, date TEXT NOT NULL, exception_type INTEGER,
  PRIMARY KEY(service_id, date)) WITHOUT ROWID`);
}

function clearAtmTables(db: Db): void {
  db.exec('DELETE FROM atm_feed_versions');
  db.exec('DELETE FROM atm_stops');
  db.exec('DELETE FROM atm_routes');
  db.exec('DELETE FROM atm_trips');
  db.exec('DELETE FROM atm_stop_times');
  db.exec('DELETE FROM atm_calendar_dates');
}

/** Load an ATM GTFS zip (raw bytes) into the prefixed tables.
 *
 * Memory-bounded (issue #2): the ATM feed is ~324 MB uncompressed
 * (stop_times.txt alone is 286 MB / 2.7 M rows), so this NEVER holds the
 * full feed as a JS string or a materialized row array. Members are
 * decompressed selectively via the unzip filter (shapes.txt is never
 * inflated), small files reuse the CSV table path, and stop_times.txt is
 * scanned from its Uint8Array in chunks — one row string at a time —
 * inserting as we go inside the transaction. Peak ≈ zip + largest member
 * buffer instead of zip + every member + full string + all rows.
 */
export function loadAtmGtfsZip(db: Db, zipBytes: Uint8Array): { sha256: string; counts: Record<string, number> } {
  const sha256 = createHash('sha256').update(zipBytes).digest('hex');
  ensureAtmTables(db);
  const prev = getRow<{ sha256: string; counts_json: string }>(db, 'SELECT sha256, counts_json FROM atm_feed_versions ORDER BY id DESC LIMIT 1');
  if (prev && prev.sha256 === sha256) {
    return { sha256, counts: JSON.parse(prev.counts_json) as Record<string, number> };
  }
  const counts: Record<string, number> = {};
  const SMALL_FILES = ['stops.txt', 'routes.txt', 'trips.txt', 'calendar.txt', 'calendar_dates.txt'];
  // pass 1: small members only (a few MB each) — shapes.txt etc. stay deflated
  const small = unzipSync(zipBytes, { filter: (f) => SMALL_FILES.includes(f.name) });
  const read = (name: string): string => {
    const f = small[name];
    if (!f) throw new Error('atm gtfs zip missing file: ' + name);
    return strFromU8(f);
  };
  db.exec('BEGIN');
  try {
    clearAtmTables(db);
    { // stops
      const t = table(read('stops.txt'));
      const iId = t.indexOf('stop_id'), iName = t.indexOf('stop_name'), iLat = t.indexOf('stop_lat'), iLon = t.indexOf('stop_lon');
      const stmt = db.prepare('INSERT OR REPLACE INTO atm_stops VALUES(?,?,?,?)');
      for (const r of t.rows) {
        runStmt(stmt, [r[iId!] ?? '', r[iName!] ?? null, iLat != null ? Number(r[iLat]) : null, iLon != null ? Number(r[iLon]) : null]);
      }
      counts.stops = t.rows.length;
    }
    { // routes
      const t = table(read('routes.txt'));
      const iId = t.indexOf('route_id'), iSn = t.indexOf('route_short_name'), iLn = t.indexOf('route_long_name'), iTy = t.indexOf('route_type');
      const stmt = db.prepare('INSERT OR REPLACE INTO atm_routes VALUES(?,?,?,?)');
      for (const r of t.rows) {
        runStmt(stmt, [r[iId!] ?? '', iSn != null ? (r[iSn] ?? null) : null, iLn != null ? (r[iLn] ?? null) : null, iTy != null ? Number(r[iTy]) : null]);
      }
      counts.routes = t.rows.length;
    }
    { // trips — ATM feed has no trip_short_name; identity is trip_id
      const t = table(read('trips.txt'));
      const iId = t.indexOf('trip_id'), iRoute = t.indexOf('route_id'), iSvc = t.indexOf('service_id');
      const stmt = db.prepare('INSERT OR REPLACE INTO atm_trips VALUES(?,?,?)');
      for (const r of t.rows) {
        runStmt(stmt, [r[iId!] ?? '', r[iRoute!] ?? null, r[iSvc!] ?? null]);
      }
      counts.trips = t.rows.length;
    }
    { // stop_times — streamed, never materialized as rows
      const st = unzipSync(zipBytes, { filter: (f) => f.name === 'stop_times.txt' })['stop_times.txt'];
      if (!st) throw new Error('atm gtfs zip missing file: stop_times.txt');
      const stmt = db.prepare('INSERT OR REPLACE INTO atm_stop_times VALUES(?,?,?,?,?)');
      let n = 0;
      let skippedQuoted = 0;
      let headerSeen = false;
      streamCsvRows(st, (fields) => {
        if (!headerSeen) { headerSeen = true; return; } // header row
        // stop_times has no quoted fields by spec — a stray quote means a
        // malformed line, skip it
        if (fields.some((v) => v.includes('"'))) { skippedQuoted++; return; }
        if (fields.length < 4) return;
        const [tripId, arr, dep, stopId, seq] = fields;
        runStmt(stmt, [tripId ?? '', Number(seq ?? '0'), stopId ?? '', hmsToSec(arr), hmsToSec(dep)]);
        n++;
      });
      counts.stop_times = n;
      if (skippedQuoted > 0) log.warn('atm gtfs: skipped malformed stop_times lines', { skippedQuoted });
    }
    { // calendar — ATM publishes calendar.txt (Mon..Sun flags over a window)
      // plus optional calendar_dates.txt exceptions
      const cal = small['calendar.txt'];
      if (cal) {
        const t = table(strFromU8(cal));
        const iSvc = t.indexOf('service_id'), iStart = t.indexOf('start_date'), iEnd = t.indexOf('end_date');
        const flags = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map((f) => t.indexOf(f));
        const stmt = db.prepare('INSERT OR REPLACE INTO atm_calendar_dates VALUES(?,?,?)');
        const dayMs = 86400_000;
        const parseGtfsDate = (d: string): number => Date.parse(d.slice(0, 4) + '-' + d.slice(4, 6) + '-' + d.slice(6, 8) + 'T00:00:00Z');
        for (const r of t.rows) {
          const svc = r[iSvc!] ?? '';
          const start = iStart != null ? r[iStart] : null;
          const end = iEnd != null ? r[iEnd] : null;
          if (start == null || end == null || !flags.every((i) => i != null)) continue;
          for (let ts = parseGtfsDate(start); ts <= parseGtfsDate(end); ts += dayMs) {
            const dow = (new Date(ts).getUTCDay() + 6) % 7; // monday=0
            if (r[flags[dow]!] === '1') {
              runStmt(stmt, [svc, new Date(ts).toISOString().slice(0, 10).replace(/-/g, ''), 1]);
            }
          }
        }
      }
      const cd = small['calendar_dates.txt'];
      if (cd) {
        const t = table(strFromU8(cd));
        const iSvc = t.indexOf('service_id'), iDate = t.indexOf('date'), iEx = t.indexOf('exception_type');
        const stmt = db.prepare('INSERT OR REPLACE INTO atm_calendar_dates VALUES(?,?,?)');
        for (const r of t.rows) {
          runStmt(stmt, [r[iSvc!] ?? '', r[iDate!] ?? '', iEx != null ? Number(r[iEx]) : 1]);
        }
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  runStmt(db.prepare('INSERT INTO atm_feed_versions(sha256, loaded_at, counts_json) VALUES(?,?,?)'), [sha256, Date.now(), JSON.stringify(counts)]);
  log.info('atm gtfs: loaded', { sha256: sha256.slice(0, 12), ...counts });
  return { sha256, counts };
}

/** Incrementally parse CSV out of a UTF-8 Uint8Array with full quoted-field
 * semantics ("" escapes) — the ATM feed quotes every field. Chunked decode
 * with parser state carried across chunk boundaries, so no full-file JS
 * string or row array is ever built (issue #2). Same field rules as
 * csv.ts parseCsv, streaming instead of materializing. */
function streamCsvRows(u8: Uint8Array, onRow: (fields: string[]) => void): void {
  const dec = new TextDecoder('utf-8');
  const CHUNK = 1 << 20; // 1 MB
  let fields: string[] = [];
  let field = '';
  let inQuotes = false;
  let started = false; // any payload char seen on the current row
  let first = true;
  const emit = () => {
    if (fields.length > 0 || field !== '' || started) {
      fields.push(field);
      if (first) {
        first = false;
        fields[0] = (fields[0] ?? '').replace(/^\uFEFF/, '');
      }
      onRow(fields);
    }
    fields = [];
    field = '';
    started = false;
  };
  for (let off = 0; off < u8.length; off += CHUNK) {
    const slice = u8.subarray(off, Math.min(off + CHUNK, u8.length));
    const text = dec.decode(slice, { stream: off + CHUNK < u8.length });
    for (let i = 0; i < text.length; i++) {
      const c = text[i]!;
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else inQuotes = false;
        } else {
          field += c;
        }
      } else if (c === '"') {
        inQuotes = true;
        started = true;
      } else if (c === ',') {
        fields.push(field);
        field = '';
      } else if (c === '\r') {
        // ignore; \n terminates the row
      } else if (c === '\n') {
        emit();
      } else {
        field += c;
        started = true;
      }
    }
  }
  emit(); // final row without trailing newline
}

/** Download (24h cache) + load. The feed URL is read from the environment
 * inside the provider (validated + host-allowlisted there); this module
 * never sees or passes a URL. */
export async function ensureAtmSchedule(dataDir: string, db: Db, userAgent: string, cachePath: string): Promise<boolean> {
  const { existsSync, readFileSync, statSync, writeFileSync, mkdirSync } = await import('node:fs');
  const { join } = await import('node:path');
  mkdirSync(join(dataDir, 'gtfs'), { recursive: true });
  const { fetchAtmGtfsZip } = await import('#providers/atm.ts');
  let needDownload = !existsSync(cachePath);
  if (!needDownload && Date.now() - statSync(cachePath).mtimeMs > 24 * 3600_000) needDownload = true;
  let buf: Uint8Array;
  if (needDownload) {
    const downloaded = await fetchAtmGtfsZip(userAgent);
    if (downloaded == null) {
      log.warn('atm gtfs: no feed url configured or download rejected — staying rail-only');
      return false;
    }
    buf = downloaded;
    writeFileSync(cachePath, buf);
  } else {
    buf = new Uint8Array(readFileSync(cachePath));
  }
  try {
    loadAtmGtfsZip(db, buf);
    return true;
  } catch (e) {
    log.warn('atm gtfs: load failed — staying rail-only', { error: String(e) });
    return false;
  }
}

// MARK: - queries

export interface AtmStopInfo {
  stop_id: string;
  stop_name: string;
  stop_lat: number | null;
  stop_lon: number | null;
}

export function atmSearchStops(db: Db, q: string, limit = 20): AtmStopInfo[] {
  return getRows<AtmStopInfo>(
    db,
    'SELECT stop_id, stop_name, stop_lat, stop_lon FROM atm_stops WHERE stop_name LIKE ? ORDER BY stop_name LIMIT ?',
    ['%' + q.toUpperCase() + '%', limit],
  );
}

export function atmStopById(db: Db, stopId: string): AtmStopInfo | undefined {
  return getRow<AtmStopInfo>(db, 'SELECT stop_id, stop_name, stop_lat, stop_lon FROM atm_stops WHERE stop_id=?', [stopId]);
}

export interface AtmDeparture {
  route_short_name: string | null;
  route_type: number | null;
  destination_name: string | null;
  departure_sec: number | null;
}

/** Scheduled ATM departures from a stop on a service date, [fromSec, toSec]. */
export function atmStopDepartures(db: Db, stopId: string, ymd: string, fromSec: number, toSec: number, limit = 40): AtmDeparture[] {
  const gtfsDate = ymd.slice(0, 4) + ymd.slice(5, 7) + ymd.slice(8, 10);
  return getRows<AtmDeparture>(
    db,
    `SELECT r.route_short_name, r.route_type, ds.stop_name AS destination_name, st.departure_sec
     FROM atm_stop_times st
     JOIN atm_trips t ON t.trip_id = st.trip_id
     JOIN atm_calendar_dates cd ON cd.service_id = t.service_id
     JOIN atm_routes r ON r.route_id = t.route_id
     LEFT JOIN atm_stops ds ON ds.stop_id = (SELECT s2.stop_id FROM atm_stop_times s2 WHERE s2.trip_id = st.trip_id ORDER BY s2.stop_sequence DESC LIMIT 1)
     WHERE st.stop_id = ? AND cd.date = ? AND cd.exception_type = 1
       AND st.departure_sec IS NOT NULL AND st.departure_sec >= ? AND st.departure_sec <= ?
     ORDER BY st.departure_sec ASC
     LIMIT ?`,
    [stopId, gtfsDate, fromSec, toSec, limit],
  );
}

// standalone: npx tsx packages/gtfs/src/atm.ts
// (opens the DB directly — importing ./setup.ts here would create a cycle,
// since setup.ts statically imports this module for ensureAtmTables)
if (process.argv[1] && process.argv[1].endsWith('atm.ts')) {
  const { loadConfig } = await import('#core/config.ts');
  const { openDb } = await import('#core/db.ts');
  const { join } = await import('node:path');
  const { mkdirSync } = await import('node:fs');
  const cfg = loadConfig();
  mkdirSync(join(cfg.dataDir, 'db'), { recursive: true });
  const db = openDb(join(cfg.dataDir, 'db', 'treno.db'));
  ensureAtmTables(db);
  const ok = await ensureAtmSchedule(cfg.dataDir, db, cfg.userAgent, join(cfg.dataDir, 'gtfs', 'atm_gtfs.zip'));
  db.close();
  if (!ok) {
    log.error('atm gtfs: download failed');
    process.exit(1);
  }
}
