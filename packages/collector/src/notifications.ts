/**
 * Watched-run notifier (GOAL.md §61, PLAN_next_frontiers F4). Called from the
 * pipeline after every fuseAndPredict; evaluates the device watches for that
 * run against thresholded rules and pushes via APNs when a value moved.
 *
 * Anti-noise by construction: a rule fires only when its tracked value
 * CHANGED past the threshold since the last push for that device+run, and at
 * most once per RATE_LIMIT_MS per device+run overall.
 */
import { getRow, getRows, runStmt, type Db } from '#core/db.ts';
import { log } from '#core/log.ts';
import { apnsConfigured, sendApns } from './apns.ts';

const RATE_LIMIT_MS = 10 * 60_000;
const ETA_MOVE_MS = 2 * 60_000;

interface WatchRow {
  token: string;
  eta_p50_notified: number | null;
  cancelled_notified: number | null;
  risk_notified: number | null;
  last_notified_at: number | null;
}

export function addDevice(db: Db, token: string, runId: number | null): void {
  runStmt(db.prepare('INSERT INTO devices(token, created_at, last_seen_at) VALUES(?,?,?) ON CONFLICT(token) DO UPDATE SET last_seen_at=excluded.created_at'), [token, Date.now(), Date.now()]);
  if (runId != null && Number.isFinite(runId)) {
    runStmt(db.prepare('INSERT OR IGNORE INTO device_watches(token, run_id) VALUES(?,?)'), [token, runId]);
  }
}

export function removeDevice(db: Db, token: string): void {
  runStmt(db.prepare('DELETE FROM device_watches WHERE token=?'), [token]);
  runStmt(db.prepare('DELETE FROM devices WHERE token=?'), [token]);
}

/** Called after a run's state is persisted; cheap no-op when nobody watches. */
export function notifyWatchers(db: Db, runId: number, state: {
  status: string;
  trainNumber: string;
  ourEstimate: { p50: number } | null;
  riskNotice?: unknown;
}): void {
  if (!apnsConfigured()) return;
  const watches = getRows<WatchRow>(db, 'SELECT * FROM device_watches WHERE run_id=?', [runId]);
  if (watches.length === 0) return;
  const now = Date.now();
  for (const w of watches) {
    if (w.last_notified_at != null && now - w.last_notified_at < RATE_LIMIT_MS) continue;
    const notices: Array<{ title: string; body: string; kind: 'eta' | 'cancelled' | 'risk' }> = [];
    if (state.status === 'cancelled' && w.cancelled_notified !== 1) {
      notices.push({ title: 'Train ' + state.trainNumber + ' cancelled', body: 'Your watched train is not running. Check departures for another service.', kind: 'cancelled' });
    } else if (state.ourEstimate && w.eta_p50_notified != null && Math.abs(state.ourEstimate.p50 - w.eta_p50_notified) > ETA_MOVE_MS) {
      const moved = Math.round((state.ourEstimate.p50 - w.eta_p50_notified) / 60_000);
      notices.push({
        title: 'Train ' + state.trainNumber + ' estimate moved ' + (moved > 0 ? '+' : '') + moved + ' min',
        body: 'Updated arrival: ' + new Date(state.ourEstimate.p50).toLocaleTimeString('it-IT', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit' }),
        kind: 'eta',
      });
    }
    const hasRisk = state.riskNotice != null;
    if (hasRisk && w.risk_notified !== 1) {
      notices.push({ title: 'Delays building ahead of train ' + state.trainNumber, body: 'Trains ahead are losing time. Your arrival may move later.', kind: 'risk' });
    }
    if (notices.length === 0) {
      // remember the baseline so the first move after watching is measurable
      if (w.eta_p50_notified == null && state.ourEstimate) {
        runStmt(db.prepare('UPDATE device_watches SET eta_p50_notified=? WHERE token=? AND run_id=?'), [state.ourEstimate.p50, w.token, runId]);
      }
      continue;
    }
    const n = notices[0]!; // one push per evaluation — the most important fact
    void sendApns(w.token, n.title, n.body).then((ok) => {
      if (!ok) return;
      runStmt(
        db.prepare('UPDATE device_watches SET eta_p50_notified=COALESCE(?, eta_p50_notified), cancelled_notified=CASE WHEN ?=\'cancelled\' THEN 1 ELSE cancelled_notified END, risk_notified=CASE WHEN ?=\'risk\' THEN 1 ELSE risk_notified END, last_notified_at=? WHERE token=? AND run_id=?'),
        [state.ourEstimate?.p50 ?? null, n.kind, n.kind, Date.now(), w.token, runId],
      );
    }).catch((e) => log.warn('notify: push error', { error: String(e) }));
  }
}

/** Housekeeping: drop watches for runs that ended over a day ago. */
export function pruneWatches(db: Db): void {
  runStmt(db.prepare("DELETE FROM device_watches WHERE run_id IN (SELECT r.id FROM train_runs r WHERE r.service_date < date('now','-2 day'))"), []);
}

export function deviceCount(db: Db): number {
  return (getRow<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM devices') ?? { n: 0 }).n;
}
