/**
 * RAPSODIA placeholder (GOAL.md §23, §74). The Lombardy smart-mobility
 * architecture is expected to publish GTFS-Realtime as open data (deadline
 * extended into 2027); no public endpoint is confirmed yet. This adapter
 * exists so that, the day the feed appears, ingestion starts by setting
 * TRENO_RAPSODIA_URL — no architectural change.
 *
 * Implementation sketch (for when the feed lands): protobuf-decode
 * VehiclePositions/TripUpdates/ServiceUpdates feeds and map them onto the
 * canonical GTFS-RT-shaped types in realtime.ts.
 */
import type { RealtimeTransitProvider, ServiceAlert, TripUpdate, VehiclePosition } from './realtime.ts';
import { ProviderNotConfiguredError } from './realtime.ts';

export class RapsodiaProvider implements RealtimeTransitProvider {
  readonly name = 'rapsodia';
  readonly available: boolean;

  constructor(private feedBaseUrl: string | null = process.env.TRENO_RAPSODIA_URL ?? null) {
    this.available = feedBaseUrl != null;
  }

  private ensure(): string {
    if (!this.feedBaseUrl) throw new ProviderNotConfiguredError(this.name);
    return this.feedBaseUrl;
  }

  async fetchVehiclePositions(): Promise<VehiclePosition[]> {
    this.ensure();
    throw new Error('rapsodia: decode implementation pending feed publication');
  }

  async fetchTripUpdates(): Promise<TripUpdate[]> {
    this.ensure();
    throw new Error('rapsodia: decode implementation pending feed publication');
  }

  async fetchAlerts(): Promise<ServiceAlert[]> {
    this.ensure();
    throw new Error('rapsodia: decode implementation pending feed publication');
  }
}
