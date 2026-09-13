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

SwiftUI, iOS 26.0+, Liquid Glass throughout: glass cards for runs and sections,
glass toolbar buttons and search field, `backgroundExtensionEffect` scrolling,
dark Flighty-style board. Features: live runs board with provider health,
search, train page with the three time levels (Scheduled / Operator / Ours),
confidence, per-source observation chips with ages and reporting-point
locations, and the full stop timeline (passed dimmed, next highlighted).

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
- A real device on the same Wi-Fi: in-app Settings (gear icon) → point at your
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
GET /api/health                     providers + table counts
GET /api/trains?q=&limit=           runs with fused state
GET /api/trains/:id                 run + stops + recent observations (id or 2174@2026-09-13)
GET /api/stops/search?q=
GET /api/stops/:id/departures       today's board ±window with live state
GET /                                web UI
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

## Configuration (env)

```
TRENO_DATA_DIR       default <repo>/data
TRENO_USER_AGENT     default identifies this collector
TRENO_API_PORT       default 8787
TRENO_MAX_TRACKED    default 80 concurrent runs
TRENO_MIN_POLL_SEC   default 20 (per-entity floor)
TRENO_GTFS_URL       default dati.lombardia.it 3z4k-mxz9 download
```
