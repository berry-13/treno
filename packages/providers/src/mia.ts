/**
 * Trenord MIA provider (GOAL.md §5.1). Undocumented backend; requires BOTH an
 * "Accept: ..." header and a descriptive User-Agent on every request (403
 * otherwise). All optional fields may be entirely ABSENT from the JSON — never
 * assume presence; parse everything defensively.
 *
 * Observed shape: top-level array; [0] = journey { date, dep_time, arr_time,
 * dep_station, arr_station, journey_list: [ { train, pass_list } ] }.
 */
import { createHash } from 'node:crypto';
import { hmsToSeconds, romeServiceTimeToEpoch, romeWallToEpoch } from '#core/time.ts';
import { politeFetch, type FetchResult } from './http.ts';
import type { ProviderStopEvent, ProviderTrainSnapshot } from './types.ts';

export const MIA_SOURCE = 'mia';
export const MIA_BASE = 'https://admin.trenord.it/store-management-api/mia';
export const MIA_PARSER_VERSION = 'mia-v1';

export interface MiaFetch {
  raw: string;
  result: FetchResult;
  snapshot: ProviderTrainSnapshot | null;
  relevantHash: string;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function bool(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null;
}

/** Local "HH:MM[:SS]" on the service date, snapped near a reference epoch. */
function localHmsNearEpoch(serviceDate: string, hms: string | null, refEpoch: number | null): number | null {
  const sec = hmsToSeconds(hms);
  if (sec == null) return null;
  if (refEpoch == null) return romeWallToEpoch(serviceDate, sec);
  const naive = romeWallToEpoch(serviceDate, sec);
  if (naive < refEpoch - 12 * 3600_000) return naive + 24 * 3600_000;
  if (naive > refEpoch + 12 * 3600_000) return naive - 24 * 3600_000;
  return naive;
}

interface MiaActualData {
  arr_estimated_time?: unknown;
  dep_estimated_time?: unknown;
  arr_actual_time?: unknown;
  dep_actual_time?: unknown;
  arr_delay_actual?: unknown;
  dep_delay_actual?: unknown;
  actual_station_mir?: unknown;
}

export function parseMiaTrain(raw: string): ProviderTrainSnapshot | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(json) || json.length === 0) return null;
  const journey = json[0] as Record<string, unknown>;
  const list = journey.journey_list;
  if (!Array.isArray(list) || list.length === 0) return null;
  const leg = list[0] as Record<string, unknown>;
  const train = (leg.train ?? {}) as Record<string, unknown>;
  const passList = Array.isArray(leg.pass_list) ? (leg.pass_list as Array<Record<string, unknown>>) : [];

  const dateRaw = str(journey.date); // "20260913"
  if (!dateRaw) return null;
  const serviceDate = dateRaw.slice(0, 4) + '-' + dateRaw.slice(4, 6) + '-' + dateRaw.slice(6, 8);

  const depStation = (journey.dep_station ?? {}) as Record<string, unknown>;
  const arrStation = (journey.arr_station ?? {}) as Record<string, unknown>;
  const trainNumber = str(train.train_id) ?? str(train.train_name);
  if (!trainNumber) return null;

  const delayMin = num(train.delay);
  const stops: ProviderStopEvent[] = [];
  passList.forEach((p, idx) => {
    const station = (p.station ?? {}) as Record<string, unknown>;
    const actual = (p.actual_data ?? {}) as MiaActualData;
    const arrIso = str(p.arr_date_time);
    const depIso = str(p.dep_date_time);
    const refEpoch = (arrIso ? Date.parse(arrIso) : NaN) || (depIso ? Date.parse(depIso) : NaN);
    const ref = Number.isFinite(refEpoch) ? refEpoch : null;
    const platform = str(p.platform);
    const cancelled = bool(p.cancelled);
    const opPredArr = localHmsNearEpoch(serviceDate, str(actual.arr_estimated_time), ref);
    const opPredDep = localHmsNearEpoch(serviceDate, str(actual.dep_estimated_time), ref);
    const actualArr = localHmsNearEpoch(serviceDate, str(actual.arr_actual_time), ref);
    const actualDep = localHmsNearEpoch(serviceDate, str(actual.dep_actual_time), ref);
    const arrDelay = num(actual.arr_delay_actual);
    const depDelay = num(actual.dep_delay_actual);
    stops.push({
      stopId: str(station.station_id),
      stopName: str(station.station_ori_name),
      stopSequence: idx + 1,
      schedArrEpoch: arrIso != null && Number.isFinite(Date.parse(arrIso)) ? Date.parse(arrIso) : localHmsNearEpoch(serviceDate, str(p.arr_time), null),
      schedDepEpoch: depIso != null && Number.isFinite(Date.parse(depIso)) ? Date.parse(depIso) : localHmsNearEpoch(serviceDate, str(p.dep_time), null),
      opPredArrEpoch: opPredArr,
      opPredDepEpoch: opPredDep,
      actualArrEpoch: actualArr,
      actualDepEpoch: actualDep,
      arrDelaySec: arrDelay != null ? Math.round(arrDelay * 60) : null,
      depDelaySec: depDelay != null ? Math.round(depDelay * 60) : null,
      platform,
      platformIsActual: bool(p.is_actual_platform),
      cancelled,
    });
  });

  const first = stops[0];
  const last = stops[stops.length - 1];
  const actualTimeRaw = str(train.actual_time);
  const observedAt = actualTimeRaw != null
    ? (actualTimeRaw.includes('T') && Number.isFinite(Date.parse(actualTimeRaw))
        ? Date.parse(actualTimeRaw)
        : localHmsNearEpoch(serviceDate, actualTimeRaw, null))
    : null;
  return {
    source: MIA_SOURCE,
    sourceKey: dateRaw + '|' + trainNumber,
    serviceDate,
    trainNumber,
    operator: str(train.train_operator) ?? 'TRENORD',
    originStopId: str(depStation.station_id) ?? first?.stopId ?? null,
    destinationStopId: str(arrStation.station_id) ?? last?.stopId ?? null,
    originStopName: str(depStation.station_ori_name),
    destinationStopName: str(arrStation.station_ori_name),
    schedDepSec: hmsToSeconds(str(journey.dep_time)) ?? (first?.schedDepEpoch != null ? schedEpochToSec(first.schedDepEpoch, serviceDate) : null),
    schedArrSec: hmsToSeconds(str(journey.arr_time)) ?? (last?.schedArrEpoch != null ? schedEpochToSec(last.schedArrEpoch, serviceDate) : null),
    delaySeconds: delayMin != null ? Math.round(delayMin * 60) : null,
    status: str(train.status),
    hasLiveInfo: bool(train.has_live_info),
    lastLocationId: str(train.actual_station_mir) ?? null,
    lastLocationName: str(train.actual_station) ?? null,
    observedAt,
    cancelled: train.suppression_type != null ? true : (stops.some((x) => x.cancelled === true) ? true : null),
    crowding: num(train.average_crowding),
    crowdingLabel: str(train.average_crowding_label),
    alerts: Array.isArray(train.alerts) ? train.alerts : [],
    stops,
  };
}

function schedEpochToSec(epoch: number, serviceDate: string): number {
  const midnight = romeWallToEpoch(serviceDate, 0);
  return Math.round((epoch - midnight) / 1000);
}

export function miaRelevantHash(s: ProviderTrainSnapshot): string {
  const rel = {
    d: s.delaySeconds, st: s.status, loc: s.lastLocationId, obs: s.observedAt, cr: s.crowding,
    stops: s.stops.map((x) => [x.stopId, x.opPredArrEpoch, x.opPredDepEpoch, x.actualArrEpoch, x.actualDepEpoch, x.platform, x.cancelled, x.arrDelaySec, x.depDelaySec]),
  };
  return createHash('sha256').update(JSON.stringify(rel)).digest('hex');
}

export async function fetchMiaTrain(trainNumber: string, userAgent: string): Promise<MiaFetch> {
  const url = MIA_BASE + '/train/' + encodeURIComponent(trainNumber);
  const result = await politeFetch(url, {
    source: MIA_SOURCE,
    userAgent,
    extraHeaders: { accept: '*/*' },
  });
  const snapshot = result.ok ? parseMiaTrain(result.text) : null;
  const relevantHash = snapshot ? miaRelevantHash(snapshot) : '';
  return { raw: result.text, result, snapshot, relevantHash };
}
