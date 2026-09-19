/**
 * Platform prediction P(platform = X) (GOAL.md §52, PLAN_complete_partials P2).
 *   npm run train:platforms
 *
 * Trains one binary GBM per known actual platform on pre-announcement
 * features only: station/line identity (hashed), scheduled departure hour,
 * weekday, the run's platform at its previous stop, and the historical mode
 * platform for (station, route) computed from the TRAIN window only. Note the
 * providers never expose a scheduled platform (platform_sched stays null) —
 * the honest baseline is therefore the historical mode, not "scheduled".
 *
 * Deployment gate (honest-claims, GOAL.md §52 "never present predicted
 * platforms as confirmed"): the model file is written only when validation
 * top-1 accuracy ≥ 85% AND it beats the historical-mode baseline on the
 * subset where the platform actually CHANGED vs that baseline — changes are
 * the only cases a user cares about. Otherwise nothing ships and serving
 * shows nothing until an actual platform lands.
 */
import { mkdirSync, writeFileSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '#core/config.ts';
import { log } from '#core/log.ts';
import { openTrenoDb } from '#gtfs/setup.ts';
import { fitGBM, predictGBM, type GBMForest } from './gbm.ts';

export const PLATFORMS_MODEL_VERSION = 'platforms-v1';
const MIN_PLATFORM = 1;
const MAX_PLATFORM = 30;

/** Deterministic string hash → [0, mod). Same function used at serving time. */
export function strHash(s: string, mod: number): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h) % mod;
}

interface RawRow {
  runId: number;
  stopId: string;
  routeId: string | null;
  actualPlatform: string;
  depEpochMs: number;
  stopSequence: number;
}

type TrainRow = RawRow & { prevPlatform: string | null };

export function platformFeatureRow(r: {
  stopId: string;
  routeId: string | null;
  hour: number;
  weekday: number;
  peak: number;
  prevPlatformNum: number;
  histTopPlatformNum: number;
  histTopShare: number;
}): number[] {
  return [
    1, // bias — gbm.ts skips col 0 for splits
    r.hour / 24,
    r.weekday / 7,
    r.peak,
    strHash(r.stopId, 997) / 997,
    r.routeId != null ? strHash(r.routeId, 97) / 97 : 0.5,
    r.prevPlatformNum / 10,
    r.histTopPlatformNum / 10,
    r.histTopShare,
  ];
}

export interface PlatformsModel {
  version: string;
  trainedAt: number;
  trainRows: number;
  valRows: number;
  top1Accuracy: number;
  baselineAccuracy: number;
  changeSubsetAccuracy: number;
  changeSubsetN: number;
  /** train-window mode platform per "stopId|routeId" — the baseline + a serving feature */
  modes: Record<string, string>;
  /** binary GBM per actual platform number */
  models: Record<string, GBMForest>;
}

function collectRows(): TrainRow[] {
  const db = openTrenoDb(loadConfig());
  const rows = db.prepare(
    `SELECT e.run_id, e.stop_id, e.platform_actual, e.stop_sequence, e.sched_dep_epoch, e.sched_arr_epoch, r.route_id
     FROM train_stop_events e JOIN train_runs r ON r.id = e.run_id
     WHERE e.platform_actual IS NOT NULL
       AND CAST(e.platform_actual AS INTEGER) BETWEEN ${MIN_PLATFORM} AND ${MAX_PLATFORM}
     ORDER BY COALESCE(e.sched_dep_epoch, e.sched_arr_epoch, 0) ASC`,
  ).all() as Array<{
    run_id: number; stop_id: string; platform_actual: string; stop_sequence: number | null;
    sched_dep_epoch: number | null; sched_arr_epoch: number | null; route_id: string | null;
  }>;
  db.close();
  const byRun = new Map<number, Array<{ seq: number; plat: string }>>();
  const out: RawRow[] = [];
  for (const r of rows) {
    if (r.stop_sequence == null) continue;
    let a = byRun.get(r.run_id);
    if (!a) byRun.set(r.run_id, a = []);
    a.push({ seq: r.stop_sequence, plat: r.platform_actual });
  }
  const prevPlat = new Map<string, string>();
  for (const [runId, a] of byRun) {
    a.sort((x, y) => x.seq - y.seq);
    for (let i = 1; i < a.length; i++) prevPlat.set(runId + '#' + a[i]!.seq, a[i - 1]!.plat);
  }
  for (const r of rows) {
    if (r.stop_sequence == null) continue;
    const dep = r.sched_dep_epoch ?? r.sched_arr_epoch;
    if (dep == null) continue;
    out.push({
      runId: r.run_id, stopId: r.stop_id, routeId: r.route_id, actualPlatform: r.platform_actual,
      depEpochMs: dep, stopSequence: r.stop_sequence,
    });
  }
  return out.map((r) => ({ ...r, prevPlatform: prevPlat.get(r.runId + '#' + r.stopSequence) ?? null }));
}

export function trainPlatforms(): PlatformsModel | null {
  const all = collectRows();
  if (all.length < 2000) {
    log.warn('platforms: not enough labelled rows yet', { have: all.length, need: 2000 });
    return null;
  }
  // time-ordered split (rows arrive sorted by scheduled departure)
  const cut = Math.floor(all.length * 0.8);
  const train = all.slice(0, cut);
  const val = all.slice(cut);
  // historical mode per (station, route) from the TRAIN window only — this is
  // both the baseline and a model feature; unseen val tuples fall back to the
  // train-wide global mode
  const hist = new Map<string, Map<string, number>>();
  const global = new Map<string, number>();
  for (const r of train) {
    const k = r.stopId + '|' + (r.routeId ?? '');
    let m = hist.get(k);
    if (!m) hist.set(k, m = new Map());
    m.set(r.actualPlatform, (m.get(r.actualPlatform) ?? 0) + 1);
    global.set(r.actualPlatform, (global.get(r.actualPlatform) ?? 0) + 1);
  }
  let globalTop = ''; let n = 0;
  for (const [p, c] of global) if (c > n) { n = c; globalTop = p; }
  const modes: Record<string, string> = {};
  const modeOf = (k: string): { top: string; share: number } => {
    const m = hist.get(k);
    if (!m || m.size === 0) return { top: globalTop, share: 0 };
    let top = '', c = 0, tot = 0;
    for (const [p, cc] of m) { tot += cc; if (cc > c) { c = cc; top = p; } }
    return { top, share: Math.round((c / tot) * 100) / 100 };
  };
  const feat = (r: TrainRow): number[] => {
    const { top, share } = modeOf(r.stopId + '|' + (r.routeId ?? ''));
    const d = new Date(r.depEpochMs);
    const hour = Number(d.toLocaleString('en-GB', { timeZone: 'Europe/Rome', hour: 'numeric', hour12: false })) || 12;
    return platformFeatureRow({
      stopId: r.stopId, routeId: r.routeId, hour, weekday: d.getUTCDay(),
      peak: (hour >= 7 && hour < 9) || (hour >= 16 && hour < 19) ? 1 : 0,
      prevPlatformNum: r.prevPlatform != null && Number.isInteger(Number(r.prevPlatform)) ? Number(r.prevPlatform) : 0,
      histTopPlatformNum: Number(top), histTopShare: share,
    });
  };
  for (const k of hist.keys()) modes[k] = modeOf(k).top;

  // one binary GBM per platform seen in train
  const platforms = [...new Set(train.map((r) => r.actualPlatform))];
  const Xtr = train.map(feat);
  const models: Record<string, GBMForest> = {};
  for (const p of platforms) {
    const y = train.map((r) => (r.actualPlatform === p ? 1 : 0));
    models[p] = fitGBM(Xtr, y, 80, 0.08, 3, 30);
  }
  const predict = (r: TrainRow): string => {
    const row = feat(r);
    let best = ''; let bestS = -Infinity;
    for (const [p, gbm] of Object.entries(models)) {
      const s = predictGBM(gbm, row);
      if (s > bestS) { bestS = s; best = p; }
    }
    return best;
  };
  let ok = 0, baseOk = 0, chOk = 0, chN = 0;
  for (const r of val) {
    const p = predict(r);
    const baseline = modeOf(r.stopId + '|' + (r.routeId ?? '')).top;
    if (p === r.actualPlatform) ok++;
    if (baseline === r.actualPlatform) baseOk++;
    if (baseline !== r.actualPlatform) {
      chN++;
      if (p === r.actualPlatform) chOk++;
    }
  }
  const acc = ok / val.length;
  const baseAcc = baseOk / val.length;
  const model: PlatformsModel = {
    version: PLATFORMS_MODEL_VERSION,
    trainedAt: Date.now(),
    trainRows: train.length,
    valRows: val.length,
    top1Accuracy: Math.round(acc * 1000) / 1000,
    baselineAccuracy: Math.round(baseAcc * 1000) / 1000,
    changeSubsetAccuracy: chN > 0 ? Math.round((chOk / chN) * 1000) / 1000 : 0,
    changeSubsetN: chN,
    modes,
    models,
  };
  log.info('platforms: validation', {
    rows: all.length, top1: model.top1Accuracy, baseline: model.baselineAccuracy,
    changeSubset: model.changeSubsetAccuracy, changeN: chN,
  });
  const gate = acc >= 0.85 && acc >= baseAcc - 0.02 && chN >= 30 && model.changeSubsetAccuracy >= 0.25;
  if (!gate) {
    log.error('platforms: gate failed — model NOT deployed', {
      top1: model.top1Accuracy, baseline: model.baselineAccuracy, changeSubset: model.changeSubsetAccuracy, changeN: chN,
    });
    return null;
  }
  const dir = join(loadConfig().dataDir, 'models');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'platforms-v1.json'), JSON.stringify(model));
  log.info('platforms: model deployed', { file: join(dir, 'platforms-v1.json') });
  return model;
}

// MARK: - serving (hot-reload like residual/connections models)

let cache: { mtime: number; model: PlatformsModel | null } | null = null;

export function getPlatformsModel(): PlatformsModel | null {
  const file = join(loadConfig().dataDir, 'models', 'platforms-v1.json');
  try {
    const mtime = statSync(file).mtimeMs;
    if (cache && cache.mtime === mtime) return cache.model;
    const model = JSON.parse(readFileSync(file, 'utf8')) as PlatformsModel;
    cache = { mtime, model };
    return model;
  } catch {
    if (!existsSync(file)) cache = { mtime: 0, model: null };
    return null;
  }
}

export interface PlatformPrediction { n: string; p: number }

/** Top likely platforms for a boarding stop, or null when no model / no
 *  confidence. Never called for stops that already have an actual platform. */
export function predictPlatforms(args: {
  stopId: string;
  routeId: string | null;
  depEpochMs: number | null;
  prevPlatform: string | null;
}): PlatformPrediction[] | null {
  const model = getPlatformsModel();
  if (!model) return null;
  const d = args.depEpochMs != null ? new Date(args.depEpochMs) : new Date();
  const hour = Number(d.toLocaleString('en-GB', { timeZone: 'Europe/Rome', hour: 'numeric', hour12: false })) || 12;
  const mode = model.modes[args.stopId + '|' + (args.routeId ?? '')] ?? null;
  const row = platformFeatureRow({
    stopId: args.stopId, routeId: args.routeId, hour, weekday: d.getUTCDay(),
    peak: (hour >= 7 && hour < 9) || (hour >= 16 && hour < 19) ? 1 : 0,
    prevPlatformNum: args.prevPlatform != null && Number.isInteger(Number(args.prevPlatform)) ? Number(args.prevPlatform) : 0,
    histTopPlatformNum: mode != null ? Number(mode) : 0,
    histTopShare: mode != null ? 0.5 : 0,
  });
  const scores = Object.entries(model.models).map(([p, gbm]) => ({ p, s: Math.exp(predictGBM(gbm, row)) }));
  const tot = scores.reduce((a, b) => a + b.s, 0);
  if (!(tot > 0)) return null;
  const sorted = scores.map((x) => ({ n: x.p, p: Math.round((x.s / tot) * 1000) / 1000 })).sort((a, b) => b.p - a.p);
  return sorted.filter((x) => x.p >= 0.1).slice(0, 3);
}

// standalone trainer
if (process.argv[1] && process.argv[1].endsWith('train-platforms.ts')) {
  trainPlatforms();
}
