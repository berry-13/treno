/**
 * Railway graph + probabilistic location inference (GOAL.md §83).
 *
 * Map matching for train observations that name a location: given the last
 * confirmed point (a station OR a non-passenger reporting point such as
 * "Bivio Casirate"), say which points are plausible next and which segment
 * the train most likely occupies.
 *
 * This module is PURE: it knows nothing about SQLite, GTFS or providers.
 * Edges (with historical traversal counts) are assembled elsewhere
 * (railgraph-build.ts) and fed to buildRailGraph().
 *
 * Honesty rule (§16): if the last confirmed point is not a node of the
 * graph, inferLocation() degrades to explicit nulls — it never guesses a
 * nearby point and never invents a uniform distribution.
 */

/** One directed edge with the number of historical traversals observed. */
export interface RailEdgeInput {
  fromId: string;
  toId: string;
  count: number;
}

/** An outgoing edge after normalization: p = count / total outgoing count. */
export interface RailSuccessor {
  key: string;
  count: number;
  /** edge prior: share of all historical traversals leaving `from` */
  p: number;
}

export type RailNodeKind = 'station' | 'reporting_point' | 'unknown';

/** Optional display metadata a builder may attach per node key. */
export interface RailNodeInfo {
  name: string | null;
  kind: RailNodeKind;
  /** total outgoing traversal count (0 for sink nodes) */
  outTotal: number;
}

export interface RailGraph {
  /** node key → outgoing edges sorted by p desc, count desc, key asc */
  adjacency: Map<string, RailSuccessor[]>;
  nodes: Map<string, RailNodeInfo>;
  /** distinct directed edges after merging */
  edgeCount: number;
  builtAt: number;
}

export interface PlausibleNext {
  key: string;
  /** renormalized share within the returned top-k */
  p: number;
}

export interface LocationInference {
  lastConfirmed: string;
  /** top-k plausible next points (renormalized); null = key unknown to graph */
  plausibleNext: PlausibleNext[] | null;
  /** segment most likely occupied right now; null = key unknown / dead end */
  likelySegment: { from: string; to: string; p: number } | null;
}

export interface InferOptions {
  /** how many plausible next points to return (default 3) */
  topK?: number;
  /**
   * Where the train came from. When known, the back-edge is masked out
   * before normalization (a train at a mid-line reporting point otherwise
   * splits its probability between both directions of travel).
   */
  previousKey?: string | null;
}

/**
 * Fold directed edges (with traversal counts) into an adjacency structure
 * with normalized edge priors. Self-loops are dropped; counts <= 0 are
 * ignored. Node metadata for keys with no outgoing edge is preserved as a
 * sink ({@link RailNodeInfo} with outTotal 0) when supplied via nodeInfos.
 */
export function buildRailGraph(
  edges: RailEdgeInput[],
  nodeInfos?: Iterable<[string, RailNodeInfo]>,
): RailGraph {
  const counts = new Map<string, Map<string, number>>();
  const nodes = new Map<string, RailNodeInfo>();
  for (const [key, info] of nodeInfos ?? []) nodes.set(key, { ...info });

  for (const e of edges) {
    if (!e || e.fromId === e.toId || !Number.isFinite(e.count) || e.count <= 0) continue;
    let out = counts.get(e.fromId);
    if (!out) counts.set(e.fromId, out = new Map<string, number>());
    out.set(e.toId, (out.get(e.toId) ?? 0) + e.count);
    if (!nodes.has(e.fromId)) nodes.set(e.fromId, { name: null, kind: 'unknown', outTotal: 0 });
    if (!nodes.has(e.toId)) nodes.set(e.toId, { name: null, kind: 'unknown', outTotal: 0 });
  }

  const adjacency = new Map<string, RailSuccessor[]>();
  let edgeCount = 0;
  for (const [from, out] of counts) {
    let total = 0;
    for (const c of out.values()) total += c;
    const succ: RailSuccessor[] = [...out.entries()]
      .map(([key, count]) => ({ key, count, p: count / total }))
      .sort((a, b) => (b.p - a.p) || (b.count - a.count) || (a.key < b.key ? -1 : 1));
    adjacency.set(from, succ);
    edgeCount += succ.length;
    const info = nodes.get(from);
    if (info) info.outTotal = total;
  }

  return { adjacency, nodes, edgeCount, builtAt: Date.now() };
}

export function isKnownNode(graph: RailGraph, key: string | null | undefined): boolean {
  return key != null && (graph.adjacency.has(key) || graph.nodes.has(key));
}

/**
 * Probabilistic location inference from the last confirmed point.
 *
 * - plausibleNext: the top-k outgoing edges by traversal-share, renormalized
 *   within the top-k (so a masked back-edge or a sliced tail does not leak
 *   mass). p sums to ~1 over the returned list.
 * - likelySegment: the edge to the single most plausible next point, with
 *   its UN-renormalized share of all outgoing traversals (an honest
 *   confidence in "the train is on this segment", not a ranking artifact).
 *
 * If the key is unknown to the graph → { lastConfirmed, null, null }.
 * If the node is a sink (terminal station) → plausibleNext: [] and
 * likelySegment: null — nothing is next; that is the honest answer.
 */
export function inferLocation(
  graph: RailGraph,
  lastLocationKey: string | null | undefined,
  opts?: InferOptions,
): LocationInference {
  const key = lastLocationKey ?? null;
  if (key == null || !isKnownNode(graph, key)) {
    return { lastConfirmed: key ?? '', plausibleNext: null, likelySegment: null };
  }

  const topK = Math.max(1, Math.floor(opts?.topK ?? 3));
  const previous = opts?.previousKey ?? null;
  let successors = graph.adjacency.get(key) ?? [];
  if (previous != null) {
    const masked = successors.filter((s) => s.key !== previous);
    // masking removed everything (end-of-line shuttle?) → keep the full set
    if (masked.length > 0) successors = masked;
  }

  if (successors.length === 0) {
    // sink node: report honestly that nothing is next
    return { lastConfirmed: key, plausibleNext: [], likelySegment: null };
  }

  const top = successors.slice(0, topK);
  const topTotal = top.reduce((s, e) => s + e.p, 0);
  const plausibleNext: PlausibleNext[] = topTotal > 0
    ? top.map((e) => ({ key: e.key, p: e.p / topTotal }))
    : top.map((e) => ({ key: e.key, p: 1 / top.length }));

  return {
    lastConfirmed: key,
    plausibleNext,
    likelySegment: { from: key, to: top[0]!.key, p: top[0]!.p },
  };
}
