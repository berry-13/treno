/**
 * Canonical train-run registry (GOAL.md §9): identity is never the bare train
 * number. Runs are resolved from (operator, service_date, train_number,
 * origin, scheduled departure) with tolerant fallback matching for providers
 * whose station coding differs from GTFS.
 */
import { getRow, runStmt, type Db } from '#core/db.ts';
import { runKeyStr, type RunKey } from '#core/ids.ts';
import { romeWallToEpoch, ymdPlusDays } from '#core/time.ts';

export interface RunRecord {
  id: number;
  run_key: string;
  operator: string;
  service_date: string;
  train_number: string;
  origin_stop_id: string | null;
  destination_stop_id: string | null;
  sched_dep_sec: number | null;
  sched_arr_sec: number | null;
  sched_dep_epoch: number | null;
  sched_arr_epoch: number | null;
  gtfs_trip_id: string | null;
  route_id: string | null;
  first_seen_source: string | null;
  created_at: number;
  last_activity_at: number | null;
}

export interface EnsureRunArgs extends RunKey {
  destinationStopId?: string | null;
  schedArrSec?: number | null;
  gtfsTripId?: string | null;
  routeId?: string | null;
  source: string;
}

/** Create-or-get the canonical run row, enriching null schedule fields when learned. */
export function ensureRun(db: Db, args: EnsureRunArgs): number {
  const key = runKeyStr(args);
  const now = Date.now();
  runStmt(
    db.prepare('INSERT OR IGNORE INTO train_runs(run_key, operator, service_date, train_number, origin_stop_id, destination_stop_id, sched_dep_sec, sched_arr_sec, sched_dep_epoch, sched_arr_epoch, gtfs_trip_id, route_id, first_seen_source, created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)'),
    [key, args.operator, args.serviceDate, args.trainNumber, args.originStopId, args.destinationStopId ?? null,
     args.schedDepSec ?? null, args.schedArrSec ?? null,
     args.schedDepSec != null ? romeWallToEpoch(args.serviceDate, args.schedDepSec) : null,
     args.schedArrSec != null ? romeWallToEpoch(args.serviceDate, args.schedArrSec) : null,
     args.gtfsTripId ?? null, args.routeId ?? null, args.source, now],
  );
  let run = getRow<{ id: number }>(db, 'SELECT id FROM train_runs WHERE run_key=?', [key]);
  if (!run) {
    // INSERT OR IGNORE kept an earlier row with same (date, number, origin) but unknown dep ('?')
    run = getRow<{ id: number }>(
      db,
      'SELECT id FROM train_runs WHERE operator=? AND service_date=? AND train_number=? AND (origin_stop_id=? OR origin_stop_id IS NULL) AND (sched_dep_sec=? OR sched_dep_sec IS NULL) ORDER BY sched_dep_sec IS NULL LIMIT 1',
      [args.operator, args.serviceDate, args.trainNumber, args.originStopId, args.schedDepSec ?? null],
    );
  }
  if (!run) throw new Error('ensureRun: failed to create run for ' + key);
  // enrich nullable fields
  runStmt(
    db.prepare('UPDATE train_runs SET destination_stop_id=COALESCE(destination_stop_id,?), sched_arr_sec=COALESCE(sched_arr_sec,?), gtfs_trip_id=COALESCE(gtfs_trip_id,?), route_id=COALESCE(route_id,?), last_activity_at=? WHERE id=?'),
    [args.destinationStopId ?? null, args.schedArrSec ?? null, args.gtfsTripId ?? null, args.routeId ?? null, now, run.id],
  );
  return run.id;
}

/** Record the source-native key that maps to this run (e.g. VT "{num}|{origin}|{epochMs}"). */
export function mapSourceKey(db: Db, runId: number, source: string, sourceKey: string): void {
  runStmt(
    db.prepare('INSERT OR IGNORE INTO train_run_sources(run_id, source, source_key, last_resolved_at) VALUES(?,?,?,?)'),
    [runId, source, sourceKey, Date.now()],
  );
  // keep the mapping fresh on the run side
  runStmt(
    db.prepare('UPDATE train_run_sources SET last_resolved_at=? WHERE run_id=? AND source=? AND source_key=?'),
    [Date.now(), runId, source, sourceKey],
  );
}

export function runIdBySourceKey(db: Db, source: string, sourceKey: string): number | null {
  const r = getRow<{ run_id: number }>(db, 'SELECT run_id FROM train_run_sources WHERE source=? AND source_key=?', [source, sourceKey]);
  return r ? r.run_id : null;
}

/**
 * Resolve a run by identity with tolerance: exact (date, number, origin, dep)
 * first; then unique (date, number) whose dep is within `toleranceSec` of the
 * observed dep; returns null when ambiguous or absent.
 */
export function resolveRun(
  db: Db,
  serviceDate: string,
  trainNumber: string,
  originStopId: string | null,
  schedDepSec: number | null,
  toleranceSec = 600,
): number | null {
  const exact = getRow<{ id: number }>(
    db,
    'SELECT id FROM train_runs WHERE service_date=? AND train_number=? AND origin_stop_id IS ? AND sched_dep_sec IS ?',
    [serviceDate, trainNumber, originStopId, schedDepSec],
  );
  if (exact) return exact.id;
  const candidates = (schedDepSec == null
    ? getRowsSafe(db, serviceDate, trainNumber)
    : getRowsSafe(db, serviceDate, trainNumber).filter((r) => r.sched_dep_sec != null && Math.abs(r.sched_dep_sec - schedDepSec) <= toleranceSec));
  const unique = new Map<number, { sched_dep_sec: number | null; origin_stop_id: string | null }>();
  for (const c of candidates) unique.set(c.id, c);
  if (unique.size === 1) return candidates[0]!.id;
  return null;
}

function getRowsSafe(db: Db, serviceDate: string, trainNumber: string): Array<{ id: number; sched_dep_sec: number | null; origin_stop_id: string | null }> {
  return (db.prepare('SELECT id, sched_dep_sec, origin_stop_id FROM train_runs WHERE service_date=? AND train_number=?').all(serviceDate, trainNumber)) as Array<{ id: number; sched_dep_sec: number | null; origin_stop_id: string | null }>;
}

export function getRun(db: Db, id: number): RunRecord | undefined {
  return getRow<RunRecord>(db, 'SELECT * FROM train_runs WHERE id=?', [id]);
}

export function runByCode(db: Db, trainNumber: string, serviceDate: string): RunRecord | undefined {
  return getRow<RunRecord>(db, 'SELECT * FROM train_runs WHERE train_number=? AND service_date=? ORDER BY sched_dep_sec LIMIT 1', [trainNumber, serviceDate]);
}

/** Yesterday's date — runs can continue past midnight into the next calendar day. */
export function previousServiceDate(ymd: string): string {
  return ymdPlusDays(ymd, -1);
}
