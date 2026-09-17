# treno

Predictive realtime transit intelligence for Italian trains — a "Flighty for
public transport". Full product specification: [GOAL.md](GOAL.md).

**Native iOS client (primary):** `apps/ios` — a SwiftUI app built on the iOS 26
Liquid Glass design (`glassEffect`, `GlassEffectContainer`, glass buttons,
background extension). See below for building/running it.

**What this is right now (POC):** a data collection + fusion pipeline for
Lombardy rail that polls the Trenord MIA backend and ViaggiaTreno/RFI for every
train running right now, resolves them against the canonical Trenord GTFS
schedule into stable run identities, stores every raw payload for later
reprocessing, fuses per-source observations into a live train state with
explicit provenance and confidence, and serves it to the iOS app (and a debug
web page) over HTTP. The prediction model is the honest v0 baseline
(our ETA = operator ETA) so that benchmarking can start immediately.

## Quickstart (backend)

```bash
npm install
npm run gtfs:load     # download + parse canonical Trenord GTFS into SQLite
npm run collector     # start the polling collector (runs forever)
npm run api           # serve API on http://127.0.0.1:8787 (iOS app + web UI)
```

Or use the helpers:

```bash
bin/start.sh          # start collector + api in background, verify health
bin/stop.sh           # stop them (kills process trees, not just wrappers)
```

## The iOS app (apps/ios)

SwiftUI, iOS 26.0+, with native navigation, adaptive light/dark appearance,
and three passenger-focused tabs: **Home**, **Stations**, and **Journeys**.
Home focuses on your next saved journey and stations you have saved or used. Stations provides
search, a map, departures, delays, and labeled platforms. Journey and train
pages show departure/arrival times and a stop timeline; the scheduled,
operator, and Treno estimates are available under **About these times**.
Settings is accessed from the gear button on Home; local server setup is
under **Data connection**. Saved routes and favorites stay on the device.

```bash
cd apps/ios
xcodegen generate        # only after adding files (project.yml is the source of truth)
open Treno.xcodeproj     # run on the simulator (⌘R)
```

CLI equivalent:

```bash
xcodebuild -project Treno.xcodeproj -scheme Treno \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' build
```

- The simulator reaches the API at `http://127.0.0.1:8787` automatically.
- A real device on the same Wi-Fi: Home → Settings → Data connection → point at your
  Mac's LAN address, e.g. `http://192.168.1.20:8787`.
- Demo deep link: `xcrun simctl launch booted com.treno.Treno --train 699`.

Useful collector invocations:

```bash
npx tsx packages/collector/src/index.ts --once                 # one discovery+poll pass
npx tsx packages/collector/src/index.ts --watch=4307,2174      # force-track numbers at 25s cadence
npx tsx packages/collector/src/index.ts --duration=3600        # run for one hour
```

## Architecture

```
GTFS zip (dati.lombardia.it, canonical)      MIA + ViaggiaTreno (undocumented, public)
        │                                              │
        ▼                                              ▼
  packages/gtfs                                 packages/providers
  (schedule DB, run discovery)                  (polite HTTP, defensive parsers)
        │                                              │
        └───────────────► packages/collector ◄─────────┘
                           (adaptive polling → raw snapshots → normalize → fuse state)
                                      │
                                      ▼
                        data/ (SQLite + zstd raw files) ◄── packages/storage
                                      │
                                      ▼
                        packages/api + apps/web (read-only views)
```

Monorepo layout (npm workspaces, TypeScript ESM, no build step — run with tsx):

| package | role |
|---|---|
| `packages/core` | Rome-timezone service-date math (§80), canonical `TrainRunId` (§9), config, logging, SQLite helpers |
| `packages/gtfs` | ZIP download + parser → schedule tables; discovery queries; station boards |
| `packages/providers` | MIA + ViaggiaTreno clients; provider-neutral snapshot model (§24) |
| `packages/storage` | normalized schema (§30-33), zstd raw snapshot store (§28-29), run registry |
| `packages/collector` | adaptive polling scheduler (§36), ingest pipeline, state fusion (§10) |
| `packages/api` | HTTP API + static web debug page |
| `apps/web` | single-file debug page (scheduled vs operator vs ours) |
| `apps/ios` | **native iOS client** — SwiftUI + Liquid Glass (iOS 26) |

## Prediction & intelligence layer (current state)

- **Segment model (§13)** — `segment_observation` rows derive automatically
  from actual stop events; `segment_stats` holds runtime/delay-delta
  distributions (p10/p50/p90, peak/off-peak buckets), refreshed every 10 min.
  `npx tsx packages/collector/src/backfill-segments.ts` retro-derives from
  collected history.
- **Heuristic ETA v1 (§66)** — model `heuristic-v1`: independent estimate
  (anchor at last actual + segment medians + live corridor adjustment) blended
  with the operator ETA (weight by freshness and history coverage). Outputs
  p10/p50/p90 + confidence + expected recovery; features are persisted per
  prediction (`features_json`) for reproducibility (§35).
- **Connection risk (§18)** — `GET /api/trains/:id` returns the next
  departures at the destination with P(success) from our arrival distribution
  + per-station transfer buffer, using live delay of the connecting service
  when tracked. Shown in the iOS app as "connections at destination".
- **Benchmark (§34)** — `npm run bench [-- --days=30]`: scores every recorded
  prediction at T-1…T-30+ horizons: schedule vs operator vs each of our models
  (MAE/medAE/RMSE/P90/P95/bias + interval coverage), writes
  `data/reports/benchmark-YYYY-MM-DD.md`. Verdict line refuses to claim
  accuracy until a model beats the operator on ≥30 outcomes.
- **Quality engine (§45)** — DELAY_JUMP flags on observations;
  SOURCE_CONFLICT/STALE_SOURCE in fused state quality.
- **Alerts (§50)** — provider alerts deduped into `service_alerts`;
  `GET /api/alerts`.
- **Retention (§43)** — `npm run retain [-- --raw-days=45 --obs-days=365]`.
- **Provider abstraction (§24/§74)** — `RealtimeTransitProvider` interface;
  `RapsodiaProvider` stub activates by setting `TRENO_RAPSODIA_URL`.
- **ATM/GiroMilano (§20)** — stop WaitMessage ingestion available; opt in with
  `TRENO_ATM_STOPS=11491,...` (disabled by default; no vehicle identity
  exists in that feed — reconstruction deliberately deferred until RAPSODIA,
  §21-22).

Early findings from day-one data (see data/reports/): the operator ETA shows a
**systematic −30…−67 s optimistic bias** at T-1…T-30 horizons — exactly the
residual the ML phase (§67) will target once enough history accumulates.

## Data layout (all under `data/`, gitignored)

```
data/db/treno.db          SQLite (WAL): gtfs_* schedule tables + normalized tables
data/gtfs/trenord_gtfs.zip canonical feed (re-downloaded if >12h old)
data/raw/{source}/YYYY/MM/DD/*.json.zst   raw payloads, one file per change (§29)
data/logs/                collector + api stdout logs
```

Normalized tables worth knowing:

- `train_runs` — canonical run identity (never the bare number: operator,
  service_date, train_number, origin, sched departure). `train_run_sources`
  maps source-native keys (MIA `date|trainId`, VT `num|origin|midnightEpoch`).
- `source_snapshots` — one row **per fetch** (freshness histograms, §37);
  payload bytes only written when the hash changes (dedup, §44).
- `train_observations` — one row per relevant-field change, with source,
  upstream-observed time, delay, location + kind (station vs reporting point).
- `train_stop_events` — per (run, stop): scheduled / operator-predicted /
  actual times, delays, platform. Actuals never regress to null.
- `train_state` — fused current state JSON (per-source ages, disagreement
  spread, confidence).
- `predictions` / `prediction_outcomes` — every prediction is recorded and
  scored against the actual arrival when it lands (§33-34).

## API

```
GET /api/health                     providers + table counts + change rates
GET /api/trains?q=&limit=           runs with fused state (incl. ourEstimate)
GET /api/trains/:id                 run + stops + observations + latestPrediction + connections
GET /api/stops/search?q=
GET /api/stops/:id/departures       today's board ±window with live state
GET /api/segments                   segment statistics (top by sample count)
GET /api/corridor?from=&to=         segment stats + live congestion delta
GET /api/alerts                     recent provider alerts
GET /api/atm/stops/:id              ATM stop observations (when enabled)
GET /                                web debug page
```

## Source etiquette (§57)

Undocumented public endpoints are treated carefully: descriptive User-Agent,
conservative adaptive polling (5min → 30s by phase, 25s floor for watched
trains), per-source request spacing + max concurrency 2, retries with backoff
on transient failures only, 4xx treated as entity-level misses (except
403/429 which pause the source), every raw payload retained so history can be
reprocessed without re-fetching (§79).

## Current status / what's next (GOAL.md build order)

Done: steps 1-10 (monorepo, GTFS parser, MIA, ViaggiaTreno, identity mapper,
raw storage, normalized DB, collector running, state service, API/UI).

Next, in order:
1. **Let it run.** History is the moat (§11) — the collector should run
   continuously for weeks. `bin/start.sh` after reboots.
2. Segment statistics: derive `segment_observation` from stop events, build
   per-segment runtime/delay-recovery distributions (§13).
3. Heuristic ETA: independent estimate from historical segment medians blended
   with operator ETA (§66), replacing the v0 passthrough.
4. Evaluation pipeline: benchmark vs operator ETA at T-30/20/10/5/2/1 horizons
   (§34) — the `predictions`/`prediction_outcomes` tables already collect
   everything needed.
5. Only then: LightGBM/CatBoost residual model (§67), time-based splits, no
   leakage.

### Notes / gotchas discovered building this

- MIA requires both an `Accept` header and a `User-Agent` or it 403s.
- Trenord GTFS `trip_short_name` is `"{line} - {number}"`; providers are
  addressed by the bare number after `" - "`.
- ViaggiaTreno autocomplete keys are `{number}-{originCode}-{epochMs}` where
  the epoch is the Rome **midnight of the service date**, not the departure.
- **Station code spaces differ**: Trenord GTFS and ViaggiaTreno agree on
  Ferrovienord `S0xxxx` codes but NOT on RFI stations (VT: Brescia `S01717`;
  GTFS uses a different id). The ingest pipeline aliases unmapped provider
  stops onto the trip's GTFS stops by normalized name (canonical stop
  identity v1, §81) — a real cross-provider stop registry is future work.
- The GTFS feed uses exception-only calendars (`calendar_dates.txt`, 385k rows,
  no `calendar.txt`); stop times are seconds-since-service-midnight and may
  exceed 86400.
- Portal-imported GTFS copies lose data (§8) — always load the original ZIP.

## Historical backfill — Monechi 2015 priors

`npm run backfill:monechi` seeds `segment_stats_prior` from the Monechi 2018
dataset (national ViaggiaTreno per-train data, March-April 2015, regional
services). It auto-downloads the 82 MB zip into `data/raw/monechi/`
(gitignored; MD5-checked against the figshare record), maps 2015 station
names onto GTFS `stop_id`s by normalized name + ≤3 km coordinate agreement
(unmatchable segments are skipped), and writes per-segment runtime /
delay-development quantiles attributed to `source='monechi-2015'`.

License: **CC BY 4.0** — cite Monechi, Di Clemente, Gravino, Servedio,
"Complex delay dynamics on railway networks from universal laws to realistic
modelling", EPJ Data Science 7, 55 (2018), DOI 10.1140/epjds/s13688-018-0160-x.

What the priors may and may not do (measured on 14 days of live traversals,
see `packages/storage/src/segments.ts`): 2015 point estimates lose to both
live stats and the current GTFS schedule in every stratum, so they **never
shift `rt_p50`/`dd_p50`** — live rows always win outright, and prior-only
segments anchor their point estimate on today's schedule. The priors
contribute distribution *shape* only: the p10..p90 spread on segments
without live coverage (widened for vintage, and never narrower than the
no-history guess) plus stored delay-development stats for future models.
`statsForSegment()` merges at read time; `refreshSegmentStats()` never
touches the prior table, and re-running the import is idempotent.

To enable on the server after a redeploy, run the import once inside the
collector image (it downloads the raw data into the shared `treno-data`
volume):

```
docker compose run --rm collector npx tsx packages/collector/src/backfill-monechi.ts
```

## Second live source — chuuchuu: investigated, not integrated

chuuchuu.com was evaluated as a third realtime source (2026-09-17) and
**rejected at the gate**: their public data offering is *historical* delay
history/statistics only ("API & Data Packs"), access is a sales contact form
with no published pricing or self-service keys, no public API docs exist,
and their terms grant use of app content "for personal purposes only" —
their realtime feed powers their own app via an undocumented internal API.
Polling that internal API at collector scale would violate their terms. If
they ever publish a documented live API, the provider pattern to follow is
`packages/providers/vt.ts` (envelope + parse → `ingestSnapshot`).

## Configuration (env)

```
TRENO_DATA_DIR       default <repo>/data
TRENO_USER_AGENT     default identifies this collector
TRENO_API_PORT       default 8787
TRENO_MAX_TRACKED    default 80 concurrent runs
TRENO_MIN_POLL_SEC   default 20 (per-entity floor)
TRENO_GTFS_URL       default dati.lombardia.it 3z4k-mxz9 download
```

## Server deployment (Docker + ClickHouse)

One image, three roles, plus ClickHouse (PLAN_docker_clickhouse.md):

```
docker compose up -d --build        # collector + api :8787 + trainer + clickhouse
```

- Image builds from the repo root Dockerfile (node:24-slim, tsx runs TS
  directly). CI (`.github/workflows/docker.yml`) pushes multi-arch images to
  `ghcr.io/berry-13/treno` on every main push and runs a compose smoke test.
- ClickHouse tables are created on first container start from
  `deploy/clickhouse-init/01_tables.sql`; its ports are loopback-only.
- The collector/api mirror inserts into ClickHouse when
  `TRENO_CLICKHOUSE_URL` is set (compose sets it automatically). SQLite on
  the `treno-data` volume stays the operational truth.
- One-shot history import on a fresh server:
  `TRENO_CLICKHOUSE_URL=http://clickhouse:8123 npm run ch:backfill`
  (10k-row batches; ~700k rows in ~20s).
- Remote server: `docker login ghcr.io`, then
  `TRENO_IMAGE=ghcr.io/berry-13/treno:latest docker compose -f docker-compose.yml -f docker-compose.ci.yml up -d`
  and point iOS Settings at `http://<server-ip>:8787`.

Additional env for the mirror:
```
TRENO_CLICKHOUSE_URL   unset = SQLite-only (local dev default)
```
