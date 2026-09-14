# Infra build — Docker image, GH Actions, server deployment, ClickHouse sink

Architecture decision (deliberate): **dual-write, not replace**. SQLite stays
the operational store (single-writer collector, GTFS joins, zero-infra local
dev). ClickHouse becomes the analytical/history sink (predictions, outcomes,
observations, stop events, alerts, snapshot index) with async batched
inserts — surviving redeploys as the permanent archive and later feeding
training reads at scale. Snapshots (.zst files) stay on a volume + path in CH.

## 1. Dockerfile (repo root)
- FROM node:22-slim (has node:sqlite? NO — node:sqlite is in node 22.5+ built-in; verify, else node:24-slim; tsx runs TS directly, no build step)
- WORKDIR /app; copy package.json + workspaces; `npm ci --omit=dev` (tsx is devDep — move tsx+typescript to deps OR run via `npx tsx` with dev deps installed: keep full install, image ~300MB fine)
- COPY packages/ bin/ apps/web/
- ENV TRENO_DATA_DIR=/data; VOLUME /data
- HEALTHCHECK curl http://127.0.0.1:8787/api/health
- One image, commands per role:
  - collector: `npx tsx packages/collector/src/index.ts`
  - api: `npx tsx packages/api/src/server.ts` (port 8787)
  - trainer loop: cron-style container: `node bin/train-loop.mjs` (new tiny script: run train + train:connections + backtest, sleep until 03:30 Rome, repeat)

## 2. docker-compose.yml (repo root)
services:
- collector (build ., command collector, volumes: treno-data:/data, env: TRENO_CLICKHOUSE_URL=http://clickhouse:8123, restart: unless-stopped)
- api (same image, command api, ports 8787:8787, volume treno-data:/data read-only? collector+api share /data → same volume rw; restart)
- trainer (same image, command train-loop, same volume)
- clickhouse (image clickhouse/clickhouse-server:24-alpine, ports 8123/9000, volume ch-data:/var/lib/clickhouse, ulimits nofile 262144)
volumes: treno-data, ch-data

## 3. ClickHouse integration
- dep: @clickhouse/client (deps)
- new packages/storage/src/clickhouse.ts: CHSink class — env-gated (TRENO_CLICKHOUSE_URL); queue + flush every 5s or 500 rows (async_insert=1); tables created idempotently on first use (CREATE TABLE IF NOT EXISTS):
  - train_runs (run_id UInt32, run_key String, train_number LowCardinality(String), service_date Date, origin_stop_id String, destination_stop_id String, sched_dep_epoch DateTime64(3), sched_arr_epoch DateTime64(3), operator LowCardinality(String)) Engine=ReplacingMergeTree ORDER BY (run_id)
  - train_observations (ts DateTime64(3), run_id UInt32, source LowCardinality(String), delay_seconds Int32, status LowCardinality(String), location_name String, quality_flags String) ORDER BY (run_id, ts, source)
  - train_stop_events (run_id, stop_id, stop_sequence UInt16, sched/actual/op_pred DateTime64(3) Nullable, arr/dep_delay Int32, platform String, cancelled UInt8) ReplacingMergeTree ORDER BY (run_id, stop_id)
  - predictions (id UInt64, model_version LowCardinality(String), run_id, stop_id, generated_at DateTime64(3), sched_arr/operator_eta DateTime64(3) Nullable, our_p10/p50/p90 DateTime64(3), confidence Float32, features_json String) ORDER BY (model_version, generated_at, run_id)
  - prediction_outcomes (prediction_id UInt64, actual_arr DateTime64(3), operator_error_sec Int32, our_error_sec Int32, recorded_at) ORDER BY prediction_id
  - service_alerts, source_snapshots (fetched_at, source, changed UInt8, sha, bytes, path) ORDER BY (fetched_at, source)
- hook points (fire-and-forget, never block/throw into pipeline): observations.ts insertObservation/recordPrediction/fillPredictionOutcomes/insertServiceAlert + runs.ensureRun + rawStore.putSnapshot + upsertStopEvent → ch.queue(table, row)
- one-shot backfill: packages/storage/src/backfill-ch.ts (npm run ch:backfill) — streams existing SQLite rows into CH in 10k batches

## 4. GitHub Actions — .github/workflows/docker.yml
on: push branches [main], tags ['v*']; permissions packages:write
jobs build: docker/setup-qemu-action + setup-buildx-action; docker/build-push-action@v6 → ghcr.io/${{ github.repository }}:latest + :sha + :vX.Y.Z on tags; platforms linux/amd64,linux/arm64; cache type=gha
(git repo currently local-only — init remote first if needed; workflow assumes GH repo)

## 5. Server deploy notes
- ssh server; `GHCR_PAT=... docker login ghcr.io`; docker compose pull && up -d
- env: TRENO_USER_AGENT as local; iOS Settings → http://<server-ip>:8787
- GTFS loads into /data on first collector start (existing ensureZip logic)

## 6. Execution order
1. Dockerfile + train-loop.mjs + compose (verify: docker compose build && up, health green, board data flowing)
2. clickhouse.ts sink + hooks + ch:backfill (verify: SELECT counts match SQLite)
3. GH Actions workflow + push to GHCR (verify image runs)
4. Memory update: server IP/URL, iOS baseUrl switch
