/**
 * Source conflict detection + historical backfill (GOAL.md §78).
 *
 * When MIA says +4 and ViaggiaTreno says +7, both observations stay in
 * train_observations AND the disagreement itself is materialized into
 * source_conflicts — "sources disagreeing may predict instability" is a
 * feature (delay_source_spread), not noise to be averaged away.
 *
 * Rule (one definition, two consumers): for the same run, a delay observation
 * from one of the two rail sources is compared against the other source's
 * most recent delay observation inside a 90s window; |Δdelay| > 120s writes a
 * conflict row, deduplicated to at most one row per run+field in any
 * 5-minute stretch. The live pipeline hook (pipeline.ts ingestSnapshot) calls
 * recordSourceConflict() at ingest; `npm run conflicts:backfill` replays the
 * identical rule over stored history so the feature has a past.
 */
import { getRow, getRows, runStmt, type Db } from '#core/db.ts';
import { loadConfig } from '#core/config.ts';
import { log } from '#core/log.ts';
import { openTrenoDb } from '#gtfs/setup.ts';

/** two per-source delay observations closer than this are comparable */
export const CONFLICT_WINDOW_MS = 90_000;
/** materialized disagreement threshold: |Δdelay| strictly greater than this */
export const CONFLICT_THRESHOLD_SEC = 120;
/** dedup: skip when an identical-field conflict for the run exists within
 *  the previous 5 minutes */
export const CONFLICT_DEDUP_MS = 5 * 60_000;
/** the only field conflicts are detected on today (kept in the row so more
 *  fields — platform, status — can be added without a migration) */
export const CONFLICT_FIELD = 'delay_seconds';

const otherSource = (s: string): string | null =>
  s === 'mia' ? 'viaggiatreno' : s === 'viaggiatreno' ? 'mia' : null;

/**
 * Live hook: compare one freshly stored delay observation (source `source`,
 * fetched at `ts`, upstream-observed `observedAt`) against the other source's
 * latest stored delay inside the window; write a conflict row when the rule
 * fires. Returns true when a row was written.
 */
export function recordSourceConflict(
  db: Db,
  runId: number,
  source: string,
  ts: number,
  observedAt: number | null,
  delaySec: number,
): boolean {
  const other = otherSource(source);
  if (other == null) return false;
  const o = getRow<{ delay_seconds: number }>(
    db,
    'SELECT delay_seconds FROM train_observations WHERE run_id=? AND source=? AND delay_seconds IS NOT NULL AND ts>=? AND ts<=? ORDER BY ts DESC LIMIT 1',
    [runId, other, ts - CONFLICT_WINDOW_MS, ts],
  );
  if (o == null) return false;
  return insertConflict(db, runId, ts, observedAt, source, delaySec, other, o.delay_seconds);
}

/** Threshold + dedup + insert. Sources are written in canonical (alphabetical)
 *  order so the same disagreement has one row shape regardless of which
 *  source triggered the write. */
function insertConflict(
  db: Db,
  runId: number,
  ts: number,
  observedAt: number | null,
  sourceX: string,
  valueX: number,
  sourceY: string,
  valueY: number,
): boolean {
  const spread = Math.abs(valueX - valueY);
  if (spread <= CONFLICT_THRESHOLD_SEC) return false;
  const dup = getRow<{ n: number }>(
    db,
    'SELECT COUNT(*) AS n FROM source_conflicts WHERE run_id=? AND field=? AND ts>? AND ts<=?',
    [runId, CONFLICT_FIELD, ts - CONFLICT_DEDUP_MS, ts],
  );
  if ((dup?.n ?? 0) > 0) return false;
  const [sourceA, valueA, sourceB, valueB] = sourceX < sourceY
    ? [sourceX, valueX, sourceY, valueY]
    : [sourceY, valueY, sourceX, valueX];
  runStmt(
    db.prepare('INSERT INTO source_conflicts(run_id, ts, field, value_a, value_b, source_a, source_b, spread_seconds, observed_at) VALUES(?,?,?,?,?,?,?,?,?)'),
    [runId, ts, CONFLICT_FIELD, valueA, valueB, sourceA, sourceB, Math.round(spread), observedAt],
  );
  return true;
}

export interface ConflictBackfillStats {
  scanned: number;       // delay observations replayed
  runsConsidered: number;// runs with observations from both sources
  candidates: number;    // source pairs passing window + threshold
  inserted: number;      // conflict rows written (post-dedup)
  distinctRuns: number;  // runs with at least one inserted row
  spreadP50Sec: number;
  spreadP90Sec: number;
}

/**
 * Replay the live rule over stored history: walk each run's mia/viaggiatreno
 * delay observations in ts order and treat every observation exactly as
 * ingestSnapshot would have (compare against the other source's latest
 * observation in the previous 90s). Existing conflict rows — from a previous
 * backfill or from live collection — seed the 5-minute dedup, so this is
 * idempotent and safe to run alongside the live collector.
 */
export function backfillSourceConflicts(db: Db): ConflictBackfillStats {
  const rows = getRows<{ run_id: number; ts: number; source: string; delay_seconds: number; observed_at: number | null }>(
    db,
    "SELECT run_id, ts, source, delay_seconds, observed_at FROM train_observations WHERE delay_seconds IS NOT NULL AND source IN ('mia','viaggiatreno') ORDER BY run_id, ts",
  );
  const lastEmitted = new Map<number, number>();
  for (const c of getRows<{ run_id: number; ts: number }>(db, 'SELECT run_id, ts FROM source_conflicts')) {
    lastEmitted.set(c.run_id, Math.max(lastEmitted.get(c.run_id) ?? 0, c.ts));
  }

  let scanned = 0;
  let runsConsidered = 0;
  let candidates = 0;
  let inserted = 0;
  const insertedRuns = new Set<number>();
  const spreads: number[] = [];

  let i = 0;
  while (i < rows.length) {
    let j = i;
    while (j < rows.length && rows[j]!.run_id === rows[i]!.run_id) j++;
    const runId = rows[i]!.run_id;
    const seenSources = new Set<string>();
    // latest replayed observation per source — in ts order this is exactly
    // the row recordSourceConflict's query would have found at ingest time
    const lastBySource = new Map<string, { ts: number; delay: number; observedAt: number | null }>();
    let lastTs = lastEmitted.get(runId) ?? Number.NEGATIVE_INFINITY;
    for (let k = i; k < j; k++) {
      const o = rows[k]!;
      scanned++;
      seenSources.add(o.source);
      const other = otherSource(o.source);
      const prev = other != null ? lastBySource.get(other) : undefined;
      if (other != null && prev != null && o.ts - prev.ts <= CONFLICT_WINDOW_MS) {
        const spread = Math.abs(o.delay_seconds - prev.delay);
        if (spread > CONFLICT_THRESHOLD_SEC) {
          candidates++;
          // same dedup gate as insertConflict, evaluated in-memory across the
          // chronological walk (existing rows seeded lastTs above); >= keeps
          // the boundary identical to the SQL `ts > ts-5min` check in live
          if (o.ts - lastTs >= CONFLICT_DEDUP_MS) {
            const [sourceA, valueA, sourceB, valueB] = o.source < other
              ? [o.source, o.delay_seconds, other, prev.delay]
              : [other, prev.delay, o.source, o.delay_seconds];
            runStmt(
              db.prepare('INSERT INTO source_conflicts(run_id, ts, field, value_a, value_b, source_a, source_b, spread_seconds, observed_at) VALUES(?,?,?,?,?,?,?,?,?)'),
              [runId, o.ts, CONFLICT_FIELD, valueA, valueB, sourceA, sourceB, Math.round(spread), o.observed_at],
            );
            inserted++;
            insertedRuns.add(runId);
            spreads.push(Math.round(spread));
            lastTs = o.ts;
          }
        }
      }
      lastBySource.set(o.source, { ts: o.ts, delay: o.delay_seconds, observedAt: o.observed_at });
    }
    if (seenSources.size >= 2) runsConsidered++;
    i = j;
  }

  spreads.sort((a, b) => a - b);
  const pct = (q: number): number => (spreads.length === 0 ? 0 : spreads[Math.min(spreads.length - 1, Math.floor(q * spreads.length))]!);
  return {
    scanned,
    runsConsidered,
    candidates,
    inserted,
    distinctRuns: insertedRuns.size,
    spreadP50Sec: pct(0.5),
    spreadP90Sec: pct(0.9),
  };
}

function main(): void {
  const db = openTrenoDb(loadConfig());
  const stats = backfillSourceConflicts(db);
  log.info('conflicts: backfill complete', { ...stats });
  if (stats.inserted > 0) {
    const sql = `SELECT r.train_number, r.service_date, c.ts, c.source_a, c.value_a, c.source_b, c.value_b, c.spread_seconds
                 FROM source_conflicts c JOIN train_runs r ON r.id=c.run_id WHERE c.field='delay_seconds'`;
    // two representative rows for the operator log: a median-spread conflict
    // and the worst disagreement found
    const pick = (orderBy: string, params: Array<null | number | string>) =>
      getRows<{ train_number: string; service_date: string; ts: number; source_a: string; value_a: number; source_b: string; value_b: number; spread_seconds: number }>(db, sql + orderBy, params);
    const typical = pick(' ORDER BY ABS(c.spread_seconds - ?) ASC, c.ts ASC LIMIT 1', [stats.spreadP50Sec]);
    const worst = pick(' ORDER BY c.spread_seconds DESC, c.ts ASC LIMIT 1', []);
    for (const e of [...typical, ...worst]) {
      log.info('conflicts: example', {
        train: e.train_number + '@' + e.service_date,
        at: new Date(e.ts).toISOString(),
        [e.source_a]: Math.round(e.value_a),
        [e.source_b]: Math.round(e.value_b),
        spreadSec: e.spread_seconds,
      });
    }
  }
  db.close();
}

if (process.argv[1] && process.argv[1].endsWith('conflicts-backfill.ts')) {
  main();
}
