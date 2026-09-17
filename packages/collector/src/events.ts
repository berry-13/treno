/**
 * Exogenous calendar: strikes, stadium events, holidays (GOAL.md §51 context).
 *
 * Three importers, all polite and re-runnable:
 *  - stadium fixtures from ESPN's keyless scoreboard (one fetch/day covering
 *    ±3 days) for matches at San Siro — the single biggest recurring crowd
 *    event on the Lombardy rail network;
 *  - strikes from a curated file at <dataDir>/calendar/strikes.json (Italian
 *    rail strikes are filed ≥10 days ahead; the official portal has no API and
 *    is unreachable from many hosts, so a hand-maintained file is the honest
 *    source — see deploy/calendar/strikes.template.json);
 *  - Italian holidays computed locally (no fetch).
 *
 * Event features are read from calendar_events at prediction time — never from
 * in-memory state — so recorded features are point-in-time correct.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getRow, getRows, type Db } from '#core/db.ts';
import { loadConfig } from '#core/config.ts';
import { log } from '#core/log.ts';

const REFRESH_MS = 24 * 3600_000;
const UA = 'treno-collector/1.0 (+github.com/berry-13/treno; transit research, one fetch per day)';

/** venues whose events stress the rail network; stations = where crowd loads land */
const VENUES: Array<{ name: string; teams: string[]; stations: string[]; windowBeforeMs: number; windowAfterMs: number }> = [
  {
    name: 'San Siro',
    // ESPN team displayName contains the club name; both Milan clubs play there
    teams: ['inter', 'milan'],
    // Milano Porta Garibaldi, Cadorna, Bovisa, Centrale, Villapizzone
    stations: ['S01645', 'S01066', 'S01642', 'S01700', 'S01609'],
    windowBeforeMs: 3 * 3600_000,
    windowAfterMs: 2 * 3600_000,
  },
];

interface CalendarEventRow {
  source: string;
  external_id: string;
  kind: 'strike' | 'stadium' | 'holiday';
  title: string | null;
  start_epoch: number;
  end_epoch: number;
  scope: 'network' | 'stations';
  stations_csv: string | null;
}

let lastRefresh = 0;

function upsert(db: Db, e: CalendarEventRow): void {
  db.prepare(
    `INSERT INTO calendar_events(source, external_id, kind, title, start_epoch, end_epoch, scope, stations_csv, created_at)
     VALUES(?,?,?,?,?,?,?,?,?)
     ON CONFLICT(source, external_id) DO UPDATE SET title=excluded.title, start_epoch=excluded.start_epoch, end_epoch=excluded.end_epoch, scope=excluded.scope, stations_csv=excluded.stations_csv`,
  ).run(e.source, e.external_id, e.kind, e.title, e.start_epoch, e.end_epoch, e.scope, e.stations_csv, Date.now());
}

/** Daily refresh — safe to call from every maintenance tick (self-gated). */
export async function refreshCalendar(db: Db): Promise<void> {
  if (Date.now() - lastRefresh < REFRESH_MS) return;
  lastRefresh = Date.now();
  try {
    importHolidays(db);
    await importStadiumFixtures(db);
    importStrikesFile(db);
  } catch (e) {
    log.warn('events: calendar refresh failed', { error: String(e) });
  }
}

// ---------------------------------------------------------------- holidays

function easterSunday(year: number): Date {
  // Anonymous Gregorian algorithm
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
}

function italianHolidays(year: number): Array<{ date: string; name: string }> {
  const out: Array<{ date: string; name: string }> = [];
  const fixed: Array<[number, number, string]> = [
    [1, 1, 'New Year'], [1, 6, 'Epiphany'], [4, 25, 'Liberation Day'], [5, 1, 'Labour Day'],
    [6, 2, 'Republic Day'], [8, 15, 'Ferragosto'], [11, 1, 'All Saints'], [12, 8, 'Immaculate Conception'],
    [12, 25, 'Christmas'], [12, 26, 'St Stephen'],
  ];
  for (const [m, d, name] of fixed) out.push({ date: `${year}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`, name });
  const easter = easterSunday(year);
  const fmt = (dt: Date) => dt.toISOString().slice(0, 10);
  out.push({ date: fmt(easter), name: 'Easter' });
  const monday = new Date(easter.getTime() + 86400_000);
  out.push({ date: fmt(monday), name: 'Easter Monday' });
  return out;
}

function importHolidays(db: Db): void {
  const y = new Date().getUTCFullYear();
  for (const year of [y, y + 1]) {
    for (const h of italianHolidays(year)) {
      const start = Date.parse(h.date + 'T00:00:00+02:00'); // Rome-anchored midnight (CET; ±1h irrelevant for a day-long flag)
      upsert(db, {
        source: 'computed', external_id: 'holiday-' + h.date, kind: 'holiday', title: h.name,
        start_epoch: start, end_epoch: start + 86400_000, scope: 'network', stations_csv: null,
      });
    }
  }
}

// ---------------------------------------------------------------- stadium

interface EspnEvent { id: string; date: string; name: string; competitions: Array<{ competitors: Array<{ homeAway: string; team: { displayName: string } }> }> }

async function importStadiumFixtures(db: Db): Promise<void> {
  // one fetch per league covering yesterday..+3 days (kickoff times can move)
  const dates = [-1, 0, 1, 2, 3].map((d) => {
    const dt = new Date(Date.now() + d * 86400_000);
    return `${dt.getUTCFullYear()}${String(dt.getUTCMonth() + 1).padStart(2, '0')}${String(dt.getUTCDate()).padStart(2, '0')}`;
  });
  const leagues = ['soccer/ita.1', 'soccer/uefa.champions', 'soccer/uefa.europa'];
  for (const league of leagues) {
    for (const date of dates) {
      const url = `https://site.api.espn.com/apis/site/v2/sports/${league}/scoreboard?dates=${date}`;
      const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
      if (!res.ok) { log.warn('events: espn fetch failed', { league, date, status: res.status }); continue; }
      const data = await res.json() as { events?: EspnEvent[] };
      for (const ev of data.events ?? []) {
        const comp = ev.competitions?.[0];
        const home = comp?.competitors?.find((c) => c.homeAway === 'home')?.team.displayName ?? '';
        const homeLower = home.toLowerCase();
        for (const venue of VENUES) {
          if (!venue.teams.some((t) => homeLower.includes(t))) continue;
          const start = Date.parse(ev.date);
          if (!Number.isFinite(start)) continue;
          upsert(db, {
            source: 'espn', external_id: ev.id, kind: 'stadium',
            title: ev.name + ' — ' + venue.name,
            start_epoch: start - venue.windowBeforeMs, end_epoch: start + venue.windowAfterMs,
            scope: 'stations', stations_csv: venue.stations.join(','),
          });
        }
      }
    }
  }
}

// ---------------------------------------------------------------- strikes

interface StrikeFileEntry { start: string; end: string; title?: string; scope?: 'network' | 'stations'; stations?: string[] }

function importStrikesFile(db: Db): void {
  const file = join(loadConfig().dataDir, 'calendar', 'strikes.json');
  if (!existsSync(file)) return;
  let parsed: StrikeFileEntry[];
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8')) as StrikeFileEntry[];
  } catch (e) {
    log.warn('events: strikes.json is not valid JSON', { error: String(e) });
    return;
  }
  for (const [i, s] of parsed.entries()) {
    const start = Date.parse(s.start), end = Date.parse(s.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      log.warn('events: skipping malformed strike entry', { index: i });
      continue;
    }
    const scope = s.scope === 'stations' ? 'stations' : 'network';
    upsert(db, {
      source: 'curated', external_id: 'strike-' + s.start + '-' + String(i), kind: 'strike',
      title: s.title ?? 'Rail strike', start_epoch: start, end_epoch: end,
      scope, stations_csv: scope === 'stations' ? (s.stations ?? []).join(',') || null : null,
    });
  }
}

// ---------------------------------------------------------------- features

export interface EventFeatures {
  /** a strike window is active or starts within 3h (0/1, null = no data) */
  strikeActive: number | null;
  /** signed hours to the nearest strike/stadium event start (negative = ongoing), capped ±24 */
  eventHoursToStart: number | null;
  holiday: 0 | 1;
}

/** Point-in-time event context for a run — read from calendar_events, so
 *  predictions recorded at any moment match what was knowable then. */
export function eventFeatures(db: Db, serviceDate: string, routeStopIds: string[]): EventFeatures {
  const now = Date.now();
  const rows = getRows<{ kind: string; start_epoch: number; end_epoch: number; scope: string; stations_csv: string | null }>(
    db,
    "SELECT kind, start_epoch, end_epoch, scope, stations_csv FROM calendar_events WHERE kind != 'holiday' AND end_epoch >= ? - 3600_000 AND start_epoch <= ? + 24*3600_000",
    [now, now],
  );
  const route = new Set(routeStopIds);
  const relevant = rows.filter((r) => r.scope === 'network'
    || (r.stations_csv ?? '').split(',').some((s) => s !== '' && route.has(s)));
  let strikeActive: number | null = null;
  let nearest: number | null = null;
  for (const r of relevant) {
    const ongoing = now >= r.start_epoch && now <= r.end_epoch;
    if (r.kind === 'strike' && (ongoing || r.start_epoch - now <= 3 * 3600_000)) strikeActive = 1;
    const dHours = (r.start_epoch - now) / 3600_000;
    if (dHours <= 24 && (nearest == null || Math.abs(dHours) < Math.abs(nearest))) nearest = dHours;
  }
  const holiday = (getRow<{ n: number }>(
    db,
    "SELECT COUNT(*) AS n FROM calendar_events WHERE kind='holiday' AND start_epoch <= ? AND end_epoch > ?",
    [now, now],
  ) ?? { n: 0 }).n > 0 ? 1 : 0;
  // holiday is about the SERVICE day, not the wall clock (post-midnight runs)
  const serviceDayIsHoliday = (getRow<{ n: number }>(
    db,
    "SELECT COUNT(*) AS n FROM calendar_events WHERE kind='holiday' AND date(start_epoch/1000, 'unixepoch', '+2 hours') = ?",
    [serviceDate],
  ) ?? { n: 0 }).n > 0 ? 1 : 0;
  return {
    strikeActive,
    eventHoursToStart: nearest != null ? Math.round(nearest * 10) / 10 : null,
    holiday: (holiday || serviceDayIsHoliday) as 0 | 1,
  };
}

export interface UpstreamFeatures {
  /** worst departure delay observed at the next stop in the last 45 min (sec) */
  upstreamStopMaxDelaySec: number | null;
  /** how many trains left the next stop ≥5 min late in the last 45 min */
  upstreamStopDelayedCount: number | null;
}

/** §51 propagation signal: the delay queue at the stop this run is about to
 *  reach — knock-on congestion shows up here before it shows up in this
 *  train's own operator ETA. */
export function upstreamFeatures(db: Db, nextStopId: string | null): UpstreamFeatures {
  if (!nextStopId) return { upstreamStopMaxDelaySec: null, upstreamStopDelayedCount: null };
  const since = Date.now() - 45 * 60_000;
  const r = getRow<{ mx: number | null; n: number }>(
    db,
    'SELECT MAX(dep_delay_sec) AS mx, SUM(CASE WHEN dep_delay_sec >= 300 THEN 1 ELSE 0 END) AS n FROM train_stop_events WHERE stop_id=? AND actual_dep_epoch >= ? AND dep_delay_sec IS NOT NULL',
    [nextStopId, since],
  );
  if (!r || r.mx == null) return { upstreamStopMaxDelaySec: null, upstreamStopDelayedCount: null };
  return { upstreamStopMaxDelaySec: r.mx, upstreamStopDelayedCount: r.n ?? 0 };
}

// standalone import: npx tsx packages/collector/src/events.ts
if (process.argv[1] && process.argv[1].endsWith('events.ts')) {
  void (async () => {
    const { openTrenoDb } = await import('#gtfs/setup.ts');
    const cfg = loadConfig();
    const db = openTrenoDb(cfg);
    await refreshCalendar(db);
    const n = (getRow<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM calendar_events') ?? { n: 0 }).n;
    log.info('events: calendar import complete', { total: n });
    db.close();
  })();
}
