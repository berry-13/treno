# Handoff prompt: historical backfill + chuuchuu as a second live source

You are working in the **treno** repository (`/Users/berry/Documents/treno`), a
predictive transit-intelligence platform for Italian (Lombardy) rail. The
collector fuses Trenord MIA + ViaggiaTreno into SQLite, an ML layer predicts
arrival residuals (currently beating the operator's ETA in every backtest
horizon), and a native iOS app consumes a Hono API. Read `GOAL.md` §13, §36,
§59, §66 and `PLAN_next_features.md` for background before coding.

You have TWO missions. Each has a gate — if a gate fails, STOP that mission
and write a short report of why instead of forcing it. Honesty over shipping.

---

## Mission A — backfill structural priors from the Monechi 2018 dataset

**Verified lead:** Monechi et al. 2018, "Complex delay dynamics on railway
networks" (EPJ Data Science) collected NATIONAL ViaggiaTreno per-train data.
The dataset is downloadable at:
https://springernature.figshare.com/articles/dataset/MOESM2_of_Complex_delay_dynamics_on_railway_networks_from_universal_laws_to_realistic_modelling/7096976
(paper: https://link.springer.com/article/10.1140/epjds/s13688-018-0160-x)

**Gate A1 (license):** check the Figshare license/CC terms first. If the
license forbids redistribution or derived use, do not import — report and stop.

**Gate A2 (shape):** download and inspect the actual files. If the data turns
out to be aggregates (no per-train per-stop events we can derive segment
runtimes from), report what IS there and stop.

**Goal:** seed `segment_stats` with historical structural priors — segment
runtime distributions (rt_p10/50/90), delay-development stats — for the long
tail of minor-station segments that currently have thin coverage. Today's
busiest 200 segments have 235+ observations; thousands of others have < 20.
2016–17 timetables differ from today's, so historical data MUST NOT feed
per-train-number features — only slowly-changing structural priors.

**Implementation:**
- New script `packages/collector/src/backfill-monechi.ts`, npm script
  `backfill:monechi` (pattern: existing `backfill-segments.ts`).
- Keep the raw download under `data/raw/monechi/` (never commit it — `data/`
  is gitignored).
- Station mapping: 2016-17 ViaggiaTreno station names/codes vs today's GTFS
  `stop_id`s. The pipeline already aliases by normalized stop name (GOAL
  §81); reuse that normalization, and SKIP segments you cannot map confidently
  (a wrong join is worse than a missing prior).
- Versioning/decay: imported rows must be attributable (e.g. a `source` or
  `origin` marker on segment_stats rows, or a separate table merged at read
  time in `packages/storage/segments.ts`) and down-weighted so live
  observations always dominate once n grows. A simple honest scheme: cap the
  historical contribution weight (e.g. historical rows count as 0.25
  observations) and document the choice in code.
- After import, run `npm run bench` locally and confirm no accuracy
  regression on current live data.

**Acceptance:** import runs end-to-end locally; segment_stats coverage jumps
(measurable via `SELECT COUNT(*) FROM segment_stats` before/after); spot-check
~5 known Lombardy segments (e.g. S01325 Sesto S.Giovanni → S01510 Arcore,
S01700 Milano Centrale corridors) for sane priors; bench unchanged or better.

---

## Mission B — chuuchuu as a second LIVE source (redundancy insurance)

**Lead (verified to exist, contents NOT yet verified):** https://chuuchuu.com
— "Train Delay Data | chuuchuu API". Also check https://chuuchuu.com/data,
their Terms and Privacy pages, and their Mastodon (@chuuchuu@toot.community)
for docs.

**Gate B1 (coverage + terms):** verify Italy live (not only historical) train
data is actually served, that the terms permit programmatic collection of the
scale we need, and note pricing/api-key requirements. If Italy live data is
absent or terms forbid it, report and stop.

**Then build:**
- Provider `packages/providers/chuuchuu.ts` following the existing patterns in
  `packages/providers/vt.ts` and `mia.ts`: fetch with the project's
  descriptive User-Agent, result envelope `{ ok, status, latencyMs, etag,
  error, raw }`, parse into the normalized snapshot shape consumed by
  `ingestSnapshot` (`packages/collector/src/pipeline.ts`).
- Env-gated like the CH sink: `TRENO_CHUUCHUU_KEY` (and/or URL env) unset =
  provider disabled, zero overhead, tests pass without it.
- Wire into `packages/collector/src/poller.ts` as a THIRD source: its own row
  in `provider_health`, its own adaptive cadence (start polite: ≥ 60s per
  train), pause after 5 consecutive errors, back off 10 min on 403/429 —
  mirror the MIA handling. The fusion layer already supports N sources
  (`train_state.sources` map, `sourceDelaySpreadSec`).
- Record snapshots through `putSnapshot` like the other providers, with
  payload-hash dedup (unchanged responses must not be re-stored).

**Politeness (hard rules):**
- NEVER increase the existing MIA/ViaggiaTreno poll pressure — this is purely
  additive redundancy. If they answer 403/429 or block, we back off and
  respect it; no retry storms, no evasion, no UA masquerading.
- chuuchuu is a small third-party service: during development, test the
  parser against a handful of RECORDED fixture responses saved under
  `tmp/chuuchuu-fixtures/` (gitignored), not live loops. A few live probes to
  verify shape are fine.
- Document the new compose environment variables in the README deploy section
  so the user can enable it on the server (they redeploy manually — you have
  no SSH access).

**Acceptance:** with the env set, a `--once` collector run locally shows
chuuchuu snapshots in `source_snapshots`, fused states carrying the third
source, and `provider_health` tracking it; with the env unset, behavior is
byte-identical to today.

---

## Environment facts you need

- Monorepo: npm workspaces, TypeScript ESM, no build step (`npx tsx`).
  Run anything with tsx; there is NO Docker on this Mac — compose tests run
  in CI (GH Actions pushes a multi-arch image to GHCR on every `main` push).
- SQLite via node:sqlite at `data/db/treno.db` (local copy has data through
  2026-09-16; the LIVE collector + API run in Docker on the LAN server
  http://192.168.1.242:8787 — reachable from this Mac, but no SSH; the user
  redeploys it themselves).
- `db.exec` must stay inline string literals; route all row data through the
  `getRow`/`getRows`/`runStmt` helpers in `packages/core/src/db.ts` (a
  security hook rejects variable-SQL). DDL belongs in
  `deploy/clickhouse-init/01_tables.sql`, not TS. The same hook blocks bash
  heredoc/python writes to source files — edit sources only with Write/Edit
  tools.
- Timezones: all epochs are Rome-anchored; use `romeWallToEpoch` from
  `#core/time.ts` (naive `Date.UTC` of date strings is off by 2h in CEST —
  this has bitten before).
- Git: identity + SSH commit signing are configured globally — plain
  `git add <paths> && git commit` produces Verified commits automatically.
  Push may fail with a GitHub billing annotation ("job was not started…"):
  run `gh run rerun <id>`; it's a known transient. Scope your commits to the
  files you touched.
- Do NOT touch `apps/ios` (out of scope) and do NOT attempt server deploys.

**Deliverables:** code + npm scripts + fixtures, README deploy notes for the
new env vars, clean commits pushed to `main`, and a final summary that
clearly separates (a) what is live locally, (b) what needs the user's server
redeploy + which env vars to add. If a gate stopped you, the summary is the
report.
