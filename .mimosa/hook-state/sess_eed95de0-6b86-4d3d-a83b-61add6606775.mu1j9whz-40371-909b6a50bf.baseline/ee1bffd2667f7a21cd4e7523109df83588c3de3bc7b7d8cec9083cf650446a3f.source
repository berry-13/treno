/**
 * Adaptive polling scheduler (GOAL.md §36). Never hammers undocumented
 * endpoints: intervals depend on time-to-departure / running state, a global
 * per-source gate spaces requests, and sources pause after consecutive
 * failures. Every fetch is persisted as a raw snapshot before normalization.
 */
import { getRow, type Db } from '#core/db.ts';
import { log } from '#core/log.ts';
import type { Config } from '#core/config.ts';
import { fetchVtTrain, vtAutocomplete, type VtTrainRef } from '#providers/vt.ts';
import { fetchMiaTrain as fetchMia } from '#providers/mia.ts';
import { MIA_PARSER_VERSION, MIA_SOURCE } from '#providers/mia.ts';
import { VT_PARSER_VERSION, VT_SOURCE } from '#providers/vt.ts';
import { ATM_SOURCE, atmConfiguredStops, fetchAtmStop } from '#providers/atm.ts';
import { putSnapshot } from '#storage/rawStore.ts';
import { updateProviderHealth } from '#storage/observations.ts';
import { refreshSegmentStats, logSegmentSummary } from '#storage/segments.ts';
import { refreshWeather } from './weather.ts';
import { refreshGauges } from './weather-arpa.ts';
import { ingestSnapshot, stateSummaryLine, type FusedState } from './pipeline.ts';
import { discoverRuns, type DiscoveredRun } from './discover.ts';

export interface TrackedRun {
  runId: number | null; // null for watchlist numbers not yet seen in GTFS/providers
  trainNumber: string;
  serviceDate: string;
  schedDepEpoch: number | null;
  schedArrEpoch: number | null;
  watch: boolean;
  vtRef: VtTrainRef | null;
  vtRefTriedAt: number;
  nextMiaAt: number;
  nextVtAt: number;
  lastState: FusedState | null;
}

const TICK_MS = 5000;
const DISCOVERY_MS = 60_000;

/** Poll interval for one run given its phase (GOAL.md §36), in ms. */
export function pollIntervalMs(tr: TrackedRun, cfg: Config, now = Date.now()): number {
  if (tr.watch) return 25_000;
  const graceMs = cfg.runCooldownMinutes * 60_000;
  if (tr.schedArrEpoch != null && now > tr.schedArrEpoch + graceMs) return Number.POSITIVE_INFINITY;
  const st = tr.lastState?.status;
  if ((st === 'arrived' || st === 'cancelled')) return Number.POSITIVE_INFINITY;
  if (tr.schedDepEpoch != null && now < tr.schedDepEpoch) {
    const minToDep = (tr.schedDepEpoch - now) / 60_000;
    if (minToDep > 60) return 300_000;
    if (minToDep > 30) return 120_000;
    if (minToDep > 10) return 60_000;
    return 30_000;
  }
  return 30_000; // running
}

function sourcePaused(db: Db, source: string, now: number): boolean {
  const r = getRow<{ paused_until: number; consecutive_errors: number }>(
    db, 'SELECT paused_until, consecutive_errors FROM provider_health WHERE source=?', [source]);
  if (!r) return false;
  if (r.paused_until != null && r.paused_until > now) return true;
  return r.consecutive_errors >= 5; // re-check with single probe requests
}

function markSourcePause(db: Db, source: string, untilMs: number): void {
  updateProviderHealth(db, source, { ok: false, latencyMs: null, error: 'consecutive failures: pausing', backoffUntil: untilMs });
}

export class Collector {
  private tracked = new Map<string, TrackedRun>(); // key: serviceDate|trainNumber
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastDiscovery = 0;
  private lastSummary = 0;
  private lastStatsRefresh = 0;
  private lastAtmPoll = 0;
  private stopped = false;
  private onTick: ((n: number) => void) | null = null;

  constructor(
    private db: Db,
    private cfg: Config,
    private watchlist: string[] = [],
  ) {}

  /** hook for --once / tests */
  setTickListener(fn: (n: number) => void): void {
    this.onTick = fn;
  }

  trackedCount(): number {
    return this.tracked.size;
  }

  start(): void {
    this.stopped = false;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async runOnce(): Promise<void> {
    await this.tick();
  }

  private key(serviceDate: string, trainNumber: string): string {
    return serviceDate + '|' + trainNumber;
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    const now = Date.now();
    try {
      if (now - this.lastDiscovery > DISCOVERY_MS || this.tracked.size === 0) {
        this.lastDiscovery = now;
        this.refreshDiscovery();
      }
      await this.pollDue(now);
      this.maintenance(now);
      this.prune(now);
      if (now - this.lastSummary > 60_000) {
        this.lastSummary = now;
        const states = [...this.tracked.values()].filter((t) => t.lastState);
        log.info('collector: summary', {
          tracked: this.tracked.size,
          withState: states.length,
          running: states.filter((s) => s.lastState?.status === 'running').length,
        });
      }
      this.onTick?.(this.tracked.size);
    } catch (e) {
      log.error('collector: tick failed', { error: String(e) });
    }
  }

  private refreshDiscovery(): void {
    const discovered = discoverRuns(this.db, {
      maxRuns: this.cfg.maxTrackedRuns,
      lookaheadMin: 90,
      graceMin: this.cfg.runCooldownMinutes,
    });
    for (const d of discovered) {
      const k = this.key(d.serviceDate, d.trainNumber);
      const cur = this.tracked.get(k);
      if (cur) {
        cur.runId = d.runId;
        cur.schedDepEpoch = d.schedDepEpoch;
        cur.schedArrEpoch = d.schedArrEpoch;
      } else {
        this.tracked.set(k, {
          runId: d.runId, trainNumber: d.trainNumber, serviceDate: d.serviceDate,
          schedDepEpoch: d.schedDepEpoch, schedArrEpoch: d.schedArrEpoch,
          watch: false, vtRef: null, vtRefTriedAt: 0, nextMiaAt: 0, nextVtAt: 0, lastState: null,
        });
      }
    }
    // watchlist entries without GTFS presence
    for (const num of this.watchlist) {
      const todayK = this.key(romeToday(), num);
      if (!this.tracked.has(todayK)) {
        this.tracked.set(todayK, {
          runId: null, trainNumber: num, serviceDate: romeToday(),
          schedDepEpoch: null, schedArrEpoch: null,
          watch: true, vtRef: null, vtRefTriedAt: 0, nextMiaAt: 0, nextVtAt: 0, lastState: null,
        });
      }
    }
  }

  /** Periodic maintenance: segment-stat refresh (10 min) and optional ATM stop polling (60s). */
  private maintenance(now: number): void {
    void refreshWeather(); // hourly rain feature for the model
    void refreshGauges(); // ARPA rain-gauge actuals (null until geo join lands)
    if (now - this.lastStatsRefresh > 10 * 60_000) {
      this.lastStatsRefresh = now;
      try {
        const r = refreshSegmentStats(this.db);
        logSegmentSummary(this.db);
        log.info('collector: segment stats refreshed', { segmentsSeen: r.segments });
      } catch (e) {
        log.warn('collector: segment stats refresh failed', { error: String(e) });
      }
    }
    const atmStops = atmConfiguredStops();
    if (atmStops.length > 0 && now - this.lastAtmPoll > 60_000) {
      this.lastAtmPoll = now;
      for (const stopId of atmStops) {
        void (async () => {
          try {
            const fetchedAt = Date.now();
            const snap = await fetchAtmStop(stopId, this.cfg.userAgent);
            putSnapshot(this.db, this.cfg.dataDir, {
              source: ATM_SOURCE, entityKey: 'stop|' + stopId, fetchedAt,
              httpStatus: snap.result.status, etag: snap.result.etag, lastModified: snap.result.lastModified,
              payloadJson: snap.raw, relevantHash: null, parserVersion: 'atm-v1',
              error: snap.result.ok ? null : snap.result.error,
            });
            updateProviderHealth(this.db, ATM_SOURCE, { ok: snap.result.ok, latencyMs: snap.result.latencyMs, error: snap.result.error });
            if (snap.result.ok) {
              this.db.prepare('INSERT INTO atm_stop_observations(stop_id, fetched_at, wait_messages, raw_hash) VALUES(?,?,?,?)')
                .run(stopId, fetchedAt, JSON.stringify(snap.waitMessages), String(snap.raw.length));
            }
          } catch (e) {
            log.warn('collector: atm poll error', { stopId, error: String(e) });
          }
        })();
      }
    }
  }

  private async pollDue(now: number): Promise<void> {
    const due: TrackedRun[] = [];
    for (const tr of this.tracked.values()) {
      const iv = pollIntervalMs(tr, this.cfg, now);
      if (!Number.isFinite(iv)) continue;
      if (tr.nextMiaAt <= now || tr.nextVtAt <= now) due.push(tr);
    }
    await Promise.all(due.map((tr) => this.pollRun(tr, now)));
  }

  private async pollRun(tr: TrackedRun, now: number): Promise<void> {
    const wantMia = tr.nextMiaAt <= now && !sourcePaused(this.db, MIA_SOURCE, now);
    const wantVt = tr.nextVtAt <= now && !sourcePaused(this.db, VT_SOURCE, now);
    const jobs: Array<Promise<void>> = [];
    if (wantMia) {
      tr.nextMiaAt = now + Math.max(pollIntervalMs(tr, this.cfg, now), this.cfg.minPollSeconds * 1000);
      jobs.push(this.pollMia(tr));
    }
    if (wantVt) {
      tr.nextVtAt = now + Math.max(pollIntervalMs(tr, this.cfg, now), this.cfg.minPollSeconds * 1000);
      jobs.push(this.pollVt(tr));
    }
    await Promise.all(jobs);
  }

  private async pollMia(tr: TrackedRun): Promise<void> {
    const fetchedAt = Date.now();
    try {
      const f = await fetchMia(tr.trainNumber, this.cfg.userAgent);
      const snap = putSnapshot(this.db, this.cfg.dataDir, {
        source: MIA_SOURCE,
        entityKey: 'train|' + tr.trainNumber,
        fetchedAt,
        httpStatus: f.result.status,
        etag: f.result.etag,
        lastModified: f.result.lastModified,
        payloadJson: f.raw,
        relevantHash: f.relevantHash || null,
        parserVersion: MIA_PARSER_VERSION,
        error: f.result.ok ? null : f.result.error,
      });
      updateProviderHealth(this.db, MIA_SOURCE, {
        ok: f.result.ok || isEntityMiss(f.result.status),
        latencyMs: f.result.latencyMs,
        error: isEntityMiss(f.result.status) ? null : f.result.error,
        changed: snap.changed,
      });
      if (!f.result.ok) {
        if (isEntityMiss(f.result.status)) {
          log.info('collector: mia entity miss', { train: tr.trainNumber, status: f.result.status });
        }
        return;
      }
      if (!f.snapshot) return;
      const res = ingestSnapshot(this.db, f.snapshot, { fetchedAt, snapshot: snap });
      if (tr.runId == null || res.runId !== tr.runId) {
        // provider answered for a different (or new) run of this number
        const k = this.key(f.snapshot.serviceDate, f.snapshot.trainNumber);
        const cur = this.tracked.get(k);
        if (cur) cur.runId = res.runId;
        else if (tr.watch && f.snapshot.serviceDate === tr.serviceDate) tr.runId = res.runId;
      }
      if (snap.changed) {
        this.ingestState(tr, res.runId);
      } else if (tr.runId != null) {
        this.reloadStateQuietly(tr);
      }
      if (f.result.status === 403 || f.result.status === 429) {
        markSourcePause(this.db, MIA_SOURCE, Date.now() + 10 * 60_000);
      }
    } catch (e) {
      updateProviderHealth(this.db, MIA_SOURCE, { ok: false, latencyMs: null, error: String(e) });
      log.warn('collector: mia poll error', { train: tr.trainNumber, error: String(e) });
    }
  }

  private async pollVt(tr: TrackedRun): Promise<void> {
    try {
      if (!tr.vtRef) {
        if (Date.now() - tr.vtRefTriedAt < 10 * 60_000) return;
        tr.vtRefTriedAt = Date.now();
        const { refs, result } = await vtAutocomplete(tr.trainNumber, this.cfg.userAgent);
        updateProviderHealth(this.db, VT_SOURCE, {
          ok: result.ok || isEntityMiss(result.status),
          latencyMs: result.latencyMs,
          error: isEntityMiss(result.status) ? null : result.error,
        });
        if (!result.ok) return;
        const ref = refs.find((r) => this.vtRefMatches(r, tr));
        if (!ref) return;
        tr.vtRef = ref;
        log.info('collector: vt ref resolved', { train: tr.trainNumber, ref: ref.originCode, dep: new Date(ref.departureEpochMs).toISOString() });
      }
      const fetchedAt = Date.now();
      const f = await fetchVtTrain(tr.vtRef, this.cfg.userAgent);
      const snap = putSnapshot(this.db, this.cfg.dataDir, {
        source: VT_SOURCE,
        entityKey: tr.vtRef.trainNumber + '|' + tr.vtRef.originCode + '|' + String(tr.vtRef.departureEpochMs),
        fetchedAt,
        httpStatus: f.result.status,
        etag: f.result.etag,
        lastModified: f.result.lastModified,
        payloadJson: f.raw,
        relevantHash: f.relevantHash || null,
        parserVersion: VT_PARSER_VERSION,
        error: f.result.ok ? null : f.result.error,
      });
      updateProviderHealth(this.db, VT_SOURCE, {
        ok: f.result.ok || isEntityMiss(f.result.status),
        latencyMs: f.result.latencyMs,
        error: isEntityMiss(f.result.status) ? null : f.result.error,
        changed: snap.changed,
      });
      if (!f.result.ok || !f.snapshot) return;
      const res = ingestSnapshot(this.db, f.snapshot, { fetchedAt, snapshot: snap });
      if (snap.changed) this.ingestState(tr, res.runId);
    } catch (e) {
      updateProviderHealth(this.db, VT_SOURCE, { ok: false, latencyMs: null, error: String(e) });
      log.warn('collector: vt poll error', { train: tr.trainNumber, error: String(e) });
    }
  }

  private vtRefMatches(r: VtTrainRef, tr: TrackedRun): boolean {
    if (romeDateOf(new Date(r.departureEpochMs)) !== tr.serviceDate) return false;
    if (tr.schedDepEpoch == null) return true;
    // sanity window only: the VT key epoch is service-date midnight
    return Math.abs(r.departureEpochMs - tr.schedDepEpoch) <= 26 * 3600_000;
  }

  private ingestState(tr: TrackedRun, runId: number | null): void {
    if (runId == null) return;
    const state = loadFusedState(this.db, runId);
    if (!state) return;
    tr.lastState = state;
    tr.runId = runId;
    log.info('collector: state', { line: stateSummaryLine(state), src: state.latestSource });
  }

  private reloadStateQuietly(tr: TrackedRun): void {
    if (tr.runId == null) return;
    const state = loadFusedState(this.db, tr.runId);
    if (state) tr.lastState = state;
  }

  private prune(now: number): void {
    const graceMs = this.cfg.runCooldownMinutes * 60_000 + 5 * 60_000;
    for (const [k, tr] of this.tracked) {
      if (tr.watch) continue;
      const iv = pollIntervalMs(tr, this.cfg, now);
      if (!Number.isFinite(iv)) {
        const finished = tr.lastState != null && (tr.lastState.status === 'arrived' || tr.lastState.status === 'cancelled');
        const expired = tr.schedArrEpoch != null && now >= tr.schedArrEpoch + graceMs;
        if (finished || expired) {
          this.tracked.delete(k);
          log.info('collector: untracked', { train: tr.trainNumber, date: tr.serviceDate });
        }
      }
    }
  }
}

function romeToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

function romeDateOf(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/** 4xx that means "this entity doesn't exist right now", not a source problem. */
function isEntityMiss(status: number): boolean {
  return status === 400 || status === 404;
}

function loadFusedState(db: Db, runId: number): FusedState | null {
  const row = getRow<{ state_json: string }>(db, 'SELECT state_json FROM train_state WHERE run_id=?', [runId]);
  if (!row) return null;
  try {
    return JSON.parse(row.state_json) as FusedState;
  } catch {
    return null;
  }
}
