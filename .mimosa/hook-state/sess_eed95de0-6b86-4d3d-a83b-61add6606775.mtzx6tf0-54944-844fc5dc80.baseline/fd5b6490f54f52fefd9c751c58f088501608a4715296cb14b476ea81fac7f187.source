/**
 * Run discovery (GOAL.md §64 step 2): from the canonical GTFS schedule, find
 * today's (and yesterday's still-running) train runs within the tracking
 * window and register canonical run rows. Watchlisted numbers are always
 * tracked even when absent from GTFS.
 */
import type { Db } from '#core/db.ts';
import { romeYmd, romeWallToEpoch, ymdPlusDays } from '#core/time.ts';
import { activeTripsOnDate } from '#gtfs/schedule.ts';
import { ensureRun } from '#storage/runs.ts';

export interface DiscoveredRun {
  runId: number;
  trainNumber: string;
  serviceDate: string;
  schedDepEpoch: number | null;
  schedArrEpoch: number | null;
  gtfsTripId: string | null;
}

/** Seconds elapsed since the given service date's midnight (may exceed 86400). */
export function secondsIntoServiceDay(serviceDate: string, nowMs = Date.now()): number {
  return Math.round((nowMs - romeWallToEpoch(serviceDate, 0)) / 1000);
}

/**
 * trip_short_name in this feed is "{line} - {number}" (e.g. "RE_11 - 2174");
 * providers are addressed by the bare train number.
 */
export function bareTrainNumber(tripShortName: string | null): string | null {
  if (tripShortName == null) return null;
  if (tripShortName.includes(' - ')) {
    const parts = tripShortName.split(' - ');
    const last = parts[parts.length - 1]!.trim();
    return last !== '' ? last : tripShortName;
  }
  return tripShortName;
}

export function discoverRuns(
  db: Db,
  opts: { maxRuns: number; lookaheadMin: number; graceMin: number },
  nowMs = Date.now(),
): DiscoveredRun[] {
  const today = romeYmd(nowMs);
  const dates = [today, ymdPlusDays(today, -1)];
  const found = new Map<string, DiscoveredRun>();

  for (const serviceDate of dates) {
    const nowSec = secondsIntoServiceDay(serviceDate, nowMs);
    const trips = activeTripsOnDate(db, serviceDate);
    for (const t of trips) {
      if (t.route_type != null && t.route_type !== 2) continue; // rail only for now
      if (t.dep_sec == null) continue;
      const number = bareTrainNumber(t.train_number);
      if (number == null) continue;
      const depWindowOk = t.dep_sec <= nowSec + opts.lookaheadMin * 60;
      const arrOk = t.arr_sec == null || nowSec <= t.arr_sec + opts.graceMin * 60;
      if (!depWindowOk || !arrOk) continue;
      const key = serviceDate + '|' + number;
      if (found.has(key)) continue;
      const runId = ensureRun(db, {
        operator: 'TRENORD',
        serviceDate,
        trainNumber: number,
        originStopId: t.origin_stop_id,
        schedDepSec: t.dep_sec,
        destinationStopId: t.destination_stop_id,
        schedArrSec: t.arr_sec,
        gtfsTripId: t.trip_id,
        routeId: t.route_id,
        source: 'gtfs',
      });
      found.set(key, {
        runId,
        trainNumber: number,
        serviceDate,
        schedDepEpoch: romeWallToEpoch(serviceDate, t.dep_sec),
        schedArrEpoch: t.arr_sec != null ? romeWallToEpoch(serviceDate, t.arr_sec) : null,
        gtfsTripId: t.trip_id,
      });
    }
  }

  const all = [...found.values()];
  if (all.length <= opts.maxRuns) return all;
  // prefer runs closest to departure (including already-departed/running)
  const nowToday = secondsIntoServiceDay(today, nowMs);
  all.sort((a, b) => {
    const da = a.serviceDate === today ? Math.abs((a.schedDepEpoch ?? 0) - nowMs) : Number.MAX_SAFE_INTEGER - 1;
    const dbv = b.serviceDate === today ? Math.abs((b.schedDepEpoch ?? 0) - nowMs) : Number.MAX_SAFE_INTEGER - 1;
    return da - dbv;
  });
  void nowToday;
  return all.slice(0, opts.maxRuns);
}
