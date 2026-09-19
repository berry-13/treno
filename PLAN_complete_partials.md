# Execution plan — completing the partial goals

Scope: the four items scored "partial" against GOAL.md — platform prediction (§52),
crowding (§53), user-facing disruption/propagation intelligence (§50–51, §62 Corridor
Health / Smart Alerts), and the ML refinements already on the backlog (hyperparameter
sweep, per-line target encoding, 2nd-order ETA velocity). Each phase is self-contained
and ends at a deployable state. Estimated total: +6–8 points on the 100-point scale.

Build order: P1 (crowding persistence — data is evaporating daily, everything else
has history) → P2 (platform model) → P3 (propagation surface) → P4 (ML sweep, pure
offline, can run anytime / in parallel).

---

## P1. Crowding persistence + live surface (§53)

**Problem:** MIA's `average_crowding` / `average_crowding_label` are parsed in
`packages/providers/src/mia.ts` and `types.ts` but never stored. Every day we run,
unrecoverable crowding history is lost — same logic that made the collector the
archive for delays.

1. **Schema** (`packages/storage/src/schema.ts`):
   - Add `crowding_pct INTEGER` + `crowding_label TEXT` to `train_observations`
     (train-level, changes over the run — keep latest per observation row; the
     observation time series itself preserves the evolution).
   - Add `crowding_pct INTEGER` to `train_stop_events` (final run-level value,
     latest-wins like `platform_actual` in `observations.ts:72`).
   - Follow the Mimosa rule: DDL goes in `deploy/` SQL, not only in TS (CH image
     has no initdb.d — see PLAN_docker_clickhouse.md gotchas).
   - Mirror columns in the ClickHouse sink (`storage/src/backfill-ch.ts` +
   dual-write path) and run `ch:backfill` style sync if applicable.
2. **Ingestion** (`collector/src/pipeline.ts`): map the MIA fields into the
   observation + stop-event writes. Defensive optionals — fields are absent, not
   null, when unavailable.
3. **Backfill**: one-off `docker compose run --rm collector npx tsx ...` job that
   re-parses retained raw MIA snapshots (`source_snapshots`) to populate history
   since collector start — the same offline-reprocessing pattern as
   `backfill-monechi.ts`. Gate: row count with crowding > 0 before declaring done.
4. **API** (`api/src/server.ts` train endpoint): expose `crowding` on the train
   payload (0–100 + label).
5. **iOS** (`TrainDetailView.swift`): single inline chip in the status area —
   color carries meaning (accent only when ≥ high), no labels/micro-headers per
   UX principles. Hidden entirely when absent (night trains often lack it).

**Gate:** live train in app shows crowding; CH + PG counts match; backfill report
committed to `data/reports/`.

---

## P2. Platform prediction P(platform = X) (§52)

**We already have training data:** `platform_sched`, `platform_actual`,
`platform_is_actual` in `train_stop_events` since 2026-09-13.

1. **Trainer** (`collector/src/train-platforms.ts`, npm script `train:platforms`):
   - Rows: stop events with `platform_actual` known AND at prediction time it was
     not yet actual (i.e. the interesting case is predicting before announcement;
     reconstruct "not yet announced" state from the observation timeline: platform
     first seen as actual at time T → features as of T−10min).
   - Features: station, line, direction, hour, weekday, train category,
     platform_sched, platform of the same run at previous stop, historical
     distribution for (station, line, scheduled platform) tuple, whether
     adjacent platform occupied by a stationary train (skip if too complex for v1).
   - Model: multinomial via per-platform binary GBM (reuse `gbm.ts` fitGBM
     wrapper) — predict P(platform=k), renormalize over the station's known
     platform set. Store `data/models/platforms-v1.json` with per-station
     platform vocabularies.
   - Validate: top-1 accuracy and log-loss vs baseline "always scheduled
     platform". **Gate: serve only if top-1 ≥ 85% AND strictly beats baseline on
     the subset where platform changed** (changes are the only cases that matter
     — GOAL §52: never present predicted platforms as confirmed).
2. **Serving** (`heuristic.ts` / train endpoint): when `platform_is_actual = 0`
   for a boarding stop, attach `platformPredicted: [{n:"5",p:0.72},...]` capped
   to top 2–3 with p ≥ 0.10. When actual → show actual only.
3. **iOS** (`TrainDetailView.swift` boarding row): platform chip shows predicted
   value with a subtle "likely" treatment (e.g. reduced opacity / no fill) vs
   confirmed solid chip — visual label per §86 (Confirmed vs Predicted), no text
   sub-labels.
4. Nightly launchd: extend the 03:30 pipeline with `train:platforms` after
   `train:connections`.

---

## P3. Disruption propagation → user-facing intelligence (§50–51, §85)

**What exists:** exogenous calendar + §51 propagation features are in the GBM
(point-in-time, commit 3bb3ad4) — they already move the ETA. What's missing is
the Flighty-grade surface: telling the user *before the operator does*.

1. **Corridor health computation** (`collector/src/pipeline.ts` or a small
   `corridor.ts`): rolling per-segment stats already exist for features; expose
   them as a computed view: segment → {median runtime delta vs historical p50,
   n disturbed trains, trend}. No new collection needed.
2. **API**: `GET /api/corridors` (list, ordered by deviation) + per-train
   `riskNotice` field on the train endpoint: generated when ≥2 preceding trains
   on the train's next segments lost > 90s each within the last 20 min AND our
   model's p50 for the user's stop moved ≥ 60s from schedule-derived — i.e. the
   §51 example "your train shows on time but will likely gain +6–10 min".
   Notice = {headline, affected segment, evidence count, expected delay range
   (p10–p90 delta)}. Thresholds conservative at launch; tune against backtest
   false-positive rate (goal: ≥ 70% of notices corroborated by later actual
   delay within the stated range).
3. **iOS**:
   - `TrainDetailView.swift`: amber banner under the status banner when
     `riskNotice` present — one line, tappable to expand evidence. Color carries
     meaning; no source names / telemetry internals in the copy.
   - Home dashboard: corridor strip only when something is actually wrong
     (hidden in normal state — dashboard stays personalized, not a board dump).
4. **Backtest the notices**: extend `backtest.ts` with a replay: for historical
     runs, when would a notice have fired and what actually happened? Report
     precision/recall into `data/reports/`. This is the honest-claims gate
     before shipping the banner visually on by default.

**Gate:** replay precision ≥ 70% (else ship behind a Settings toggle), notice
end-to-end latency < 2 min after trigger conditions.

---

## P4. ML refinements (backlog, offline-only, no deploy risk)

Order by expected MAE gain per effort:

1. **Per-line target encoding** — replace/augment raw line one-hots with
   out-of-fold smoothed target encoding of `line` (and `line × hour bucket`)
   for the residual target. Biggest expected win: lines have wildly different
   operator bias. Implementation in `train.ts` feature extraction + encoding
   table stored inside the model json. Gate: backtest MAE improvement ≥ 3s on
   every horizon bucket, else drop.
2. **Hyperparameter sweep via backtest** — grid over depth/leaves/lr/min_data
   scored by the existing backtest harness (NOT val MAE alone). ~50 configs,
   minutes each on the nightly box; pick per the "beats operator in every
   bucket, worst bucket first" objective.
3. **2nd-order ETA velocity** — feature: d(operator_eta)/dt over last 2–3
   observations (operator ETA trend already observable from stored
   predictions). Requires point-in-time reconstruction from `predictions`
   table — straightforward since we store every prediction. Gate: same
   every-bucket improvement rule.

Each lands through the existing hot-swap (`npm run train` → model json) — no
API or app changes. Do NOT stack unvalidated changes: one at a time, backtest,
keep or revert, commit with the report numbers in the message.

---

## Deployment & verification notes

- P1–P3 all need a server rebuild + redeploy (packages/* are baked into the
  image). From the Mac there are no SSH creds — prepare the release, ask user
  to `docker compose pull && up -d`, then verify via `curl /api/health` →
  `/api/coverage` → the new endpoints (coverage, not /api/trains, for freshness).
- CH DDL changes (P1) go in `deploy/` SQL and the ch-init container path.
- iOS verification per the standard recipe: debug deep links, simctl
  screenshots, subagent Vision-OCR, leave running in the sim for manual check.
- After redeploy, confirm the next 03:30 nightly produced a 09-2x backtest
  report (readable via `/api/backtest`) — that validates P2/P4 model artifacts
  are being regenerated nightly.

## Suggested sequencing

1. P1 (days of crowding history are being lost every day the schema isn't there)
2. P2 trainer + backtest gate (offline, while P1 collects)
3. P3 replay + gate, then surface
4. P4 interleaved with any waiting time; sweep last.
