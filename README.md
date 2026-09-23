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
Running trains also get a **likely area** card (GOAL §48): without GPS there
is no exact dot, so the train page names the stretch the train is plausibly
on — two stops joined by a dashed line on a small map, plus the last
confirmed sighting and its age. The card hides entirely when the position is
stale or unknown.
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
- **Recovery prediction (§17/§62)** — `recoveryForecast()` in
  `packages/collector/src/heuristic.ts`: given the current delay D and our
  p10/p50/p90 arrival quantiles, P(final delay ≤ D − 120s) via a
  piecewise-linear quantile CDF (documented assumption; monotone by
  construction). `GET /api/trains/:id` attaches it additively as
  `recovery: {probRecover2m, expectedDelaySec, basedOnQuantiles}` — omitted
  when D ≤ 0 (nothing to recover) or when p90−p10 > 1800s (§16: no fake
  percentages on thin spreads). The iOS train page shows one inline chip
  ("72% recovers ≥2m") in the status area, hidden when suppressed.
- **Smart alternatives / journey ranking (§19/§62)** —
  `GET /api/journeys` options are now ranked by expected REAL arrival, not
  schedule: each option gets `expectedArrivalEpoch` (strongest signal first:
  actual arrival → operator stop prediction → our p50 delay carried onto the
  leg → observed departure delay → scheduled fallback, `expectedArrivalLive`
  says which), a `riskPenaltySec` (§19 utility = expected arrival + risk; the
  p90 tail of our own distribution is the single-leg analogue of a shaky
  connection — the same spread the §18 connection model consumes), and the
  best still-catchable option is flagged `recommended: true`. Existing fields
  are unchanged (additive). The iOS trip search marks the recommended option
  and prints expected arrival times where they move the scheduled one by
  more than a minute; saved-trip cards do the same.
- **Benchmark (§34)** — `npm run bench [-- --days=30]`: scores every recorded
  prediction at T-1…T-30+ horizons: schedule vs operator vs each of our models
  (MAE/medAE/RMSE/P90/P95/bias + interval coverage), writes
  `data/reports/benchmark-YYYY-MM-DD.md`. Verdict line refuses to claim
  accuracy until a model beats the operator on ≥30 outcomes.
- **Quality engine (§45)** — every observation is validated at ingest
  (OUT_OF_ORDER / STALE_SOURCE / DELAY_JUMP) and the full rule set
  (SOURCE_CONFLICT, BACKWARDS_TELEPORT, IMPOSSIBLE_RUNTIME, UNKNOWN_RUN,
  UNMAPPED_STOP) is recomputable over history; see
  [Data quality engine (§45)](#data-quality-engine-45) below.
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
                                    + locationInference (§83 rail-graph map matching)
                                    + recovery (§17/§62, omitted when suppressed)
GET /api/stops/search?q=
GET /api/stops/:id/departures       today's board ±window with live state
GET /api/journeys?from=&to=          direct options ranked by expected real arrival
                                    (§19: expectedArrivalEpoch, riskPenaltySec, recommended)
GET /api/segments                   segment statistics (top by sample count)
GET /api/corridor?from=&to=         segment stats + live congestion delta
GET /api/alerts                     recent provider alerts
GET /api/rail-locations             reporting-point registry with counts (§82)
GET /api/atm/stops/:id              ATM stop observations (when enabled)
GET /                                web debug page
```

## Railway reporting points (§82)

Providers report trains at plenty of locations that are not passenger stops —
`Bivio Casirate`, `PM Albate`, `DEV. ESTR. ROGOREDO`, border points like
`CONFINE ITALO/SVIZZERO`. These now live as a first-class entity, separate
from `gtfs_stops` (which remains the canonical home of passenger stations):

- `rail_locations` (SQLite + ClickHouse mirror DDL) — one row per location
  name slug (`railLocationKey('BIVIO/PC SESIA')` = `bivio-pc-sesia`), with
  `type` (`PASSENGER_STATION` | `JUNCTION` | `BIVIO` | `CONTROL_POINT` |
  `UNKNOWN_REPORTING_POINT`), optional `lat`/`lon`, and observation stats
  (`first_seen`, `last_seen`, `observation_count`).
- Classification is pure and offline (`classifyLocationName`): `bivio` →
  BIVIO, `diramazione`/`giunzione` → JUNCTION, else UNKNOWN_REPORTING_POINT.
  Passenger stations are typed by matching reported location ids and
  normalized names against `gtfs_stops` — matched rows also pick up the gtfs
  coordinates. No geocoding or API calls: unknown coordinates stay NULL.
- Every `insertObservation` with a non-null `location_name` updates the
  stats; `npm run raillocations:backfill` rebuilds the table from the full
  observation history (idempotent — clears first) and prints the type
  histogram plus top locations by observation count.
- Ops can inspect via `GET /api/rail-locations?type=&limit=` (heaviest
  evidence first), which is also the stable read path for §83 map matching.

## Rail graph location inference (§83)

Reporting-point observations (above) say where a train *was* — §83 turns them
into where it *is going*: last confirmed point, next plausible points, and the
segment most likely occupied right now.

**Graph** (`packages/core/src/railgraph-build.ts`, read-only scans, built once
per API process and cached; rebuilt lazily only while empty):

- Node keys: GTFS stop ids; observation `location_id`s that are GTFS stops
  (MIA uses the same id space); ids bridged by uppercase name when RFI and
  Trenord disagree (Brescia `S01717` vs `S09999`); and for non-passenger
  reporting points the raw id or `n:` + slug(UPPERCASE name) — `Bivio Casirate`
  and `BIVIO CASIRATE` collapse to the same node.
- Edges (directed, with traversal counts → per-node normalized priors):
  consecutive stop pairs per trip in `gtfs_stop_times`, plus consecutive
  distinct locations per **(run, source)** in `train_observations` — the only
  way reporting points enter the graph. Sequencing is per source: sources
  disagree about a train's position at the same instant (MIA often lags at the
  origin), so interleaving by timestamp would fabricate transitions.

**Inference** (`packages/core/src/railgraph.ts`, pure, no DB): `inferLocation`
returns `{lastConfirmed, plausibleNext (top-3, renormalized), likelySegment
{from, to, p}}`. An unknown point degrades to explicit nulls — never a guess
(§16). A sink (terminal station) returns an empty `plausibleNext`. Serving:
`GET /api/trains/:id` gains `locationInference` computed from the run's latest
located observation.

**Offline evaluation** (tmp/railgraph-eval.ts, not committed; numbers from
2026-09-16 data): for every confirmed non-schedule point in per-source
observation histories, predict top-3 plausible next and check the next
distinct observed location. Two regimes:

| regime | n | top-1 | top-3 |
|---|---|---|---|
| full history (production steady state) | 12,104 | 26.1% | 52.6% |
| time-split (edges from first 80%, tested on last 20%) | 1,920 | 19.3% | 35.4% |

Per-source (split): MIA 27.2%/43.3%, viaggiatreno 13.7%/29.9% — MIA's
next-stop progressions are cleaner, viaggiatreno's raw positions flap
(A→B→A). Notably, reporting points are far *more* predictive than stations
(station-confirmed instances: 9.6% top-1): a station fans out to many route
successors, a mid-line point has few.

Honest limitations:

- **Direction is real but unmasked on purpose.** Masking the back-edge
  ("where we came from") measured *worse* (top-3 41.9% vs 52.6%): ~17% of
  misses have the actual next equal to the previous point — the feed itself
  flaps between adjacent points, so the back-edge is often genuinely the next
  report. Without route/direction context the top-3 must span both
  directions; e.g. the border point `Conf. IT/CH MO1` splits Varese 40% /
  Como S.Giovanni 40%.
- **Sparsity bounds top-1.** Many reporting points have 2–5 observed
  transitions total, so priors are coarse (50/25/25-style).
- The likely-segment confidence is the raw share of outgoing traversals
  (not renormalized), so a 40% "likely segment" is an honest statement that
  60% of the time the train is elsewhere.

## Source etiquette (§57)

Undocumented public endpoints are treated carefully: descriptive User-Agent,
conservative adaptive polling (5min → 30s by phase, 25s floor for watched
trains), per-source request spacing + max concurrency 2, retries with backoff
on transient failures only, 4xx treated as entity-level misses (except
403/429 which pause the source), every raw payload retained so history can be
reprocessed without re-fetching (§79).

## Source trust model (§77)

Source reliability is contextual, per field class — never one fixed global
ranking. `packages/collector/src/trust.ts` holds the declarative table
(`FIELD_TRUST`); `resolveTrust(fieldClass, candidates, healthSnapshot)` picks
a winner, quantifies cross-source disagreement (`disagreementSeconds`), and
returns a human-readable reason. The pipeline routes its current-delay and
position picks through it and attaches a `provenance` object to the fused
state (source, trust, age, disagreement, reason per field).

| field class | mia | viaggiatreno | gtfsrt | ours |
|---|---|---|---|---|
| actual passed-stop timestamp | HIGH | HIGH | – | – |
| current delay | MEDIUM | HIGH | – | – |
| future ETA | MEDIUM | – | HIGH | model confidence |
| position | freshest infrastructure observation wins | | | |

Resolution rules (in order):

1. **Trust ladder**: highest trust wins (`HIGH > MEDIUM > LOW`, unknown
   sources rank LOW); within equal trust the fresher observation wins;
   `ours` ranks by model confidence (>=0.75 HIGH, >=0.5 MEDIUM, else LOW).
2. **Position rule**: `FRESHEST_INFRASTRUCTURE_WINS` — the freshest
   observation among infrastructure sources (mia/viaggiatreno/gtfsrt);
   trust only breaks exact-timestamp ties.
3. **Agreement window** (60s in the pipeline): when the trust winner and a
   fresher candidate from another source agree within the window, freshness
   decides — sources that concur carry no conflict, so the common-case pick
   is identical to the legacy freshest-wins logic and the trust ladder takes
   over only on real disagreement (§78).
4. **Health degradation**: a source whose `provider_health` state is
   `DEGRADED` is demoted one trust level, `PAUSED` two levels (floored at
   LOW) before ranking — passed in as a snapshot (the resolver itself is
   pure: no DB access). A paused ViaggiaTreno therefore lets a healthy MIA
   supply the delay, and vice versa.

Confidence coupling (§46/§77): when the resolver reports MIA vs ViaggiaTreno
delay disagreement >300s, the heuristic prediction shaves 0.1 off confidence
(before clamping) — the fused input itself is suspect.

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

## Source conflicts (2026-09-23)

When MIA says +4 and ViaggiaTreno says +7, neither value is overwritten —
per-source observation rows keep both (that was already true), and since
2026-09-23 the disagreement itself is materialized as its own signal
(GOAL §78): the intuition is that *sources disagreeing predicts instability*.

- **Table** `source_conflicts` (SQLite schema + ClickHouse mirror DDL): one
  row per detected disagreement — `run_id`, `ts` (the newer observation's
  time), `field` (`delay_seconds` today; more fields can be added without a
  migration), `value_a/value_b` with canonical alphabetical `source_a/source_b`
  ordering (`mia` < `viaggiatreno`), `spread_seconds = |Δdelay|`.
- **Rule** (`packages/collector/src/conflicts-backfill.ts`, one definition for
  live + backfill): two per-source delay observations for the same run within
  a **90s window** whose |Δdelay| is **> 120s** write a conflict row, deduped
  to at most one row per run+field in any **5-minute** stretch. The live hook
  runs in `pipeline.ts` `ingestSnapshot` right after the observation insert.
- **Backfill** — replay the identical rule over stored history (idempotent;
  existing rows, live or from a previous run, seed the dedup):
  ```
  npm run conflicts:backfill        # local
  docker compose run --rm collector npx tsx packages/collector/src/conflicts-backfill.ts   # server
  ```
- **Feature** `delay_source_spread` (FeatureInput `delaySourceSpreadSec`):
  the latest conflict spread at or before the prediction instant, `0` when the
  sources agree — point-in-time safe (`ts <=` prediction time, the same
  discipline as the other context features). New predictions record it into
  `features_json`; historical prediction rows get it recomputed the same way
  at train time (`train.ts` `extract()`), so the nightly retrain sees it
  across the whole window without a re-ingest. Append-only like every feature:
  the serving model ignores it until a retrain picks it up.

## Data quality engine (§45)

Every observation is validated; anomalies are **flagged, never silently
discarded** (`packages/storage/src/quality.ts`). Flags accumulate as a JSON
string array in `quality_flags` on `train_observations` and
`train_stop_events` — the same format the insert path has always written, e.g.
`["OUT_OF_ORDER","BACKWARDS_TELEPORT"]`. Rows are never dropped or rewritten;
the flag is the annotation.

| flag | meaning | where |
|---|---|---|
| `OUT_OF_ORDER` | `observed_at` goes backwards vs the previous observation of the same source (≥1 s regression) | both |
| `STALE_SOURCE` | upstream `observed_at` lags the fetch `ts` by >10 min | both |
| `SOURCE_CONFLICT` | MIA vs ViaggiaTreno delay differ by >300 s within a 90 s fetch window (flag lands on the later row) | backfill |
| `DELAY_JUMP` | same-source delay changes by more than ±60 min between consecutive observations | both |
| `BACKWARDS_TELEPORT` | location regresses to an earlier stop of the run's `gtfs_stop_times` sequence (locations that are not trip stops are skipped) | backfill |
| `IMPOSSIBLE_RUNTIME` | consecutive stop actuals imply >300 km/h (needs `gtfs_stops` coords; rows lacking them are skipped; non-positive Δt over a real distance flags too) | backfill (stop events) |
| `UNKNOWN_RUN` | run has no GTFS trip mapping (`gtfs_trip_id IS NULL`) — schedule-relative checks are impossible for these rows | backfill |
| `UNMAPPED_STOP` | observation `location_id` not present in `gtfs_stops` | backfill |

- **Ingest hook** — `pipeline.ts` runs the cheap per-row rules
  (`OUT_OF_ORDER`, `STALE_SOURCE`, `DELAY_JUMP`) against the previous
  same-source observation and stores the flags at insert time
  (`ingestRowFlags`).
- **Backfill** — the whole-run rules (SOURCE_CONFLICT, BACKWARDS_TELEPORT,
  IMPOSSIBLE_RUNTIME, UNKNOWN_RUN, UNMAPPED_STOP) plus the same cheap rules
  are recomputed over stored history by a single deterministic pass that
  overwrites `quality_flags` in place (idempotent — a second pass updates
  zero rows, which `--verify` asserts):
  ```
  npm run quality:backfill          # local; writes data/reports/quality-backfill.md
  npm run quality:backfill -- --verify
  docker compose run --rm collector npm run quality:backfill    # server
  ```
- **Design** — rule predicates are pure functions of row values
  (`outOfOrder`, `staleSource`, `delayJump`, `flagRunObservations`,
  `flagStopEventRuntimes`) so they are unit-testable without a DB; the apply
  step (`recomputeRunQuality` / `recomputeAllQuality`) loads each run's rows
  in observation order and stamps the result.
- **vs §78 source conflicts** — complementary layers: §78 materializes every
  >120 s MIA↔VT disagreement into `source_conflicts` (feature-shaped, 5-min
  dedup); the §45 `SOURCE_CONFLICT` flag marks the observation rows
  themselves at the >300 s severity the GOAL list implies.
- **ClickHouse** — `quality_flags` exists on both mirrored tables
  (`deploy/clickhouse-init/01_tables.sql`); new rows carry their insert-time
  flags from the collector deploy onward, while backfilled historical flags
  live in SQLite (the CH observation table is an append-only MergeTree —
  re-mirroring would duplicate rows).

Local backfill over the full history (2026-09-23, 228,912 observations /
82,408 stop events): 114,319 flagged observations (49.9%) — UNKNOWN_RUN 53,113
· OUT_OF_ORDER 43,423 · BACKWARDS_TELEPORT 27,531 · UNMAPPED_STOP 11,906 ·
STALE_SOURCE 7,442 · SOURCE_CONFLICT 5,321 · DELAY_JUMP 24 — plus 212
IMPOSSIBLE_RUNTIME stop events. Verified idempotent (second pass: 0 updates).


## Source conflicts (2026-09-23)

When MIA says +4 and ViaggiaTreno says +7, neither value is overwritten —
per-source observation rows keep both (that was already true), and since
2026-09-23 the disagreement itself is materialized as its own signal
(GOAL §78): the intuition is that *sources disagreeing predicts instability*.

- **Table** `source_conflicts` (SQLite schema + ClickHouse mirror DDL): one
  row per detected disagreement — `run_id`, `ts` (the newer observation's
  time), `field` (`delay_seconds` today; more fields can be added without a
  migration), `value_a/value_b` with canonical alphabetical `source_a/source_b`
  ordering (`mia` < `viaggiatreno`), `spread_seconds = |Δdelay|`.
- **Rule** (`packages/collector/src/conflicts-backfill.ts`, one definition for
  live + backfill): two per-source delay observations for the same run within
  a **90s window** whose |Δdelay| is **> 120s** write a conflict row, deduped
  to at most one row per run+field in any **5-minute** stretch. The live hook
  runs in `pipeline.ts` `ingestSnapshot` right after the observation insert.
- **Backfill** — replay the identical rule over stored history (idempotent;
  existing rows, live or from a previous run, seed the dedup):
  ```
  npm run conflicts:backfill        # local
  docker compose run --rm collector npx tsx packages/collector/src/conflicts-backfill.ts   # server
  ```
- **Feature** `delay_source_spread` (FeatureInput `delaySourceSpreadSec`):
  the latest conflict spread at or before the prediction instant, `0` when the
  sources agree — point-in-time safe (`ts <=` prediction time, the same
  discipline as the other context features). New predictions record it into
  `features_json`; historical prediction rows get it recomputed the same way
  at train time (`train.ts` `extract()`), so the nightly retrain sees it
  across the whole window without a re-ingest. Append-only like every feature:
  the serving model ignores it until a retrain picks it up.

## Event calendar — strikes, stadium fixtures, holidays (2026-09-18)

Exogenous event features for the model (GOAL §51 context + propagation
signals), all point-in-time recorded into `features_json`:

- **Stadium fixtures** at San Siro — auto-imported daily from ESPN's keyless
  scoreboard (Serie A + UCL + UEL, ±3 days, one fetch per league per day;
  descriptive UA). Crowd load is attributed to the Milano Garibaldi/Cadorna/
  Bovisa/Centrale/Villapizzone stations in a ±3h/2h window.
- **Italian holidays** 2026–2027 — computed locally (computus), no fetch.
- **Strikes** — curated file (the official portal has no API and is
  unreachable from many hosts). Maintain `<TRENO_DATA_DIR>/calendar/strikes.json`
  using the format in `deploy/calendar/strikes.template.json`; rail strikes in
  Italy are filed ≥10 days ahead, so a hand-updated file is honest and
  sufficient. On the server, place it inside the `treno-data` volume, e.g.:
  `docker compose cp deploy/calendar/strikes.json collector:/data/calendar/strikes.json`
  (adjust if TRENO_DATA_DIR differs). The collector re-reads it daily.

New prediction features (append-only — the serving model ignores them until
the nightly retrain): `strikeActive`, `eventHoursToStart`, `holiday`,
`upstreamStopMaxDelaySec` / `upstreamStopDelayedCount` (§51 knock-on queue at
the run's next stop, last 45 min). Manual import:
`npx tsx packages/collector/src/events.ts` (or `docker compose run --rm
collector npx tsx packages/collector/src/events.ts` on the server).

## Risk notices — §51 propagation, tunable generator + nightly sweep (2026-09-23)

The pre-emptive "delays building ahead of your train" notice (GOAL §51) is a
parameterized corridor rule in `packages/collector/src/heuristic.ts`. All
thresholds live in ONE exported config, `RiskNoticeConfig`:

- `minPrecedingTrains` — how many preceding-train traversals the upcoming
  corridor segments must show inside the window (default 2).
- `evidenceWindowMin` — evidence lookback in minutes (default 20).
- `minMedianRuntimeDeltaSec` — the median runtime delta across those
  traversals must reach this (default 90s). Median, not per-train floor: a
  corridor where most trains still run on time cannot fire off one outlier —
  that is the precision direction the ≥70% gate demands.
- `minP50MoveSec` — our own p50 must already project this much lateness
  (default 60s); the notice is a *this will get worse* claim, so it only
  fires when the model already sees a move.
- Toggleable candidates, each with a causal story:
  - `requirePersistence` — the corridor deviation must be present in 2
    consecutive refreshes (an in-memory last-refresh snapshot per run; a
    transient blip in one refresh should not fire a push).
  - `weightSevereEvidence` — a preceding train that is cancelled or >10 min
    late counts double (a cancellation is the strongest propagation
    evidence there is).
  - `adaptiveWindow` — 1.5x wider evidence window at Rome rush hours
    (7–9 / 17–19), where headways are short and affected trains accrue
    faster.

The live trigger (`pipeline.ts` → push notifications and state) evaluates
this rule from recorded per-prediction features
(`corridorEvidenceTrains`, `corridorSevereTrains`,
`corridorCancelledTrains`, `corridorMedianDeltaSec`,
`corridorEvidencePersisted` — append-only in `features_json`, so future
replays never need to recompute them).

The precision gate is deliberately NOT in the config: `MIN_PRECISION_TARGET
= 0.7` is a constant in `backtest.ts`. Tuning evidence thresholds is the
legitimate lever; moving the gate is not.

**Nightly tuning loop.** `npm run backtest` (trainer role, 03:30 Rome) now
prints, after the unchanged single-config §51 replay and its gate line, a
`risk-notice generator threshold sweep (§51)` section: a 27-point grid over
(minPrecedingTrains × evidenceWindowMin × minMedianRuntimeDeltaSec) plus the
candidate toggles at default thresholds, each with fired / precision /
recall, evidence rebuilt point-in-time from `segment_observation` /
`train_stop_events` (only rows at or before each prediction instant). It
ends with a chosen default — the gate-passing config with the best recall,
ties broken toward more conservative thresholds — and the exact
`TRENO_RISK_NOTICE_CONFIG` JSON to apply. Read it at
`curl http://<server>:8787/api/backtest`.

**Applying a tuned config** (no code change): set the collector env
```
TRENO_RISK_NOTICE_CONFIG='{"minPrecedingTrains":3,"evidenceWindowMin":45,"minMedianRuntimeDeltaSec":90}'
```
(unknown keys / malformed JSON fall back to the code defaults, never widen).
Defaults = the shipped behavior; change them only from a sweep result.

## Configuration (env)

```
TRENO_DATA_DIR            default <repo>/data
TRENO_USER_AGENT          default identifies this collector
TRENO_API_PORT            default 8787
TRENO_MAX_TRACKED         default 80 concurrent runs
TRENO_MIN_POLL_SEC        default 20 (per-entity floor)
TRENO_GTFS_URL            default dati.lombardia.it 3z4k-mxz9 download
TRENO_RISK_NOTICE_CONFIG  default unset — §51 risk-notice thresholds (JSON, see above)
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

## Training data export (GOAL §71)

Export point-in-time training sets as Parquet — one row per scored prediction
(`predictions ⋈ prediction_outcomes ⋈ train_runs`), `features_json` unpacked
into 21 typed `f_*` columns, plus run/stop context (`service_date`,
`train_number`, `operator`, `line`, `run_id`, `prediction_id`, `stop_id`,
`model_version`, `generated_at`, `horizon_sec`, `horizon_bucket`, all ETA
epochs/errors) — 41 columns total:

```
npm run export:parquet                     # full export of the local SQLite DB
npm run export:parquet -- --limit 1000     # smoke sample
npm run export:parquet -- --date 2026-09-13 --by-line
```

Layout: `data/exports/parquet/service_date=YYYY-MM-DD/part-NNNN.parquet`
(Hive-style, `line=…` sublevel with `--by-line`; `data/exports/` is
gitignored). Files roll at 100k rows (`--rows-per-file`).

Two sources, in preference order:

- `TRENO_CLICKHOUSE_URL` set (default `auto`): streams
  `SELECT … FORMAT Parquet` per partition through `@clickhouse/client` —
  ClickHouse itself writes the Parquet. On the server:
  `docker compose exec collector sh -c 'TRENO_CLICKHOUSE_URL=http://clickhouse:8123 npm run export:parquet'`
  (then `docker compose cp` the `data/exports/` directory out of the volume).
- Local fallback (offline, zero new deps): a minimal pure-TS Parquet writer
  (`packages/storage/src/export-parquet.ts`) — PLAIN encoding, gzip via
  fflate, one row group per file, data page v1, all columns OPTIONAL; no
  dictionary/statistics/nested types (limits documented in the file header).
  Every file is round-trip verified after writing: the exporter re-parses the
  footer, re-decodes every page of every column and compares all cells
  against what was written; it prints per-file rows/size and `round-trip OK`.

Analyze with DuckDB/Polars:

```
duckdb -c "SELECT horizon_bucket, count(*), avg(abs(our_error_sec)) AS mae
           FROM read_parquet('data/exports/parquet/**/*.parquet', hive_partitioning=true)
           GROUP BY 1 ORDER BY 1"
```
