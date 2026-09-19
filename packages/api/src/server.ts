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
import { streamSSE } from 'hono/streaming';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadConfig } from '#core/config.ts';
import { getRows, getRow, type Db } from '#core/db.ts';
import { log } from '#core/log.ts';
import { openTrenoDb } from '#gtfs/setup.ts';
import { searchStops, stopById, stopDepartures, type StopDeparture } from '#gtfs/schedule.ts';
import { atmSearchStops, atmStopById, atmStopDepartures } from '#gtfs/atm.ts';
import { decodeWaitMessage } from '#providers/atm.ts';
import { providerHealth } from '#storage/observations.ts';
import { segmentStatsTable, corridorDelta, segmentId as segId } from '#storage/segments.ts';
import { connectionOptions } from '#collector/heuristic.ts';
import { predictPlatforms } from '#collector/train-platforms.ts';
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
    // F8 readiness probes (national rail, RAPSODIA catalog) — newest per kind
    const probes: Record<string, unknown> = {};
    try {
      for (const r of getRows<{ kind: string; payload_json: string; created_at: number }>(
        db, 'SELECT kind, payload_json, created_at FROM probe_results ORDER BY created_at DESC LIMIT 10')) {
        if (!(r.kind in probes)) probes[r.kind] = { at: r.created_at, ...JSON.parse(r.payload_json) as object };
      }
    } catch { /* probe table absent on old DBs */ }
    // source change rate over the last hour (§58 freshness evidence)
    const hourAgo = Date.now() - 3600_000;
    const changes = new Map<string, number>();
    for (const r of getRows<{ source: string; n: number }>(db, 'SELECT source, COUNT(*) AS n FROM source_snapshots WHERE fetched_at >= ? AND changed=1 GROUP BY source', [hourAgo])) {
      changes.set(r.source, r.n);
    }
    const providers = providerHealth(db).map((p) => ({ ...p, changedLastHour: changes.get(p.source) ?? 0 }));
    return c.json({ ok: true, counts, providers, probes });
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
    interface StopApiRow {
      stop_id: string; stop_name: string | null; stop_sequence: number | null;
      sched_arr_epoch: number | null; sched_dep_epoch: number | null;
      op_pred_arr_epoch: number | null; op_pred_dep_epoch: number | null;
      actual_arr_epoch: number | null; actual_dep_epoch: number | null;
      arr_delay_sec: number | null; dep_delay_sec: number | null;
      platform_actual: string | null; platform_is_actual: number | null; cancelled: number | null;
      platform_predicted?: Array<{ n: string; p: number }> | null;
    }
    const stops = getRows<StopApiRow>(db,
      'SELECT e.stop_id, g.stop_name, e.stop_sequence, e.sched_arr_epoch, e.sched_dep_epoch, e.op_pred_arr_epoch, e.op_pred_dep_epoch, e.actual_arr_epoch, e.actual_dep_epoch, e.arr_delay_sec, e.dep_delay_sec, e.platform_actual, e.platform_is_actual, e.cancelled FROM train_stop_events e LEFT JOIN gtfs_stops g ON g.stop_id = e.stop_id WHERE e.run_id=? ORDER BY e.stop_sequence ASC',
      [run.id]);
    // §52 platform prediction: for stops without a confirmed platform yet,
    // attach the top likely platforms (model file only exists past its gate)
    const routeId = getRow<{ route_id: string | null }>(db, 'SELECT route_id FROM train_runs WHERE id=?', [run.id])?.route_id ?? null;
    let prevActualPlatform: string | null = null;
    for (const s of stops) {
      const confirmed = s.platform_actual != null && s.platform_is_actual === 1;
      if (confirmed) { prevActualPlatform = s.platform_actual; continue; }
      if (s.cancelled !== 1 && s.actual_arr_epoch == null && s.actual_dep_epoch == null) {
        s.platform_predicted = predictPlatforms({
          stopId: s.stop_id, routeId, depEpochMs: s.sched_dep_epoch, prevPlatform: prevActualPlatform,
        });
      }
    }
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
    // §53 crowding: latest MIA-reported load level for this run
    const crowding = getRow<{ crowding_pct: number; crowding_label: string | null }>(
      db,
      "SELECT crowding_pct, crowding_label FROM train_observations WHERE run_id=? AND source='mia' AND crowding_pct IS NOT NULL ORDER BY ts DESC LIMIT 1",
      [run.id],
    );
    // §51 pre-emptive risk notice: preceding trains on this run's next
    // segments are already losing time while the operator still shows this
    // train on time — surfaced before the operator flags it
    let riskNotice: { headline: string; detail: string | null; expectedDelaySec: number | null; evidenceTrains: number | null; segmentName: string | null } | null = null;
    const stState = base.state as { status?: string; schedArrEpoch?: number | null; ourEstimate?: { p50: number } | null } | null;
    if (stState && stState.status !== 'arrived' && stState.status !== 'cancelled' && stops.length >= 2) {
      const firstUpcoming = stops.findIndex((s) => s.actual_arr_epoch == null && s.actual_dep_epoch == null && s.cancelled !== 1);
      if (firstUpcoming >= 0) {
        const since20 = Date.now() - 20 * 60_000;
        let evidence = 0;
        let worst: { segId: string; delta: number } | null = null;
        for (let i = Math.max(0, firstUpcoming - 1); i + 1 < stops.length && i < firstUpcoming + 3; i++) {
          const a = stops[i]!;
          const b = stops[i + 1]!;
          const deltas = getRows<{ delay_delta_sec: number }>(
            db,
            'SELECT delay_delta_sec FROM segment_observation WHERE segment_id=? AND entered_at >= ? AND delay_delta_sec > 90',
            [a.stop_id + '>' + b.stop_id, since20],
          );
          evidence += deltas.length;
          const mx = deltas.reduce((m, r) => Math.max(m, r.delay_delta_sec), 0);
          if (deltas.length > 0 && (!worst || mx > worst.delta)) worst = { segId: a.stop_id + '>' + b.stop_id, delta: mx };
        }
        const expectedDelaySec = stState.ourEstimate && stState.schedArrEpoch != null
          ? Math.round((stState.ourEstimate.p50 - stState.schedArrEpoch) / 1000)
          : null;
        if (evidence >= 2 && (expectedDelaySec ?? 0) >= 60) {
          const names = worst ? worst.segId.split('>').map((sid) => {
            const r = getRow<{ stop_name: string }>(db, 'SELECT stop_name FROM gtfs_stops WHERE stop_id=?', [sid]);
            return r?.stop_name ?? sid;
          }) : null;
          const segName = names != null && names.length === 2 ? names.join(' → ') : null;
          riskNotice = {
            headline: 'Delays building ahead of this train',
            detail: evidence + (evidence === 1 ? ' train is' : ' trains are') + ' already losing time' + (segName != null ? ' between ' + segName : '') + '.',
            expectedDelaySec,
            evidenceTrains: evidence,
            segmentName: segName,
          };
        }
      }
    }
    return c.json({ ...base, stops, recentObservations: observations, latestPrediction: latestPrediction ?? null, connections, crowding: crowding ?? null, riskNotice });
  });

  // §84 reliability: 30-day actual behaviour. Percentages are suppressed
  // (null) below n=20 — no fake stats on thin data (§16).
  app.get('/api/reliability/train/:number', (c) => {
    const number = c.req.param('number');
    const since = Date.now() - 30 * 86400_000;
    const sinceYmd = new Date(since).toISOString().slice(0, 10);
    const arrivals = getRows<{ arr_delay_sec: number }>(
      db,
      'SELECT e.arr_delay_sec AS arr_delay_sec FROM train_stop_events e JOIN train_runs r ON r.id = e.run_id WHERE r.train_number=? AND e.stop_id = r.destination_stop_id AND e.arr_delay_sec IS NOT NULL AND r.service_date >= ?',
      [number, sinceYmd],
    );
    const cancelled = (getRow<{ n: number }>(
      db,
      'SELECT COUNT(*) AS n FROM train_stop_events e JOIN train_runs r ON r.id = e.run_id WHERE r.train_number=? AND e.cancelled = 1 AND r.service_date >= ?',
      [number, sinceYmd],
    ) ?? { n: 0 }).n;
    const segs = getRows<{ from_stop_id: string; to_stop_id: string; delay_delta_sec: number }>(
      db,
      'SELECT s.from_stop_id, s.to_stop_id, s.delay_delta_sec FROM segment_observation s JOIN train_runs r ON r.id = s.run_id WHERE r.train_number=? AND s.entered_at >= ? AND s.delay_delta_sec IS NOT NULL',
      [number, since],
    );
    const bySeg = new Map<string, { name: [string, string]; ds: number[] }>();
    for (const s of segs) {
      const k = s.from_stop_id + '>' + s.to_stop_id;
      let e = bySeg.get(k);
      if (!e) bySeg.set(k, e = { name: [s.from_stop_id, s.to_stop_id], ds: [] });
      e.ds.push(s.delay_delta_sec);
    }
    const nameOf = (sid: string) => getRow<{ stop_name: string }>(db, 'SELECT stop_name FROM gtfs_stops WHERE stop_id=?', [sid])?.stop_name ?? sid;
    const segStats = [...bySeg.values()].filter((e) => e.ds.length >= 20).map((e) => {
      const sorted = [...e.ds].sort((a, b) => a - b);
      return {
        fromName: nameOf(e.name[0]!),
        toName: nameOf(e.name[1]!),
        medianDelayDeltaSec: Math.round(sorted[Math.floor(sorted.length / 2)]!),
        n: sorted.length,
      };
    });
    const delays = arrivals.map((a) => a.arr_delay_sec).sort((a, b) => a - b);
    const n = delays.length;
    const q = (p: number): number | null => n > 0 ? delays[Math.min(n - 1, Math.floor(p * n))]! : null;
    const pct = (cond: (d: number) => boolean): number | null => n >= 20 ? Math.round((delays.filter(cond).length / n) * 1000) / 10 : null;
    const worst = segStats.reduce<typeof segStats[number] | null>((w, s) => (!w || (s.medianDelayDeltaSec ?? -1e9) > (w.medianDelayDeltaSec ?? -1e9)) ? s : w, null);
    const recovery = segStats.reduce<typeof segStats[number] | null>((w, s) => (!w || (s.medianDelayDeltaSec ?? 1e9) < (w.medianDelayDeltaSec ?? 1e9)) ? s : w, null);
    return c.json({
      trainNumber: number,
      days: 30,
      completedRuns: n,
      onTimePct: pct((d) => d < 180),
      late5Pct: pct((d) => d >= 300),
      late10Pct: pct((d) => d >= 600),
      cancelledPct: n + cancelled >= 20 ? Math.round((cancelled / (n + cancelled)) * 1000) / 10 : null,
      medianDelaySec: q(0.5),
      p90DelaySec: q(0.9),
      worstSegment: worst && (worst.medianDelayDeltaSec ?? 0) > 30 ? worst : null,
      recoverySegment: recovery && (recovery.medianDelayDeltaSec ?? 0) < -15 ? recovery : null,
    });
  });

  app.get('/api/reliability/stop/:id', (c) => {
    const stopId = c.req.param('id');
    const sinceYmd = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
    const rows = getRows<{ route_id: string | null; arr_delay_sec: number }>(
      db,
      `SELECT r.route_id, e.arr_delay_sec FROM train_stop_events e JOIN train_runs r ON r.id = e.run_id
       WHERE e.stop_id=? AND e.arr_delay_sec IS NOT NULL AND r.service_date >= ? AND r.route_id IS NOT NULL`,
      [stopId, sinceYmd],
    );
    const byRoute = new Map<string, number[]>();
    for (const r of rows) {
      let a = byRoute.get(r.route_id!);
      if (!a) byRoute.set(r.route_id!, a = []);
      a.push(r.arr_delay_sec);
    }
    const routes = [...byRoute.entries()].map(([routeId, ds]) => {
      const sorted = [...ds].sort((a, b) => a - b);
      const routeName = getRow<{ route_short_name: string | null; route_long_name: string | null }>(db, 'SELECT route_short_name, route_long_name FROM gtfs_routes WHERE route_id=?', [routeId]);
      return {
        routeId,
        routeName: routeName?.route_short_name ?? routeName?.route_long_name ?? routeId,
        n: sorted.length,
        onTimePct: sorted.length >= 20 ? Math.round((sorted.filter((d) => d < 180).length / sorted.length) * 1000) / 10 : null,
        medianDelaySec: sorted.length >= 20 ? sorted[Math.floor(sorted.length / 2)]! : null,
        p90DelaySec: sorted.length >= 20 ? sorted[Math.min(sorted.length - 1, Math.floor(0.9 * sorted.length))]! : null,
      };
    }).filter((r) => r.n >= 10).sort((a, b) => b.n - a.n);
    return c.json({ stopId, days: 30, routes });
  });

  // §61 device registry — the API owns writes, the collector's notifier reads
  app.post('/api/devices', async (c) => {
    const body = await c.req.json<{ token?: string; runId?: number }>().catch(() => null);
    const token = body?.token;
    if (typeof token !== 'string' || token.length < 32 || token.length > 200 || !/^[a-f0-9]+$/i.test(token)) {
      return c.json({ error: 'invalid token' }, 400);
    }
    const { addDevice } = await import('#collector/notifications.ts');
    addDevice(db, token, body?.runId ?? null);
    return c.json({ ok: true });
  });

  app.delete('/api/devices/:token', async (c) => {
    const token = c.req.param('token');
    const { removeDevice } = await import('#collector/notifications.ts');
    removeDevice(db, token);
    return c.json({ ok: true });
  });

  // §60 SSE: live train state stream. The API process doesn't see collector
  // writes directly, so each open stream tails train_state.updated_at at 5 s
  // (a cheap indexed read) and emits the changed view. Heartbeat comments
  // every 20 s keep proxies from idling the connection.
  let openStreams = 0;
  app.get('/api/stream/trains/:id', (c) => {
    if (openStreams >= 50) return c.json({ error: 'too many streams' }, 429);
    const idParam = c.req.param('id');
    const run = idParam.includes('@')
      ? getRow<{ id: number }>(db, 'SELECT id FROM train_runs WHERE train_number=? AND service_date=?', [idParam.split('@')[0]!, idParam.split('@')[1] ?? ''])
      : getRow<{ id: number }>(db, 'SELECT id FROM train_runs WHERE id=?', [Number(idParam)]);
    if (!run || !Number.isFinite(run.id)) return c.json({ error: 'not found' }, 404);
    const runId = run.id;
    openStreams++;
    let closed = false;
    return streamSSE(c, async (stream) => {
      stream.onAbort(() => { closed = true; });
      let lastStateAt: number | null = null;
      let lastPlatforms = '';
      let lastAlertCount = -1;
      let tick = 0;
      try {
        while (!closed && !stream.aborted) {
          const st = getRow<{ state_json: string; updated_at: number }>(db, 'SELECT state_json, updated_at FROM train_state WHERE run_id=?', [runId]);
          if (st && st.updated_at !== lastStateAt) {
            lastStateAt = st.updated_at;
            await stream.writeSSE({ event: 'state_update', data: st.state_json });
          }
          const plats = getRows<{ stop_id: string; platform_actual: string | null; platform_is_actual: number | null }>(
            db,
            'SELECT stop_id, platform_actual, platform_is_actual FROM train_stop_events WHERE run_id=? AND platform_actual IS NOT NULL ORDER BY stop_sequence',
            [runId],
          );
          const platsKey = JSON.stringify(plats);
          if (platsKey !== lastPlatforms) {
            if (lastPlatforms !== '') {
              await stream.writeSSE({ event: 'platform_update', data: platsKey });
            }
            lastPlatforms = platsKey;
          }
          const since = Date.now() - 3600_000;
          const alerts = getRows(db, 'SELECT id, title, description, severity, created_at FROM service_alerts WHERE run_id=? AND created_at >= ? ORDER BY created_at DESC LIMIT 10', [runId, since]);
          if (alerts.length !== lastAlertCount) {
            if (lastAlertCount !== -1) {
              for (const a of alerts.slice(0, Math.max(0, alerts.length - lastAlertCount))) {
                await stream.writeSSE({ event: 'alert', data: JSON.stringify(a) });
              }
            }
            lastAlertCount = alerts.length;
          }
          if (tick++ % 4 === 3) await stream.write(': hb\n\n');
          await stream.sleep(5000);
        }
      } catch {
        // client disconnected mid-write — hono closes the stream
      } finally {
        openStreams--;
      }
    });
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

  // §62 corridor health: segments traversed in the last hour, ordered by how
  // far the last few trains' delay delta deviates from 0
  app.get('/api/corridors', (c) => {
    const limit = Math.min(Number(c.req.query('limit') ?? 20), 100);
    const since = Date.now() - 3600_000;
    const rows = getRows<{ segment_id: string; n: number; deltas: string }>(
      db,
      `SELECT segment_id, COUNT(*) AS n, GROUP_CONCAT(delay_delta_sec) AS deltas
       FROM segment_observation WHERE entered_at >= ? AND delay_delta_sec IS NOT NULL
       GROUP BY segment_id`,
      [since],
    );
    const out = rows.map((r) => {
      const ds = r.deltas.split(',').map(Number).filter(Number.isFinite).sort((a, b) => a - b);
      const median = ds[Math.floor(ds.length / 2)] ?? 0;
      const [f, t] = r.segment_id.split('>');
      const nf = getRow<{ stop_name: string }>(db, 'SELECT stop_name FROM gtfs_stops WHERE stop_id=?', [f ?? '']);
      const nt = getRow<{ stop_name: string }>(db, 'SELECT stop_name FROM gtfs_stops WHERE stop_id=?', [t ?? '']);
      return {
        segmentId: r.segment_id,
        fromName: nf?.stop_name ?? f,
        toName: nt?.stop_name ?? t,
        traversals: r.n,
        medianDelayDeltaSec: median,
        worstDelayDeltaSec: ds[ds.length - 1] ?? null,
      };
    })
      .filter((r) => Math.abs(r.medianDelayDeltaSec) >= 60 || (r.worstDelayDeltaSec ?? 0) >= 180)
      .sort((a, b) => Math.abs(b.medianDelayDeltaSec) - Math.abs(a.medianDelayDeltaSec))
      .slice(0, limit);
    return c.json({ generatedAt: Date.now(), corridors: out });
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
    const rail = searchStops(db, q, 20).map((s) => ({ ...s, network: 'rail' }));
    // ATM stops ride along when the static feed is loaded (F1)
    let atm: Array<{ stop_id: string; stop_name: string; stop_lat: number | null; stop_lon: number | null; network: string }> = [];
    try {
      atm = atmSearchStops(db, q, 10).map((s) => ({ ...s, network: 'atm' }));
    } catch { /* atm tables absent on old DBs */ }
    return c.json([...rail, ...atm]);
  });

  // F1: ATM stop board — scheduled departures from the static feed merged
  // with the operator's live quantized predictions (WaitMessage), which ARE
  // the operator estimate here (no raw telemetry exists, GOAL §21)
  app.get('/api/atm/stops/:id/board', (c) => {
    const stopId = c.req.param('id');
    const stop = atmStopById(db, stopId);
    if (!stop) return c.json({ error: 'unknown atm stop' }, 404);
    const today = romeYmd(Date.now());
    const nowSec = secondsIntoServiceDay(today);
    const deps = atmStopDepartures(db, stopId, today, nowSec - 300, nowSec + 5400, 40);
    // freshest live prediction per line (decoded WaitMessages)
    const live = new Map<string, { etaSec: number | null; flag: string | null; fetchedAt: number }>();
    for (const r of getRows<{ etas_json: string | null; wait_messages: string | null; fetched_at: number }>(
      db,
      'SELECT etas_json, wait_messages, fetched_at FROM atm_stop_observations WHERE stop_id=? ORDER BY fetched_at DESC LIMIT 3',
      [stopId],
    )) {
      let entries: Array<{ line: string | null; etaSec?: number | null; flag?: string | null }> = [];
      try {
        entries = r.etas_json != null
          ? JSON.parse(r.etas_json) as typeof entries
          : (JSON.parse(r.wait_messages ?? '[]') as Array<{ line: string | null; message: string | null }>)
              .map((w) => ({ line: w.line, ...decodeWaitMessage(w.message) }));
      } catch { continue; }
      for (const e of entries) {
        if (e.line == null || live.has(e.line)) continue;
        live.set(e.line, { etaSec: e.etaSec ?? null, flag: e.flag ?? null, fetchedAt: r.fetched_at });
      }
    }
    const merged = deps.map((d) => {
      const l = d.route_short_name != null ? live.get(d.route_short_name) : undefined;
      return {
        line: d.route_short_name,
        routeType: d.route_type,
        destinationName: d.destination_name,
        scheduledInSec: d.departure_sec != null ? d.departure_sec - nowSec : null,
        liveEtaSec: l?.etaSec ?? null,
        flag: l?.flag ?? null,
      };
    });
    return c.json({ stop: { stopId: stop.stop_id, name: stop.stop_name }, generatedAt: Date.now(), departures: merged, liveLines: [...live.entries()].map(([line, v]) => ({ line, etaSec: v.etaSec, flag: v.flag })) });
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
