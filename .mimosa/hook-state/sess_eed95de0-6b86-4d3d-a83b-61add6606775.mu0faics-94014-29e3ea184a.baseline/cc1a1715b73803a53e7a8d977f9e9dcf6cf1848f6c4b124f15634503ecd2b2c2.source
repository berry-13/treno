/**
 * Generic realtime provider contract (GOAL.md §24, §76). Every realtime
 * source — current or future (RAPSODIA, ATM GTFS-RT, EU TSI telematics) — is
 * isolated behind this interface so the rest of the system never learns
 * provider specifics.
 */

/** GTFS-Realtime-shaped vehicle position. */
export interface VehiclePosition {
  provider: string;
  vehicleId: string | null;
  tripId: string | null;
  routeId: string | null;
  stopId: string | null;
  lat: number | null;
  lon: number | null;
  bearing: number | null;
  speed: number | null;
  timestamp: number | null;
}

/** GTFS-Realtime-shaped trip update (stop-time predictions). */
export interface TripUpdate {
  provider: string;
  tripId: string | null;
  routeId: string | null;
  startTime: number | null;
  delaySec: number | null;
  stopTimeUpdates: Array<{ stopId: string | null; stopSequence: number | null; arrivalEpoch: number | null; departureEpoch: number | null; delaySec: number | null }>;
}

export interface ServiceAlert {
  provider: string;
  id: string | null;
  headerText: string | null;
  descriptionText: string | null;
  severity: string | null;
  activeFrom: number | null;
  activeTo: number | null;
  informedEntities: Array<{ routeId: string | null; stopId: string | null; tripId: string | null }>;
}

export interface RealtimeTransitProvider {
  readonly name: string;
  readonly available: boolean;
  fetchVehiclePositions(): Promise<VehiclePosition[]>;
  fetchTripUpdates(): Promise<TripUpdate[]>;
  fetchAlerts(): Promise<ServiceAlert[]>;
}

export class ProviderNotConfiguredError extends Error {
  constructor(provider: string) {
    super(provider + ' is not configured yet (no public endpoint identified)');
    this.name = 'ProviderNotConfiguredError';
  }
}
