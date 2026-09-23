/**
 * Direct-journey planning over the canonical GTFS tables: trains that call at
 * the origin and then the destination, within a forward time window, each
 * fused with live state (delay, platform, our estimate).
 *
 * §19/§62 smart alternatives: options are ranked by expected REAL arrival
 * (live/predicted estimate when one exists, scheduled as fallback) plus a
 * risk penalty for shaky legs — never by scheduled arrival alone. The best
 * still-catchable option carries `recommended: true`.
 */
import { getRow, getRows, type Db } from '#core/db.ts';
import { romeYmd, romeWallToEpoch, ymdPlusDays } from '#core/time.ts';
import { bareTrainNumber, secondsIntoServiceDay } from '#collector/discover.ts';

export interface JourneyRow {
  runId: number | null;
  trainNumber: string;
  line: string | null;
  originName: string | null;
  destinationName: string | null;
  finalDestinationName: string | null;
  depEpoch: number;
  arrEpoch: number;
  depDelaySec: number | null;
  actualDepEpoch: number | null;
  platform: string | null;
  state: unknown;
  // §19/§62 ranking (additive) — expectedArrivalEpoch is the scored expected
  // actual arrival at the destination stop (== arrEpoch when not predictable;
  // expectedArrivalLive says which), riskPenaltySec the §19 risk term, and
  // recommended flags the best still-catchable option by ranked order.
  expectedArrivalEpoch: number;
  expectedArrivalLive: boolean;
  riskPenaltySec: number | null;
  recommended: boolean;
}

/** What the fused state carries for ranking (shape of train_state.state_json). */
interface StateForRanking {
  status?: string;
  operatorDelaySec?: number | null;
  schedArrEpoch?: number | null;
  ourEstimate?: { p10?: number; p50?: number; p90?: number } | null;
}

/** §19 risk term: how shaky this leg's arrival is. The p90 tail of our own
 *  arrival distribution is the single-leg analogue of a shaky connection —
 *  the §18 connection model consumes this same spread (connectionOptions),
 *  and per-connection probabilities slot into this penalty unchanged once
 *  journeys gain transfers. */
function riskPenaltySecOf(state: StateForRanking | null): number | null {
  const p50 = state?.ourEstimate?.p50;
  const p90 = state?.ourEstimate?.p90;
  if (p50 == null || p90 == null) return null;
  return Math.min(300, Math.round(0.2 * ((p90 - p50) / 1000)));
}

interface LegQuery {
  trip_id: string;
  train_number: string | null;
  line_name: string | null;
  final_destination_name: string | null;
  from_dep_sec: number;
  to_arr_sec: number;
}

function legsForDay(db: Db, fromId: string, toId: string, ymd: string, fromSec: number, toSec: number, limit: number): LegQuery[] {
  return getRows<LegQuery>(
    db,
    `SELECT a.trip_id, s.train_number, r.route_short_name AS line_name, ds.stop_name AS final_destination_name,
       a.departure_sec AS from_dep_sec, b.arrival_sec AS to_arr_sec
     FROM gtfs_stop_times a
     JOIN gtfs_stop_times b ON b.trip_id = a.trip_id AND b.stop_id = ? AND b.stop_sequence > a.stop_sequence
     JOIN gtfs_trip_summaries s ON s.trip_id = a.trip_id
     JOIN gtfs_trips t ON t.trip_id = a.trip_id
     JOIN gtfs_calendar_dates cd ON cd.service_id = t.service_id AND cd.exception_type = 1
     JOIN gtfs_routes r ON r.route_id = s.route_id AND r.route_type = 2
     LEFT JOIN gtfs_stops ds ON ds.stop_id = s.destination_stop_id
     WHERE a.stop_id = ? AND a.departure_sec IS NOT NULL
       AND a.departure_sec >= ? AND a.departure_sec <= ? AND cd.date = ?
     ORDER BY a.departure_sec ASC
     LIMIT ?`,
    [toId, fromId, fromSec, toSec, ymd.slice(0, 4) + ymd.slice(5, 7) + ymd.slice(8, 10), limit],
  );
}

/** Next direct trains from→to starting now-ish. Legs already departed keep
 *  their live state so the UI can show "departed +2" style context.
 *  Ranked by expected real arrival (§19/§62), depEpoch as tiebreak. */
export function journeysFor(db: Db, fromId: string, toId: string, nowMs: number, limit = 8): JourneyRow[] {
  const today = romeYmd(nowMs);
  const nowSec = secondsIntoServiceDay(today, nowMs);
  const tomorrow = ymdPlusDays(today, 1);
  const fromName = getRow<{ stop_name: string }>(db, 'SELECT stop_name FROM gtfs_stops WHERE stop_id=?', [fromId])?.stop_name ?? null;
  const toName = getRow<{ stop_name: string }>(db, 'SELECT stop_name FROM gtfs_stops WHERE stop_id=?', [toId])?.stop_name ?? null;
  const legs: Array<{ ymd: string; leg: LegQuery }> = [
    ...legsForDay(db, fromId, toId, today, nowSec - 600, 108_000, limit).map((leg) => ({ ymd: today, leg })),
    ...legsForDay(db, fromId, toId, tomorrow, 0, 10_800, Math.ceil(limit / 2)).map((leg) => ({ ymd: tomorrow, leg })),
  ];
  const seen = new Set<string>();
  const rows: JourneyRow[] = [];
  for (const { ymd, leg } of legs) {
    const key = leg.train_number + '@' + String(leg.from_dep_sec);
    if (seen.has(key)) continue;
    seen.add(key);
    const trainNumber = bareTrainNumber(leg.train_number ?? '') ?? '';
    const rawLine = leg.line_name;
    const line = rawLine !== null && rawLine.length <= 8 && !rawLine.includes('(') ? rawLine : null;
    const depEpoch = romeWallToEpoch(ymd, leg.from_dep_sec);
    const arrEpoch = romeWallToEpoch(ymd, leg.to_arr_sec ?? leg.from_dep_sec);
    const run = trainNumber !== ''
      ? getRow<{ id: number }>(db, 'SELECT id FROM train_runs WHERE service_date=? AND train_number=? LIMIT 1', [ymd, trainNumber])
      : undefined;
    let platform: string | null = null;
    let depDelaySec: number | null = null;
    let actualDepEpoch: number | null = null;
    let state: StateForRanking | null = null;
    if (run) {
      const ev = getRow<{ actual_dep_epoch: number | null; dep_delay_sec: number | null; platform_actual: string | null }>(
        db,
        'SELECT actual_dep_epoch, dep_delay_sec, platform_actual FROM train_stop_events WHERE run_id=? AND stop_id=?',
        [run.id, fromId],
      );
      if (ev) {
        platform = ev.platform_actual;
        depDelaySec = ev.dep_delay_sec;
        actualDepEpoch = ev.actual_dep_epoch;
      }
      if (platform !== null) {
        const pn = Number(platform);
        if (!Number.isInteger(pn) || pn < 1 || pn > 30) platform = null;
      }
      const st = getRow<{ state_json: string }>(db, 'SELECT state_json FROM train_state WHERE run_id=?', [run.id]);
      if (st) state = JSON.parse(st.state_json) as StateForRanking;
    }
    // §19/§62: expected real arrival at the destination stop — strongest
    // signal first: what actually happened, then the operator's own
    // stop-level prediction, then our run-level prediction (its delay,
    // measured against the run's scheduled terminus arrival, carried onto
    // this leg — exact when toId is the terminus), then the observed
    // departure delay carried through. Scheduled only as the last resort.
    let expectedArrivalEpoch = arrEpoch;
    let expectedArrivalLive = false;
    if (run) {
      const arrEv = getRow<{ actual_arr_epoch: number | null; op_pred_arr_epoch: number | null }>(
        db,
        'SELECT actual_arr_epoch, op_pred_arr_epoch FROM train_stop_events WHERE run_id=? AND stop_id=?',
        [run.id, toId],
      );
      const est = state?.ourEstimate;
      if (arrEv?.actual_arr_epoch != null) {
        expectedArrivalEpoch = arrEv.actual_arr_epoch;
        expectedArrivalLive = true;
      } else if (arrEv?.op_pred_arr_epoch != null) {
        expectedArrivalEpoch = arrEv.op_pred_arr_epoch;
        expectedArrivalLive = true;
      } else if (est?.p50 != null && state?.schedArrEpoch != null) {
        expectedArrivalEpoch = arrEpoch + (est.p50 - state.schedArrEpoch);
        expectedArrivalLive = true;
      } else if (depDelaySec != null) {
        expectedArrivalEpoch = arrEpoch + depDelaySec * 1000;
        expectedArrivalLive = true;
      }
    }
    const riskPenaltySec = riskPenaltySecOf(state);
    rows.push({
      runId: run?.id ?? null,
      trainNumber,
      line,
      originName: fromName,
      destinationName: toName,
      finalDestinationName: leg.final_destination_name,
      depEpoch,
      arrEpoch,
      depDelaySec,
      actualDepEpoch,
      platform,
      state,
      expectedArrivalEpoch: Math.round(expectedArrivalEpoch),
      expectedArrivalLive,
      riskPenaltySec,
      recommended: false,
    });
  }
  // §19 rank: expected real arrival, penalised for a shaky p90 tail;
  // departure order breaks ties (and is the natural order when nothing is
  // live-tracked, so far-future searches keep today's behaviour)
  const score = (r: JourneyRow) => r.expectedArrivalEpoch + (r.riskPenaltySec ?? 0) * 1000;
  rows.sort((a, b) => (score(a) - score(b)) || (a.depEpoch - b.depEpoch));
  const ranked = rows.slice(0, limit);
  // flag the best option the rider can still catch — an already-departed or
  // cancelled option may rank first, but it is not a recommendation
  const boardable = (r: JourneyRow) => {
    const st = r.state as StateForRanking | null;
    return st?.status !== 'cancelled' && st?.status !== 'arrived'
      && r.actualDepEpoch == null
      && r.depEpoch + (r.depDelaySec ?? 0) * 1000 >= nowMs - 30_000;
  };
  const best = ranked.find(boardable);
  if (best) best.recommended = true;
  return ranked;
}
