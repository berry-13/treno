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

/** peak = Rome-local 7-9 / 16-19, matching the buckets written into segment_stats. */
export function bucketFor(timeOfDaySec: number | null): string[] {
  if (timeOfDaySec == null) return ['all'];
  const h = timeOfDaySec / 3600;
  const peak = (h >= 7 && h < 9) || (h >= 16 && h < 19);
  return peak ? ['all', 'peak'] : ['all', 'off'];
}

export { quantile };

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
  /** where the numbers come from — priors are vintage and must be anchored on
   *  the current schedule by the caller (see excessP50Sec), never trusted as
   *  absolute runtimes when no live data backs them */
  origin?: 'live' | 'blended' | 'prior';
  /** prior rows only: median runtime excess over the source-year schedule */
  excessP50Sec?: number | null;
}

/**
 * Historical structural priors (segment_stats_prior) are merged here, at read
 * time, never written into segment_stats — the live recompute in
 * refreshSegmentStats must stay free to overwrite its own table.
 *
 * Weighting scheme (measured, not assumed): the 2015 Monechi import was A/B'd
 * on 14 days of live traversals and the prior's point estimates LOST in every
 * stratum — vs live stats (MAE 92→96s at live n=5-20, 38→39s at n>20) and vs
 * the current schedule on uncovered segments (114→124s with excess-anchoring,
 * 141s with absolute runtimes). Minute quantization plus 11 years of timetable
 * drift make 2015 medians worse than what already exists. So the historical
 * weight on point estimates is zero: a prior never shifts rt_p50/dd_p50.
 * What the priors DO contribute, on segments with no live row, is the shape
 * of the distribution (rt_p10..p90 spread, widened for vintage) and the
 * stored delay-development stats — and every row stays attributable via
 * `source`, so a better vintage can be blended in later.
 */

/** Extra spread when a prior is a segment's ONLY signal — the vintage itself
 *  is uncertainty the 2015 sample cannot express, so widen p10..p90. */
const PRIOR_ONLY_SPREAD_FACTOR = 1.3;

const STAT_COLS = 'segment_id, bucket, n, rt_p10, rt_p50, rt_p90, dd_p50, dd_p90';

interface PriorRow extends SegmentStatRow { ex_p50: number | null }

function liveStatsRow(db: Db, segId: string, bucket: string): SegmentStatRow | undefined {
  return getRow<SegmentStatRow>(
    db,
    'SELECT ' + STAT_COLS + ' FROM segment_stats WHERE segment_id=? AND bucket=? AND n >= 5',
    [segId, bucket],
  );
}

/** Live-observation stats only (no prior merge) — the pre-backfill behavior,
 *  kept for A/B verification of the prior import. */
export function liveStatsForSegment(db: Db, segId: string, timeOfDaySec: number | null): SegmentStatRow | null {
  const preferred = bucketFor(timeOfDaySec).find((b) => b !== 'all') ?? 'off';
  return liveStatsRow(db, segId, preferred) ?? liveStatsRow(db, segId, 'all') ?? null;
}

function priorStatsRow(db: Db, segId: string, bucket: string): PriorRow | undefined {
  return getRow<PriorRow>(
    db,
    'SELECT ' + STAT_COLS + ', ex_p50 FROM segment_stats_prior WHERE segment_id=? AND bucket=? AND n >= 5 ORDER BY n DESC LIMIT 1',
    [segId, bucket],
  );
}

/** Best stats row for a segment near a given time of day (peak bucket preferred when populated), with historical priors merged in. */
export function statsForSegment(db: Db, segId: string, timeOfDaySec: number | null): SegmentStatRow | null {
  const preferred = bucketFor(timeOfDaySec).find((b) => b !== 'all') ?? 'off';
  const live = liveStatsRow(db, segId, preferred) ?? liveStatsRow(db, segId, 'all');
  // live observations always win outright: priors never shift a point
  // estimate that live data already provides
  if (live) return { ...live, origin: 'live' };
  const prior = priorStatsRow(db, segId, preferred) ?? priorStatsRow(db, segId, 'all');
  if (prior) {
    // prior-only: shape only — spread widened for vintage; rt_p50 carries
    // 2015 drift so callers anchor the point estimate on the current
    // schedule (heuristic) instead of taking it at face value
    const widen = (p50: number | null, edge: number | null, up: boolean): number | null =>
      p50 == null || edge == null ? (edge ?? p50) : p50 + (up ? 1 : -1) * PRIOR_ONLY_SPREAD_FACTOR * Math.abs(edge - p50);
    return {
      segment_id: segId,
      bucket: prior.bucket,
      n: prior.n,
      origin: 'prior',
      excessP50Sec: prior.ex_p50,
      rt_p10: widen(prior.rt_p50, prior.rt_p10, false),
      rt_p50: prior.rt_p50,
      rt_p90: widen(prior.rt_p50, prior.rt_p90, true),
      dd_p50: prior.dd_p50,
      dd_p90: widen(prior.dd_p50, prior.dd_p90, true),
    };
  }
  return null;
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
  const r = getRow<{ obs: number; segs: number; priorSegs: number }>(
    db, 'SELECT (SELECT COUNT(*) FROM segment_observation) AS obs, (SELECT COUNT(*) FROM segment_stats) AS segs, (SELECT COUNT(DISTINCT segment_id) FROM segment_stats_prior) AS priorSegs');
  log.info('segments: stats', { observations: r?.obs ?? 0, segmentsWithStats: r?.segs ?? 0, segmentsWithPriors: r?.priorSegs ?? 0 });
}
