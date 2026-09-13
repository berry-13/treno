/**
 * Schedule queries over the canonical GTFS tables: which train runs are active
 * on a service date, their stop patterns, and station boards. Used by the
 * collector for run discovery and by the API.
 */
import { getRow, getRows, type Db } from '#core/db.ts';

export interface ActiveTrip {
  trip_id: string;
  route_id: string | null;
  route_type: number | null;
  train_number: string | null;
  origin_stop_id: string | null;
  destination_stop_id: string | null;
  dep_sec: number | null;
  arr_sec: number | null;
  stop_count: number | null;
  valid_from: string | null;
  valid_to: string | null;
}

function ymdToGtfsDate(ymd: string): string {
  return ymd.slice(0, 4) + ymd.slice(5, 7) + ymd.slice(8, 10);
}

/**
 * All trips scheduled on the given service date, deduplicated by train number
 * (the feed may contain several validity-window versions of the same train).
 * Preference: version whose validity window covers the date, then the one with
 * the latest valid_from.
 */
export function activeTripsOnDate(db: Db, ymd: string): ActiveTrip[] {
  const rows = getRows<ActiveTrip>(
    db,
    `SELECT s.trip_id, s.route_id, r.route_type, s.train_number, s.origin_stop_id, s.destination_stop_id,
       s.dep_sec, s.arr_sec, s.stop_count, s.valid_from, s.valid_to
     FROM gtfs_trip_summaries s
     JOIN gtfs_trips t ON t.trip_id = s.trip_id
     JOIN gtfs_routes r ON r.route_id = s.route_id
     JOIN gtfs_calendar_dates cd ON cd.service_id = t.service_id
     WHERE cd.date = ? AND cd.exception_type = 1`,
    [ymdToGtfsDate(ymd)],
  );
  const best = new Map<string, ActiveTrip>();
  for (const r of rows) {
    const key = r.train_number ?? r.trip_id;
    const cur = best.get(key);
    if (!cur) { best.set(key, r); continue; }
    const covers = (x: ActiveTrip): number =>
      (x.valid_from !== null && x.valid_from <= ymd && x.valid_to !== null && ymd <= x.valid_to) ? 1 : 0;
    const a = covers(r), b = covers(cur);
    if (a > b || (a === b && (r.valid_from ?? '') > (cur.valid_from ?? ''))) best.set(key, r);
  }
  return [...best.values()];
}

export interface TripStopTime {
  stop_sequence: number;
  stop_id: string;
  arrival_sec: number | null;
  departure_sec: number | null;
}

export function tripStopTimes(db: Db, tripId: string): TripStopTime[] {
  return getRows<TripStopTime>(
    db,
    'SELECT stop_sequence, stop_id, arrival_sec, departure_sec FROM gtfs_stop_times WHERE trip_id=? ORDER BY stop_sequence ASC',
    [tripId],
  );
}

export interface StopInfo {
  stop_id: string;
  stop_name: string;
  stop_lat: number | null;
  stop_lon: number | null;
}

export function stopById(db: Db, stopId: string): StopInfo | undefined {
  return getRow<StopInfo>(db, 'SELECT stop_id, stop_name, stop_lat, stop_lon FROM gtfs_stops WHERE stop_id=?', [stopId]);
}

export function searchStops(db: Db, q: string, limit = 20): StopInfo[] {
  return getRows<StopInfo>(
    db,
    'SELECT stop_id, stop_name, stop_lat, stop_lon FROM gtfs_stops WHERE stop_name LIKE ? ORDER BY stop_name LIMIT ?',
    ['%' + q.toUpperCase() + '%', limit],
  );
}

export interface StopDeparture extends ActiveTrip {
  stop_id: string;
  stop_sequence: number;
  departure_sec: number | null;
}

/** Departures from a stop on a service date within [fromSec, toSec] of the service day. */
export function stopDepartures(db: Db, stopId: string, ymd: string, fromSec: number, toSec: number): StopDeparture[] {
  const rows = getRows<StopDeparture>(
    db,
    `SELECT s.trip_id, s.route_id, s.train_number, s.origin_stop_id, s.destination_stop_id,
       s.dep_sec, s.arr_sec, s.stop_count, s.valid_from, s.valid_to,
       st.stop_id AS qstop_id, st.stop_sequence, st.departure_sec
     FROM gtfs_stop_times st
     JOIN gtfs_trip_summaries s ON s.trip_id = st.trip_id
     JOIN gtfs_trips t ON t.trip_id = st.trip_id
     JOIN gtfs_calendar_dates cd ON cd.service_id = t.service_id
     WHERE st.stop_id = ? AND cd.date = ? AND cd.exception_type = 1
       AND st.departure_sec IS NOT NULL AND st.departure_sec >= ? AND st.departure_sec <= ?
     ORDER BY st.departure_sec ASC`,
    [stopId, ymdToGtfsDate(ymd), fromSec, toSec],
  );
  // dedup by train number (validity-window overlaps)
  const best = new Map<string, StopDeparture>();
  for (const r of rows) {
    const key = r.train_number ?? r.trip_id;
    if (!best.has(key)) best.set(key, r);
  }
  return [...best.values()];
}

/** Map a query result row alias back (stopDepartures aliases qstop_id). */
export function normalizeDepartureRow(r: StopDeparture & { qstop_id?: string }): StopDeparture {
  return { ...r, stop_id: r.qstop_id ?? r.stop_id };
}

export function feedStatus(db: Db): { sha256: string; loaded_at: number; counts_json: string; feed_start: string | null; feed_end: string | null } | undefined {
  return getRow(db, 'SELECT sha256, loaded_at, counts_json, feed_start, feed_end FROM gtfs_feed_versions ORDER BY id DESC LIMIT 1');
}
