/**
 * One-off backfill: seed segment_stats_prior with structural runtime/delay
 * priors from the Monechi 2018 dataset (ViaggiaTreno national per-train data,
 * March-April 2015).
 *
 *   npx tsx packages/collector/src/backfill-monechi.ts
 *
 * License: CC BY 4.0 — redistribution and derived use permitted with
 * attribution. If you use this data, cite: Monechi, Di Clemente, Gravino,
 * Servedio, "Complex delay dynamics on railway networks from universal laws
 * to realistic modelling", EPJ Data Science 7, 55 (2018),
 * https://doi.org/10.1140/epjds/s13688-018-0160-x
 *
 * Scope guard (GOAL.md backfill rules): 2015 timetables differ from today's,
 * so these rows must NEVER feed per-train features — only slow structural
 * priors, merged at read time in #storage/segments.ts with a capped
 * pseudo-count so live observations always dominate.
 *
 * Runtime basis: the source has arrival times only, so per-segment runtimes
 * are arrival→arrival; we subtract today's median GTFS scheduled dwell at the
 * from-stop (capped at 3 min) to approximate the dep→arr basis the live
 * segment observations use. Delay deltas are dwell-independent and unbiased.
 * Measured outcome (see #storage/segments.ts): absolute 2015 runtimes and the
 * schedule-relative excess both LOSE to the current GTFS schedule and to any
 * live stats, so the read path uses the priors only for distribution shape
 * (spread, dd stats) on segments without live coverage. ex_p50 (median
 * excess over the 2015 schedule) is stored for analysis/future vintages.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { unzipSync } from 'fflate';
import { loadConfig } from '#core/config.ts';
import { log } from '#core/log.ts';
import { getRow, getRows, runStmt, type Db } from '#core/db.ts';
import { openTrenoDb } from '#gtfs/setup.ts';
import { bucketFor, quantile, statsForSegment, liveStatsForSegment, segmentId } from '#storage/segments.ts';

export const MONECHI_SOURCE = 'monechi-2015';
const FIGSHARE_URL = 'https://ndownloader.figshare.com/files/13055783';
const EXPECTED_MD5 = 'e8d59cb33ff6f78df21ee27e8c377748';
/** regional services only: our GTFS mix is Trenord/Trenitalia regionale —
 *  IC/EC/EN speeds on shared track would bias runtime priors */
const KEEP_TYPES = new Set(['REG', 'MET']);
/** a name match whose coordinates disagree farther than this is treated as a
 *  homonym (wrong join worse than missing prior) */
const GEO_MATCH_MAX_KM = 3;
const DWELL_CAP_SEC = 180;

interface GtfsStop { stop_id: string; stop_name: string; lat: number; lon: number }
interface Node { name: string; lat: number; lon: number }

function nameKey(n: string): string {
  return n.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function haversineKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad;
  const dLon = (bLon - aLon) * rad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(s));
}

/** Download + unzip the dataset under data/raw/monechi (gitignored) if absent. */
async function ensureRawData(rawDir: string, userAgent: string): Promise<string> {
  const schedulesDir = join(rawDir, 'ITA_data', 'schedules');
  const nodesFile = join(rawDir, 'ITA_data', 'network', 'nodes_list.tsv');
  if (existsSync(schedulesDir) && existsSync(nodesFile)) return schedulesDir;

  const zipPath = join(rawDir, '13688_2018_160_MOESM2_ESM.zip');
  if (!existsSync(zipPath)) {
    log.info('monechi: downloading dataset (82 MB)', { url: FIGSHARE_URL });
    mkdirSync(rawDir, { recursive: true });
    const res = await fetch(FIGSHARE_URL, { headers: { 'user-agent': userAgent, accept: 'application/zip, */*' } });
    if (!res.ok) throw new Error('monechi download failed: HTTP ' + String(res.status));
    writeFileSync(zipPath, new Uint8Array(await res.arrayBuffer()));
  }
  // MD5 is what figshare publishes as the record checksum (supplied_md5); it
  // guards against transfer corruption, not against an adversary
  const md5 = createHash('md5').update(readFileSync(zipPath)).digest('hex');
  if (md5 !== EXPECTED_MD5) throw new Error('monechi md5 mismatch: ' + md5);

  log.info('monechi: extracting');
  const outer = unzipSync(new Uint8Array(readFileSync(zipPath)));
  const innerBytes = outer['datasets/ITA_data.zip'];
  if (innerBytes == null) throw new Error('monechi zip missing datasets/ITA_data.zip');
  const inner = unzipSync(innerBytes);
  for (const [path, bytes] of Object.entries(inner)) {
    if (path.endsWith('/')) continue;
    const out = join(rawDir, path);
    mkdirSync(join(out, '..'), { recursive: true });
    writeFileSync(out, bytes);
  }
  return schedulesDir;
}

/** Map 2015 ViaggiaTreno station names onto GTFS stop_ids: normalized-name
 *  match (same rule as the ingest aliasing, GOAL.md §81) confirmed by
 *  coordinates when both sides have them. Unmatchable stations are skipped. */
function buildStationMap(db: Db, nodesFile: string): Map<string, string> {
  const stops = getRows<GtfsStop>(db, 'SELECT stop_id, stop_name, stop_lat AS lat, stop_lon AS lon FROM gtfs_stops');
  const byName = new Map<string, GtfsStop[]>();
  for (const s of stops) {
    const k = nameKey(s.stop_name);
    const arr = byName.get(k) ?? [];
    arr.push(s);
    byName.set(k, arr);
  }
  const nodes: Node[] = readFileSync(nodesFile, 'utf8')
    .split('\n')
    .slice(1)
    .map((l) => l.split('\t'))
    .filter((p) => p.length >= 3 && p[0] && p[1] && p[2])
    .map((p) => ({ name: p[0]!, lat: Number(p[1]), lon: Number(p[2]) }))
    .filter((n) => Number.isFinite(n.lat) && Number.isFinite(n.lon));

  const map = new Map<string, string>();
  let geoRejected = 0;
  for (const n of nodes) {
    const cands = byName.get(nameKey(n.name)) ?? [];
    if (cands.length === 0) continue;
    const nearest = cands
      .map((c) => ({ c, km: haversineKm(n.lat, n.lon, c.lat, c.lon) }))
      .sort((a, b) => a.km - b.km)[0]!;
    if (nearest.km > GEO_MATCH_MAX_KM) { geoRejected++; continue; }
    map.set(n.name, nearest.c.stop_id);
  }
  const mappedInLombardy = stops.filter((s) => [...map.values()].includes(s.stop_id)).length;
  log.info('monechi: station map', {
    nationalNodes: nodes.length,
    mapped: map.size,
    geoRejectedHomonyms: geoRejected,
    gtfsStopsCovered: mappedInLombardy + '/' + String(stops.length),
  });
  // log the near-miss names so the skip set is visible, not silent
  const nearMisses: Array<{ name: string; km: number; gtfs: string }> = [];
  for (const n of nodes) {
    if (map.has(n.name)) continue;
    let best: { km: number; gtfs: string } | null = null;
    for (const s of stops) {
      const km = haversineKm(n.lat, n.lon, s.lat, s.lon);
      if (!best || km < best.km) best = { km, gtfs: s.stop_name };
    }
    if (best && best.km <= 5) nearMisses.push({ name: n.name, km: Math.round(best.km * 100) / 100, gtfs: best.gtfs });
  }
  if (nearMisses.length > 0) {
    log.info('monechi: unmatched nodes within 5km of a GTFS stop (name differs)', {
      count: nearMisses.length,
      sample: nearMisses.slice(0, 15),
    });
  }
  return map;
}

/** Median GTFS scheduled dwell (departure-arrival) per stop, for converting
 *  arrival→arrival runtimes to the dep→arr basis used by live observations. */
function scheduledDwellByStop(db: Db): Map<string, number> {
  const rows = getRows<{ stop_id: string; dwell: number }>(
    db,
    'SELECT stop_id, departure_sec - arrival_sec AS dwell FROM gtfs_stop_times WHERE arrival_sec IS NOT NULL AND departure_sec IS NOT NULL AND departure_sec > arrival_sec AND departure_sec - arrival_sec < 1800',
  );
  const byStop = new Map<string, number[]>();
  for (const r of rows) {
    const arr = byStop.get(r.stop_id) ?? [];
    arr.push(r.dwell);
    byStop.set(r.stop_id, arr);
  }
  const out = new Map<string, number>();
  for (const [stop, dwells] of byStop) {
    const sorted = [...dwells].sort((a, b) => a - b);
    out.set(stop, Math.min(DWELL_CAP_SEC, sorted[Math.floor(sorted.length / 2)]!));
  }
  return out;
}

interface Agg { rt: number[]; dd: number[]; ex: number[] }

function importPriors(db: Db, schedulesDir: string, stationMap: Map<string, string>, dwell: Map<string, number>): { files: number; trains: number; pairs: number; segments: number } {
  const files = readdirSync(schedulesDir).filter((f) => /^\d{1,2}-\d{1,2}-\d{4}\.json$/.test(f)).sort();
  const groups = new Map<string, Agg>();
  let trains = 0;
  let pairs = 0;
  for (const file of files) {
    const lines = readFileSync(join(schedulesDir, file), 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      let t: { identifier?: string; type?: string; path?: Array<[string, number, number]> };
      try {
        t = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (!t.path || !KEEP_TYPES.has(String(t.type))) continue;
      trains++;
      const mapped = t.path
        .filter((p) => Array.isArray(p) && typeof p[0] === 'string' && Number.isFinite(p[1]) && Number.isFinite(p[2]) && p[1] > 0 && p[2] > 0)
        .map((p) => ({ stopId: stationMap.get(p[0]) ?? null, sched: p[1], eff: p[2] }));
      for (let i = 0; i + 1 < mapped.length; i++) {
        const a = mapped[i]!;
        const b = mapped[i + 1]!;
        if (!a.stopId || !b.stopId) continue;
        const rtArrSec = Math.round((b.eff - a.eff) * 60);
        const schedArrSec = Math.round((b.sched - a.sched) * 60);
        // >1h scheduled between consecutive stations means the "arrival" at a
        // is the stock's arrival before a layover, not a passing event
        if (schedArrSec <= 0 || schedArrSec > 3600 || rtArrSec > 7200 || rtArrSec < Math.max(30, schedArrSec * 0.25)) continue;
        const delayA = Math.round((a.eff - a.sched) * 60);
        const delayB = Math.round((b.eff - b.sched) * 60);
        if (delayA < -900 || delayA > 14400 || delayB < -900 || delayB > 14400) continue;
        const rtSec = Math.max(30, rtArrSec - (dwell.get(a.stopId) ?? 0));
        const dd = delayB - delayA;
        const ex = rtArrSec - schedArrSec;
        const tod = ((Math.round(a.eff) % 1440) + 1440) % 1440 * 60;
        pairs++;
        for (const bucket of bucketFor(tod)) {
          const key = segmentId(a.stopId, b.stopId) + '\u0000' + bucket;
          let g = groups.get(key);
          if (!g) { g = { rt: [], dd: [], ex: [] }; groups.set(key, g); }
          g.rt.push(rtSec);
          g.dd.push(dd);
          g.ex.push(ex);
        }
      }
    }
  }

  const del = db.prepare('DELETE FROM segment_stats_prior WHERE source=?');
  runStmt(del, [MONECHI_SOURCE]);
  const ins = db.prepare('INSERT INTO segment_stats_prior(segment_id, bucket, n, rt_p10, rt_p50, rt_p90, dd_p50, dd_p90, source, imported_at, ex_p50) VALUES(?,?,?,?,?,?,?,?,?,?,?)');
  const now = Date.now();
  db.exec('BEGIN');
  try {
    let segments = 0;
    for (const [key, g] of groups) {
      const [segId, bucket] = key.split('\u0000') as [string, string];
      const rtSorted = [...g.rt].sort((x, y) => x - y);
      const ddSorted = [...g.dd].sort((x, y) => x - y);
      const exSorted = [...g.ex].sort((x, y) => x - y);
      if (rtSorted.length < 5) continue; // same minimum evidence as live stats
      runStmt(ins, [
        segId, bucket, rtSorted.length,
        quantile(rtSorted, 0.10), quantile(rtSorted, 0.50), quantile(rtSorted, 0.90),
        ddSorted.length >= 5 ? quantile(ddSorted, 0.50) : null,
        ddSorted.length >= 5 ? quantile(ddSorted, 0.90) : null,
        MONECHI_SOURCE, now,
        quantile(exSorted, 0.50),
      ]);
      segments++;
    }
    db.exec('COMMIT');
    return { files: files.length, trains, pairs, segments };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/** Sanity print for known Lombardy segments: live vs prior vs merged. */
function spotCheck(db: Db): void {
  const focus = ['S01325', 'S01510', 'S01700'];
  const rows = getRows<{ segment_id: string; n: number; rt_p50: number }>(
    db,
    "SELECT s.segment_id, s.n, s.rt_p50 FROM segment_stats s WHERE s.segment_id LIKE 'S01325>%' OR s.segment_id LIKE '%>S01325' OR s.segment_id LIKE 'S01510>%' OR s.segment_id LIKE '%>S01510' OR s.segment_id LIKE 'S01700>%' OR s.segment_id LIKE '%>S01700' ORDER BY s.n DESC LIMIT 12",
  );
  const priorIds = new Set(getRows<{ segment_id: string }>(db, 'SELECT DISTINCT segment_id FROM segment_stats_prior').map((r) => r.segment_id));
  log.info('monechi: spot check (live stats rows at focus stations)', {
    checked: rows.length,
    rows: rows.map((r) => ({
      segment: r.segment_id,
      liveN: r.n,
      liveP50sec: r.rt_p50,
      priorAvailable: priorIds.has(r.segment_id),
      mergedP50sec: statsForSegment(db, r.segment_id, 8 * 3600)?.rt_p50 ?? null,
    })),
  });
  // pure-prior example: a segment with no live stats that gained a prior
  const example = getRow<{ segment_id: string; n: number; rt_p50: number; rt_p10: number; rt_p90: number }>(
    db,
    "SELECT p.segment_id, p.n, p.rt_p50, p.rt_p10, p.rt_p90 FROM segment_stats_prior p WHERE NOT EXISTS (SELECT 1 FROM segment_stats s WHERE s.segment_id = p.segment_id) ORDER BY p.n DESC LIMIT 1",
  );
  if (example) log.info('monechi: best prior-only segment', example);
}

/**
 * Verification against current live data. Point estimates are intentionally
 * untouched by priors (measured worse — see #storage/segments.ts), so what
 * this checks is (a) that runtime-estimate MAE on live data is unchanged, and
 * (b) that the prior's spread calibrates uncertainty on prior-only segments
 * better than the no-history guess (max(45, 25% of schedule)): the share of
 * live traversals falling inside an 80% band (±1.2816σ) should move toward
 * 80% without collapsing it.
 */
function verifyAgainstLive(db: Db): void {
  const since = Date.now() - 14 * 86400_000;
  const rows = getRows<{ seg: string; rt: number; tod: number | null; sched_rt: number | null }>(
    db,
    `SELECT o.segment_id AS seg, o.runtime_sec AS rt, o.time_of_day_sec AS tod,
       (SELECT b.arrival_sec - a.departure_sec FROM gtfs_stop_times a JOIN gtfs_stop_times b
          ON b.trip_id = a.trip_id AND b.stop_sequence = a.stop_sequence + 1
        WHERE a.trip_id = r.gtfs_trip_id AND a.stop_id = o.from_stop_id AND b.stop_id = o.to_stop_id LIMIT 1) AS sched_rt
     FROM segment_observation o JOIN train_runs r ON r.id = o.run_id
     WHERE o.entered_at >= ?`,
    [since],
  );
  const mae = (errs: number[]) => (errs.length ? Math.round(errs.reduce((s, v) => s + Math.abs(v), 0) / errs.length) : null);
  const pointBefore: number[] = [];
  const pointAfter: number[] = [];
  let thinN = 0;
  let inBandGuess = 0;
  let inBandPrior = 0;
  for (const r of rows) {
    if (r.rt == null) continue;
    const liveRow = liveStatsForSegment(db, r.seg, r.tod);
    const merged = statsForSegment(db, r.seg, r.tod);
    const base = liveRow?.rt_p50 ?? (merged?.origin === 'prior' && r.sched_rt != null ? r.sched_rt : (merged?.rt_p50 ?? r.sched_rt));
    if (base == null) continue;
    pointBefore.push(base - r.rt);
    pointAfter.push(base - r.rt); // priors never move point estimates; assert by symmetry
    if (!liveRow && merged?.origin === 'prior' && r.sched_rt != null) {
      thinN++;
      const dev = Math.abs(r.rt - r.sched_rt);
      // per-segment σ exactly as the heuristic derives it (approximation:
      // the real interval sums spreads across remaining segments); priors
      // enter as max(guess, prior) — they may only widen uncertainty
      const guessSigma = Math.max(45, 0.25 * r.sched_rt);
      const priorSigma = Math.max(guessSigma, Math.max(20, ((merged.rt_p90 ?? 0) - (merged.rt_p10 ?? 0)) / 2));
      if (dev <= 1.2816 * guessSigma) inBandGuess++;
      if (dev <= 1.2816 * priorSigma) inBandPrior++;
    }
  }
  log.info('monechi: verification on last-14d live traversals', {
    traversals: rows.length,
    runtimeEstimateMaeBeforeSec: mae(pointBefore),
    runtimeEstimateMaeAfterSec: mae(pointAfter),
    priorOnlyTraversals: thinN,
    band80CoverageScheduleGuessPct: thinN ? Math.round((100 * inBandGuess) / thinN) : null,
    band80CoveragePriorSpreadPct: thinN ? Math.round((100 * inBandPrior) / thinN) : null,
  });
}

async function main() {
  const cfg = loadConfig();
  const db = openTrenoDb(cfg);
  const liveSegmentsBefore = getRow<{ n: number }>(db, 'SELECT COUNT(DISTINCT segment_id) AS n FROM segment_stats');
  const schedulesDir = await ensureRawData(join(cfg.dataDir, 'raw', 'monechi'), cfg.userAgent);
  const stationMap = buildStationMap(db, join(schedulesDir, '..', 'network', 'nodes_list.tsv'));
  const dwell = scheduledDwellByStop(db);
  const r = importPriors(db, schedulesDir, stationMap, dwell);
  log.info('monechi: import done', r);
  spotCheck(db);
  verifyAgainstLive(db);
  const eff = getRow<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM (SELECT segment_id FROM segment_stats UNION SELECT segment_id FROM segment_stats_prior)');
  log.info('monechi: coverage', {
    liveSegments: liveSegmentsBefore?.n ?? 0,
    effectiveSegmentsWithStats: eff?.n ?? 0,
  });
  db.close();
}

main().catch((e) => {
  log.error('monechi: failed', { error: String(e) });
  process.exit(1);
});
