/**
 * Data quality engine (GOAL.md §45): validate every source, flag anomalies,
 * never silently discard. Rules run over a run's observations in observation
 * order (ts ASC, id ASC); flags accumulate as a JSON string array stored in
 * `train_observations.quality_flags` / `train_stop_events.quality_flags` (the
 * same format `insertObservation` has always written, e.g.
 * `["DELAY_JUMP","STALE_SOURCE"]`).
 *
 * Flags:
 *   OUT_OF_ORDER        observed_at goes backwards for a source
 *   STALE_SOURCE        source_observed_at lags the fetch ts by >10 min
 *   SOURCE_CONFLICT     MIA vs ViaggiaTreno delay differ >300 s within 90 s
 *   DELAY_JUMP          delay changes >±60 min between consecutive obs (same source)
 *   BACKWARDS_TELEPORT location regresses to an earlier stop in the trip
 *                       (gtfs_stop_times ordering; unknown stops are skipped)
 *   IMPOSSIBLE_RUNTIME  consecutive stop actuals imply >300 km/h
 *                       (needs gtfs_stops coords; rows lacking them are skipped)
 *   UNKNOWN_RUN         run has no GTFS trip mapping (gtfs_trip_id IS NULL)
 *   UNMAPPED_STOP       observation location_id not present in gtfs_stops
 *
 * Architecture: the rule predicates are pure functions of row values (unit-
 * testable without a DB); `flagRunObservations` / `flagStopEventRuntimes`
 * fold them over an ordered run; `ingestRowFlags` is the cheap insert-time
 * hook (previous-same-source-row only); `recomputeAllQuality` is the offline
 * backfill that deterministically overwrites flags for the whole DB — running
 * it twice updates zero rows the second time.
 */
import { getRow, getRows, type Db } from '#core/db.ts';

// ---------- thresholds (all times epoch ms / seconds unless suffixed) ----------

/** observed_at regression large enough to rule out clock jitter */
export const OUT_OF_ORDER_MIN_REGRESSION_MS = 1_000;
/** source_observed_at lag behind the fetch ts that marks a source stale */
export const STALE_SOURCE_MAX_LAG_MS = 10 * 60_000;
/** max fetch-ts distance for a MIA↔ViaggiaTreno delay comparison */
export const SOURCE_CONFLICT_WINDOW_MS = 90_000;
/** MIA vs ViaggiaTreno delay disagreement (seconds) above which sources conflict */
export const SOURCE_CONFLICT_MAX_DIFF_SEC = 300;
/** same-source consecutive delay delta (seconds) treated as a jump */
export const DELAY_JUMP_MAX_DELTA_SEC = 60 * 60;
/** implied speed between consecutive actual stop times (km/h) deemed impossible */
export const IMPOSSIBLE_RUNTIME_KMH = 300;
/** distance below which a stop pair is treated as co-located (km) */
const COLOCATED_KM = 0.05;

/** Canonical flag order — output lists are deterministic. */
export const QUALITY_FLAGS = [
  'OUT_OF_ORDER', 'STALE_SOURCE', 'SOURCE_CONFLICT', 'DELAY_JUMP',
  'BACKWARDS_TELEPORT', 'IMPOSSIBLE_RUNTIME', 'UNKNOWN_RUN', 'UNMAPPED_STOP',
] as const;
export type QualityFlag = (typeof QUALITY_FLAGS)[number];

// ---------- pure single-row predicates ----------

/** True when this row's upstream event time is older than the previous row's
 *  from the same source (≥1 s regression to ignore sub-second jitter). */
export function outOfOrder(prevObservedAt: number | null, curObservedAt: number | null): boolean {
  return prevObservedAt != null && curObservedAt != null
    && prevObservedAt - curObservedAt >= OUT_OF_ORDER_MIN_REGRESSION_MS;
}

/** True when the upstream-stated event time lags the fetch time by >10 min. */
export function staleSource(fetchTs: number, observedAt: number | null): boolean {
  return observedAt != null && fetchTs - observedAt > STALE_SOURCE_MAX_LAG_MS;
}

/** True when the delay moved by more than ±60 min vs the previous same-source obs. */
export function delayJump(prevDelaySec: number | null, curDelaySec: number | null): boolean {
  return prevDelaySec != null && curDelaySec != null
    && Math.abs(curDelaySec - prevDelaySec) > DELAY_JUMP_MAX_DELTA_SEC;
}

// ---------- pure run-level folds ----------

export interface ObservationForQuality {
  id: number;
  ts: number; // fetch time
  source: string;
  observedAt: number | null;
  delaySeconds: number | null;
  locationId: string | null;
}

/** Per-run reference data: trip mapping, trip stop order, GTFS stop universe. */
export interface RunQualityContext {
  gtfsTripId: string | null;
  /** stop_id → stop_sequence from the run's gtfs_stop_times (empty if unmapped) */
  tripStopSeq: ReadonlyMap<string, number>;
  /** every stop_id known to gtfs_stops */
  knownStops: ReadonlySet<string>;
}

/**
 * Flag one run's observations, given them in observation order. Returns the
 * flag list per row, positionally aligned with the input. SOURCE_CONFLICT
 * lands on the later row of a conflicting pair (the insert-time hook can only
 * stamp the row being written, so the backfill mirrors that convention).
 */
export function flagRunObservations(obs: ObservationForQuality[], ctx: RunQualityContext): string[][] {
  const lastObservedAt = new Map<string, number>();
  const lastDelaySec = new Map<string, number>();
  const lastWithDelay = new Map<string, { ts: number; delaySeconds: number }>();
  let maxStopSeq = -1;
  const out: string[][] = [];
  for (const o of obs) {
    const flags: string[] = [];
    const prevObs = lastObservedAt.get(o.source) ?? null;
    if (outOfOrder(prevObs, o.observedAt)) flags.push('OUT_OF_ORDER');
    if (staleSource(o.ts, o.observedAt)) flags.push('STALE_SOURCE');
    if (o.delaySeconds != null) {
      for (const [src, cand] of lastWithDelay) {
        if (src === o.source) continue;
        if (Math.abs(o.ts - cand.ts) <= SOURCE_CONFLICT_WINDOW_MS
          && Math.abs(o.delaySeconds - cand.delaySeconds) > SOURCE_CONFLICT_MAX_DIFF_SEC) {
          flags.push('SOURCE_CONFLICT');
          break;
        }
      }
    }
    const prevDelay = lastDelaySec.get(o.source) ?? null;
    if (delayJump(prevDelay, o.delaySeconds)) flags.push('DELAY_JUMP');
    const seq = o.locationId != null ? ctx.tripStopSeq.get(o.locationId) : undefined;
    if (seq != null) {
      if (seq < maxStopSeq) flags.push('BACKWARDS_TELEPORT');
      else if (seq > maxStopSeq) maxStopSeq = seq;
    }
    if (ctx.gtfsTripId == null) flags.push('UNKNOWN_RUN');
    if (o.locationId != null && !ctx.knownStops.has(o.locationId)) flags.push('UNMAPPED_STOP');
    // fold state forward
    if (o.observedAt != null) lastObservedAt.set(o.source, o.observedAt);
    if (o.delaySeconds != null) {
      lastDelaySec.set(o.source, o.delaySeconds);
      lastWithDelay.set(o.source, { ts: o.ts, delaySeconds: o.delaySeconds });
    }
    out.push(flags);
  }
  return out;
}

export interface StopEventForQuality {
  stopId: string;
  stopSequence: number | null;
  schedArrEpoch: number | null;
  actualArrEpoch: number | null;
}

export interface StopCoords { lat: number; lon: number }

/** Great-circle distance in km. */
export function haversineKm(a: StopCoords, b: StopCoords): number {
  const R = 6371.0088;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const s = Math.sin(dLat / 2) ** 2
    + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(Math.min(1, s)));
}

/**
 * IMPOSSIBLE_RUNTIME over one run's stop events, given them in journey order
 * (stop_sequence ASC, sched_arr ASC — same ordering as the fused state). A
 * pair is only evaluated when both stops have actual arrival times and GTFS
 * coordinates; the flag lands on the later stop of the offending pair. A
 * non-positive time delta over a real distance implies unbounded speed and
 * flags too (covers "arrival earlier than previous stop").
 */
export function flagStopEventRuntimes(
  events: StopEventForQuality[],
  coordsOf: (stopId: string) => StopCoords | null,
): string[][] {
  const out = events.map(() => [] as string[]);
  for (let i = 1; i < events.length; i++) {
    const prev = events[i - 1]!;
    const cur = events[i]!;
    if (prev.actualArrEpoch == null || cur.actualArrEpoch == null) continue;
    const cp = coordsOf(prev.stopId);
    const cc = coordsOf(cur.stopId);
    if (cp == null || cc == null) continue;
    const km = haversineKm(cp, cc);
    if (km <= COLOCATED_KM) continue;
    const dtSec = (cur.actualArrEpoch - prev.actualArrEpoch) / 1000;
    const kmh = dtSec <= 0 ? Infinity : km / (dtSec / 3600);
    if (kmh > IMPOSSIBLE_RUNTIME_KMH) out[i]!.push('IMPOSSIBLE_RUNTIME');
  }
  return out;
}

// ---------- (de)serialization ----------

/** Flags → the stored column value (null when empty, matching the insert path). */
export function serializeQualityFlags(flags: string[]): string | null {
  return flags.length > 0 ? JSON.stringify(flags) : null;
}

/** Stored column value → flags; tolerates JSON arrays, comma lists and null. */
export function parseQualityFlags(stored: string | null | undefined): string[] {
  if (stored == null || stored === '') return [];
  const t = stored.trim();
  if (t.startsWith('[')) {
    try {
      const arr = JSON.parse(t) as unknown;
      if (Array.isArray(arr)) return arr.map((x) => String(x));
    } catch { /* fall through */ }
  }
  return t.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
}

// ---------- insert-time hook (cheap, previous same-source row only) ----------

export interface IngestRowInput {
  runId: number;
  ts: number;
  source: string;
  observedAt: number | null;
  delaySeconds: number | null;
}

/**
 * Per-row flags computed where observations are inserted: OUT_OF_ORDER,
 * STALE_SOURCE, DELAY_JUMP against the previous observation of the same
 * source. The cross-source / sequence rules (SOURCE_CONFLICT,
 * BACKWARDS_TELEPORT, ...) need whole-run context and are (re)computed by
 * `recomputeAllQuality`; the backfill deterministically restamps these three
 * as well, so insert-time and offline results agree.
 */
export function ingestRowFlags(db: Db, a: IngestRowInput): string[] {
  const prev = getRow<{ observed_at: number | null; delay_seconds: number | null }>(
    db,
    'SELECT observed_at, delay_seconds FROM train_observations WHERE run_id=? AND source=? ORDER BY ts DESC, id DESC LIMIT 1',
    [a.runId, a.source],
  );
  const flags: string[] = [];
  if (outOfOrder(prev?.observed_at ?? null, a.observedAt)) flags.push('OUT_OF_ORDER');
  if (staleSource(a.ts, a.observedAt)) flags.push('STALE_SOURCE');
  if (delayJump(prev?.delay_seconds ?? null, a.delaySeconds)) flags.push('DELAY_JUMP');
  return flags;
}

// ---------- apply step: recompute flags in place ----------

/** Whole-DB GTFS reference loaded once per backfill (566-row stops table). */
export interface QualityReference {
  knownStops: Set<string>;
  coordsByStop: Map<string, StopCoords>;
}

export function loadQualityReference(db: Db): QualityReference {
  const knownStops = new Set<string>();
  const coordsByStop = new Map<string, StopCoords>();
  for (const s of getRows<{ stop_id: string; stop_lat: number | null; stop_lon: number | null }>(
    db, 'SELECT stop_id, stop_lat, stop_lon FROM gtfs_stops',
  )) {
    knownStops.add(s.stop_id);
    if (s.stop_lat != null && s.stop_lon != null && (s.stop_lat !== 0 || s.stop_lon !== 0)) {
      coordsByStop.set(s.stop_id, { lat: s.stop_lat, lon: s.stop_lon });
    }
  }
  return { knownStops, coordsByStop };
}

export interface RunQualityCounters {
  obsRows: number;
  obsFlaggedRows: number;
  obsUpdated: number;
  stopRows: number;
  stopFlaggedRows: number;
  stopUpdated: number;
  /** occurrences per flag written to train_observations for this run */
  obsFlagCounts: Record<string, number>;
  /** occurrences per flag written to train_stop_events for this run */
  stopFlagCounts: Record<string, number>;
}

interface ObsDbRow {
  id: number; ts: number; source: string;
  observed_at: number | null; delay_seconds: number | null;
  location_id: string | null; quality_flags: string | null;
}

interface StopDbRow {
  stop_id: string; stop_sequence: number | null;
  sched_arr_epoch: number | null; actual_arr_epoch: number | null;
  quality_flags: string | null;
}

/**
 * Recompute and store quality_flags for every row of one run. Rows are only
 * rewritten when the serialized value differs, so re-running on an already
 * processed DB updates zero rows (idempotent).
 */
export function recomputeRunQuality(db: Db, runId: number, ref?: QualityReference): RunQualityCounters {
  const r = ref ?? loadQualityReference(db);
  const run = getRow<{ gtfs_trip_id: string | null }>(db, 'SELECT gtfs_trip_id FROM train_runs WHERE id=?', [runId]);
  const tripStopSeq = new Map<string, number>();
  if (run?.gtfs_trip_id != null) {
    for (const st of getRows<{ stop_id: string; stop_sequence: number }>(
      db, 'SELECT stop_id, stop_sequence FROM gtfs_stop_times WHERE trip_id=? ORDER BY stop_sequence ASC', [run.gtfs_trip_id],
    )) {
      tripStopSeq.set(st.stop_id, st.stop_sequence);
    }
  }
  const c: RunQualityCounters = {
    obsRows: 0, obsFlaggedRows: 0, obsUpdated: 0,
    stopRows: 0, stopFlaggedRows: 0, stopUpdated: 0,
    obsFlagCounts: {}, stopFlagCounts: {},
  };

  const obs = getRows<ObsDbRow>(
    db,
    'SELECT id, ts, source, observed_at, delay_seconds, location_id, quality_flags FROM train_observations WHERE run_id=? ORDER BY ts ASC, id ASC',
    [runId],
  );
  c.obsRows = obs.length;
  if (obs.length > 0) {
    const inputs: ObservationForQuality[] = obs.map((o) => ({
      id: o.id, ts: o.ts, source: o.source,
      observedAt: o.observed_at, delaySeconds: o.delay_seconds, locationId: o.location_id,
    }));
    const flags = flagRunObservations(inputs, { gtfsTripId: run?.gtfs_trip_id ?? null, tripStopSeq, knownStops: r.knownStops });
    const upd = db.prepare('UPDATE train_observations SET quality_flags=? WHERE id=?');
    for (let i = 0; i < obs.length; i++) {
      const rowFlags = flags[i]!;
      const value = serializeQualityFlags(rowFlags);
      if (value != null) {
        c.obsFlaggedRows++;
        for (const f of rowFlags) c.obsFlagCounts[f] = (c.obsFlagCounts[f] ?? 0) + 1;
      }
      if (value !== obs[i]!.quality_flags) {
        upd.run(value, obs[i]!.id);
        c.obsUpdated++;
      }
    }
  }

  const stops = getRows<StopDbRow>(
    db,
    'SELECT stop_id, stop_sequence, sched_arr_epoch, actual_arr_epoch, quality_flags FROM train_stop_events WHERE run_id=? ORDER BY stop_sequence ASC, sched_arr_epoch ASC, stop_id ASC',
    [runId],
  );
  c.stopRows = stops.length;
  if (stops.length > 0) {
    const events: StopEventForQuality[] = stops.map((s) => ({
      stopId: s.stop_id, stopSequence: s.stop_sequence,
      schedArrEpoch: s.sched_arr_epoch, actualArrEpoch: s.actual_arr_epoch,
    }));
    const flags = flagStopEventRuntimes(events, (id) => r.coordsByStop.get(id) ?? null);
    const upd = db.prepare('UPDATE train_stop_events SET quality_flags=? WHERE run_id=? AND stop_id=? AND stop_sequence=?');
    for (let i = 0; i < stops.length; i++) {
      const rowFlags = flags[i]!;
      const value = serializeQualityFlags(rowFlags);
      const s = stops[i]!;
      if (value != null) {
        c.stopFlaggedRows++;
        for (const f of rowFlags) c.stopFlagCounts[f] = (c.stopFlagCounts[f] ?? 0) + 1;
      }
      if (value !== s.quality_flags) {
        upd.run(value, runId, s.stop_id, s.stop_sequence ?? 0);
        c.stopUpdated++;
      }
    }
  }
  return c;
}

export interface QualitySummary {
  runs: number;
  obsRows: number;
  obsFlaggedRows: number;
  obsUpdated: number;
  stopRows: number;
  stopFlaggedRows: number;
  stopUpdated: number;
  /** occurrences per flag across train_observations */
  obsFlagCounts: Record<string, number>;
  /** occurrences per flag across train_stop_events */
  stopFlagCounts: Record<string, number>;
  elapsedMs: number;
}

/**
 * Backfill driver: reprocess every run that has observations or stop events,
 * overwriting quality_flags in place inside batched transactions. Pure
 * function of the stored rows — deterministic and idempotent (a second pass
 * reports obsUpdated=0, stopUpdated=0).
 */
export function recomputeAllQuality(db: Db, opts?: { onProgress?: (done: number, total: number) => void }): QualitySummary {
  const t0 = Date.now();
  const runIds = getRows<{ run_id: number }>(
    db,
    'SELECT DISTINCT run_id FROM train_observations UNION SELECT DISTINCT run_id FROM train_stop_events ORDER BY run_id ASC',
  ).map((r) => r.run_id);
  const ref = loadQualityReference(db);
  const s: QualitySummary = {
    runs: runIds.length, obsRows: 0, obsFlaggedRows: 0, obsUpdated: 0,
    stopRows: 0, stopFlaggedRows: 0, stopUpdated: 0,
    obsFlagCounts: {}, stopFlagCounts: {}, elapsedMs: 0,
  };
  const mergeCounts = (dst: Record<string, number>, src: Record<string, number>): void => {
    for (const [f, n] of Object.entries(src)) dst[f] = (dst[f] ?? 0) + n;
  };
  const BATCH = 500;
  for (let i = 0; i < runIds.length; i++) {
    if (i % BATCH === 0) db.exec('BEGIN IMMEDIATE');
    const c = recomputeRunQuality(db, runIds[i]!, ref);
    s.obsRows += c.obsRows; s.obsFlaggedRows += c.obsFlaggedRows; s.obsUpdated += c.obsUpdated;
    s.stopRows += c.stopRows; s.stopFlaggedRows += c.stopFlaggedRows; s.stopUpdated += c.stopUpdated;
    mergeCounts(s.obsFlagCounts, c.obsFlagCounts);
    mergeCounts(s.stopFlagCounts, c.stopFlagCounts);
    if ((i + 1) % BATCH === 0 || i === runIds.length - 1) db.exec('COMMIT');
    if (opts?.onProgress && ((i + 1) % 1000 === 0 || i === runIds.length - 1)) opts.onProgress(i + 1, runIds.length);
  }
  s.elapsedMs = Date.now() - t0;
  return s;
}

/** Convenience: total per-flag counts straight from the DB (post-backfill truth). */
export function countFlagsInDb(db: Db): { obsFlagCounts: Record<string, number>; stopFlagCounts: Record<string, number> } {
  const count = (sql: string): Record<string, number> => {
    const counts: Record<string, number> = {};
    for (const row of getRows<{ quality_flags: string }>(db, sql)) {
      for (const f of parseQualityFlags(row.quality_flags)) counts[f] = (counts[f] ?? 0) + 1;
    }
    return counts;
  };
  return {
    obsFlagCounts: count('SELECT quality_flags FROM train_observations WHERE quality_flags IS NOT NULL'),
    stopFlagCounts: count('SELECT quality_flags FROM train_stop_events WHERE quality_flags IS NOT NULL'),
  };
}
