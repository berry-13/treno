# Project: Flighty-style Predictive Realtime Transit Intelligence for Italy

## 1. Product vision

Build a realtime public-transport intelligence platform for Italy, starting with Lombardy and especially:

- Trenord regional trains
- RFI/Trenitalia-visible trains in Lombardy
- ATM Milano buses
- ATM Milano trams
- later Milan Metro
- later potentially the rest of Italy

The product should not be another timetable app.

The defining feature should be:

> Predict what will happen to a journey before the normal operator app can tell the passenger.

Think conceptually of Flighty, but for trains and public transport.

The application should combine:

- operator realtime information
- infrastructure observations
- historical running behaviour
- surrounding trains/vehicles
- timetable topology
- disruptions
- congestion
- weather and external context where useful

to produce an independent prediction of:

- arrival time
- departure time
- future delay
- delay recovery
- disruption propagation
- connection success probability
- likely platform changes
- likely downstream problems

The system should always distinguish:

1. scheduled time
2. operator prediction
3. our prediction

Example:

```text
RE 25317
Milano Centrale → Bergamo

Scheduled arrival       18:42
Trenord prediction       18:49
Our prediction           18:47

Expected delay           +5m
Confidence               ±45 sec
Prediction confidence    HIGH

Last observed:
Bivio Casirate
18:31:17
21 seconds ago

Trend:
Recovering ~35 sec since Treviglio

Connection at Bergamo:
87% probability of success
```

The long-term goal is the closest practically achievable equivalent of:

> “Flighty for Italian rail/public transport.”

The product must not pretend it has signalling-control-room information when it does not.

Instead, it should expose uncertainty honestly and use inference.

---

# 2. Current fundamental limitation

The largest limitation is data access.

Italian rail operators do not currently expose anything comparable to aviation ADS-B.

We generally do NOT have public access to:

- continuous exact train GPS positions
- railway block occupancy
- signal aspects
- route locking
- switch/points state
- dispatcher decisions
- train priority decisions
- exact reasons trains are being held
- complete traffic-management-system state

Therefore today we cannot build:

```text
Train is exactly 1.43 km before signal X
Speed: 82 km/h
Signal ahead: red
Train Y is occupying block Z
Dispatcher will release route in 71 sec
```

However, enough fragmented realtime information exists that we can build a very strong passenger prediction system.

The architectural philosophy must therefore be:

```text
multiple incomplete observations
              ↓
state reconstruction
              ↓
historical knowledge
              ↓
probabilistic prediction
```

rather than:

```text
one perfect realtime source
```

---

# 3. Primary product objective

The first measurable product objective is:

> Produce lower ETA prediction error than Trenord's passenger-facing prediction.

Do NOT initially try to predict arrival completely from scratch.

Instead predict the residual error in the operator ETA.

Define:

```text
operator_error =
actual_arrival - operator_predicted_arrival
```

Train a model to predict:

```text
predicted_operator_error
```

Then:

```text
our_eta =
operator_eta + predicted_operator_error
```

Example:

```text
Trenord says             08:46:00

Model predicts:
Trenord currently tends
to be 78 sec pessimistic

Our ETA                  08:44:42
```

This is considerably easier and more robust than replacing the operator prediction entirely.

---

# 4. Initial geographical scope

Start with Lombardy.

Priority order:

## Phase 1

Trenord.

This is currently the strongest opportunity because several independent realtime sources exist.

## Phase 2

ATM bus and tram.

Useful realtime predictions exist but raw vehicle identity/position is missing.

## Phase 3

Metro Milano.

Public realtime data is currently too weak for Flighty-level functionality.

## Phase 4

Expand nationally.

Potential sources:

- ViaggiaTreno
- future EU railway telematics interfaces
- National Access Point feeds
- regional transport agencies
- operators publishing GTFS-Realtime

---

# 5. Current Trenord realtime sources

Do not rely on one source.

Use all of them.

---

## 5.1 Trenord MIA backend

An undocumented but currently publicly accessible Trenord backend exists:

```text
https://admin.trenord.it/store-management-api/mia/
```

Train endpoint:

```http
GET /train/{trainNumber}
```

Example:

```text
https://admin.trenord.it/store-management-api/mia/train/4307
```

No API key is required.

Important request requirement:

```http
Accept: */*
User-Agent: <our descriptive UA>
```

The endpoint has been observed to respond:

```text
no headers              403
Accept only             403
User-Agent only         403
Accept + User-Agent     200
```

Therefore every production request must explicitly include both.

Do NOT design around browser-default headers.

### Relevant MIA fields

At train level:

```text
train_id
line
train_category
train_operator
direction

delay
status
has_live_info

actual_station
actual_time

average_crowding
average_crowding_label

suppression_type
alerts

bicycle
handicap
mxp
```

Status values observed:

```text
N = not departed
V = travelling
P = departed
A = arrived
C = cancelled
```

At stop level:

```text
station

arr_time
dep_time

arr_date_time
dep_date_time

platform
is_actual_platform

cancelled
type

actual_data
```

Actual stop information may contain:

```text
arr_actual_time
dep_actual_time

arr_delay_actual
dep_delay_actual
```

This is extremely useful.

MIA therefore gives:

```text
current train status
current delay
latest known Trenord location
latest Trenord observation time

historical actual times
for already passed stops

delay evolution

platform information

alerts

sometimes crowding
```

Important:

Some fields are entirely absent from the JSON when unavailable rather than:

```json
null
```

Treat all optional fields defensively.

Examples:

```text
average_crowding
average_crowding_label
suppression_type
alerts
```

must not be assumed present.

---

# 6. ViaggiaTreno / RFI

Base endpoint:

```text
http://www.viaggiatreno.it/infomobilita/resteasy/viaggiatreno/
```

This API is undocumented but widely reverse engineered.

Important endpoints include:

```text
cercaNumeroTrenoTrenoAutocomplete/{trainNumber}
```

and:

```text
andamentoTreno/{originStationCode}/{trainNumber}/{departureEpochMs}
```

Station boards also exist.

---

## 6.1 Why ViaggiaTreno is especially useful

For every train it may expose:

```text
ritardo

stazioneUltimoRilevamento
oraUltimoRilevamento

fermate[]
```

Individual stop data can include:

```text
programmata

partenza_teorica
arrivo_teorico

effettiva

partenzaReale
arrivoReale

ritardo

platform information
```

Most importantly:

```text
stazioneUltimoRilevamento
```

is not always a passenger station.

It can be a railway operating/reporting point such as:

```text
Bivio Casirate
```

This is extremely valuable.

It means we may obtain observations between passenger stops.

Conceptually:

```text
Milano Lambrate
      │
      │
      ● railway detection point
      │  18:43:28
      │
      ▼
Pioltello
```

This is NOT GPS.

But railway reporting-point observations can still produce excellent ETA predictions.

---

# 7. Trenord GTFS-Realtime

Trenord publishes an official GTFS Static + GTFS-Realtime feed through Regione Lombardia's E015 ecosystem.

Relevant realtime information includes:

- actual delays
- predicted future delays
- cancellations

Use this as another independent data source.

It may represent the operator's passenger-facing prediction layer.

Do not treat it as ground truth.

Treat it as a model/input.

The important conceptual distinction is:

```text
operator prediction ≠ actual future arrival
```

The operator prediction should become a feature in our model.

---

# 8. Static Trenord GTFS

Use the operator's original downloadable GTFS ZIP as the canonical scheduled timetable.

Do NOT use convenient portal-imported database/table versions as the primary source.

Existing research has found substantial data loss in imported copies.

Observed comparison:

```text
                     GTFS ZIP        imported tables

stop_times           90,553          68,952
trips                  8,470           6,265
```

Problems found in imported tables include:

- truncated trips
- broken after-midnight times
- rewritten service IDs
- missing `trip_short_name`
- route type inconsistencies
- coordinate corruption
- seasonal service ambiguity

Therefore:

```text
ORIGINAL GTFS ZIP
      ↓
our own parser
      ↓
our canonical schedule DB
```

---

# 9. Train identity

Never use train number alone as the database identity.

The same train number can represent more than one run.

Create a canonical train-run identity.

Possible key:

```text
operator
service_date
train_number
origin_station
scheduled_origin_departure
```

Internally define:

```text
TrainRunId
```

with stable mapping across:

- GTFS
- MIA
- ViaggiaTreno
- GTFS-RT

Mapping between source identifiers will be a significant engineering task.

Preserve every source-native identifier.

Example:

```text
train_runs

id

operator
service_date

train_number

gtfs_trip_id
mia_train_id
viaggiatreno_origin_code

origin_stop_id
destination_stop_id

scheduled_departure
scheduled_arrival
```

---

# 10. Fusion strategy for trains

A single train should have several simultaneous observations.

Example:

```text
Trenord MIA
    ↓
actual_station = Treviglio
actual_time = 09:21:08
delay = +5

ViaggiaTreno
    ↓
last_detection = Bivio Casirate
last_detection_time = 09:25:14
delay = +5

GTFS-RT
    ↓
operator predicts Milano arrival 09:43
```

The state reconstruction layer should determine:

```text
freshest observation
most reliable observation
source disagreement
observation age
current inferred position
```

Do NOT simply select MIA or ViaggiaTreno permanently.

A state object should look conceptually like:

```text
TrainRealtimeState

run_id

operator_delay

latest_location
latest_location_type

latest_observed_at
latest_source

mia_observation_age
viaggiatreno_observation_age
gtfs_rt_observation_age

previous_stop
previous_actual_arrival
previous_actual_departure

next_stop

operator_next_stop_eta

confidence
```

---

# 11. Historical data is one of the project's main assets

Start collecting immediately.

Historical behaviour cannot simply be recreated later if the upstream providers do not expose historical snapshots.

Example valuable historical query:

```text
RE 2534
Monday
07:30–08:30

enters Treviglio +4 min

historically:

Treviglio → Pioltello

median segment time    15:42
P10                    14:51
P90                    18:03

when entering +4:
median delay change    +0:38
```

Over time the product improves.

Approximate maturity:

```text
Day 1
basic realtime fusion

Week 1
segment statistics

Month 1
meaningful route/time patterns

3 months
weekday/time-specific prediction

6 months
seasonality and recurring disruptions

12+ months
very strong historical network model
```

The historical dataset may become more valuable than the application code itself.

---

# 12. Network-level prediction

Do not predict each train independently.

Other trains are sensors.

Suppose the preceding three trains on the same segment are currently doing:

```text
Train A   X → Y    loses 63 sec
Train B   X → Y    loses 81 sec
Train C   X → Y    loses 69 sec
```

A fourth train has not yet entered the segment.

Strong inference:

```text
segment is currently degraded
```

Build live corridor features.

Examples:

```text
preceding_train_delay_change
preceding_train_segment_runtime

median_last_3_trains_segment_runtime

median_last_5_trains_segment_delay_delta

trains_currently_in_segment

segment_congestion_index

upstream_congestion

downstream_congestion
```

This may become one of the strongest competitive advantages.

---

# 13. Segment model

Represent railway routes as segments.

Possible abstraction:

```text
node = station or reporting point

edge = railway segment
```

Important:

Use railway reporting points from ViaggiaTreno when available, not only passenger stations.

Graph example:

```text
Station A
   │
Detection X
   │
Detection Y
   │
Station B
```

Collect traversal observations:

```text
segment_observation

segment_id
train_run_id

entered_at
left_at

runtime_seconds

entry_delay_seconds
exit_delay_seconds

delay_delta_seconds

time_of_day
day_of_week

source_confidence
```

Build per-segment distributions.

---

# 14. Prediction model

Start simple.

Recommended first production model:

```text
LightGBM
```

or:

```text
CatBoost
```

Do not begin with:

- transformers
- LSTMs
- giant neural networks
- graph neural networks

unless the simple system has already been benchmarked.

---

## 14.1 Initial prediction target

Use residual prediction.

For each future stop:

```text
target =
actual_arrival_time
-
operator_predicted_arrival_time
```

Input features may include:

### Operator features

```text
operator ETA

current delay

future operator delay

operator status
```

### Current-train features

```text
last location

observation age

previous stop arrival delay

previous stop departure delay

last 2–5 segment runtimes

last 2–5 delay deltas

number of remaining stops

scheduled remaining runtime

train category

line

direction
```

### Temporal features

```text
hour
minute
weekday
weekend
month
holiday
school day
rush hour
```

### Network features

```text
preceding train delay

preceding train runtime

following train delay

median current corridor delay

rolling segment runtime

number of disturbed trains
```

### Operational features

```text
alerts
cancellation/suppression signals
platform changes

crowding
```

### External features later

```text
weather

large events

road traffic for bus/tram

strikes

planned works
```

---

# 15. Prediction output

Never expose only one timestamp.

Output distribution/confidence.

Example:

```text
arrival_p10
arrival_p50
arrival_p90
```

UI:

```text
Our ETA
18:42

Likely range
18:41–18:43
```

Potential internal response:

```json
{
  "scheduled": "...",
  "operator_eta": "...",
  "our_eta_p10": "...",
  "our_eta_p50": "...",
  "our_eta_p90": "...",
  "confidence": 0.88
}
```

---

# 16. Avoid fake precision

Source ground truth may itself have uncertainty.

"Actual arrival" can mean:

- enters station
- stops at platform
- doors release
- operator records arrival
- backend publishes event

Therefore do not advertise:

```text
08:43:17
```

unless we have proven second-level target quality.

Passenger UI probably should say:

```text
08:43
±45 sec
```

or:

```text
08:42–08:44
```

---

# 17. Delay recovery prediction

A major product feature:

```text
Current delay: +8 min

Expected delay at Milano:
+5 min

Recovery probability:
74%

Likely recovery:
2–4 min
```

Model:

```text
delay_delta =
future_stop_delay - current_delay
```

Historical training can answer:

```text
When entering this segment
with +8 min delay,
what normally happens?
```

---

# 18. Connection-risk prediction

This should be one of the killer features.

Instead of:

```text
connection scheduled: 6 min
```

calculate:

```text
P(connection succeeds)
```

Inputs:

```text
arrival distribution of first service

departure distribution of next service

station transfer time distribution

platforms

platform-change probability

walking distance

train holding behaviour

historical transfer success
```

Example:

```text
Connection at Milano Centrale

Scheduled transfer       7m
Expected transfer        3m40s

Success probability      41%

Recommendation:
Use the following train
```

This can materially improve journey planning.

---

# 19. Journey ranking

Never rank solely by scheduled arrival.

Rank by:

```text
expected actual arrival
```

possibly adjusted for risk.

For example:

```text
utility =
expected_arrival
+
risk_penalty
```

Example:

```text
Option A

Scheduled arrival        18:42
Predicted arrival        18:51
Connection probability   31%


Option B

Scheduled arrival        18:47
Predicted arrival        18:49
Connection probability   86%

Recommendation: B
```

This is exactly the kind of intelligence ordinary operator apps often lack.

---

# 20. ATM Milano buses and trams

Current GiroMilano backend:

```text
https://giromilano.atm.it/proxy.tpportal/api/tpPortal/
```

Useful stop endpoint:

```text
geodata/pois/stops/{STOP_ID}
```

Example:

```text
https://giromilano.atm.it/proxy.tpportal/api/tpPortal/geodata/pois/stops/11491
```

Known live fields include:

```text
stop code

stop description

stop latitude
stop longitude

line information

line id
line code
direction

JourneyPatternId

WaitMessage

TrafficBulletins

links to:
timetable
journey pattern
```

Possible live values:

```text
"in arrivo"

"3 min"

"7 min"

"ricalcolo"

"no serv."
```

---

# 21. ATM limitation

Current GiroMilano stop response does NOT appear to expose:

```text
vehicle_id

vehicle latitude
vehicle longitude

speed

bearing

raw ETA seconds

vehicle source timestamp

run/block ID
```

Therefore today:

```text
ATM AVM/GPS
    ↓
ATM prediction engine
    ↓
quantized WaitMessage
    ↓
GiroMilano
    ↓
us
```

We receive processed predictions rather than raw telemetry.

This is the single biggest limitation for ATM.

---

# 22. ATM latent vehicle reconstruction

Until raw VehiclePosition data becomes available, attempt to infer anonymous vehicles across consecutive stops.

Route:

```text
A ─ B ─ C ─ D ─ E
```

At 12:00:

```text
B    90 → 1 min
C    90 → 4 min
D    90 → 7 min
```

At 12:01:

```text
B    90 → in arrivo
C    90 → 3 min
D    90 → 6 min
```

At 12:02:

```text
B    next 90 → 9 min
C    90 → 2 min
D    90 → 5 min
```

Infer:

```text
one vehicle passed B around 12:01–12:02
```

Maintain latent identities:

```text
latent_vehicle_001
latent_vehicle_002
latent_vehicle_003
```

Possible methods:

- probabilistic matching
- Hungarian assignment
- Kalman filter
- particle filter
- hidden Markov model

Features:

```text
route
direction
JourneyPatternId

expected stop order

previous ETA evolution

minimum/maximum plausible travel time

headway constraints
```

Difficulty:

Vehicle bunching makes identity ambiguous.

Example:

```text
Bus A
30 sec
Bus B
```

Predictions may become impossible to associate reliably.

Therefore ATM identity reconstruction is a high-complexity subsystem.

---

# 23. RAPSODIA / future Lombardy GTFS-Realtime

A major future data opportunity exists through the Lombardy Smart Mobility Data Driven / RAPSODIA architecture.

The project specification describes:

```text
operator AVM
    ↓
basin control center
    ↓
GTFS-Realtime
    ↓
open data
    ↓
third parties
```

The architecture is intended to ingest realtime AVM information from public-transport vehicles.

Potential information could include:

- realtime vehicle movement
- passenger counting
- diagnostics

The specification says GTFS-Realtime data should be made directly available as open data for third-party services.

However:

A confirmed publicly consumable RAPSODIA GTFS-Realtime endpoint has not yet been identified.

The broader project implementation deadline was extended into 2027.

The system must therefore be architected so a future feed can be plugged in instantly.

---

# 24. GTFS-Realtime adapter interface

Create a generic ingestion adapter.

Example:

```typescript
interface RealtimeTransitProvider {
  fetchVehiclePositions(): Promise<VehiclePosition[]>;
  fetchTripUpdates(): Promise<TripUpdate[]>;
  fetchAlerts(): Promise<ServiceAlert[]>;
}
```

The rest of the system should not care whether data came from:

- RAPSODIA
- ATM
- Trenord
- another Italian operator

Canonical representation should follow GTFS-RT concepts where possible.

---

# 25. Milan Metro

Current GiroMilano namespace:

```text
https://giromilano.atm.it/proxy.tpportal/api/tpPortal/tpl/atm
```

Known endpoint:

```text
/sm
```

It gives roughly:

```text
metro line

directions[]

direction description

direction status
```

Useful for:

```text
M1 → Sesto direction → regular/disrupted
```

Not enough for:

```text
specific metro train location
next train exact ETA
track-circuit location
```

Therefore Metro should NOT be the primary focus of v1.

---

# 26. Static ATM GTFS

Comune di Milano publishes GTFS containing:

- stops
- routes
- trips
- stop_times
- shapes
- calendars

Use this for:

```text
network topology

route geometry

station order

scheduled timetables
```

Realtime GiroMilano information layers on top of that.

---

# 27. Data collector architecture

This is one of the most important components.

Do not write polling logic directly into prediction workers.

Create a dedicated ingestion system.

Concept:

```text
SOURCE ADAPTERS

Trenord MIA
ViaggiaTreno
Trenord GTFS-RT
GiroMilano
static GTFS
future RAPSODIA

         ↓

INGESTION SCHEDULER

         ↓

RAW EVENT STORAGE

         ↓

NORMALIZATION

         ↓

CURRENT STATE STORE

         ↓

HISTORICAL TIME SERIES
```

---

# 28. Preserve raw responses

Always retain raw upstream payloads, at least temporarily.

Undocumented APIs will change.

Schema bugs or parser mistakes must be recoverable without recollecting history.

Store:

```text
source_snapshot

id

source

entity_type
entity_key

fetched_at

http_status

server_date

etag

last_modified

payload_hash

relevant_fields_hash

raw_payload

parser_version
```

This makes historical reprocessing possible.

---

# 29. Raw storage

Do NOT store every giant raw JSON response forever in PostgreSQL.

Preferred:

```text
compressed object storage
```

Possible:

- S3-compatible storage
- MinIO
- filesystem initially

Format:

```text
zstd compressed JSON

or

Parquet batches
```

Partition:

```text
source/year/month/day/hour
```

Example:

```text
raw/
  mia/
    2026/
      08/
        31/
```

---

# 30. Normalized database

Recommended:

```text
PostgreSQL
+
TimescaleDB
```

or pure PostgreSQL first if simplicity is preferred.

Potential tables:

```text
operators
stops
routes
route_patterns
segments
train_runs
vehicle_runs

source_snapshots

train_observations

train_stop_events

segment_observations

atm_stop_observations

service_alerts

predictions

prediction_outcomes
```

---

# 31. Train observation schema

Example:

```text
train_observations

time
run_id

source

delay_seconds

last_location_id
last_location_name

location_type

source_observed_at

observation_age_seconds

status

crowding_percentage

platform

raw_snapshot_id
```

---

# 32. Stop-event schema

```text
train_stop_events

run_id

stop_id
stop_sequence

scheduled_arrival
scheduled_departure

operator_predicted_arrival
operator_predicted_departure

actual_arrival
actual_departure

arrival_delay_seconds
departure_delay_seconds

platform_scheduled
platform_actual

cancelled

source

observed_at
```

---

# 33. Prediction storage

Every prediction must be saved.

Otherwise proper benchmarking is impossible.

```text
predictions

id

model_version

run_id
stop_id

generated_at

scheduled_arrival

operator_eta

our_eta_p10
our_eta_p50
our_eta_p90

confidence

feature_snapshot_id
```

After the event completes:

```text
prediction_outcomes

prediction_id

actual_arrival

operator_error_seconds

our_error_seconds
```

---

# 34. Benchmarking methodology

Do not claim improved accuracy without measuring it.

For every completed stop, evaluate predictions at horizons such as:

```text
T-30 min
T-20 min
T-10 min
T-5 min
T-2 min
T-1 min
```

Metrics:

```text
MAE

median absolute error

RMSE

P90 absolute error

P95 absolute error

signed bias

confidence interval coverage
```

Compare:

```text
A
schedule only

B
operator ETA

C
simple historical model

D
residual ML model

E
future advanced model
```

Example desired report:

```text
             Trenord       ours

T-20         3m01s         2m08s
T-10         2m04s         1m22s
T-5          1m17s         0m51s
T-2          0m48s         0m33s
```

Only after seeing this may marketing claim:

```text
more accurate than operator ETA
```

---

# 35. Model-version reproducibility

Every prediction must know:

```text
model_version

feature_schema_version

data_snapshot_version
```

Training configuration should be reproducible.

Use MLflow or a lightweight internal alternative.

At minimum store:

```text
Git commit
training date
training window
hyperparameters
feature list
evaluation results
model binary hash
```

---

# 36. Source polling strategy

Never hammer undocumented endpoints.

Polling must be adaptive.

Example train polling:

```text
>60 min before departure
every 5 min

30–60 min
every 2 min

10–30 min
every 60 sec

<10 min
every 30 sec

running train
every 15–30 sec

arrived/cancelled
stop
```

Start conservatively.

Measure actual upstream update frequency.

---

# 37. Freshness experiment

Before scaling network-wide, run a controlled collector.

Poll selected sources every ~10 seconds for 24–72 hours.

Record:

```text
fetch timestamp

HTTP Date

ETag

Last-Modified

payload hash

relevant-field hash

upstream timestamp
```

Determine actual source cadence.

Example possible result:

```text
MIA
requested every 10s
changes every 30–60s

ViaggiaTreno
changes following detector passage

GiroMilano
changes every ~30s
```

Then tune the collector to the source.

---

# 38. Cache architecture

Use Redis for:

```text
current train state

latest predictions

stop boards

source freshness

distributed locks

poll scheduling

rate-limit protection
```

Do not use Redis as permanent history.

---

# 39. Processing pipeline

Recommended stream:

```text
fetch source

↓
store raw snapshot

↓
parse source schema

↓
normalize IDs

↓
deduplicate

↓
produce observation

↓
update current state

↓
append historical event

↓
trigger feature recalculation

↓
run prediction

↓
cache API result
```

Kafka is unnecessary initially.

Possible lighter options:

- Redis Streams
- PostgreSQL queue
- NATS
- RabbitMQ

Start simple.

---

# 40. Recommended backend stack

A reasonable implementation:

```text
TypeScript
Node.js

or

Python for data/ML services
```

Possible split:

```text
API / ingestion
TypeScript

ML/training
Python
```

Frameworks:

```text
Fastify / Hono / NestJS

FastAPI for ML endpoints

PostgreSQL
TimescaleDB
Redis
MinIO/S3
```

Avoid overengineering microservices at the beginning.

Possible initial deployment:

```text
collector
normalizer
prediction worker
API
PostgreSQL
Redis
object storage
```

---

# 41. Server requirements

Compute is not currently the bottleneck.

Data quality is.

Reasonable initial resources:

```text
Collector
2–4 CPU
1–2 GB RAM

API
2 CPU
1–2 GB RAM

Redis
512 MB–2 GB

Postgres/Timescale
4–8 CPU
8–16 GB RAM

Model inference
1–2 CPU
<2 GB RAM

Model training
8–16 CPU
```

GPU:

```text
not necessary for initial models
```

A GPU provides little value if using:

- LightGBM
- CatBoost
- statistical models

Storage IOPS and efficient schema design matter much more.

---

# 42. Data volume

If eventually observing:

```text
2,000 active entities

every 20 sec

18 service hours/day
```

that means approximately:

```text
6.5 million observations/day
```

Naive storage could become multiple GB/day.

Therefore implement:

- deduplication
- compression
- aggregation
- retention

---

# 43. Retention strategy

Suggested:

```text
raw high-frequency snapshots
30–90 days

normalized detailed observations
3–12 months

1-minute aggregates
multiple years

completed trip outcomes
permanent

segment statistics
permanent

training Parquet
versioned
```

Raw history can be rolled into Parquet.

---

# 44. Deduplication

Most polling responses may not change.

Calculate:

```text
payload_hash

relevant_fields_hash
```

If unchanged:

Do not create unnecessary normalized observation rows unless observation freshness itself matters.

Possibly store:

```text
first_seen
last_seen
```

for repeated state.

---

# 45. Data quality engine

Every source needs validation.

Examples:

```text
arrival earlier than previous departure

impossible 300 km/h inferred speed

train teleports backwards

delay jumps ±60 min unexpectedly

station sequence mismatch

source timestamp older than previous one
```

Do not silently discard anomalies.

Store quality flags.

```text
quality_flags

OUT_OF_ORDER
IMPOSSIBLE_RUNTIME
STALE_SOURCE
SOURCE_CONFLICT
UNMAPPED_STOP
UNKNOWN_RUN
```

These flags may become useful ML features.

---

# 46. Confidence model

Separate ETA prediction from confidence.

Confidence depends on:

```text
source freshness

number of independent sources

source agreement

historical sample size

current disruption state

distance/horizon

data quality
```

Example:

```text
confidence = HIGH
```

when:

```text
MIA and ViaggiaTreno agree
last observation <30 sec
historical segment has 3,000 samples
no disruption
```

Low confidence when:

```text
last observation 4 min old
sources disagree
service altered
new route pattern
```

---

# 47. Product UI philosophy

Never hide source uncertainty.

Train page should show:

```text
Scheduled
Operator
Our estimate
Confidence
```

Example:

```text
18:42          scheduled
18:49          Trenord
18:47          predicted

Likely:
18:46–18:48
```

Potential detail panel:

```text
Why?

+52 sec
traffic ahead

-28 sec
historical recovery on next segment

+14 sec
longer-than-normal dwell

Net:
+38 sec vs current operator estimate
```

Do not expose raw ML feature values if they are misleading, but create human-readable explanations.

---

# 48. Realtime train visualization

Without GPS, do not put a fake exact dot on the railway.

Use uncertain segment location.

Example:

```text
Last detected:
Bivio Casirate
18:31:17

Likely current area:
Bivio Casirate → Treviglio
```

Map representation could use:

```text
highlighted segment
```

rather than an exact point.

If interpolation is shown:

Make uncertainty visually explicit.

---

# 49. Later exact vehicle maps

If GTFS-Realtime VehiclePosition becomes available:

Display:

```text
vehicle position

bearing

speed

timestamp
```

Map-match onto the route shape.

Never display raw GPS directly without map matching because public-transit GPS can drift.

---

# 50. Alert/disruption intelligence

Aggregate:

- Trenord alerts
- GTFS-RT alerts
- GiroMilano traffic bulletins
- ATM alerts
- planned works

Normalize into:

```text
service_alert

operator

scope

affected_routes
affected_stops

start
end

severity

title
description

source
```

Then predict effects.

Example:

```text
signal failure near Monza
```

may imply future delays on trains not yet flagged individually.

This should feed network-level prediction.

---

# 51. Predicting disruption propagation

Advanced feature:

```text
incident starts at X
```

Observe:

```text
first affected trains

segment runtimes

queue growth

recovery rate
```

Estimate:

```text
which trains will be affected next

expected additional delay

time until network normalization
```

This can produce:

```text
Your train currently shows on time.

However:
high probability of +6–10 min
before Monza because three preceding
trains are currently delayed there.
```

This is very Flighty-like.

---

# 52. Platform prediction

When historical platform assignment exists, build:

```text
P(platform = X)
```

Features:

```text
train
station
route
time
weekday
current platform assignments
preceding services
disruption
```

UI:

```text
Platform not announced

Likely:
5   72%
6   18%
4   10%
```

Do NOT present predicted platforms as confirmed.

---

# 53. Crowding

MIA sometimes exposes:

```text
average_crowding
average_crowding_label
```

Persist it.

Potential future prediction:

```text
expected crowding

likelihood of standing

carriage loading patterns
```

If enough history is collected.

---

# 54. Weather

Weather probably has low importance for trains under normal conditions but may matter during:

- storms
- extreme heat
- snow
- flooding

For buses/trams it may affect:

- road speeds
- boarding dwell
- congestion

Add later.

Do not make weather a dependency in v1.

---

# 55. Road traffic integration

For ATM buses, external road traffic may substantially improve prediction if raw vehicle positions become available.

Potential data:

```text
current traffic speed
road incidents
closures
```

Map vehicle route segments to road segments.

Use as feature:

```text
traffic_speed_ratio
```

Do later.

---

# 56. What is currently bottlenecking the project

Ranking:

```text
1. raw realtime data quality

2. amount of historical observations

3. entity/run matching

4. state reconstruction

5. prediction model

6. storage architecture

7. CPU

8. RAM

9. GPU
```

Approximate current severity:

```text
ATM raw realtime data             10/10

historical dataset                 9/10

ATM vehicle identity               9/10

Trenord observation granularity    7/10

normalization/matching              7/10

prediction algorithm                5/10

database performance                3/10

CPU                                 2/10

RAM                                 2/10

GPU                                 1/10
```

Do NOT attempt to solve poor data with more GPU.

---

# 57. Security and source etiquette

These APIs are undocumented.

Therefore:

- use conservative polling
- identify our client via descriptive User-Agent
- add exponential backoff
- honor HTTP errors
- use caching
- never intentionally bypass authentication
- never evade explicit rate limits
- do not depend on scraping HTML if a JSON endpoint exists
- isolate each provider behind an adapter

If a source changes, application functionality should degrade rather than crash globally.

---

# 58. Provider health

Track:

```text
request success rate

latency

last successful fetch

last changed payload

schema errors

403 frequency

5xx frequency
```

Expose internal dashboard.

Example:

```text
MIA             HEALTHY
ViaggiaTreno    DEGRADED
GiroMilano      HEALTHY
GTFS-RT         STALE
```

Prediction confidence should account for degraded providers.

---

# 59. API design

Possible public API:

```text
GET /stations/search

GET /stations/:id/departures

GET /trains/:runId

GET /trains/:runId/predictions

GET /journeys

GET /lines/:id/status

GET /vehicles/:id
```

Train endpoint response:

```json
{
  "run": {},
  "schedule": {},
  "operatorRealtime": {},
  "ourPrediction": {},
  "confidence": {},
  "observations": [],
  "alerts": []
}
```

---

# 60. Public websocket/SSE

For realtime UI:

Use:

```text
Server-Sent Events
```

or WebSocket.

SSE is probably enough initially.

Example:

```text
GET /stream/trains/{id}
```

Events:

```text
state_update
prediction_update
platform_update
alert
```

---

# 61. Notification system

Potential notifications:

```text
Train actually starting to recover

Our predicted arrival changed by >2 min

Connection risk drops below 50%

Platform changed

Cancellation probability increases

Operator prediction changes

Disruption likely to affect your train
```

Avoid noisy updates.

Use thresholds.

---

# 62. User-facing flagship features

Eventually:

## Live Journey

```text
where is my train?

what is its real likely ETA?

why is it delayed?
```

## Delay Trend

```text
+7 now

expected:
+6 Monza
+4 Milano
```

## Recovery Prediction

```text
68% chance of recovering ≥2 min
```

## Connection Guardian

```text
connection success 84%

alternative ready if risk drops
```

## Reliability Intelligence

```text
This train:
on time 72%
>5 min late 19%
>10 min late 7%
cancelled 2%
```

## Actual vs Scheduled History

```text
specific train
specific weekday
specific hour
```

## Corridor Health

```text
Milano → Monza currently slower
than normal by 2m14s
```

## Smart Alternatives

Recommend based on expected real arrival rather than planned arrival.

---

# 63. Avoid becoming another timetable app

Do not spend months initially rebuilding:

- ticket purchasing
- account systems
- huge journey-planner UI
- generic maps
- station amenities

before predictive intelligence works.

The project's differentiation is:

```text
prediction
+
explanation
+
risk
```

Build those first.

---

# 64. MVP

The MVP should be Trenord-only.

Requirements:

1. Parse Trenord static GTFS.
2. Discover today's active train runs.
3. Poll MIA.
4. Poll ViaggiaTreno.
5. Map observations to canonical runs.
6. Persist raw payloads.
7. Persist normalized observations.
8. Build current train state.
9. Save completed actual stop times.
10. Produce heuristic predictions.
11. Benchmark those predictions against operator estimates.
12. Build simple web UI.

Do NOT start ML immediately.

First heuristic:

```text
operator ETA
+
historical median residual
```

or:

```text
current delay
+
historical segment delay evolution
```

---

# 65. MVP UI

Home:

```text
search train
search station
```

Train page:

```text
Train number

origin → destination

scheduled timeline

current status

current delay

last observation

operator ETA

our ETA

confidence

future stop predictions
```

Example:

```text
RE 25317

Bergamo → Milano Centrale

Current
Pioltello area

Last detected
Bivio Casirate · 18 sec ago

Delay
+7m

Milano Lambrate

Scheduled      18:39
Trenord        18:47
Our estimate   18:45–18:46

Confidence     High
```

---

# 66. Phase 1 heuristic prediction

Before enough ML history exists:

Use:

```text
current latest detection

scheduled remaining travel time

current delay

historical segment median

recent corridor delay
```

Possible formula:

```text
ETA =
last_observed_time
+
historical_remaining_runtime
+
live_corridor_adjustment
```

Blend with operator ETA.

For example:

```text
our_eta =
0.65 * operator_eta
+
0.35 * independent_eta
```

Weights may depend on:

```text
observation freshness

historical sample size

source agreement
```

---

# 67. Phase 2 ML

When enough history exists:

Train LightGBM/CatBoost residual predictor.

Train separate horizons or a general model.

Features should be generated in point-in-time correct fashion.

Critical:

No leakage.

When predicting at:

```text
18:30
```

features must contain only information available at 18:30.

Build a point-in-time feature generation framework.

---

# 68. ML train/validation split

Never randomly shuffle individual observations.

That causes leakage from the same journey appearing in train and test.

Use time-based split.

Example:

```text
training:
Jan–Jun

validation:
July

test:
August
```

Possibly also route holdouts.

---

# 69. Advanced models later

Only if benchmarked improvement exists.

Candidates:

```text
temporal convolution

LSTM/GRU

transformer

temporal graph neural network

graph attention

survival analysis

Bayesian models
```

A graph model could eventually represent:

```text
railway network nodes
+
moving trains
+
segment congestion
```

But this is not an MVP requirement.

---

# 70. Feature store

Initially use SQL views/materialized queries.

Do NOT introduce a giant feature-store platform immediately.

Potential feature snapshot:

```text
prediction_features

prediction_time

run_id
target_stop

current_delay
last_observation_age

segment_id

rolling_segment_runtime_3
rolling_segment_runtime_10

preceding_train_delay

historical_segment_p50

operator_eta

hour
weekday
...
```

Persist for reproducibility.

---

# 71. Training data export

Export point-in-time feature sets to:

```text
Parquet
```

Partition by:

```text
date
route
```

Use DuckDB/Polars for analysis.

---

# 72. Observability

Use:

```text
Prometheus
Grafana
```

Metrics:

```text
source_fetch_total

source_fetch_error

source_fetch_latency

observations_ingested

prediction_latency

prediction_count

database_write_latency

provider_schema_errors

source_data_age

active_train_count
```

ML metrics:

```text
rolling operator MAE

rolling our MAE

model improvement %

confidence calibration
```

Grafana should literally show whether we are beating Trenord.

---

# 73. Success criterion

The project becomes truly interesting when the dashboard shows:

```text
Past 30 days

Trenord ETA MAE       94 sec
Our ETA MAE           61 sec

Improvement           35%
```

And especially:

```text
P95

Trenord               6m12s
ours                  3m48s
```

That is the real milestone.

---

# 74. RAPSODIA readiness

Implement a placeholder provider now.

Example:

```text
providers/rapsodia
```

Interfaces:

```text
VehiclePosition

TripUpdate

Alert
```

When the feed becomes available:

```text
plug URL
decode protobuf
map IDs
start ingestion
```

No architectural rewrite should be required.

---

# 75. Future European rail feeds

The EU Telematics Applications TSI entered into force in 2026.

The richer passenger train running/forecast-information implementation timeline extends toward 2028.

The architecture must expect future standardized information such as:

```text
train running information

train running forecast

reporting points

delay causes

interruptions
```

Do not hard-code the product around today's unofficial sources.

Today's providers should simply be adapters.

---

# 76. Long-term source abstraction

Canonical source hierarchy:

```text
ProviderAdapter
    │
    ├── ScheduleProvider
    ├── TrainRealtimeProvider
    ├── VehicleRealtimeProvider
    ├── AlertProvider
    └── JourneyPlannerProvider
```

Possible providers:

```text
TrenordMiaProvider

ViaggiaTrenoProvider

TrenordGtfsRealtimeProvider

AtmGiroMilanoProvider

RapsodiaProvider

FutureRfiTelematicsProvider
```

---

# 77. Source trust model

Different sources may disagree.

Assign contextual reliability.

Example:

```text
actual passed-stop timestamp

MIA        high
VT         high

future ETA

MIA        medium/high
GTFS-RT    high
ours       model confidence

position

freshest infrastructure
observation usually wins
```

Do not assign one fixed global ranking.

Reliability depends on field type.

---

# 78. Source conflict storage

When MIA says:

```text
+4
```

and ViaggiaTreno says:

```text
+7
```

do not overwrite one.

Store both.

Create:

```text
source_conflict
```

Feature:

```text
delay_source_spread = 180 sec
```

This disagreement itself may predict instability.

---

# 79. Offline reprocessing

Raw snapshots + versioned parsers should allow:

```text
re-run parser v3

rebuild normalized data

retrain model
```

without re-fetching upstream APIs.

This is mandatory for a serious historical system.

---

# 80. Time handling

Use:

```text
UTC internally
```

with:

```text
Europe/Rome
```

for display and service-day logic.

Italian public transport has service times after midnight.

GTFS may contain:

```text
24:05:00
25:12:00
```

Do not convert these naively to `LocalTime`.

Represent:

```text
service_date
+
seconds_since_service_midnight
```

or equivalent.

This avoids day-boundary bugs.

---

# 81. Station identity

Different providers use different station codes.

Create canonical stop mapping.

```text
canonical_stop

id

name

lat
lon

gtfs_stop_ids[]

viaggiatreno_codes[]

trenord_station_ids[]

atm_stop_ids[]
```

Never match only by exact station name.

Use:

- IDs where possible
- coordinates
- normalized names
- operator mappings

Keep manual overrides.

---

# 82. Railway reporting points

Create a separate entity from passenger stops.

```text
rail_location

id

name

type

lat/lon if discoverable

line/segment mapping
```

Types:

```text
PASSENGER_STATION

JUNCTION

BIVIO

CONTROL_POINT

UNKNOWN_REPORTING_POINT
```

This improves train localization.

---

# 83. Map matching railway observations

If reporting-point coordinates can be obtained:

Map onto railway graph.

Then infer:

```text
last confirmed point

next plausible point

segment occupied probabilistically
```

Potential map UI:

```text
confirmed point

uncertain current segment

next stop
```

---

# 84. Historical reliability pages

Once sufficient history exists:

```text
Train RE25317 reliability
```

Show:

```text
30-day on-time %

median delay

P90 delay

cancellation rate

most problematic segment

typical recovery segment
```

Also:

```text
route reliability by hour
```

This becomes useful independently of live travel.

---

# 85. Personal journey monitoring

Eventually users can follow:

```text
train
connection
journey
```

The app continually recalculates:

```text
ETA

connection probability

recommended action
```

Instead of merely sending operator changes.

Example:

```text
Trenord has not changed your ETA.

However, trains immediately ahead have
lost ~4 minutes.

Our expected arrival moved from
18:43 to 18:47.

Connection success fell:
82% → 46%.
```

That is one of the strongest possible differentiators.

---

# 86. What not to promise

Never promise:

```text
exact realtime train GPS
```

unless a source provides it.

Never claim:

```text
we know dispatch decisions
```

unless supported.

Never label inferred values as operator-confirmed.

Use visual labels:

```text
Confirmed

Operator estimate

Predicted

Inferred
```

---

# 87. Long-term vision

The eventual system should look like:

```text
                  ITALIAN TRANSIT DATA GRAPH

                            │
          ┌─────────────────┼─────────────────┐
          │                 │                 │
       schedules         realtime          alerts
          │                 │                 │
          └────────────┬────┴────┬────────────┘
                       │         │
                       ▼         ▼
               live state    history
                       │         │
                       └────┬────┘
                            ▼
                   prediction engine
                            │
         ┌──────────────────┼──────────────────┐
         ▼                  ▼                  ▼
      realtime ETA      connection risk   disruption forecast
         │                  │                  │
         └──────────────────┼──────────────────┘
                            ▼
                        user app
```

When richer Italian/EU infrastructure feeds appear:

```text
new provider
     ↓
same data graph
     ↓
better predictions
```

The application should therefore become more accurate over time without needing a redesign.

---

# 88. Build order

Recommended exact order:

## Step 1

Create monorepo.

## Step 2

Implement canonical GTFS parser.

## Step 3

Implement Trenord MIA provider.

## Step 4

Implement ViaggiaTreno provider.

## Step 5

Build train-run identity mapper.

## Step 6

Build raw snapshot storage.

## Step 7

Build normalized observation DB.

## Step 8

Run collector continuously.

Do this as early as possible because history is valuable.

## Step 9

Build current train state service.

## Step 10

Build simple train page/API.

## Step 11

Build historical segment statistics.

## Step 12

Implement heuristic ETA predictor.

## Step 13

Record every prediction.

## Step 14

Build evaluation pipeline.

## Step 15

Measure operator ETA baseline.

## Step 16

Train LightGBM/CatBoost residual model.

## Step 17

Deploy shadow prediction.

Do NOT show it publicly until benchmarked.

## Step 18

If consistently better, expose it.

## Step 19

Implement connection probability.

## Step 20

Add ATM GiroMilano ingestion.

## Step 21

Build latent bus reconstruction.

## Step 22

Integrate RAPSODIA when available.

---

# 89. Immediate proof-of-concept

Before committing to the entire product, implement:

```text
10–20 Trenord trains
```

over several routes.

Poll:

```text
MIA

ViaggiaTreno

GTFS-RT if access is available
```

every:

```text
20–30 sec
```

Store everything.

Run for:

```text
1–2 weeks
```

Then answer:

```text
How often does each source update?

Which source is freshest?

How often do they disagree?

How good is operator ETA?

How predictive is the latest reporting point?

How much delay is recovered per segment?

Can a simple historical model beat Trenord?
```

If yes:

Scale.

This experiment is more valuable than building a polished frontend first.

---

# 90. First research notebook

Generate analyses:

```text
source freshness histogram

MIA vs VT delay difference

delay change by segment

segment runtime distribution

operator prediction error by horizon

prediction error by route

prediction error by hour

prediction error after disruptions

prediction error vs observation age
```

Find where Trenord is systematically wrong.

That becomes the model opportunity.

---

# 91. Core hypothesis

The product is based on this hypothesis:

> Operator passenger ETAs are not fully optimized for each passenger's exact downstream arrival prediction and can be improved by combining operator prediction with historical segment behaviour and network-wide contemporary state.

This must be tested empirically.

If it is false and Trenord consistently outperforms us:

Still build features around:

- confidence
- connection probability
- reliability
- explanations
- history

But do not falsely claim better ETA.

---

# 92. Main technical risks

## Risk 1

Undocumented APIs disappear.

Mitigation:

multiple sources + adapters + raw data history.

## Risk 2

Train-run matching errors.

Mitigation:

strict canonical identity and confidence.

## Risk 3

Operator ETA already extremely strong.

Mitigation:

predict higher-level outcomes such as connections/risk.

## Risk 4

Insufficient historical volume.

Mitigation:

start collection immediately.

## Risk 5

ATM vehicle identity impossible from WaitMessages.

Mitigation:

wait for raw GTFS-RT / RAPSODIA.

## Risk 6

GTFS changes break schedule mapping.

Mitigation:

version schedules by feed publication.

---

# 93. Main opportunity

The strongest opportunity is not merely:

```text
show train position
```

It is:

```text
predict downstream consequences
```

Examples:

```text
Will my train recover?

Will I make my connection?

Should I take the later departure instead?

Is this line becoming congested?

Is my train likely to be affected before the operator marks it?

Is the current +3 likely to become +10?
```

That is the real Flighty analogy.

---

# 94. Product identity

Potential positioning:

> Realtime predictive intelligence for Italian trains.

or:

> Know what's going to happen to your train before the timetable does.

Avoid positioning as a generic ticketing/timetable replacement at first.

---

# 95. Definition of a successful v1

A successful v1 should be able to say something like:

```text
RE 25317

Operator currently says:
+7 min

Our model:
+5m20s at Milano

Reason:
- recent trains are recovering ~80 sec
  on the next two segments
- this train recovered 31 sec on
  its previous segment
- no downstream disruption detected

Confidence:
81%
```

And after arrival:

```text
Actual delay:
+5m41s

Operator prediction error:
1m19s

Our prediction error:
21s
```

Persist that result.

Repeat thousands of times.

That loop is the core of the entire product.

---

# 96. Core principle for the coding agent

Do not optimize for flashy UI or sophisticated AI first.

Optimize for:

```text
DATA CORRECTNESS

SOURCE RESILIENCE

HISTORICAL COLLECTION

POINT-IN-TIME REPRODUCIBILITY

MEASURABLE PREDICTION ACCURACY
```

Everything else comes later.

The project's moat should eventually be:

```text
years of Italian transit observations
+
network reconstruction
+
prediction models
```

not merely access to an undocumented API that anybody else can discover.

---

# 97. Final system principle

Every displayed piece of realtime information should answer four internal questions:

```text
Where did this value come from?

When was it observed?

Is it confirmed or inferred?

How confident are we?
```

Never lose that metadata during normalization.

The end product should feel extremely simple to the user while internally preserving all of that uncertainty and provenance.

That is how to build something substantially better than another Trenord/GiroMilano frontend.