# Execution plan — connection model, backtester, ARPA weather, RFI feed

Build order and exact specs (continue from here; each is self-contained):

## 2. Backtesting harness — `packages/collector/src/backtest.ts` (+ `npm run backtest`)
- Input: model files under `data/models/` + scored prediction rows (features_json).
- For each val-style row: rebuild FeatureInput from features_json (train.ts `extract()` shows the mapping), compute corrected p50 with `applyResidual(model, ...)` for EVERY model json present, report per-horizon MAE table (reuse bench.ts bucket edges) WITHOUT needing live rows.
- Gate: print heuristic vs each model version side by side. No DB writes.

## 1. Connection-level model — `packages/collector/src/connections-model.ts`
- Label: for arriving train A at stop S, connecting train B departs S: success = A.actual_arr ≤ B.actual_dep − 120s (walk buffer); failure = missed or B actual_dep with A arriving later.
- Reconstruct training pairs from train_stop_events: A arrives S, B's scheduled dep from S 5–30 min later, same service_date.
- Features: A's p10/p50/p90 at T-10min (from predictions), B's scheduled dep delta, A delay, line of B, hour, peak, corridor stats.
- Logistic GBM (wrap fitGBM with logit labels, clip) or ridge on logit; validate AUC ≥ 0.8 before serving; store in `data/models/connections-v1.json`; `connectionOptions()` in heuristic.ts reads it if present and replaces the normal-CDF probability (keep normal-CDF as fallback + gate).

## 4. ARPA Lombardia rain gauges — `packages/collector/src/weather-arpa.ts`
- ARPA open data: `https://www.dati.lombardia.it` Socrata dataset for sensori meteo (resource id for precipitation sensors, e.g. `nf76-ai7a` "Stazioni meteo" + readings endpoint — discover via catalog API at runtime, cache 24h).
- Map ~10 rain gauges near major rail corridors (Milano, Monza, Sesto, Brescia, Varese, Pavia…); feature `precipGaugeMm` = mean of gauges reading in the current hour; `precipSource` becomes gauge|dwd-icon (gauge preferred, actuals > forecasts).
- Refresh on the 10-min maintenance tick after refreshWeather(); add to heuristic features + featureRow (name 'precipGauge', scale min(x,10)/5) + FeatureInput + pipeline mapping + train extraction (?? null) + buildStopLevel nulls — same checklist as precipMm.

## 5. RFI GTFS-RT probe — `packages/providers/src/gtfsrt.ts`
- ViaggiaTreno has no GTFS-RT; check RFI endpoints: `http://www.viaggiatreno.it/infomobilita/resteasy/viaggiatreno/...` (already used) and any protobuf GTFS-RT at `https://gtfsrfi.viaggiatreno.it/gtfsrt/...`? Probe known URLs with politeFetch (Accept + descriptive UA as mia.ts does); if a protobuf feed responds, decode minimal TripUpdate via protobufjs (add dep) into the existing `RealtimeTransitProvider` interface (realtime.ts already defines it — this becomes the first real impl).
- Honest outcome either way: if unreachable, document in file header and keep the provider stub; do NOT fake data.
