/**
 * §82 railway reporting points backfill: rebuild rail_locations from the full
 * observation history in the local SQLite DB.
 *   npm run raillocations:backfill
 *
 * The table is cleared first, then rebuilt from a GROUP BY over
 * train_observations, so re-runs are idempotent (counts are set, not
 * accumulated). Passenger stations are detected by matching the reported
 * location ids and normalized names against gtfs_stops — matched rows are
 * typed PASSENGER_STATION and pick up the gtfs coordinates; everything else
 * is classified by name only (see railLocations.ts). Run while the collector
 * is stopped for exact counts; a live collector only skews them by the rows
 * it writes meanwhile.
 */
import { loadConfig } from '#core/config.ts';
import { log } from '#core/log.ts';
import { openTrenoDb } from '#gtfs/setup.ts';
import { getRows, type Db } from '#core/db.ts';
import {
  classifyLocationName,
  listRailLocations,
  normalizeLocationName,
  railLocationKey,
  upsertRailLocation,
  type RailLocationType,
} from '#storage/railLocations.ts';

interface GtfsMatch {
  lat: number | null;
  lon: number | null;
}

function main(): void {
  const cfg = loadConfig();
  const db = openTrenoDb(cfg);

  // gtfs lookup tables (a few hundred rows — trivially small, kept in memory);
  // match by reported location id first (providers reuse gtfs S-codes), then
  // by normalized name (same normalization both sides)
  const matchById = new Map<string, GtfsMatch>();
  const matchByNormName = new Map<string, GtfsMatch>();
  for (const s of getRows<{ stop_id: string; stop_name: string | null; stop_lat: number | null; stop_lon: number | null }>(
    db, 'SELECT stop_id, stop_name, stop_lat, stop_lon FROM gtfs_stops')) {
    const m: GtfsMatch = { lat: s.stop_lat, lon: s.stop_lon };
    matchById.set(s.stop_id, m);
    const norm = s.stop_name != null ? normalizeLocationName(s.stop_name) : '';
    if (norm !== '' && !matchByNormName.has(norm)) matchByNormName.set(norm, m);
  }
  const matchGtfs = (locationName: string, locationIds: Set<string> | undefined): GtfsMatch | null => {
    for (const id of locationIds ?? []) {
      const r = matchById.get(id);
      if (r) return r;
    }
    return matchByNormName.get(normalizeLocationName(locationName)) ?? null;
  };

  // distinct location ids reported per name (for the id-side gtfs match)
  const idsByName = new Map<string, Set<string>>();
  for (const r of getRows<{ location_name: string; location_id: string }>(
    db, 'SELECT DISTINCT location_name, location_id FROM train_observations WHERE location_id IS NOT NULL AND location_name IS NOT NULL')) {
    let s = idsByName.get(r.location_name);
    if (!s) idsByName.set(r.location_name, (s = new Set()));
    s.add(r.location_id);
  }

  db.exec('DELETE FROM rail_locations');
  const agg = getRows<{ location_name: string; first_seen: number; last_seen: number; c: number }>(
    db,
    `SELECT location_name,
            MIN(COALESCE(observed_at, ts)) AS first_seen,
            MAX(COALESCE(observed_at, ts)) AS last_seen,
            COUNT(*) AS c
     FROM train_observations
     WHERE location_name IS NOT NULL AND TRIM(location_name) != ''
     GROUP BY location_name`,
  );

  let matched = 0;
  for (const r of agg) {
    const m = matchGtfs(r.location_name, idsByName.get(r.location_name));
    if (m) matched++;
    const type: RailLocationType = m ? 'PASSENGER_STATION' : classifyLocationName(r.location_name);
    upsertRailLocation(db, {
      key: railLocationKey(r.location_name),
      name: r.location_name,
      type,
      lat: m?.lat ?? null,
      lon: m?.lon ?? null,
      firstSeen: r.first_seen,
      lastSeen: r.last_seen,
      observationCount: r.c,
    });
  }

  const rows = listRailLocations(db);
  const histogram = new Map<string, number>();
  let totalObs = 0;
  for (const row of rows) {
    histogram.set(row.type, (histogram.get(row.type) ?? 0) + 1);
    totalObs += row.observation_count;
  }
  const top = rows.slice(0, 10);
  const lines = [
    'rail-locations backfill (GOAL.md §82)',
    '  distinct location names aggregated: ' + agg.length,
    '  rail_locations rows (slug keys may merge spellings): ' + rows.length,
    '  gtfs stop matches (typed PASSENGER_STATION): ' + matched,
    '  sum(observation_count): ' + totalObs,
    '  type histogram: ' + [...histogram.entries()].map(([t, n]) => t + '=' + n).join(' '),
    '  top-10 by observation_count:',
    ...top.map((r, i) => '    ' + String(i + 1).padStart(2) + '. ' + r.name + ' [' + r.type + '] ' + r.observation_count + ' obs'),
  ];
  log.info('raillocations: backfill done', { rows: rows.length, matched });
  console.log(lines.join('\n'));
  db.close();
}

if (process.argv[1] && process.argv[1].endsWith('raillocations-backfill.ts')) {
  main();
}
