/**
 * F8 probes (PLAN_next_frontiers): cheap, self-gated readiness checks that
 * run from the collector maintenance tick.
 *
 *  - national rail probe (weekly): ViaggiaTreno is already a national API —
 *    sample known non-Lombardy train numbers and measure what fraction gives
 *    usable andamentoTreno data. When >50%, flipping discovery nationwide is
 *    a decision, not a build (storage/retention scale first, GOAL §42).
 *  - RAPSODIA catalog probe (monthly): scan the Regione Lombardia open-data
 *    catalog for a GTFS-Realtime dataset; when one appears the existing
 *    placeholder provider (providers/rapsodia.ts) gets its URL and decoding.
 *
 * Results land in probe_results (kind + payload + created_at) so /api/health
 * can surface them.
 */
import { getRow, getRows, runStmt, type Db } from '#core/db.ts';
import { log } from '#core/log.ts';
import { vtAutocomplete, fetchVtTrain } from '#providers/vt.ts';
import { loadConfig } from '#core/config.ts';

export function ensureProbeTable(db: Db): void {
  db.exec('CREATE TABLE IF NOT EXISTS probe_results(kind TEXT NOT NULL, payload_json TEXT NOT NULL, created_at INTEGER NOT NULL)');
}

function lastProbeAt(db: Db, kind: string): number {
  const r = getRow<{ t: number }>(db, 'SELECT MAX(created_at) AS t FROM probe_results WHERE kind=?', [kind]);
  return r?.t ?? 0;
}

function record(db: Db, kind: string, payload: unknown): void {
  runStmt(db.prepare('INSERT INTO probe_results(kind, payload_json, created_at) VALUES(?,?,?)'), [kind, JSON.stringify(payload), Date.now()]);
  // keep the newest 20 rows per kind
  const old = getRows<{ kind: string; created_at: number }>(db, 'SELECT kind, created_at FROM probe_results ORDER BY created_at DESC LIMIT -1 OFFSET 20');
  const del = db.prepare('DELETE FROM probe_results WHERE kind=? AND created_at=?');
  for (const r of old) runStmt(del, [r.kind, r.created_at]);
}

/** Known non-Lombardy long-distance numbers (Freccia/IC/night samples). */
const NATIONAL_SAMPLE = [9505, 9610, 8710, 522, 657, 713, 350, 19636, 2206, 2914];

export async function probeNationalRail(db: Db): Promise<void> {
  const cfg = loadConfig();
  let usable = 0;
  for (const num of NATIONAL_SAMPLE) {
    try {
      const ac = await vtAutocomplete(String(num), cfg.userAgent);
      const first = ac.refs[0];
      if (!first) continue;
      const t = await fetchVtTrain(first, cfg.userAgent);
      if (t.result.ok && t.snapshot && t.snapshot.stops.length >= 2) usable++;
    } catch {
      // unreachable numbers are data too
    }
  }
  const payload = { sampled: NATIONAL_SAMPLE.length, usable, usablePct: Math.round((usable / NATIONAL_SAMPLE.length) * 100), note: 'flip discovery nationwide when usablePct > 50 (decision, then §42 volume check)' };
  record(db, 'national-rail', payload);
  log.info('probe: national rail', payload);
}

const RAPSODIA_CATALOG = 'https://www.dati.lombardia.it/api/catalog/v1';

export async function probeRapsodia(db: Db): Promise<void> {
  let hits: string[] = [];
  try {
    const res = await fetch(RAPSODIA_CATALOG + '?q=' + encodeURIComponent('gtfs realtime') + '&limit=20', {
      headers: { accept: 'application/json', 'user-agent': loadConfig().userAgent },
    });
    if (res.ok) {
      const data = await res.json() as { results?: Array<{ resource?: { name?: string; id?: string } }> };
      for (const r of data.results ?? []) {
        const name = r.resource?.name ?? '';
        if (/gtfs.*(real.?time|rt)|(real.?time|rt).*gtfs/i.test(name)) hits.push(name + '#' + String(r.resource?.id ?? ''));
      }
    }
  } catch (e) {
    log.warn('probe: rapsodia catalog unreachable', { error: String(e) });
  }
  const payload = { gtfsRealtimeDatasets: hits, found: hits.length > 0, note: hits.length > 0 ? 'RAPSODIA FEED APPEARED — wire providers/rapsodia.ts (TRENO_RAPSODIA_URL + protobuf decode)' : 'placeholder stays' };
  record(db, 'rapsodia-catalog', payload);
  log.info('probe: rapsodia catalog', { found: payload.found });
}

/** Self-gated entry point from the maintenance tick. */
export async function runDueProbes(db: Db): Promise<void> {
  ensureProbeTable(db);
  const now = Date.now();
  if (now - lastProbeAt(db, 'national-rail') > 7 * 86400_000) {
    await probeNationalRail(db).catch((e) => log.warn('probe: national failed', { error: String(e) }));
  }
  if (now - lastProbeAt(db, 'rapsodia-catalog') > 30 * 86400_000) {
    await probeRapsodia(db).catch((e) => log.warn('probe: rapsodia failed', { error: String(e) }));
  }
}
