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
    };
    return c.json({ ok: true, counts, providers: providerHealth(db) });
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
      'SELECT stop_id, stop_sequence, sched_arr_epoch, sched_dep_epoch, op_pred_arr_epoch, op_pred_dep_epoch, actual_arr_epoch, actual_dep_epoch, arr_delay_sec, dep_delay_sec, platform_actual, cancelled FROM train_stop_events WHERE run_id=? ORDER BY stop_sequence ASC',
      [run.id]);
    const observations = getRows(db,
      'SELECT ts, source, observed_at, delay_seconds, location_id, location_name, location_kind, status FROM train_observations WHERE run_id=? ORDER BY ts DESC LIMIT 50',
      [run.id]);
    return c.json({ ...base, stops, recentObservations: observations });
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
