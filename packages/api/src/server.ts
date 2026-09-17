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
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadConfig } from '#core/config.ts';
import { getRows, getRow, type Db } from '#core/db.ts';
import { log } from '#core/log.ts';
import { openTrenoDb } from '#gtfs/setup.ts';
import { searchStops, stopById, stopDepartures, type StopDeparture } from '#gtfs/schedule.ts';
import { providerHealth } from '#storage/observations.ts';
import { segmentStatsTable, corridorDelta, segmentId as segId } from '#storage/segments.ts';
import { connectionOptions } from '#collector/heuristic.ts';
import { secondsIntoServiceDay, bareTrainNumber } from '#collector/discover.ts';
import { romeYmd, romeWallToEpoch, ymdPlusDays } from '#core/time.ts';
import { journeysFor } from './journeys.ts';

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
  // nightly backtest reports land here (03:30 trainer loop)
  const reportsDir = join(loadConfig().dataDir, 'reports');

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
      // historical structural priors (Monechi 2015): same row semantics as
      // segmentsWithStats (segment × bucket); priors never shift point
      // estimates, they only carry distribution shape for segments without
      // live coverage. segmentsEffective counts distinct segments served by
      // either table.
      segmentsWithPriors: (getRow<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM segment_stats_prior') ?? { n: 0 }).n,
      segmentsEffective: (getRow<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM (SELECT segment_id FROM segment_stats UNION SELECT segment_id FROM segment_stats_prior)') ?? { n: 0 }).n,
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

  // collection heartbeat: per-15-min counts over the last 48h so feed gaps
  // (a stalled collector shows as a run of empty buckets) are visible without
  // server shell access
  app.get('/api/coverage', (c) => {
    const since = Date.now() - 48 * 3600_000;
    const snaps = getRows<{ bucket: number; source: string; n: number }>(
      db, 'SELECT CAST(fetched_at/900000 AS INTEGER)*900000 AS bucket, source, COUNT(*) AS n FROM source_snapshots WHERE fetched_at>=? GROUP BY bucket, source', [since]);
    const obs = getRows<{ bucket: number; n: number }>(
      db, 'SELECT CAST(ts/900000 AS INTEGER)*900000 AS bucket, COUNT(*) AS n FROM train_observations WHERE ts>=? GROUP BY bucket', [since]);
    const states = getRows<{ bucket: number; n: number }>(
      db, 'SELECT CAST(updated_at/900000 AS INTEGER)*900000 AS bucket, COUNT(*) AS n FROM train_state WHERE updated_at>=? GROUP BY bucket', [since]);
    const map = new Map<number, { bucket: number; observations: number; stateUpdates: number; snapshots: Record<string, number> }>();
    const at = (ms: number) => {
      let e = map.get(ms);
      if (!e) map.set(ms, e = { bucket: ms, observations: 0, stateUpdates: 0, snapshots: {} });
      return e;
    };
    for (const r of snaps) at(r.bucket).snapshots[r.source] = r.n;
    for (const r of obs) at(r.bucket).observations += r.n;
    for (const r of states) at(r.bucket).stateUpdates += r.n;
    return c.json({ windowMs: 900_000, from: since, generatedAt: Date.now(), buckets: [...map.values()].sort((a, b) => a.bucket - b.bucket) });
  });

  // nightly backtest reports (markdown tables, newest first)
  app.get('/api/backtest', (c) => {
    const limit = Math.min(Number(c.req.query('limit') ?? 5) || 5, 20);
    let names: string[] = [];
    try {
      names = readdirSync(reportsDir).filter((f) => /^backtest-\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort().reverse();
    } catch { names = []; }
    const reports = names.slice(0, limit).map((f) => ({
      date: f.slice('backtest-'.length, f.length - '.md'.length),
      markdown: readFileSync(join(reportsDir, f), 'utf8'),
    }));
    return c.json({ latest: reports[0]?.date ?? null, reports });
  });

  // all rail stations with coords + today's departure volume (map + nearest)
  let stationsCache: { at: number; rows: Array<{ stopId: string; name: string; lat: number | null; lon: number | null; depCount: number }> } | null = null;
  app.get('/api/stations', (c) => {
    const today = romeYmd(Date.now());
    if (stationsCache && Date.now() - stationsCache.at < 600_000) return c.json(stationsCache.rows);
    const rows = getRows<{ stopId: string; name: string; lat: number | null; lon: number | null; depCount: number }>(
      db,
      `SELECT g.stop_id AS stopId, g.stop_name AS name, g.stop_lat AS lat, g.stop_lon AS lon, COUNT(DISTINCT s.trip_id) AS depCount
       FROM gtfs_stops g
       JOIN gtfs_stop_times st ON st.stop_id = g.stop_id
       JOIN gtfs_trip_summaries s ON s.trip_id = st.trip_id
       JOIN gtfs_trips t ON t.trip_id = s.trip_id
       JOIN gtfs_calendar_dates cd ON cd.service_id = t.service_id AND cd.exception_type = 1
       JOIN gtfs_routes r ON r.route_id = s.route_id AND r.route_type = 2
       WHERE cd.date = ?
       GROUP BY g.stop_id ORDER BY depCount DESC`,
      [today.slice(0, 4) + today.slice(5, 7) + today.slice(8, 10)],
    );
    stationsCache = { at: Date.now(), rows };
    return c.json(rows);
  });

  app.get('/api/journeys', (c) => {
    const from = c.req.query('from') ?? '';
    const to = c.req.query('to') ?? '';
    const limit = Math.min(Number(c.req.query('limit') ?? 8), 20);
    if (from === '' || to === '') return c.json({ error: 'from and to required' }, 400);
    // optional reference time (ms epoch) for "other day / other hour" searches;
    // clamped to [yesterday, +30d] so the service-date windows stay sane
    const atParam = Number(c.req.query('at'));
    const at = Number.isFinite(atParam) && atParam > 1_500_000_000_000
      ? Math.min(Math.max(atParam, Date.now() - 86_400_000), Date.now() + 30 * 86_400_000)
      : Date.now();
    const journeys = journeysFor(db, from, to, at, limit);
    return c.json({ from, to, generatedAt: Date.now(), journeys });
  });

  app.get('/api/stops/:id/departures', (c) => {
    const stopId = c.req.param('id');
    const station = stopById(db, stopId);
    if (!station) return c.json({ error: 'unknown station' }, 404);
    const today = romeYmd(Date.now());
    const nowSec = secondsIntoServiceDay(today);
    const tomorrow = ymdPlusDays(today, 1);
    // today's service day keeps post-midnight departures (sec > 86400); the
    // tomorrow window catches trips whose service date rolls over at midnight
    const rowsToday = stopDepartures(db, stopId, today, nowSec - 3600, 108_000, 45);
    const rowsTomorrow = stopDepartures(db, stopId, tomorrow, 0, 10_800, 15);
    const build = (ymd: string, d: StopDeparture) => {
      const trainNumber = bareTrainNumber(d.train_number ?? '');
      const rawLine = d.line_name;
      const line = rawLine !== null && rawLine.length <= 8 && !rawLine.includes('(') ? rawLine : null;
      const depEpoch = romeWallToEpoch(ymd, d.departure_sec ?? 0);
      const run = trainNumber !== ''
        ? getRow<{ id: number }>(db, 'SELECT id FROM train_runs WHERE service_date=? AND train_number=? LIMIT 1', [ymd, trainNumber])
        : undefined;
      let platform: string | null = null;
      let depDelaySec: number | null = null;
      let actualDepEpoch: number | null = null;
      let state: unknown = null;
      if (run) {
        const ev = getRow<{ actual_dep_epoch: number | null; dep_delay_sec: number | null; platform_actual: string | null }>(
          db,
          'SELECT actual_dep_epoch, dep_delay_sec, platform_actual FROM train_stop_events WHERE run_id=? AND stop_id=?',
          [run.id, stopId],
        );
        if (ev) {
          platform = ev.platform_actual;
          depDelaySec = ev.dep_delay_sec;
          actualDepEpoch = ev.actual_dep_epoch;
        }
        // feed sometimes carries nonsense platforms ("1989", "2000") — keep 1..30
        if (platform !== null) {
          const pn = Number(platform);
          if (!Number.isInteger(pn) || pn < 1 || pn > 30) platform = null;
        }
        const st = getRow<StateRow>(db, 'SELECT run_id, state_json, updated_at FROM train_state WHERE run_id=?', [run.id]);
        if (st) state = JSON.parse(st.state_json);
      }
      return {
        runId: run?.id ?? null,
        trainNumber,
        line,
        destinationName: d.destination_name,
        depEpoch,
        platform,
        depDelaySec,
        actualDepEpoch,
        state,
      };
    };
    const departures = [
      ...rowsToday.map((d) => build(today, d)),
      ...rowsTomorrow.map((d) => build(tomorrow, d)),
    ].sort((a, b) => a.depEpoch - b.depEpoch);
    return c.json({ station: { stopId: station.stop_id, name: station.stop_name }, generatedAt: Date.now(), departures });
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
