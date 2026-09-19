/**
 * Provider-neutral realtime snapshot model. Providers translate their native
 * payloads into this shape; everything downstream (storage, fusion, API) works
 * only against it (GOAL.md §24, §76).
 */
export interface ProviderStopEvent {
  stopId: string | null;
  stopName: string | null;
  stopSequence: number | null;
  schedArrEpoch: number | null;
  schedDepEpoch: number | null;
  /** operator's current estimated times (live prediction layer) */
  opPredArrEpoch: number | null;
  opPredDepEpoch: number | null;
  actualArrEpoch: number | null;
  actualDepEpoch: number | null;
  arrDelaySec: number | null;
  depDelaySec: number | null;
  platform: string | null;
  platformIsActual: boolean | null;
  cancelled: boolean | null;
}

export interface ProviderTrainSnapshot {
  source: string;
  sourceKey: string;
  serviceDate: string; // YYYY-MM-DD Europe/Rome
  trainNumber: string;
  operator: string | null;
  originStopId: string | null;
  destinationStopId: string | null;
  originStopName: string | null;
  destinationStopName: string | null;
  schedDepSec: number | null; // seconds since service midnight
  schedArrSec: number | null;
  delaySeconds: number | null; // operator-reported current delay
  status: string | null;      // provider-native status code
  hasLiveInfo: boolean | null;
  lastLocationId: string | null;
  lastLocationName: string | null;
  observedAt: number | null;  // upstream-stated event time (epoch ms)
  cancelled: boolean | null;
  crowding: number | null;
  crowdingLabel: string | null;
  alerts: unknown[];
  stops: ProviderStopEvent[];
}
