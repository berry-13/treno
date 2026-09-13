/**
 * ATM Milano (GiroMilano) stop provider (GOAL.md §20-21). The stop endpoint
 * exposes quantized WaitMessages ("in arrivo", "3 min", ...) without vehicle
 * identity or raw positions — so we record stop-level observations only.
 * Latent vehicle reconstruction (§22) is deliberately out of scope until a
 * real GTFS-RT VehiclePosition feed (RAPSODIA) appears. Disabled unless stop
 * ids are configured via TRENO_ATM_STOPS.
 */
import { politeFetch, type FetchResult } from './http.ts';

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
