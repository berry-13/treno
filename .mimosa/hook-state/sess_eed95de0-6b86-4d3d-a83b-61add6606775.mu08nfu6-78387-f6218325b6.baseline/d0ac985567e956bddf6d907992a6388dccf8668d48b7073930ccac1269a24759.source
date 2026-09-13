/**
 * Canonical train-run identity (GOAL.md §9): never the bare train number.
 * A run is identified by operator + service date + train number + origin +
 * scheduled origin departure (seconds since service midnight).
 */
export type Operator = string; // 'TRENORD' | 'TRENITALIA' | ...

export interface RunKey {
  operator: Operator;
  serviceDate: string;      // YYYY-MM-DD in Europe/Rome
  trainNumber: string;
  originStopId: string | null;
  schedDepSec: number | null; // seconds since service-day midnight
}

export function runKeyStr(k: RunKey): string {
  const dep = k.schedDepSec == null ? '?' : String(k.schedDepSec).padStart(6, '0');
  return `${k.operator}|${k.serviceDate}|${k.trainNumber}|${k.originStopId ?? '?'}|${dep}`;
}

/** Human-facing stable code, e.g. "4307@2026-09-13". */
export function runCode(trainNumber: string, serviceDate: string): string {
  return `${trainNumber}@${serviceDate}`;
}
