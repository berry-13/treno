/**
 * Railway reporting points (GOAL.md §82): locations providers report trains
 * at that are NOT passenger stops — 'Bivio Casirate', 'PM Albate',
 * 'DEV. ESTR. ROGOREDO', border points, ... — kept as a first-class entity
 * separate from gtfs_stops so train localization (§83) can reason about the
 * non-passenger railway geography.
 *
 * DESIGN CHOICE — passenger stations ARE recorded here. gtfs_stops remains
 * their canonical home (schedules, boards); rail_locations is the
 * observation-driven registry of every location name ever seen in
 * train_observations. A location whose reported id or normalized name matches
 * a gtfs stop is typed PASSENGER_STATION (and picks up that stop's
 * coordinates); the gtfs reference itself is NOT stored as a column — the
 * §82 schema is fixed and the match is cheaply recoverable by re-joining
 * location ids / normalized names against gtfs_stops.
 *
 * Coordinates: NULL unless already known offline (i.e. gtfs_stops lat/lon for
 * matched stations). No geocoding, scraping or API calls — NULLs stay NULL.
 *
 * ClickHouse: the mirror table DDL lives in
 * deploy/clickhouse-init/01_tables.sql (house rule) but rows are not mirrored
 * from here yet — SQLite is the operational truth; a ch:backfill pass can
 * populate the analytical side later if §83 needs it.
 *
 * first_seen / last_seen use the observation's effective time
 * (observed_at when the provider states one, else the fetch ts) — the same
 * expression the backfill aggregates over, so live stats and backfilled
 * stats agree.
 */
import { getRows, runStmt, type Db } from '#core/db.ts';

export type RailLocationType =
  | 'PASSENGER_STATION'
  | 'JUNCTION'
  | 'BIVIO'
  | 'CONTROL_POINT'
  | 'UNKNOWN_REPORTING_POINT';

/**
 * Stable primary key for a location name: lowercase, hyphen-separated slug.
 * 'BIVIO/PC SESIA' → 'bivio-pc-sesia'; 'Bivio Casirate' and 'BIVIO CASIRATE'
 * collapse to the same key (that is the point — providers spell the same
 * point inconsistently). Names with no alphanumerics at all ('--') fall back
 * to 'unnamed' so the PRIMARY KEY is never empty.
 */
export function railLocationKey(name: string): string {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug === '' ? 'unnamed' : slug;
}

/**
 * Pure name-based classification (§82), deliberately conservative and
 * offline-only: 'bivio' → BIVIO; 'diramazione'/'giunzione' → JUNCTION;
 * anything else → UNKNOWN_REPORTING_POINT. PASSENGER_STATION is never
 * produced here — it only comes from a gtfs stop match, and CONTROL_POINT
 * (PM/PC posts) is reserved for a future, more confident classifier.
 */
export function classifyLocationName(name: string): RailLocationType {
  const n = name.toLowerCase();
  if (n.includes('bivio')) return 'BIVIO';
  if (n.includes('diramazione') || n.includes('giunzione')) return 'JUNCTION';
  return 'UNKNOWN_REPORTING_POINT';
}

/**
 * Normalized form used to compare provider location names with gtfs stop
 * names: casefolded, accents stripped, non-alphanumerics collapsed to spaces
 * ('COMO S.GIOVANNI' ≡ 'Como S. Giovanni').
 */
export function normalizeLocationName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
}

export interface RailLocationUpsert {
  key: string;
  name: string;
  /** Omit to derive from `name` via classifyLocationName (never downgrades an existing PASSENGER_STATION). */
  type?: RailLocationType | null;
  lat?: number | null;
  lon?: number | null;
  /** Observation effective time in epoch ms; widens both first_seen and last_seen (live hook path). */
  seenAt?: number | null;
  /** Explicit window in epoch ms (backfill aggregate path); takes precedence over seenAt. */
  firstSeen?: number | null;
  lastSeen?: number | null;
  /** Defaults to 1 (one observation); the backfill passes the aggregated count. */
  observationCount?: number | null;
}

/**
 * Upsert one rail_locations row. Pure DB access, no provider logic. Merge
 * semantics on conflict: type only moves when the caller asserts one (and a
 * confirmed PASSENGER_STATION is never demoted to UNKNOWN_REPORTING_POINT by
 * the name classifier), coordinates are only ever filled (never nulled),
 * first_seen/last_seen widen, observation_count accumulates.
 */
export function upsertRailLocation(db: Db, u: RailLocationUpsert): void {
  const first = u.firstSeen ?? u.seenAt ?? null;
  const last = u.lastSeen ?? u.seenAt ?? null;
  runStmt(
    db.prepare(`INSERT INTO rail_locations(key, name, type, lat, lon, first_seen, last_seen, observation_count, updated_at)
VALUES(?,?,?,?,?,?,?,?,?)
ON CONFLICT(key) DO UPDATE SET
  type=CASE
    WHEN excluded.type IS NULL THEN rail_locations.type
    WHEN rail_locations.type='PASSENGER_STATION' AND excluded.type='UNKNOWN_REPORTING_POINT' THEN rail_locations.type
    ELSE excluded.type END,
  lat=COALESCE(excluded.lat, rail_locations.lat),
  lon=COALESCE(excluded.lon, rail_locations.lon),
  first_seen=CASE WHEN rail_locations.first_seen IS NULL OR excluded.first_seen < rail_locations.first_seen THEN excluded.first_seen ELSE rail_locations.first_seen END,
  last_seen=CASE WHEN rail_locations.last_seen IS NULL OR excluded.last_seen > rail_locations.last_seen THEN excluded.last_seen ELSE rail_locations.last_seen END,
  observation_count=COALESCE(rail_locations.observation_count,0)+COALESCE(excluded.observation_count,0),
  updated_at=COALESCE(excluded.updated_at, rail_locations.updated_at)`),
    [u.key, u.name, u.type ?? classifyLocationName(u.name), u.lat ?? null, u.lon ?? null,
     first, last, u.observationCount ?? 1, Date.now()],
  );
}

/** Row shape returned by listRailLocations — stable for downstream consumers (§83 graph inference reads this defensively). */
export interface RailLocationRow {
  key: string;
  name: string | null;
  type: string;
  lat: number | null;
  lon: number | null;
  first_seen: number | null;
  last_seen: number | null;
  observation_count: number;
  updated_at: number | null;
}

/** All rail locations, heaviest evidence first. Explicit column list so added columns never surprise readers. */
export function listRailLocations(db: Db): RailLocationRow[] {
  return getRows<RailLocationRow>(
    db,
    'SELECT key, name, type, lat, lon, first_seen, last_seen, observation_count, updated_at FROM rail_locations ORDER BY observation_count DESC, key ASC',
  );
}
