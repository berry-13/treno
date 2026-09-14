/**
 * Minimal gradient-boosted regression trees (squared loss), dependency-free.
 * Depth-3 trees, quantile candidate splits, row subsampling for split
 * finding on large nodes. Trains on ~30k rows in a few seconds on an M-series
 * laptop — transit ETA is a small tabular problem; no GPU required.
 */
export interface GBTree {
  f?: number;
  thr?: number;
  left?: GBTree;
  right?: GBTree;
  leaf?: number;
}

export interface GBMForest {
  base: number;
  lr: number;
  trees: GBTree[];
}

const MAX_SPLIT_ROWS = 5000;
const CANDIDATES = 8;

function predictTree(t: GBTree, x: number[]): number {
  let node = t;
  while (node.leaf === undefined) {
    node = (x[node.f!]! <= node.thr!) ? node.left! : node.right!;
  }
  return node.leaf!;
}

export function predictGBM(m: GBMForest, x: number[]): number {
  let p = m.base;
  for (const t of m.trees) p += m.lr * predictTree(t, x);
  return p;
}

function fitTree(X: number[][], y: number[], idx: number[], depth: number, maxDepth: number, minLeaf: number): GBTree {
  let sum = 0;
  for (const i of idx) sum += y[i]!;
  const mean = sum / idx.length;
  if (depth >= maxDepth || idx.length < minLeaf * 2) return { leaf: mean };

  // greedy variance-reduction split with quantile candidate thresholds
  const rows = idx.length > MAX_SPLIT_ROWS
    ? (() => {
        const s: number[] = [];
        const step = idx.length / MAX_SPLIT_ROWS;
        for (let i = 0; i < MAX_SPLIT_ROWS; i++) s.push(idx[Math.floor(i * step)]!);
        return s;
      })()
    : idx;
  let sseAll = 0;
  for (const i of idx) sseAll += (y[i]! - mean) ** 2;

  let best: { f: number; thr: number; gain: number } | null = null;
  const d = X[0]!.length;
  for (let f = 1; f < d; f++) { // col 0 is the bias constant — skip
    const vals = rows.map((i) => X[i]![f]!).sort((a, b) => a - b);
    const cands = new Set<number>();
    for (let k = 1; k <= CANDIDATES; k++) cands.add(vals[Math.floor((k / (CANDIDATES + 1)) * vals.length)]!);
    for (const thr of cands) {
      let sl = 0, sr = 0, nl = 0, nr = 0;
      for (const i of rows) {
        const v = X[i]![f]!;
        const yv = y[i]!;
        if (v <= thr) { sl += yv; nl++; } else { sr += yv; nr++; }
      }
      if (nl < minLeaf || nr < minLeaf) continue;
      const gain = (sl * sl) / nl + (sr * sr) / nr - (sum * sum) / idx.length;
      if (gain > 0 && (best === null || gain > best.gain)) best = { f, thr, gain };
    }
  }
  void sseAll;
  if (best === null) return { leaf: mean };
  const leftIdx = idx.filter((i) => X[i]![best!.f]! <= best!.thr!);
  const rightIdx = idx.filter((i) => X[i]![best!.f]! > best!.thr!);
  return {
    f: best.f,
    thr: best.thr,
    left: fitTree(X, y, leftIdx, depth + 1, maxDepth, minLeaf),
    right: fitTree(X, y, rightIdx, depth + 1, maxDepth, minLeaf),
  };
}

export function fitGBM(X: number[][], y: number[], rounds = 150, lr = 0.08, maxDepth = 3, minLeaf = 40): GBMForest {
  const n = X.length;
  let base = 0;
  for (const v of y) base += v;
  base /= n;
  const pred = new Array<number>(n).fill(base);
  const trees: GBTree[] = [];
  for (let m = 0; m < rounds; m++) {
    const residual = new Array<number>(n);
    for (let i = 0; i < n; i++) residual[i] = y[i]! - pred[i]!;
    const tree = fitTree(X, residual, Array.from({ length: n }, (_, i) => i), 0, maxDepth, minLeaf);
    trees.push(tree);
    for (let i = 0; i < n; i++) pred[i]! += lr * predictTree(tree, X[i]!);
  }
  return { base, lr, trees };
}
