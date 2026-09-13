/**
 * Read-only API over the collector's fused state (GOAL.md §59).
 *
 *   npx tsx packages/api/src/server.ts
 *
 * Endpoints:
 *   GET /api/health                  providers + counts
 *   GET /api/trains?q=&limit=        search train runs (fused state included)
 *   GET /api/trains/:id              full run: schedule, stop events, state
 *   GET /api/stops/search?q=
 *   GET /api/stops/:id/departures   today's board with live state
 */
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadConfig } from '#core/config.ts';
import { getRows, getRow, type Db } from '#core/db.ts';
import { log } from '#core/log.ts';
import { openTrenoDb } from '#gtfs/setup.ts';
import { searchStops, stopDepartures } from '#gtfs/schedule.ts';
import { providerHealth } from '#storage/observations.ts';
import { segmentStatsTable, corridorDelta, segmentId as segId } from '#storage/segments.ts';
import { connectionOptions } from '#collector/heuristic.ts';
import { secondsIntoServiceDay } from '#collector/discover.ts';
import { romeYmd } from '#core/time.ts';

interface StateRow { run_id: number; state_json: string; updated_at: number }

function runWithState(db: Db, where: string, params: Array<string | number>, limit: number) {
  const runs = getRows<{
    id: number; train_number: string; service_date: string; origin_stop_id: string | null;
    destination_stop_id: string | null; sched_dep_epoch: number | null; sched_arr_epoch: number | null;
    operator: string; state_json: string | null; updated_at: number | null;
  }>(
    db,
    `SELECT r.id, r.train_number, r.service_date, r.origin_stop_id, r.destination_stop_id,
            r.sched_dep_epoch, r.sched_arr_epoch, r.operator, s.state_json, s.updated_at
     FROM train_runs r LEFT JOIN train_state s ON s.run_id = r.id
     WHERE ${where}
     ORDER BY COALESCE(s.updated_at, 0) DESC, r.sched_dep_epoch DESC
     LIMIT ?`,
    [...params, limit],
  );
  return runs.map((r) => ({
    id: r.id,
    trainNumber: r.train_number,
    serviceDate: r.service_date,
    operator: r.operator,
    origin: r.origin_stop_id,
    destination: r.destination_stop_id,
    schedDepEpoch: r.sched_dep_epoch,
    schedArrEpoch: r.sched_arr_epoch,
    updatedAt: r.updated_at,
    state: r.state_json ? JSON.parse(r.state_json) : null,
  }));
}

export function buildApp(db: Db) {
  const app = new Hono();

  app.get('/api/health', (c) => {
    const counts = {
      runs: (getRow<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM train_runs') ?? { n: 0 }).n,
      observations: (getRow<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM train_observations') ?? { n: 0 }).n,
      stopEvents: (getRow<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM train_stop_events') ?? { n: 0 }).n,
      snapshots: (getRow<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM source_snapshots') ?? { n: 0 }).n,
      predictions: (getRow<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM predictions') ?? { n: 0 }).n,
      scoredOutcomes: (getRow<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM prediction_outcomes') ?? { n: 0 }).n,
      segmentObservations: (getRow<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM segment_observation') ?? { n: 0 }).n,
      segmentsWithStats: (getRow<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM segment_stats') ?? { n: 0 }).n,
      alerts: (getRow<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM service_alerts') ?? { n: 0 }).n,
    };
    // source change rate over the last hour (§58 freshness evidence)
    const hourAgo = Date.now() - 3600_000;
    const changes = new Map<string, number>();
    for (const r of getRows<{ source: string; n: number }>(db, 'SELECT source, COUNT(*) AS n FROM source_snapshots WHERE fetched_at >= ? AND changed=1 GROUP BY source', [hourAgo])) {
      changes.set(r.source, r.n);
    }
    const providers = providerHealth(db).map((p) => ({ ...p, changedLastHour: changes.get(p.source) ?? 0 }));
    return c.json({ ok: true, counts, providers });
  });

  app.get('/api/trains', (c) => {
    const q = (c.req.query('q') ?? '').trim();
    const limit = Math.min(Number(c.req.query('limit') ?? 50), 200);
    if (q !== '') {
      return c.json(runWithState(db, 'r.train_number LIKE ?', ['%' + q + '%'], limit));
    }
    const today = romeYmd(Date.now());
    return c.json(runWithState(db, 'r.service_date >= ?', [today], limit));
  });

  app.get('/api/trains/:id', (c) => {
    const idParam = c.req.param('id');
    const run = idParam.includes('@')
      ? getRow<{ id: number }>(db, 'SELECT id FROM train_runs WHERE train_number=? AND service_date=?', [idParam.split('@')[0]!, idParam.split('@')[1] ?? ''])
      : getRow<{ id: number }>(db, 'SELECT id FROM train_runs WHERE id=?', [Number(idParam)]);
    if (!run || !Number.isFinite(run.id)) return c.json({ error: 'not found' }, 404);
    const base = runWithState(db, 'r.id=?', [run.id], 1)[0];
    if (!base) return c.json({ error: 'not found' }, 404);
    const stops = getRows(db,
      'SELECT e.stop_id, g.stop_name, e.stop_sequence, e.sched_arr_epoch, e.sched_dep_epoch, e.op_pred_arr_epoch, e.op_pred_dep_epoch, e.actual_arr_epoch, e.actual_dep_epoch, e.arr_delay_sec, e.dep_delay_sec, e.platform_actual, e.cancelled FROM train_stop_events e LEFT JOIN gtfs_stops g ON g.stop_id = e.stop_id WHERE e.run_id=? ORDER BY e.stop_sequence ASC',
      [run.id]);
    const observations = getRows(db,
      'SELECT ts, source, observed_at, delay_seconds, location_id, location_name, location_kind, status, quality_flags FROM train_observations WHERE run_id=? ORDER BY ts DESC LIMIT 50',
      [run.id]);
    const latestPrediction = getRow(db,
      'SELECT model_version, generated_at, sched_arr_epoch, operator_eta_epoch, our_p10, our_p50, our_p90, confidence, features_json FROM predictions WHERE run_id=? ORDER BY generated_at DESC LIMIT 1',
      [run.id]);
    // connection risk at the destination (§18) from our arrival distribution
    let connections: unknown[] = [];
    const st = base.state as { ourEstimate?: { p10: number; p50: number; p90: number } | null; destination?: { stopId: string | null }; serviceDate?: string; trainNumber?: string } | null;
    if (st?.ourEstimate && st.destination?.stopId) {
      connections = connectionOptions(
        db, st.destination.stopId, st.serviceDate ?? romeYmd(Date.now()),
        st.ourEstimate.p50, st.ourEstimate.p10, st.ourEstimate.p90,
        st.trainNumber ?? null,
      ) as unknown[];
    }
    return c.json({ ...base, stops, recentObservations: observations, latestPrediction: latestPrediction ?? null, connections });
  });

  app.get('/api/segments', (c) => {
    const limit = Math.min(Number(c.req.query('limit') ?? 100), 500);
    return c.json(segmentStatsTable(db, limit));
  });

  app.get('/api/corridor', (c) => {
    const from = c.req.query('from') ?? '';
    const to = c.req.query('to') ?? '';
    if (from === '' || to === '') return c.json({ error: 'from and to required' }, 400);
    const id = segId(from, to);
    const stats = getRow(db, 'SELECT segment_id, bucket, n, rt_p10, rt_p50, rt_p90, dd_p50, dd_p90 FROM segment_stats WHERE segment_id=? ORDER BY CASE bucket WHEN \'all\' THEN 0 ELSE 1 END LIMIT 1', [id]);
    const live = corridorDelta(db, id);
    return c.json({ segmentId: id, stats: stats ?? null, liveDeltaSec: live });
  });

  app.get('/api/alerts', (c) => {
    const since = Date.now() - 24 * 3600_000;
    return c.json(getRows(db, 'SELECT id, source, run_id, title, description, severity, created_at FROM service_alerts WHERE created_at >= ? ORDER BY created_at DESC LIMIT 100', [since]));
  });

  app.get('/api/atm/stops/:id', (c) => {
    const id = c.req.param('id');
    return c.json(getRows(db, 'SELECT stop_id, fetched_at, wait_messages FROM atm_stop_observations WHERE stop_id=? ORDER BY fetched_at DESC LIMIT 60', [id]));
  });

  app.get('/api/stops/search', (c) => {
    const q = (c.req.query('q') ?? '').trim();
    if (q.length < 2) return c.json([]);
    return c.json(searchStops(db, q, 20));
  });

  app.get('/api/stops/:id/departures', (c) => {
    const stopId = c.req.param('id');
    const today = romeYmd(Date.now());
    const nowSec = secondsIntoServiceDay(today);
    const deps = stopDepartures(db, stopId, today, nowSec - 3600, nowSec + 3 * 3600);
    const withState = deps.map((d) => {
      const st = getRow<StateRow>(db, 'SELECT run_id, state_json, updated_at FROM train_state WHERE run_id=(SELECT id FROM train_runs WHERE service_date=? AND train_number=? LIMIT 1)', [today, d.train_number ?? '']);
      return { ...d, state: st ? JSON.parse(st.state_json) : null };
    });
    return c.json(withState);
  });

  // minimal static UI
  const webDir = resolve(import.meta.dirname, '../../../apps/web');
  app.get('/', (c) => {
    try {
      return c.html(readFileSync(join(webDir, 'index.html'), 'utf8'));
    } catch {
      return c.text('web ui missing', 500);
    }
  });

  return app;
}

async function main() {
  const cfg = loadConfig();
  const db = openTrenoDb(cfg);
  const app = buildApp(db);
  const server = serve({ fetch: app.fetch, port: cfg.apiPort });
  log.info('api: listening', { port: cfg.apiPort });
  const shutdown = () => {
    server.close();
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (process.argv[1] && process.argv[1].endsWith('server.ts')) {
  main().catch((e) => {
    log.error('api: fatal', { error: String(e) });
    process.exit(1);
  });
}
