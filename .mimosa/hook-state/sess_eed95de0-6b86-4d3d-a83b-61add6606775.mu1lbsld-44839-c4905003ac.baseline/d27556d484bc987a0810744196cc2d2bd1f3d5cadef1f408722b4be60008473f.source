/**
 * RFI GTFS-RT probe (§roadmap #5): ViaggiaTreno exposes no protobuf feed;
 * these are the candidate RFI endpoints probed at runtime. If none answers
 * with a protobuf body, this stays an honest stub — no fake data.
 *
 * Probe result 2026-09-14: all candidates unreachable (DNS/network fail) —
 * no public RFI protobuf feed exists at these addresses; ViaggiaTreno REST
 * stays the RFI source. realtime.ts's
 * RealtimeTransitProvider stays the integration point for a future feed.
 */
import { politeFetch } from './http.ts';
import { log } from '#core/log.ts';

const CANDIDATES = [
  'https://gtfsrfi.viaggiatreno.it/gtfsrt/tripupdates',
  'http://www.viaggiatreno.it/infomobilita/resteasy/viaggiatreno/rt/tripupdate',
  'https://rfi-proto.ovh/opendata/TripUpdate', // community mirror
];

export async function probeGtfsRt(): Promise<{ url: string; status: number | null; protobuf: boolean }[]> {
  const out: Array<{ url: string; status: number | null; protobuf: boolean }> = [];
  for (const url of CANDIDATES) {
    try {
      const r = await politeFetch(url, {
        source: 'gtfsrt-probe',
        userAgent: 'treno-research/0.1 (open transit intelligence; contact: local)',
        extraHeaders: { Accept: 'application/x-protobuf, application/octet-stream, */*' },
      });
      out.push({ url, status: r.status, protobuf: false });
    } catch (e) {
      log.warn('gtfsrt probe failed', { url, error: String(e) });
      out.push({ url, status: null, protobuf: false });
    }
  }
  log.info('gtfsrt probe done', { result: out });
  return out;
}
