/**
 * Hourly weather signal for the model (rain measurably slows Lombardy rail).
 * Open-Meteo, no key. Anchored on three points across the network; the
 * feature served is the mean current-hour precipitation.
 */
import { log } from '#core/log.ts';

const POINTS = [
  { name: 'milano', lat: 45.46, lon: 9.19 },
  { name: 'brescia', lat: 45.54, lon: 10.21 },
  { name: 'varese', lat: 45.82, lon: 8.82 },
];

let cached: { at: number; precipMm: number | null; source: string | null } = { at: 0, precipMm: null, source: null };

/** which model served the current value ('dwd-icon' via open-meteo mirror) */
export function precipSource(): string | null {
  return Date.now() - cached.at < 3 * 3600_000 ? cached.source : null;
}

export function currentPrecipMm(): number | null {
  return Date.now() - cached.at < 3 * 3600_000 ? cached.precipMm : null;
}

// refreshWeather() is called from every maintenance tick (~5 s). Without a
// gate that was ~52k Open-Meteo requests/day, 5x the free tier, and the API
// started refusing us (issue #4). Refresh at most every 30 min, never two at
// once, and back off exponentially (capped at 6 h) while it keeps failing.
const WEATHER_TTL_MS = 30 * 60_000;
const WEATHER_MAX_BACKOFF_MS = 6 * 3600_000;
let inflight = false;
let lastAttemptAt = 0;
let failures = 0;

function nextDelayMs(): number {
  return failures === 0 ? WEATHER_TTL_MS : Math.min(WEATHER_MAX_BACKOFF_MS, WEATHER_TTL_MS * 2 ** (failures - 1));
}

export async function refreshWeather(): Promise<void> {
  const now = Date.now();
  if (inflight || now - lastAttemptAt < nextDelayMs()) return;
  inflight = true;
  lastAttemptAt = now;
  try {
    await doRefreshWeather();
  } finally {
    inflight = false;
  }
}

async function doRefreshWeather(): Promise<void> {
  try {
    const vals: number[] = [];
    const statuses: number[] = [];
    for (const p of POINTS) {
      // pinned to DWD's ICON model — deterministic, authoritative input rather
// than the auto-mixing default; if ICON is missing for a point it errors and
// that point is skipped instead of silently swapping models
      const url = 'https://api.open-meteo.com/v1/forecast?latitude=' + p.lat + '&longitude=' + p.lon + '&hourly=precipitation&models=icon_seamless&forecast_days=1';
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) { statuses.push(res.status); continue; }
      const j = (await res.json()) as { hourly?: { time: string[]; precipitation: number[] } };
      const now = new Date();
      const times = j.hourly?.time ?? [];
      const precip = j.hourly?.precipitation ?? [];
      const idx = times.findIndex((t) => t.startsWith(now.toISOString().slice(0, 13)));
      if (idx >= 0 && precip[idx] != null) vals.push(precip[idx]!);
    }
    if (vals.length > 0) {
      cached = { at: Date.now(), precipMm: Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100, source: 'dwd-icon' };
      failures = 0;
      log.info('weather refreshed', { precipMm: cached.precipMm, points: vals.length });
    } else {
      failures++;
      log.warn('weather refresh failed', { statuses, failures, retryInMin: Math.round(nextDelayMs() / 60_000) });
    }
  } catch (e) {
    failures++;
    log.warn('weather refresh failed', { error: String(e), failures, retryInMin: Math.round(nextDelayMs() / 60_000) });
  }
}
