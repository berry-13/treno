# Execution plan — the not-started frontier (~38 pts)

Scope: everything GOAL.md lists that had zero implementation before this
plan — ATM bus/tram incl. latent vehicle reconstruction (§20–22, §26), Metro
(§25), national expansion + RAPSODIA/EU feeds (§4, §23, §74–75), notifications
(§61), SSE streaming (§60), reliability pages (§84), and the corridor-health
UI strip (§62 — the API landed in 96a7de6, the app surface didn't).

Existing foundations this plan builds on (verified in-repo):
- `providers/atm.ts` — GiroMilano stop polling with defensive WaitMessage
  extraction, already wired into the poller (60 s, `TRENO_ATM_STOPS`-gated)
  into `atm_stop_observations`; disabled by default.
- `providers/rapsodia.ts` — plug-in placeholder behind `TRENO_RAPSODIA_URL`.
- `RealtimeTransitProvider` (realtime.ts) — canonical GTFS-RT-shaped types.
- `/api/corridors` + `riskNotice` + iOS amber banner (96a7de6).
- iOS: widget + Live Activity + per-segment TrainRef already shipped.

Build order below is value/effort-ranked, not GOAL-section order. Each phase
ends deployable. Phases are independent — no cross-dependency except F2 on F1
and F4 on F3.

---

## F3. SSE streaming (§60) — smallest effort, biggest app payoff

Realtime UI without polling-refresh hacks. Hono supports SSE natively.

1. **API** (`packages/api/src/server.ts`): `GET /api/stream/trains/:id` —
   Server-Sent Events, one event per `fuseAndPredict` state change. The API
   is a separate process from the collector, so stream from `train_state`
   changes: poll `updated_at` internally every 5 s per open stream (cheap,
   reads-only), emit `state_update` (full fused state), `prediction_update`
   (ourEstimate only), `platform_update`, `alert` event types. Cap concurrent
   streams per process (e.g. 50); heartbeat comment every 20 s so proxies
   don't idle-kill.
2. **iOS** (`APIClient.swift` + `TrainDetailView.swift`): replace the 15 s
   `Timer.publish` refresh with `URLSession.bytes` SSE consumption (iOS has
   no native SSE, but line-delimited `event:`/`data:` parsing is ~40 lines);
   fall back to the timer when the stream drops. Live Activity refresh piggy-
   backs on the same events.
3. **Web dashboard** (`apps/web/index.html`): trivial `EventSource` on the
   train panel.

**Gate:** live train detail updates < 6 s after state change end-to-end;
stream survives 10 min without proxy reset (test via the LAN server, not
localhost).

---

## F6. Corridor-health UI (§62) — API already exists, surface it

1. **iOS Home** (`HomeView.swift`): a corridor strip shown ONLY when
   `/api/corridors` returns non-empty entries — "Milano → Monza running ~2m
   slower" style single lines, tappable → filtered station board for the
   affected segment's downstream stop. Hidden entirely in normal state
   (dashboard stays personalized, not a status dump; no source names in copy).
2. **Web ops dashboard**: corridors table panel next to coverage/backtest.

**Gate:** strip renders on a live degraded evening (or seeded fixture),
zero visual footprint when clean.

---

## F5. Reliability pages (§84) — data accumulates while we build

We have continuous history since 2026-09-13; on-time % / P90 delay become
meaningful around the 30-day mark. Build the surface now, value compounds.

1. **API**: `GET /api/reliability/train/:number` — last 30 days for the train
   number: on-time % (<3m), >5m/10m late %, cancelled %, median/P90 delay at
   destination, most problematic segment (max median dd_p50), typical
   recovery segment (min dd_p50 with n≥20). `GET /api/reliability/stop/:id`
   — same per route through the station, by hour bucket.
2. **iOS**: reliability section inside TrainDetail (below stops; "This train:
   on time 72% · >5m late 19% · cancelled 2%") — collapsed one-liner,
   expands to per-segment hot spots. NOT a separate tab; station-centric app.
3. **Web ops dashboard**: full table (this is the natural home for detail).

**Gate:** numbers reconcile with a hand-written SQL cross-check on 3 train
numbers; sample-size disclosure (n) always visible or suppressed when n<20
(no fake percentages on thin data — §16).

---

## F4. Notification system (§61) — after F3 (event plumbing is shared)

Thresholded, never noisy. Needs APNs + a push token registration path —
first server-side mutable state, so scope it tightly.

1. **Server**: `POST /api/devices` (token + optional watched runId/trip),
   `DELETE` on unfollow; SQLite `devices` table. A small notifier loop in the
   collector (after `fuseAndPredict`) evaluates watched items against the
   user's own rules from GOAL §61: our ETA moved >2 min, platform changed
   (only after P(platform) gate passes — never alert a guess), cancellation,
   connection risk crossing 50%, riskNotice fired. Rate-limit: max 1 push per
   watched run per 10 min per rule.
2. **APNs**: token-based auth (`.p8`), key via env/secret file only — never
   committed (creds rule). iOS `UNUserNotificationCenter` + background
   token registration.
3. **iOS**: Settings toggle "Notify me about delays" per saved trip; default
   off.

**Gate:** end-to-end push on the physical device (sim can't receive);
notifier idle-CPU negligible; no push storm during a strike morning replay
(threshold test on recorded data).

---

## F1. ATM bus/tram ingestion at scale (§20–21, §26)

Stop-level only (the feed has no vehicle telemetry — §21 limitation stands).
Purpose: crowding-free stop boards + reliability for the Milan urban network
+ the data substrate for F2.

1. **Static ATM GTFS** (`packages/gtfs`): second feed loader (Comune di
   Milano ZIP), separate table prefix (`atm_stops`, `atm_routes`,
   `atm_stop_times`) — must NOT mix with rail GTFS tables; `stops/search`
   learns a `network` discriminator ('rail' | 'atm').
2. **Poller scale-up**: `TRENO_ATM_STOPS` list → curated ~50 high-traffic
   stops first (Duomo, Centrale FS, Cadorna, Loreto, Sesto FS interchanges —
   the rail↔tram handoff points, which is where a Flighty-style product
   actually helps). 60 s cadence is already polite vs the ~30 s upstream
   refresh; measure change-rate first week and tune (§37).
3. **WaitMessage parsing v2**: current extractor keeps raw strings; add
   quantized-ETA decode ("in arrivo"→≤60s, "N min"→N*60±60, "ricalcolo"→
   null + RICALCOLO flag, "no serv."→NO_SERVICE flag) stored as
   `eta_sec_pred` + `quality_flags` on `atm_stop_observations` (ALTER, +CH
   mirror — same Mimosa rule: DDL in deploy SQL).
4. **API + iOS**: `GET /api/atm/stops/:id/board` (merged with rail in
   Stations tab for stops that exist in both, e.g. Centrale); iOS station
   sheet shows tram/bus lines with live countdowns. Label-free, color for
   meaning, same UX rules as rail.

**Gate:** one week of ATM observations without provider PAUSED state;
board shows live countdowns that match the GiroMilano website spot-check.

---

## F2. Latent vehicle reconstruction (§22) — research phase, hard-gated

The high-complexity subsystem GOAL §22 warns about (bunching makes identity
ambiguous). Do NOT commit to a full tracker; run a measured feasibility
study on F1's data first.

1. **Feasibility study** (notebook-style script, `packages/collector/src/
   atm-latent-study.ts`): on recorded stop observations, implement the
   simplest possible matcher — per (line, direction, stop), track ETA
   sequences; a vehicle "passes" when its ETA hits "in arrivo" then vanishes.
   Measure: fraction of passages linkable across ≥2 consecutive stops with
   consistent inter-stop runtime (±40%); bunching collision rate (≥2
   vehicles with indistinguishable ETAs at same stop).
2. **Go/no-go gate**: proceed to a Kalman/HMM tracker ONLY if ≥70% of
   passages link across ≥3 stops AND bunching collisions <20% on the curated
   stop set. Otherwise: document, keep stop-level predictions (quantized
   WaitMessages already are the operator's prediction — residual modeling on
   top of them is the realistic win), revisit when RAPSODIA lands.
3. If GO: `latent_vehicles` + `latent_vehicle_obs` tables, Hungarian
   assignment between frames, corridor features for ATM analog of rail §12.

---

## F7. Metro (§25) — deliberately tiny

`/sm` gives line-level regular/disrupted status only.

1. Daily poll of `tpl/atm/sm`, normalize to `service_alerts` with
   `source='atm-sm'`, scope=line.
2. Surface: one status row in the iOS Stations tab header area when a line
   is disrupted (hidden otherwise). No per-train metro anything — GOAL §25
   explicitly says not v1 focus.

**Gate:** a real M-line disruption shows up within one refresh cycle; zero
footprint otherwise.

---

## F8. National expansion + RAPSODIA/EU readiness (§4, §23, §74–75)

Mostly wait-and-plug-in; cheap readiness tasks now.

1. **National rail probe** (weekly cron in collector maintenance): ViaggiaTreno
   is already national — probe N randomly-sampled non-Lombardy train numbers
   weekly; measure what fraction of `andamentoTreno` responds with usable
   data. When >50%: flip the discover loop's region filter to nationwide and
   watch storage/costs (§42 — dedup + retention matter at 3–4× volume).
   Decision, not a build.
2. **RAPSODIA**: keep the placeholder compiling; add a monthly probe of the
   Lombardy open-data catalog (dati.lombardia.it Socrata API, zero-auth
   query) for `gtfs` realtime datasets; alert in /api/health when one
   appears. The day it lands: protobufjs decode → existing
   `RealtimeTransitProvider` types → instant ingestion (that was the design
   promise; verify with one contract test).
3. **EU TSI telematics** (§75): nothing to build — adapters stay the only
   coupling; revisit when implementation timelines (2028) firm up.

---

## Suggested sequencing

1. **F3 SSE** (small, unlocks F4's plumbing, immediately visible in app)
2. **F6 corridor UI** (hours of work, API done)
3. **F5 reliability** (surface now, compounding value; full value at day 30)
4. **F1 ATM** (start collecting immediately — history argument again)
5. **F7 Metro** (one evening)
6. **F4 notifications** (needs F3 + APNs setup + device)
7. **F2 latent study** (after ≥2 weeks of F1 data)
8. **F8** probes run continuously in maintenance ticks.

## Cross-cutting notes

- F1/F3/F4/F5 all need server rebuild + redeploy; batch the first four into
  one release if executed together.
- Every new state remains provenance-carrying (§97): ATM boards show
  "operator estimate" semantics (WaitMessage IS their prediction), latent
  vehicles would be labeled "inferred", reliability stats carry n.
- Point recovery estimate if all phases land: ~+20 pts of the 38 (ATM full
  incl. latent ~+9, Metro +2, notifications +3, SSE +2, reliability +2,
  corridor UI +1, national ~+1 as a decision); the remaining ~18 pts
  (RAPSODIA/EU, full national, mature latent tracking) are gated on external
  feeds/timelines, not on our code.
