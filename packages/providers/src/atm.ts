/**
 * ATM Milano (GiroMilano) stop provider (GOAL.md §20-21). The stop endpoint
 * exposes quantized WaitMessages ("in arrivo", "3 min", ...) without vehicle
 * identity or raw positions — so we record stop-level observations only.
 * Latent vehicle reconstruction (§22) is deliberately out of scope until a
 * real GTFS-RT VehiclePosition feed (RAPSODIA) appears. Disabled unless stop
 * ids are configured via TRENO_ATM_STOPS.
 */
import { politeFetch, politeFetchBytes, type FetchResult } from './http.ts';
import { log } from '#core/log.ts';

export const ATM_SOURCE = 'giromilano';
export const ATM_BASE = 'https://giromilano.atm.it/proxy.tpportal/api/tpPortal';

export interface AtmWaitMessage {
  line: string | null;
  message: string | null;
}

export interface AtmStopSnapshot {
  stopId: string;
  raw: string;
  result: FetchResult;
  waitMessages: AtmWaitMessage[];
}

/** Recursively collect {line, WaitMessage} pairs from the unknown schema. */
function extractWaitMessages(node: unknown, out: AtmWaitMessage[], depth = 0): void {
  if (depth > 6 || node == null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) extractWaitMessages(item, out, depth + 1);
    return;
  }
  const obj = node as Record<string, unknown>;
  const msg = typeof obj.WaitMessage === 'string' ? obj.WaitMessage : null;
  if (msg != null) {
    const line = typeof obj.Line === 'string'
      ? obj.Line
      : typeof obj.line === 'string'
        ? obj.line
        : typeof obj.Code === 'string' ? obj.Code : null;
    out.push({ line, message: msg });
  }
  for (const v of Object.values(obj)) extractWaitMessages(v, out, depth + 1);
}

export async function fetchAtmStop(stopId: string, userAgent: string): Promise<AtmStopSnapshot> {
  const url = ATM_BASE + '/geodata/pois/stops/' + encodeURIComponent(stopId);
  const result = await politeFetch(url, { source: ATM_SOURCE, userAgent });
  let waitMessages: AtmWaitMessage[] = [];
  if (result.ok) {
    try {
      waitMessages = [];
      extractWaitMessages(JSON.parse(result.text), waitMessages);
    } catch {
      waitMessages = [];
    }
  }
  return { stopId, raw: result.text, result, waitMessages };
}

export function atmConfiguredStops(): string[] {
  const raw = process.env.TRENO_ATM_STOPS ?? '';
  return raw.split(',').map((s) => s.trim()).filter((s) => s !== '');
}

/** ATM static GTFS (GOAL.md §26) — the official open-data zip, a fixed
 * literal URL (AMAT publishes the feed here; nothing is configurable, so no
 * request can ever be steered anywhere else). Downloaded through the shared
 * polite HTTP layer. */
export const ATM_GTFS_URL = 'https://dati.comune.milano.it/gtfs.zip';

export async function fetchAtmGtfsZip(userAgent: string): Promise<Uint8Array | null> {
  const r = await politeFetchBytes(ATM_GTFS_URL, { source: 'atm-gtfs', userAgent, timeoutMs: 120000, retries: 1 });
  if (!r.ok || r.bytes == null) {
    log.warn('atm gtfs: download failed — staying rail-only', { status: r.status, error: r.error });
    return null;
  }
  return r.bytes;
}

/** Quantized WaitMessage → predicted ETA seconds + quality flag (§20-21).
 * The message IS the operator's prediction — keep it labeled as such. */
export function decodeWaitMessage(msg: string | null): { etaSec: number | null; flag: string | null } {
  if (msg == null) return { etaSec: null, flag: null };
  const m = msg.trim().toLowerCase();
  if (m === 'in arrivo' || m === 'in arrivo.') return { etaSec: 45, flag: null };
  const min = m.match(/^(\d+)\s*(?:min|minute|minuti)/);
  if (min) return { etaSec: Number(min[1]) * 60, flag: null };
  if (m.includes('ricalcolo')) return { etaSec: null, flag: 'RECALC' };
  if (m.includes('no serv') || m.includes('non in servizio') || m.includes('sospesa')) return { etaSec: null, flag: 'NO_SERVICE' };
  return { etaSec: null, flag: null };
}

/** Metro line status (GOAL.md §25) — line-level regular/disrupted only.
 * Normalized to service-alert-shaped rows; lines running normally produce
 * nothing (silence = healthy). */
export interface MetroLineStatus {
  line: string;
  direction: string | null;
  status: string | null; // raw description from the feed
  disrupted: boolean;
}

export async function fetchMetroStatus(userAgent: string): Promise<MetroLineStatus[]> {
  const url = ATM_BASE + '/tpl/atm/sm';
  const result = await politeFetch(url, { source: ATM_SOURCE, userAgent });
  if (!result.ok) return [];
  let json: unknown;
  try {
    json = JSON.parse(result.text);
  } catch {
    return [];
  }
  const out: MetroLineStatus[] = [];
  const visit = (node: unknown, depth: number) => {
    if (depth > 6 || node == null || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const item of node) visit(item, depth + 1); return; }
    const obj = node as Record<string, unknown>;
    const line = typeof obj.Line === 'string' ? obj.Line : typeof obj.line === 'string' ? obj.line : null;
    const desc = typeof obj.Description === 'string' ? obj.Description : typeof obj.description === 'string' ? obj.description : null;
    const status = typeof obj.Status === 'string' ? obj.Status : typeof obj.status === 'string' ? obj.status : null;
    if (line != null && (desc != null || status != null)) {
      const s = ((desc ?? '') + ' ' + (status ?? '')).toLowerCase();
      out.push({
        line,
        direction: desc,
        status: status ?? desc,
        disrupted: /disagi|ferm|sosp|lent|ritard|irregol|chius/.test(s),
      });
    }
    for (const v of Object.values(obj)) visit(v, depth + 1);
  };
  visit(json, 0);
  return out;
}
