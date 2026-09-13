/**
 * Segment model (GOAL.md §13): consecutive-stop traversal observations derived
 * from actual stop events, per-segment runtime/delay-delta distributions
 * (overall + peak/off-peak buckets), and live corridor state (what the last
 * few trains through a segment just experienced).
 */
import { getRow, getRows, runStmt, type Db } from '#core/db.ts';
import { log } from '#core/log.ts';
import { romeYmd } from '#core/time.ts';

export interface StopEventForSegments {
  stop_id: string;
  stop_sequence: number | null;
  sched_arr_epoch: number | null;
  sched_dep_epoch: number | null;
  actual_arr_epoch: number | null;
  actual_dep_epoch: number | null;
  arr_delay_sec: number | null;
  dep_delay_sec: number | null;
}

export function segmentId(fromStopId: string, toStopId: string): string {
  return fromStopId + '>' + toStopId;
}

/**
 * Derive traversal observations for one run from its stop events: for every
 * consecutive pair with actual times, record runtime, entry/exit delay and
 * delay delta. Idempotent (unique per run + stop pair).
 */
export function deriveSegmentObservations(db: Db, runId: number, serviceDate: string, source: string): number {
  const events = getRows<StopEventForSegments>(
    db,
    'SELECT stop_id, stop_sequence, sched_arr_epoch, sched_dep_epoch, actual_arr_epoch, actual_dep_epoch, arr_delay_sec, dep_delay_sec FROM train_stop_events WHERE run_id=? ORDER BY stop_sequence ASC, sched_arr_epoch ASC',
    [runId],
  );
  const stmt = db.prepare('INSERT OR IGNORE INTO segment_observation(segment_id, run_id, service_date, from_stop_id, to_stop_id, entered_at, left_at, runtime_sec, entry_delay_sec, exit_delay_sec, delay_delta_sec, time_of_day_sec, weekday, source, created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  let inserted = 0;
  for (let i = 0; i + 1 < events.length; i++) {
    const a = events[i]!;
    const b = events[i + 1]!;
    // traversal: leave a (departure preferred) → arrive b
    const enteredAt = a.actual_dep_epoch ?? a.actual_arr_epoch;
    const leftAt = b.actual_arr_epoch ?? b.actual_dep_epoch;
    if (enteredAt == null || leftAt == null || leftAt <= enteredAt) continue;
    const runtime = Math.round((leftAt - enteredAt) / 1000);
    const schedRuntime = (a.sched_dep_epoch ?? a.sched_arr_epoch) != null && (b.sched_arr_epoch ?? b.sched_dep_epoch) != null
      ? Math.round((((b.sched_arr_epoch ?? b.sched_dep_epoch)!) - ((a.sched_dep_epoch ?? a.sched_arr_epoch)!)) / 1000)
      : null;
    // impossible-traversal guard (§45): a segment cannot be traversed at a
    // fraction of its scheduled runtime — flag rather than pollute stats
    if (schedRuntime != null && runtime < Math.max(30, schedRuntime * 0.25)) continue;
    const entryDelay = a.dep_delay_sec ?? a.arr_delay_sec ?? null;
    const exitDelay = b.arr_delay_sec ?? b.dep_delay_sec ?? null;
    const r = stmt.run(
      segmentId(a.stop_id, b.stop_id), runId, serviceDate, a.stop_id, b.stop_id,
      enteredAt, leftAt, runtime, entryDelay, exitDelay,
      entryDelay != null && exitDelay != null ? exitDelay - entryDelay : null,
      timeOfDaySec(enteredAt), new Date(enteredAt).getUTCDay(), source, Date.now(),
    );
    if (Number(r.changes) > 0) inserted++;
  }
  return inserted;
}

function timeOfDaySec(epochMs: number): number {
  const ymd = romeYmd(epochMs);
  const midnight = Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(5, 7)) - 1, Number(ymd.slice(8, 10)));
  return Math.round((epochMs - midnight) / 1000);
}

function quantile(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

function bucketFor(timeOfDaySec: number | null): string[] {
  if (timeOfDaySec == null) return ['all'];
  const h = timeOfDaySec / 3600;
  const peak = (h >= 7 && h < 9) || (h >= 16 && h < 19);
  return peak ? ['all', 'peak'] : ['all', 'off'];
}

/**
 * Recompute per-segment distributions from recent observations (default last
 * 90 days). Called periodically by the collector.
 */
export function refreshSegmentStats(db: Db, lookbackDays = 90): { segments: number } {
  const since = Date.now() - lookbackDays * 86400_000;
  const rows = getRows<{ segment_id: string; runtime_sec: number | null; delay_delta_sec: number | null; time_of_day_sec: number | null }>(
    db,
    'SELECT segment_id, runtime_sec, delay_delta_sec, time_of_day_sec FROM segment_observation WHERE entered_at >= ?',
    [since],
  );
  const groups = new Map<string, { rt: number[]; dd: number[]; tod: number | null }>();
  for (const r of rows) {
    let g = groups.get(r.segment_id);
    if (!g) { g = { rt: [], dd: [], tod: null }; groups.set(r.segment_id, g); }
    if (r.runtime_sec != null) g.rt.push(r.runtime_sec);
    if (r.delay_delta_sec != null) g.dd.push(r.delay_delta_sec);
    g.tod = r.time_of_day_sec;
  }
  const upsert = db.prepare('INSERT INTO segment_stats(segment_id, bucket, n, rt_p10, rt_p50, rt_p90, dd_p50, dd_p90, updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(segment_id, bucket) DO UPDATE SET n=excluded.n, rt_p10=excluded.rt_p10, rt_p50=excluded.rt_p50, rt_p90=excluded.rt_p90, dd_p50=excluded.dd_p50, dd_p90=excluded.dd_p90, updated_at=excluded.updated_at');
  db.exec('BEGIN');
  try {
    for (const [segId, g] of groups) {
      const rtSorted = [...g.rt].sort((x, y) => x - y);
      const ddSorted = [...g.dd].sort((x, y) => x - y);
      for (const bucket of bucketFor(g.tod)) {
        if (rtSorted.length < 5) continue;
        runStmt(upsert, [
          segId, bucket, rtSorted.length,
          quantile(rtSorted, 0.10), quantile(rtSorted, 0.50), quantile(rtSorted, 0.90),
          quantile(ddSorted, 0.50), quantile(ddSorted, 0.90),
          Date.now(),
        ]);
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { segments: groups.size };
}

export interface SegmentStatRow {
  segment_id: string;
  bucket: string;
  n: number;
  rt_p10: number | null;
  rt_p50: number | null;
  rt_p90: number | null;
  dd_p50: number | null;
  dd_p90: number | null;
}

/** Best stats row for a segment near a given time of day (peak bucket preferred when populated). */
export function statsForSegment(db: Db, segId: string, timeOfDaySec: number | null): SegmentStatRow | null {
  const buckets = bucketFor(timeOfDaySec).filter((b) => b !== 'all');
  const preferred = buckets[0] ?? 'off';
  const row = getRow<SegmentStatRow>(
    db,
    'SELECT segment_id, bucket, n, rt_p10, rt_p50, rt_p90, dd_p50, dd_p90 FROM segment_stats WHERE segment_id=? AND bucket=? AND n >= 5',
    [segId, preferred],
  );
  if (row) return row;
  return getRow<SegmentStatRow>(
    db,
    'SELECT segment_id, bucket, n, rt_p10, rt_p50, rt_p90, dd_p50, dd_p90 FROM segment_stats WHERE segment_id=? AND bucket=? AND n >= 5',
    [segId, 'all'],
  ) ?? null;
}

/** Live corridor state: median delay delta of the last K traversals within the window. */
export function corridorDelta(db: Db, segId: string, withinMs = 3 * 3600_000, k = 3): number | null {
  const since = Date.now() - withinMs;
  const rows = getRows<{ delay_delta_sec: number | null }>(
    db,
    'SELECT delay_delta_sec FROM segment_observation WHERE segment_id=? AND entered_at >= ? AND delay_delta_sec IS NOT NULL ORDER BY entered_at DESC LIMIT ?',
    [segId, since, k],
  );
  const vals = rows.map((r) => r.delay_delta_sec!).filter((v) => v != null).sort((a, b) => a - b);
  if (vals.length === 0) return null;
  return vals[Math.floor(vals.length / 2)]!;
}

export function segmentStatsTable(db: Db, limit = 100): SegmentStatRow[] {
  return getRows<SegmentStatRow>(
    db,
    'SELECT segment_id, bucket, n, rt_p10, rt_p50, rt_p90, dd_p50, dd_p90 FROM segment_stats ORDER BY n DESC LIMIT ?',
    [limit],
  );
}

export function logSegmentSummary(db: Db): void {
  const r = getRow<{ obs: number; segs: number }>(
    db, 'SELECT (SELECT COUNT(*) FROM segment_observation) AS obs, (SELECT COUNT(*) FROM segment_stats) AS segs');
  log.info('segments: stats', { observations: r?.obs ?? 0, segmentsWithStats: r?.segs ?? 0 });
}
