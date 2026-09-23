/**
 * Builds the railway graph for §83 location inference from the local store.
 * Read-only: SELECTs only — no writes, no schema changes.
 *
 * Node key space (stable across processes):
 *   - GTFS stop ids from gtfs_stop_times (passenger stations);
 *   - observation location_ids when they are GTFS stop ids (MIA stations use
 *     the same id space);
 *   - observation location_ids whose NAME matches a GTFS stop get bridged to
 *     that stop id (RFI and Trenord disagree on ids for a few stations, e.g.
 *     Brescia S01717 vs S09999 — the uppercase name unifies them);
 *   - everything else (non-passenger reporting points like "Bivio Casirate")
 *     falls back to the raw location_id when the provider gives one (RFI ids
 *     for points with no GTFS counterpart), else "n:" + slug(UPPERCASE name).
 *
 * Edges (directed, counted):
 *   1. consecutive stop pairs per trip in gtfs_stop_times (schedule topology);
 *   2. consecutive DISTINCT locations observed per (run, source) in
 *      train_observations — this is how reporting points enter the graph.
 *      Sequencing is per source, not per run: sources disagree about where a
 *      train is at the same instant (MIA often lags at the origin), and
 *      interleaving them by ts would fabricate transitions.
 */
import { getRows, type Db } from './db.ts';
import { buildRailGraph, type RailEdgeInput, type RailGraph, type RailNodeInfo } from './railgraph.ts';

/** Case-insensitive stable slug for name-only locations ("Bivio Casirate" → n:BIVIO-CASIRATE). */
export function slugLocationName(name: string | null | undefined): string | null {
  const s = (name ?? '').trim().toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s === '' ? null : 'n:' + s;
}

/** UPPER(stop_name) → stop_id and stop_id → name, from the loaded GTFS feed. */
export interface StopKeyspace {
  byUpperName: Map<string, string>;
  stopIds: Set<string>;
  stopName: (id: string) => string | null;
}

export function buildStopKeyspace(db: Db): StopKeyspace {
  const rows = getRows<{ stop_id: string; stop_name: string | null }>(db, 'SELECT stop_id, stop_name FROM gtfs_stops');
  const byUpperName = new Map<string, string>();
  const names = new Map<string, string | null>();
  for (const r of rows) {
    names.set(r.stop_id, r.stop_name);
    const u = (r.stop_name ?? '').trim().toUpperCase();
    if (u !== '' && !byUpperName.has(u)) byUpperName.set(u, r.stop_id); // uppercase names are unique in this feed
  }
  return { byUpperName, stopIds: new Set(names.keys()), stopName: (id) => names.get(id) ?? null };
}

/** Canonical graph key for one observation's location columns (null = no location). */
export function canonicalLocationKey(
  ks: StopKeyspace,
  locationId: string | null | undefined,
  locationName: string | null | undefined,
): string | null {
  const name = (locationName ?? '').trim();
  if (locationId && locationId !== '') {
    if (ks.stopIds.has(locationId)) return locationId;
    const bridged = name !== '' ? ks.byUpperName.get(name.toUpperCase()) : undefined;
    return bridged ?? locationId;
  }
  if (name !== '') {
    const bridged = ks.byUpperName.get(name.toUpperCase());
    return bridged ?? slugLocationName(name);
  }
  return null;
}

export interface ObsLocationRow {
  run_id: number;
  source: string;
  ts: number;
  location_id: string | null;
  location_name: string | null;
  location_kind: string | null;
}

/**
 * Per (run, source) sequence of canonical location keys, consecutive
 * duplicates collapsed, oldest → newest. Sequences of length < 2 are dropped.
 */
export function observationKeySequences(db: Db, ks: StopKeyspace): Array<{ runId: number; source: string; keys: string[] }> {
  const rows = getRows<ObsLocationRow>(
    db, 'SELECT run_id, source, ts, location_id, location_name, location_kind FROM train_observations ORDER BY run_id, source, ts');
  const out: Array<{ runId: number; source: string; keys: string[] }> = [];
  let curRun = -1;
  let curSource = '';
  for (const r of rows) {
    const key = canonicalLocationKey(ks, r.location_id, r.location_name);
    if (key == null) continue;
    const seq = out[out.length - 1];
    if (!seq || seq.runId !== r.run_id || seq.source !== r.source) {
      out.push({ runId: r.run_id, source: r.source, keys: [key] });
      continue;
    }
    const prev = seq.keys[seq.keys.length - 1];
    if (prev !== key) seq.keys.push(key);
  }
  return out.filter((s) => s.keys.length >= 2);
}

export interface RailGraphBuildStats {
  /** distinct directed edges contributed by the schedule */
  gtfsEdges: number;
  /** total (non-distinct) consecutive stop pairs scanned in the schedule */
  gtfsPairTotal: number;
  /** distinct directed edges contributed by observations (incl. overlap with schedule edges) */
  obsEdges: number;
  /** total (non-distinct) distinct-location transitions scanned in observations */
  obsTransitionTotal: number;
  /** runs that contributed at least one located observation */
  runs: number;
}

export interface RailGraphBundle {
  graph: RailGraph;
  keyspace: StopKeyspace;
  stats: RailGraphBuildStats;
}

const EDGE_SEP = '\u0000';

function bump(map: Map<string, number>, from: string, to: string): void {
  const k = from + EDGE_SEP + to;
  map.set(k, (map.get(k) ?? 0) + 1);
}

/** Scan the store and assemble the graph (both edge families). */
export function buildRailGraphFromDb(db: Db): RailGraphBundle {
  const keyspace = buildStopKeyspace(db);
  const gtfsCounts = new Map<string, number>();
  const obsCounts = new Map<string, number>();
  const nodeMeta = new Map<string, RailNodeInfo>();

  // — family 1: schedule topology (consecutive stop pairs per trip) —
  let gtfsPairTotal = 0;
  {
    const rows = getRows<{ trip_id: string; stop_id: string }>(
      db, 'SELECT trip_id, stop_id FROM gtfs_stop_times ORDER BY trip_id, stop_sequence');
    let trip = '\u0000';
    let prev: string | null = null;
    for (const r of rows) {
      if (r.trip_id !== trip) { trip = r.trip_id; prev = null; }
      if (prev != null && prev !== r.stop_id) { bump(gtfsCounts, prev, r.stop_id); gtfsPairTotal++; }
      prev = r.stop_id;
    }
    for (const s of getRows<{ stop_id: string; stop_name: string | null }>(db, 'SELECT stop_id, stop_name FROM gtfs_stops')) {
      nodeMeta.set(s.stop_id, { name: s.stop_name, kind: 'station', outTotal: 0 });
    }
  }

  // — family 2: observed consecutive distinct locations per (run, source) —
  let obsTransitionTotal = 0;
  const runs = new Set<number>();
  {
    const rows = getRows<ObsLocationRow>(
      db, 'SELECT run_id, source, ts, location_id, location_name, location_kind FROM train_observations ORDER BY run_id, source, ts');
    let curRun = -1;
    let curSource = '';
    let lastKey: string | null = null;
    for (const r of rows) {
      const key = canonicalLocationKey(keyspace, r.location_id, r.location_name);
      if (key == null) continue;
      // display metadata: prefer an explicitly observed name/kind
      if (!nodeMeta.has(key) || nodeMeta.get(key)!.name == null) {
        const isStop = keyspace.stopIds.has(key);
        const k = r.location_kind === 'station' || (r.location_kind !== 'reporting_point' && isStop) ? 'station' : 'reporting_point';
        nodeMeta.set(key, { name: (r.location_name ?? '').trim() || keyspace.stopName(key), kind: k, outTotal: nodeMeta.get(key)?.outTotal ?? 0 });
      }
      if (r.run_id !== curRun || r.source !== curSource) {
        curRun = r.run_id; curSource = r.source; lastKey = key; runs.add(r.run_id);
        continue;
      }
      if (key !== lastKey && lastKey != null) { bump(obsCounts, lastKey, key); obsTransitionTotal++; }
      lastKey = key;
    }
  }

  // merge: an edge seen by both families sums its counts (one traversal
  // counted once by the schedule and once per observed run reinforces it)
  const merged = new Map<string, number>();
  for (const [k, c] of gtfsCounts) merged.set(k, (merged.get(k) ?? 0) + c);
  for (const [k, c] of obsCounts) merged.set(k, (merged.get(k) ?? 0) + c);
  const edgeList: RailEdgeInput[] = [...merged.entries()].map(([k, count]) => {
    const sep = k.indexOf(EDGE_SEP);
    return { fromId: k.slice(0, sep), toId: k.slice(sep + 1), count };
  });

  const graph = buildRailGraph(edgeList, nodeMeta.entries());
  return {
    graph,
    keyspace,
    stats: {
      gtfsEdges: gtfsCounts.size,
      gtfsPairTotal,
      obsEdges: obsCounts.size,
      obsTransitionTotal,
      runs: runs.size,
    },
  };
}

let cached: RailGraphBundle | null = null;

/**
 * Process-wide cached graph: built once, rebuilt lazily only while empty
 * (e.g. the GTFS feed had not been loaded yet at first request). Read-only
 * scans, so the cache never needs invalidation for correctness of serving.
 */
export function getCachedRailGraph(db: Db): RailGraphBundle {
  if (cached && cached.graph.edgeCount > 0) return cached;
  cached = buildRailGraphFromDb(db);
  return cached;
}
