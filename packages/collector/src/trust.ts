/**
 * Contextual source trust model (GOAL.md §77): reliability is a property of
 * (field class, source), never one fixed global ranking. A source that is
 * authoritative for one field can be second-tier for another — ViaggiaTreno
 * leads for current delay, while both MIA and ViaggiaTreno are equally
 * ground-truth for realized passed-stop timestamps, and position is simply
 * the freshest infrastructure observation.
 *
 * This module is deliberately PURE: no DB, no imports. Callers pass a health
 * snapshot (see healthSnapshot) so degradation logic is testable in isolation.
 */
export type TrustLevel = 'HIGH' | 'MEDIUM' | 'LOW';

/** Field classes with distinct reliability profiles (GOAL.md §77). */
export type FieldClass =
  | 'actual_stop_time' // realized passed-stop timestamps (ground truth)
  | 'current_delay' // live delay right now
  | 'future_eta' // predicted time at a stop the train has not passed yet
  | 'position'; // last-known vehicle position

export type SourceHealthState = 'HEALTHY' | 'DEGRADED' | 'PAUSED' | 'UNKNOWN';

export interface TrustRule {
  /** Per-source reliability for this field class; unknown sources rank LOW. */
  perSource: Readonly<Record<string, TrustLevel>>;
  /** Position uses a freshness rule instead of the trust ladder. */
  rule?: 'FRESHEST_INFRASTRUCTURE_WINS';
  /** Sources whose reliability for this field is our own model confidence
   *  (0..1 on the candidate): >=0.75 HIGH, >=0.5 MEDIUM, else LOW. */
  modelConfidenceSources?: readonly string[];
}

/**
 * The declarative trust table (GOAL.md §77). Edit this table — not call
 * sites — when reliability beliefs change.
 */
export const FIELD_TRUST: Readonly<Record<FieldClass, TrustRule>> = {
  actual_stop_time: { perSource: { mia: 'HIGH', viaggiatreno: 'HIGH' } },
  current_delay: { perSource: { viaggiatreno: 'HIGH', mia: 'MEDIUM' } },
  future_eta: { perSource: { gtfsrt: 'HIGH', mia: 'MEDIUM' }, modelConfidenceSources: ['ours'] },
  position: { rule: 'FRESHEST_INFRASTRUCTURE_WINS', perSource: {} },
};

const LEVEL_RANK: Readonly<Record<TrustLevel, number>> = { HIGH: 3, MEDIUM: 2, LOW: 1 };

/** Sources that observe infrastructure reality (usable for position). */
const INFRASTRUCTURE_SOURCES: ReadonlySet<string> = new Set(['mia', 'viaggiatreno', 'gtfsrt']);

export interface TrustCandidate<V = unknown> {
  source: string;
  value: V;
  /** Observation time (ms epoch); null = unknown age, ranks oldest. */
  observedAt: number | null;
  /** 0..1 — only consulted for the field's modelConfidenceSources. */
  modelConfidence?: number | null;
  /** Per-candidate health override; wins over the health snapshot. */
  sourceHealth?: SourceHealthState | null;
}

export interface ResolvedCandidate<V = unknown> extends TrustCandidate<V> {
  /** Effective trust after health degradation; null when a rule (not the
   *  trust ladder) made the pick, e.g. freshest-infrastructure position. */
  trust: TrustLevel | null;
}

export interface TrustDegradation {
  source: string;
  from: TrustLevel;
  to: TrustLevel;
  state: SourceHealthState;
}

export interface TrustResolution<V = unknown> {
  chosen: ResolvedCandidate<V> | null;
  /** Best-ranked candidate from a DIFFERENT source than the chosen one. */
  runnerUp: ResolvedCandidate<V> | null;
  /** |chosen.value - runnerUp.value| in seconds when both are numeric. */
  disagreementSeconds: number | null;
  reason: string;
  /** Health-driven demotions applied to the candidates. */
  degraded: TrustDegradation[];
}

/** Per-field pick provenance embedded in the fused state (GOAL.md §77). */
export interface FusedProvenancePick {
  source: string;
  /** Effective trust level, or null when a rule (freshness) made the pick. */
  trust: TrustLevel | null;
  observedAt: number | null;
  ageSec: number | null;
  reason: string;
}

/** Normalize provider_health-style rows into a {source -> state} snapshot. */
export function healthSnapshot(
  rows: ReadonlyArray<{ source: string; state: string | null | undefined }>,
): Record<string, SourceHealthState> {
  const out: Record<string, SourceHealthState> = {};
  for (const r of rows) {
    const s = (r.state ?? '').toUpperCase();
    out[r.source] = s === 'HEALTHY' || s === 'DEGRADED' || s === 'PAUSED' ? s : 'UNKNOWN';
  }
  return out;
}

function demote(level: TrustLevel, state: SourceHealthState): TrustLevel {
  if (state !== 'DEGRADED' && state !== 'PAUSED') return level;
  const steps = state === 'PAUSED' ? 2 : 1; // DEGRADED −1, PAUSED −2 (floor LOW)
  const rank = Math.max(LEVEL_RANK.LOW, LEVEL_RANK[level] - steps);
  return (['LOW', 'MEDIUM', 'HIGH'] as const)[rank - 1]!;
}

function baseLevel(rule: TrustRule, c: TrustCandidate): TrustLevel {
  if (rule.modelConfidenceSources != null && rule.modelConfidenceSources.includes(c.source)) {
    const mc = c.modelConfidence;
    if (mc == null || !Number.isFinite(mc)) return 'LOW';
    if (mc >= 0.75) return 'HIGH';
    if (mc >= 0.5) return 'MEDIUM';
    return 'LOW';
  }
  return rule.perSource[c.source] ?? 'LOW';
}

function levelLabel(t: TrustLevel | null): string {
  return t ?? 'RULE';
}

/**
 * Resolve one field class among competing source candidates.
 *
 * Ordering:
 *  - position: FRESHEST_INFRASTRUCTURE_WINS — freshest observation among
 *    infrastructure sources (mia/viaggiatreno/gtfsrt), trust only breaks
 *    exact-timestamp ties.
 *  - everything else: highest trust wins; equal trust prefers fresher;
 *    remaining ties break deterministically by source name.
 *  - agreementSec (>0): when the trust winner and a fresher candidate from
 *    another source agree within this many seconds, the fresher one is
 *    chosen — sources that concur carry no conflict, so freshness decides
 *    (this reproduces the legacy freshest-wins pick in the common case and
 *    lets the trust ladder take over only on real disagreement).
 *
 * A source whose provider_health is DEGRADED/PAUSED (per the snapshot or a
 * per-candidate override) is demoted before ranking: DEGRADED one level,
 * PAUSED two levels, floored at LOW.
 */
export function resolveTrust<V>(
  fieldClass: FieldClass,
  candidates: readonly TrustCandidate<V>[],
  health: Readonly<Record<string, SourceHealthState>> = {},
  opts: { agreementSec?: number } = {},
): TrustResolution<V> {
  const rule = FIELD_TRUST[fieldClass];
  const degraded: TrustDegradation[] = [];

  const resolved: Array<ResolvedCandidate<V> & { _rankLevel: number }> = candidates.map((c) => {
    const from = baseLevel(rule, c);
    const state = c.sourceHealth ?? health[c.source] ?? 'UNKNOWN';
    const to = demote(from, state);
    if (to !== from) degraded.push({ source: c.source, from, to, state });
    return { ...c, trust: rule.rule != null ? null : to, _rankLevel: LEVEL_RANK[to] };
  });

  if (resolved.length === 0) {
    return { chosen: null, runnerUp: null, disagreementSeconds: null, reason: `no candidates for ${fieldClass}`, degraded };
  }

  const byFreshnessDesc = (a: { observedAt: number | null }, b: { observedAt: number | null }): number =>
    (b.observedAt ?? -Infinity) - (a.observedAt ?? -Infinity);
  const byName = (a: { source: string }, b: { source: string }): number => a.source.localeCompare(b.source);

  let ranked: typeof resolved;
  let reason: string;

  if (rule.rule === 'FRESHEST_INFRASTRUCTURE_WINS') {
    const infra = resolved.filter((c) => INFRASTRUCTURE_SOURCES.has(c.source));
    ranked = (infra.length > 0 ? infra : resolved)
      .slice()
      .sort((a, b) => byFreshnessDesc(a, b) || b._rankLevel - a._rankLevel || byName(a, b));
    const chosen = ranked[0]!;
    const ages = ranked
      .map((c) => `${c.source}@${c.observedAt ?? '?'}`)
      .join(' vs ');
    reason = `${chosen.source} wins: freshest infrastructure observation (${ages})`;
  } else {
    ranked = resolved
      .slice()
      .sort((a, b) => b._rankLevel - a._rankLevel || byFreshnessDesc(a, b) || byName(a, b));
    const chosen = ranked[0]!;
    const runner = ranked.find((c) => c.source !== chosen.source) ?? null;

    // agreement window: no real conflict -> let freshness decide (legacy pick)
    const agreementSec = opts.agreementSec ?? 0;
    if (agreementSec > 0 && runner != null) {
      const fresher = resolved.slice().sort((a, b) => byFreshnessDesc(a, b) || byName(a, b))[0]!;
      const dv = Math.abs(Number(chosen.value) - Number(fresher.value));
      if (
        fresher.source !== chosen.source
        && fresher.observedAt != null
        && chosen.observedAt != null
        && fresher.observedAt > chosen.observedAt
        && Number.isFinite(dv)
        && dv <= agreementSec
      ) {
        const idx = ranked.findIndex((c) => c === fresher);
        if (idx > 0) ranked.splice(idx, 1);
        ranked.unshift(fresher);
        reason = `${fresher.source} fresher and agrees with ${chosen.source} within ${agreementSec}s (delta ${Math.round(dv)}s); freshness decides (${fieldClass})`;
        return finish(ranked, degraded, reason);
      }
    }

    if (runner == null) {
      reason = `${chosen.source}: sole candidate (${fieldClass}, trust ${levelLabel(chosen.trust)})`;
    } else if (chosen._rankLevel > runner._rankLevel) {
      reason = `${chosen.source}:${levelLabel(chosen.trust)} beats ${runner.source}:${levelLabel(runner.trust)} (${fieldClass} trust table)`;
    } else {
      const by = chosen.observedAt != null && runner.observedAt != null
        ? `, fresher by ${Math.round((chosen.observedAt - runner.observedAt) / 1000)}s`
        : '';
      reason = `${chosen.source} and ${runner.source} equal trust ${levelLabel(chosen.trust)}${by}; fresher wins (${fieldClass})`;
    }
  }

  return finish(ranked, degraded, reason);
}

function finish<V>(
  ranked: Array<ResolvedCandidate<V> & { _rankLevel: number }>,
  degraded: TrustDegradation[],
  reason: string,
): TrustResolution<V> {
  const { _rankLevel: _c, ...chosenRaw } = ranked[0]!;
  const chosen: ResolvedCandidate<V> = chosenRaw;
  const runnerUpRaw = ranked.find((c) => c.source !== chosen.source);
  const runnerUp: ResolvedCandidate<V> | null = runnerUpRaw == null ? null : (() => {
    const { _rankLevel: _r, ...rest } = runnerUpRaw;
    return rest;
  })();
  const a = chosen.value as unknown;
  const b = runnerUp?.value as unknown;
  const disagreementSeconds = typeof a === 'number' && typeof b === 'number'
    ? Math.round(Math.abs(a - b))
    : null;
  if (disagreementSeconds != null) reason += `; disagreement ${disagreementSeconds}s`;
  if (degraded.length > 0) {
    reason += `; degraded ${degraded.map((d) => `${d.source} ${d.from}->${d.to} (${d.state})`).join(', ')}`;
  }
  return { chosen, runnerUp, disagreementSeconds, reason, degraded };
}

/** Alias matching the GOAL §77 vocabulary. */
export const resolve = resolveTrust;
