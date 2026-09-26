/**
 * Polite HTTP for undocumented public endpoints (GOAL.md §57): explicit
 * descriptive User-Agent, timeouts, bounded retries with backoff+jitter on
 * transient failures only, per-source rate gating. Honors 4xx as definitive.
 */
import { log } from '#core/log.ts';

export interface FetchResult {
  ok: boolean;
  status: number;
  text: string;
  etag: string | null;
  lastModified: string | null;
  latencyMs: number;
  error: string | null;
}

export interface PoliteOptions {
  source: string;
  userAgent: string;
  timeoutMs?: number;
  retries?: number;
  extraHeaders?: Record<string, string>;
  minIntervalMs?: number; // per-source spacing
}

const lastReqAt = new Map<string, number>();
const inflight = new Map<string, number>();
const MAX_CONCURRENCY = 2;

interface GateWaiter { minIntervalMs: number; admit: () => void }
/** FIFO per source. Waiters are parked promises, woken by at most one timer
 * per source — a queued request costs no CPU while it waits. (The previous
 * gate re-polled every 150 ms per waiter, so a backlog burned CPU linearly
 * in its own length.) */
const waiters = new Map<string, GateWaiter[]>();
const wakeTimers = new Map<string, ReturnType<typeof setTimeout>>();

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function gate(source: string, minIntervalMs: number): Promise<void> {
  return new Promise((admit) => {
    let q = waiters.get(source);
    if (!q) waiters.set(source, (q = []));
    q.push({ minIntervalMs, admit });
    pump(source);
  });
}

/** Admit queued waiters for `source` in order while concurrency and spacing
 * allow; otherwise arm the single wake timer (spacing) or wait for release()
 * (concurrency). */
function pump(source: string): void {
  if (wakeTimers.has(source)) return;
  const q = waiters.get(source);
  while (q && q.length > 0) {
    const n = inflight.get(source) ?? 0;
    if (n >= MAX_CONCURRENCY) return;
    const now = Date.now();
    const waitMs = (lastReqAt.get(source) ?? 0) + q[0]!.minIntervalMs - now;
    if (waitMs > 0) {
      wakeTimers.set(source, setTimeout(() => {
        wakeTimers.delete(source);
        pump(source);
      }, waitMs));
      return;
    }
    const w = q.shift()!;
    inflight.set(source, n + 1);
    lastReqAt.set(source, now);
    w.admit();
  }
}

function release(source: string): void {
  inflight.set(source, Math.max(0, (inflight.get(source) ?? 1) - 1));
  pump(source);
}

/** Requests waiting in the per-source gate (for the collector summary). A
 * number that keeps climbing means demand exceeds the gate's rate. */
export function gateQueueDepth(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [source, q] of waiters) if (q.length > 0) out[source] = q.length;
  return out;
}

export async function politeFetch(url: string, opts: PoliteOptions): Promise<FetchResult> {
  const { source, userAgent } = opts;
  const timeoutMs = opts.timeoutMs ?? 15000;
  const retries = opts.retries ?? 2;
  const minInterval = opts.minIntervalMs ?? 400;

  let attempt = 0;
  for (;;) {
    await gate(source, minInterval);
    const started = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        redirect: 'follow',
        headers: { accept: '*/*', 'user-agent': userAgent, ...opts.extraHeaders },
      });
      clearTimeout(timer);
      release(source);
      const latencyMs = Date.now() - started;
      const text = await res.text();
      if (res.status >= 500 && attempt < retries) {
        attempt++;
        await sleep(1000 * attempt * attempt + (Date.now() % 997) * 0.5);
        continue;
      }
      return {
        ok: res.ok,
        status: res.status,
        text,
        etag: res.headers.get('etag'),
        lastModified: res.headers.get('last-modified'),
        latencyMs,
        error: res.ok ? null : 'HTTP ' + String(res.status),
      };
    } catch (e) {
      clearTimeout(timer);
      release(source);
      const latencyMs = Date.now() - started;
      if (attempt < retries) {
        attempt++;
        await sleep(1000 * attempt * attempt + (Date.now() % 997) * 0.5);
        continue;
      }
      log.warn('http: request failed', { source, url, error: String(e) });
      return { ok: false, status: 0, text: '', etag: null, lastModified: null, latencyMs, error: String(e) };
    }
  }
}

/** Binary variant of politeFetch for feed zips (same politeness contract).
 * Callers must validate the URL themselves — see providers/atm.ts for the
 * hostname-allowlist pattern. */
export async function politeFetchBytes(url: string, opts: PoliteOptions): Promise<{ ok: boolean; status: number; bytes: Uint8Array | null; error: string | null }> {
  const { source, userAgent } = opts;
  const timeoutMs = opts.timeoutMs ?? 60000;
  const retries = opts.retries ?? 1;
  const minInterval = opts.minIntervalMs ?? 1000;
  let attempt = 0;
  for (;;) {
    await gate(source, minInterval);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        redirect: 'follow',
        headers: { accept: 'application/zip, */*', 'user-agent': userAgent, ...opts.extraHeaders },
      });
      clearTimeout(timer);
      release(source);
      if (res.status >= 500 && attempt < retries) {
        attempt++;
        await sleep(1000 * attempt * attempt);
        continue;
      }
      if (!res.ok) return { ok: false, status: res.status, bytes: null, error: 'HTTP ' + String(res.status) };
      return { ok: true, status: res.status, bytes: new Uint8Array(await res.arrayBuffer()), error: null };
    } catch (e) {
      clearTimeout(timer);
      release(source);
      if (attempt < retries) {
        attempt++;
        await sleep(1000 * attempt * attempt);
        continue;
      }
      return { ok: false, status: 0, bytes: null, error: String(e) };
    }
  }
}
