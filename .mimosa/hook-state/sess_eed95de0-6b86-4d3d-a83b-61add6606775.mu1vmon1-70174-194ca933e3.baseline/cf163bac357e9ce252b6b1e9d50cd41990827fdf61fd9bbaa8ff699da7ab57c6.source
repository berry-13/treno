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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function gate(source: string, minIntervalMs: number): Promise<void> {
  for (;;) {
    const now = Date.now();
    const last = lastReqAt.get(source) ?? 0;
    const n = inflight.get(source) ?? 0;
    if (n < MAX_CONCURRENCY && now - last >= minIntervalMs) {
      inflight.set(source, n + 1);
      lastReqAt.set(source, now);
      return;
    }
    await sleep(150);
  }
}

function release(source: string): void {
  inflight.set(source, (inflight.get(source) ?? 1) - 1);
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
