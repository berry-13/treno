-- Treno analytical mirror schema (PLAN_docker_clickhouse.md §3).
-- Executed automatically by the clickhouse-server container on first start
-- (mounted at /docker-entrypoint-initdb.d/), or manually for bare-metal:
--   clickhouse client --queries-file deploy/clickhouse-init/01_tables.sql
--
-- Epoch-milli columns are DateTime64(3); nullable in ClickHouse where the
-- SQLite source column is nullable. ORDER BY keys are non-nullable.

CREATE TABLE IF NOT EXISTS train_runs (
  run_id UInt32,
  run_key String,
  train_number LowCardinality(String),
  service_date Date,
  operator LowCardinality(String),
  origin_stop_id Nullable(String),
  destination_stop_id Nullable(String),
  sched_dep_epoch Nullable(DateTime64(3)),
  sched_arr_epoch Nullable(DateTime64(3)),
  gtfs_trip_id Nullable(String),
  route_id Nullable(String),
  first_seen_source LowCardinality(String),
  created_at DateTime64(3)
) ENGINE = ReplacingMergeTree ORDER BY (run_id);

CREATE TABLE IF NOT EXISTS train_observations (
  ts DateTime64(3),
  run_id UInt32,
  source LowCardinality(String),
  observed_at Nullable(DateTime64(3)),
  delay_seconds Nullable(Int32),
  location_id Nullable(String),
  location_name Nullable(String),
  status Nullable(String),
  quality_flags Nullable(String)
) ENGINE = MergeTree ORDER BY (run_id, ts, source);

CREATE TABLE IF NOT EXISTS train_stop_events (
  run_id UInt32,
  stop_id String,
  stop_sequence UInt16,
  sched_arr_epoch Nullable(DateTime64(3)),
  sched_dep_epoch Nullable(DateTime64(3)),
  op_pred_arr_epoch Nullable(DateTime64(3)),
  op_pred_dep_epoch Nullable(DateTime64(3)),
  actual_arr_epoch Nullable(DateTime64(3)),
  actual_dep_epoch Nullable(DateTime64(3)),
  arr_delay_sec Nullable(Int32),
  dep_delay_sec Nullable(Int32),
  platform_sched Nullable(String),
  platform_actual Nullable(String),
  cancelled Nullable(UInt8),
  source LowCardinality(String),
  updated_at DateTime64(3)
) ENGINE = ReplacingMergeTree(updated_at) ORDER BY (run_id, stop_id, stop_sequence);

CREATE TABLE IF NOT EXISTS predictions (
  id UInt64,
  model_version LowCardinality(String),
  run_id UInt32,
  stop_id String,
  generated_at DateTime64(3),
  sched_arr_epoch Nullable(DateTime64(3)),
  operator_eta_epoch Nullable(DateTime64(3)),
  our_p10 Nullable(DateTime64(3)),
  our_p50 Nullable(DateTime64(3)),
  our_p90 Nullable(DateTime64(3)),
  confidence Nullable(Float32),
  features_json Nullable(String)
) ENGINE = MergeTree ORDER BY (model_version, generated_at, run_id);

CREATE TABLE IF NOT EXISTS prediction_outcomes (
  prediction_id UInt64,
  actual_arr_epoch Nullable(DateTime64(3)),
  operator_error_sec Nullable(Int32),
  our_error_sec Nullable(Int32),
  recorded_at DateTime64(3)
) ENGINE = ReplacingMergeTree ORDER BY (prediction_id);

CREATE TABLE IF NOT EXISTS service_alerts (
  id UInt64,
  source LowCardinality(String),
  run_id Nullable(UInt32),
  stop_id Nullable(String),
  title Nullable(String),
  description Nullable(String),
  severity Nullable(String),
  start_epoch Nullable(DateTime64(3)),
  end_epoch Nullable(DateTime64(3)),
  payload_hash String,
  raw_json String,
  created_at DateTime64(3)
) ENGINE = ReplacingMergeTree ORDER BY (payload_hash);

CREATE TABLE IF NOT EXISTS source_snapshots (
  fetched_at DateTime64(3),
  source LowCardinality(String),
  entity_key String,
  http_status Nullable(UInt16),
  etag Nullable(String),
  last_modified Nullable(String),
  payload_hash String,
  relevant_hash Nullable(String),
  changed UInt8,
  codec LowCardinality(String),
  bytes Nullable(UInt64),
  path Nullable(String),
  parser_version LowCardinality(String),
  error Nullable(String)
) ENGINE = MergeTree ORDER BY (fetched_at, source);

-- crowding (GOAL.md §53), added 2026-09-19 — additive migration for existing installs
ALTER TABLE train_observations ADD COLUMN IF NOT EXISTS crowding_pct Nullable(Int32);
ALTER TABLE train_observations ADD COLUMN IF NOT EXISTS crowding_label Nullable(String);

-- data quality flags (GOAL.md §45), added 2026-09-23 — stop-event-level flags
-- (IMPOSSIBLE_RUNTIME over consecutive actual times); train_observations
-- already carries quality_flags in its CREATE above. SQLite is the operational
-- truth; the backfill recomputes flags there.
ALTER TABLE train_stop_events ADD COLUMN IF NOT EXISTS quality_flags Nullable(String);

-- source conflicts (GOAL.md §78), added 2026-09-23 — materialized MIA vs
-- ViaggiaTreno disagreement per run/field (delay_source_spread feature);
-- SQLite source_conflicts is the operational truth, this the analytical mirror
CREATE TABLE IF NOT EXISTS source_conflicts (
  id UInt64,
  run_id UInt32,
  ts DateTime64(3),
  field LowCardinality(String),
  value_a Nullable(Float64),
  value_b Nullable(Float64),
  source_a LowCardinality(String),
  source_b LowCardinality(String),
  spread_seconds Int32,
  observed_at Nullable(DateTime64(3))
) ENGINE = MergeTree ORDER BY (run_id, ts);

-- railway reporting points (GOAL.md §82), added 2026-09-23 — additive.
-- Observation-driven registry of every location providers report (junctions,
-- bivi, control posts, border points; matched passenger stops typed as such).
-- SQLite is the operational truth; this analytical mirror can be populated
-- by a later ch:backfill pass if §83 map matching needs it.
CREATE TABLE IF NOT EXISTS rail_locations (
  key String,
  name Nullable(String),
  type LowCardinality(String),
  lat Nullable(Float64),
  lon Nullable(Float64),
  first_seen Nullable(DateTime64(3)),
  last_seen Nullable(DateTime64(3)),
  observation_count UInt64,
  updated_at DateTime64(3)
) ENGINE = ReplacingMergeTree(updated_at) ORDER BY (key);
