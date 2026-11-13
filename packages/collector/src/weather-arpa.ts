/**
 * ARPA Lombardia rain-gauge actuals (§roadmap #4): measured precipitation
 * from the regional sensor network, preferred over forecast models when
 * available. Socrata API on dati.lombardia.it, no token for reads.
 * If discovery/reads fail, features stay null and we log once — no fakes.
 *
 * STATUS 2026-09-14: readings dataset verified live (i95f-5avh, 10-min
 * cadence, fresh today). Remaining: sensor→station geo join via the
 * '4wxn-35av' station registry to pick sensors near rail corridors —
 * then wire gaugePrecipMm() into heuristic features (precipGaugeMm).
 */
import { log } from '#core/log.ts';

const STATIONS = ['my9y-8ykb']; // Stazioni Meteorologiche provincia Milano (has tipologia+location, verified)
const READINGS = ['i95f-5avh']; // Dati sensori meteo (verified live)
const NEAR: Array<{ lat: number; lon: number }> = [
  { lat: 45.46, lon: 9.19 }, { lat: 45.58, lon: 9.27 }, { lat: 45.54, lon: 10.21 }, { lat: 45.82, lon: 8.82 },
];

let cached: { at: number; mm: number | null } = { at: 0, mm: null };
let warned = false;
// non-2xx statuses seen during the current refresh, logged with its summary
let httpErrors: number[] = [];

export function gaugePrecipMm(): number | null {
  return Date.now() - cached.at < 3600_000 ? cached.mm : null;
}

async function get(url: string): Promise<unknown | null> {
  try {
    const r = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) {
      httpErrors.push(r.status);
      return null;
    }
    return await r.json();
  } catch {
    return null;
  }
}

// refreshGauges() is called from every maintenance tick (~5 s): without a
// gate that was ~100k Socrata requests/day. Readings are on a 10-min cadence,
// so refresh at most every 10 min, never concurrently; the station->sensor
// lookup changes rarely and is cached for 24 h.
const GAUGE_TTL_MS = 10 * 60_000;
const SENSOR_TTL_MS = 24 * 3600_000;
let inflight = false;
let lastAttemptAt = 0;
let sensorCache: { at: number; ids: string[] } | null = null;

export async function refreshGauges(): Promise<void> {
  const now = Date.now();
  if (inflight || now - lastAttemptAt < GAUGE_TTL_MS) return;
  inflight = true;
  lastAttemptAt = now;
  try {
    await doRefreshGauges(now);
  } finally {
    inflight = false;
  }
}

async function nearbySensors(now: number): Promise<string[]> {
  if (sensorCache && sensorCache.ids.length > 0 && now - sensorCache.at < SENSOR_TTL_MS) return sensorCache.ids;
  // resolve precipitation sensors near our corridors from station metadata
  const where = NEAR.map((p) => `within_circle(location,${p.lat},${p.lon},15000)`).join(' OR ');
  const st = (await get(`https://www.dati.lombardia.it/resource/${STATIONS[0]}.json?$where=${encodeURIComponent(where)}&$limit=200`)) as Array<{ idsensore?: string; tipologia?: string; location?: { coordinates?: number[] } }> | null;
  const ids = (st ?? []).filter((s) => (s.tipologia ?? '').toLowerCase().includes('precip')).map((s) => s.idsensore).filter(Boolean).slice(0, 12) as string[];
  if (ids.length > 0) sensorCache = { at: now, ids };
  return ids;
}

async function doRefreshGauges(now: number): Promise<void> {
  httpErrors = [];
  const sensors = await nearbySensors(now);
  if (sensors.length === 0) {
    if (!warned) { log.warn('arpa: no precipitation sensors found (dataset ids may have moved)'); warned = true; }
    cached = { at: Date.now(), mm: null };
    return;
  }
  const vals: number[] = [];
  for (const id of sensors) {
    for (const ds of READINGS) {
      const rows = (await get(`https://www.dati.lombardia.it/resource/${ds}.json?idsensore=${id}&$order=data%20DESC&$limit=2`)) as Array<{ valore?: string }> | null;
      const v = rows?.[0]?.valore;
      const num = v != null ? Number(v) : NaN;
      if (Number.isFinite(num) && num >= 0) { vals.push(num); break; } // ARPA uses -999 as no-data sentinel
    }
  }
  cached = { at: Date.now(), mm: vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100 : null };
  if (httpErrors.length > 0) log.warn('arpa: some requests failed', { statuses: [...new Set(httpErrors)], failed: httpErrors.length });
  log.info('arpa gauges refreshed', { mm: cached.mm, sensors: vals.length });
}
