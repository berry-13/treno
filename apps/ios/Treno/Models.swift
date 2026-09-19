import Foundation

// MARK: - API models (matching packages/api responses)

/// Navigation value for a train run, optionally scoped to the rider's own
/// segment — the detail page then clocks where THEY board and get off instead
/// of the train's first and last city.
struct TrainRef: Hashable {
    let runId: Int
    var fromStopId: String?
    var toStopId: String?

    init(runId: Int, fromStopId: String? = nil, toStopId: String? = nil) {
        self.runId = runId
        self.fromStopId = fromStopId
        self.toStopId = toStopId
    }
}

struct TrainSummary: Codable, Identifiable, Hashable {
    let id: Int
    let trainNumber: String
    let serviceDate: String
    let operatorName: String?
    let originStop: String?
    let destinationStop: String?
    let schedDepEpoch: Double?
    let schedArrEpoch: Double?
    let updatedAt: Double?
    let state: TrainState?

    enum CodingKeys: String, CodingKey {
        case id, trainNumber, serviceDate, state
        case operatorName = "operator"
        case originStop = "origin"
        case destinationStop = "destination"
        case schedDepEpoch, schedArrEpoch, updatedAt
    }
}

struct TrainState: Codable, Hashable {
    var runId: Int?
    var runCode: String?
    var trainNumber: String?
    var serviceDate: String?
    var origin: Place?
    var destination: Place?
    var schedDepEpoch: Double?
    var schedArrEpoch: Double?
    var status: String?
    var operatorDelaySec: Int?
    var latestLocation: LatestLocation?
    var latestObservedAt: Double?
    var latestSource: String?
    var sources: [String: SourceObs]?
    var sourceDelaySpreadSec: Int?
    var previousStop: StopRef?
    var nextStop: StopRef?
    var destinationOperatorEta: Double?
    var confidence: String?
    var ourEstimate: OurEstimate?
    var quality: [String]?
}

// An unavailable optional prediction must not hide the station timetable.
extension TrainState {
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        runId = try values.decodeIfPresent(Int.self, forKey: .runId)
        runCode = try values.decodeIfPresent(String.self, forKey: .runCode)
        trainNumber = try values.decodeIfPresent(String.self, forKey: .trainNumber)
        serviceDate = try values.decodeIfPresent(String.self, forKey: .serviceDate)
        origin = try values.decodeIfPresent(Place.self, forKey: .origin)
        destination = try values.decodeIfPresent(Place.self, forKey: .destination)
        schedDepEpoch = try values.decodeIfPresent(Double.self, forKey: .schedDepEpoch)
        schedArrEpoch = try values.decodeIfPresent(Double.self, forKey: .schedArrEpoch)
        status = try values.decodeIfPresent(String.self, forKey: .status)
        operatorDelaySec = try values.decodeIfPresent(Int.self, forKey: .operatorDelaySec)
        latestLocation = try values.decodeIfPresent(LatestLocation.self, forKey: .latestLocation)
        latestObservedAt = try values.decodeIfPresent(Double.self, forKey: .latestObservedAt)
        latestSource = try values.decodeIfPresent(String.self, forKey: .latestSource)
        sources = try values.decodeIfPresent([String: SourceObs].self, forKey: .sources)
        sourceDelaySpreadSec = try values.decodeIfPresent(Int.self, forKey: .sourceDelaySpreadSec)
        previousStop = try values.decodeIfPresent(StopRef.self, forKey: .previousStop)
        nextStop = try values.decodeIfPresent(StopRef.self, forKey: .nextStop)
        destinationOperatorEta = try values.decodeIfPresent(Double.self, forKey: .destinationOperatorEta)
        confidence = try values.decodeIfPresent(String.self, forKey: .confidence)
        ourEstimate = try? values.decodeIfPresent(OurEstimate.self, forKey: .ourEstimate)
        quality = try values.decodeIfPresent([String].self, forKey: .quality)
    }
}

struct OurEstimate: Codable, Hashable {
    var p10: Double
    var p50: Double
    var p90: Double
    var modelVersion: String?
    var confidence: Double?
    var recoverySec: Int?
    var operatorWeight: Double?
    var statsCoverage: Double?
    var corridorAdjustSec: Int?
}

struct Place: Codable, Hashable {
    var stopId: String?
    var name: String?
}

struct LatestLocation: Codable, Hashable {
    var id: String?
    var name: String?
    var kind: String?
}

struct SourceObs: Codable, Hashable {
    var observedAt: Double?
    var fetchedAt: Double?
    var delaySec: Int?
    var ageSec: Int?
    var status: String?
}

struct StopRef: Codable, Hashable {
    var stopId: String?
    var name: String?
    var schedArrEpoch: Double?
    var opPredArrEpoch: Double?
    var actualArrEpoch: Double?
}

struct TrainDetail: Codable {
    let id: Int
    let trainNumber: String
    let serviceDate: String
    let operatorName: String?
    let originStop: String?
    let destinationStop: String?
    var state: TrainState?
    let stops: [DetailStop]?
    let recentObservations: [ObservationRow]?
    let latestPrediction: LatestPrediction?
    let connections: [ConnectionOption]?
    let crowding: Crowding?
    let riskNotice: RiskNotice?

    enum CodingKeys: String, CodingKey {
        case id, trainNumber, serviceDate, state, stops, recentObservations, latestPrediction, connections, crowding, riskNotice
        case operatorName = "operator"
        case originStop = "origin"
        case destinationStop = "destination"
    }
}

/// MIA-reported load level (0–100 + operator label); absent when unavailable.
struct Crowding: Codable, Hashable {
    let crowdingPct: Int?
    let crowdingLabel: String?

    enum CodingKeys: String, CodingKey {
        case crowdingPct = "crowding_pct"
        case crowdingLabel = "crowding_label"
    }
}

/// §51 pre-emptive warning: preceding trains on the rider's route are already
/// losing time — shown before the operator flags this train.
struct RiskNotice: Codable, Hashable {
    let headline: String
    let detail: String?
    let expectedDelaySec: Int?
    let evidenceTrains: Int?
    let segmentName: String?
}

/// §62 corridor health: a segment currently running slower than normal.
struct CorridorRow: Codable, Hashable, Identifiable {
    let segmentId: String
    let fromName: String?
    let toName: String?
    let traversals: Int?
    let medianDelayDeltaSec: Int?
    let worstDelayDeltaSec: Int?

    var id: String { segmentId }
    var title: String { (fromName ?? "?") + " → " + (toName ?? "?") }
}

/// §84 reliability: 30-day behaviour of one train number.
struct TrainReliability: Codable, Hashable {
    struct SegHotspot: Codable, Hashable {
        let fromName: String?
        let toName: String?
        let medianDelayDeltaSec: Int?
        let n: Int?
    }
    let trainNumber: String
    let days: Int?
    let completedRuns: Int
    let onTimePct: Double?
    let late5Pct: Double?
    let late10Pct: Double?
    let cancelledPct: Double?
    let medianDelaySec: Int?
    let p90DelaySec: Int?
    let worstSegment: SegHotspot?
    let recoverySegment: SegHotspot?
}

struct LatestPrediction: Codable, Hashable {
    let modelVersion: String
    let generatedAt: Double?
    let operatorEtaEpoch: Double?
    let ourP10: Double?
    let ourP50: Double?
    let ourP90: Double?
    let confidence: Double?

    enum CodingKeys: String, CodingKey {
        case confidence
        case modelVersion = "model_version"
        case generatedAt = "generated_at"
        case operatorEtaEpoch = "operator_eta_epoch"
        case ourP10 = "our_p10"
        case ourP50 = "our_p50"
        case ourP90 = "our_p90"
    }
}

struct ConnectionOption: Codable, Hashable, Identifiable {
    let trainNumber: String
    let line: String?
    let destinationName: String?
    let depEpoch: Double
    let transferSec: Int
    let probability: Double
    let operatorDelaySec: Int?

    var id: String { trainNumber + "@" + String(depEpoch) }
}

/// Raw DB rows come through snake_cased.
struct DetailStop: Codable, Hashable, Identifiable {
    let stopId: String
    let stopName: String?
    let stopSequence: Int?
    let schedArrEpoch: Double?
    let schedDepEpoch: Double?
    let opPredArrEpoch: Double?
    let opPredDepEpoch: Double?
    let actualArrEpoch: Double?
    let actualDepEpoch: Double?
    let arrDelaySec: Int?
    let depDelaySec: Int?
    let platformActual: String?
    let platformPredicted: [PlatformPred]?
    let cancelled: Int?

    var id: String { stopId + "#" + String(stopSequence ?? 0) }
    var displayName: String { stopName ?? stopId }

    enum CodingKeys: String, CodingKey {
        case stopId = "stop_id"
        case stopName = "stop_name"
        case stopSequence = "stop_sequence"
        case schedArrEpoch = "sched_arr_epoch"
        case schedDepEpoch = "sched_dep_epoch"
        case opPredArrEpoch = "op_pred_arr_epoch"
        case opPredDepEpoch = "op_pred_dep_epoch"
        case actualArrEpoch = "actual_arr_epoch"
        case actualDepEpoch = "actual_dep_epoch"
        case arrDelaySec = "arr_delay_sec"
        case depDelaySec = "dep_delay_sec"
        case platformActual = "platform_actual"
        case platformPredicted = "platform_predicted"
        case cancelled
    }
}

/// §52: likely platform with probability — never shown as confirmed.
struct PlatformPred: Codable, Hashable {
    let n: String
    let p: Double
}

struct ObservationRow: Codable, Hashable {
    let ts: Double
    let source: String
    let observedAt: Double?
    let delaySeconds: Int?
    let locationName: String?
    let locationKind: String?
    let status: String?

    enum CodingKeys: String, CodingKey {
        case ts, source, status
        case observedAt = "observed_at"
        case delaySeconds = "delay_seconds"
        case locationName = "location_name"
        case locationKind = "location_kind"
    }
}

struct ProviderHealth: Codable, Hashable, Identifiable {
    let source: String
    let okCount: Int
    let errCount: Int
    let lastLatencyMs: Int?
    let healthState: String
    let changedLastHour: Int?

    var id: String { source }

    enum CodingKeys: String, CodingKey {
        case source, changedLastHour
        case okCount = "ok_count"
        case errCount = "err_count"
        case lastLatencyMs = "last_latency_ms"
        case healthState = "state"
    }
}

struct HealthCounts: Codable, Hashable {
    var runs: Int?
    var observations: Int?
    var stopEvents: Int?
    var snapshots: Int?
    var predictions: Int?
    var scoredOutcomes: Int?
    var segmentObservations: Int?
    var segmentsWithStats: Int?
    var alerts: Int?
}

struct HealthResponse: Codable {
    let ok: Bool
    let counts: HealthCounts?
    let providers: [ProviderHealth]?
}

// MARK: - formatting helpers

enum Fmt {
    static let rome = TimeZone(identifier: "Europe/Rome")!

    static func hhmm(_ epochMs: Double?) -> String {
        guard let ms = epochMs else { return "—" }
        let f = DateFormatter()
        f.timeZone = rome
        f.locale = Locale(identifier: "en_GB")
        f.dateFormat = "HH:mm"
        return f.string(from: Date(timeIntervalSince1970: ms / 1000))
    }

    static func hhmmss(_ epochMs: Double?) -> String {
        guard let ms = epochMs else { return "—" }
        let f = DateFormatter()
        f.timeZone = rome
        f.locale = Locale(identifier: "en_GB")
        f.dateFormat = "HH:mm:ss"
        return f.string(from: Date(timeIntervalSince1970: ms / 1000))
    }

    static func delay(_ sec: Int?) -> String {
        guard let s = sec else { return "—" }
        if s == 0 { return "on time" }
        let m = Int((Double(s) / 60.0).rounded())
        return m > 0 ? "+\(m)m" : "−\(-m)m"
    }

    static func age(_ sec: Int?) -> String {
        guard let s = sec, s >= 0 else { return "—" }
        if s < 60 { return "\(s)s ago" }
        if s < 3600 { return "\(Int((Double(s) / 60).rounded()))m ago" }
        return "\(Int((Double(s) / 3600).rounded()))h ago"
    }

    /// "in 38m" / "in 1h 05m" — rounded up; nil when already past or too far
    static func countdown(_ toMs: Double?, now: Date) -> String? {
        guard let ms = toMs else { return nil }
        let sec = Int((ms / 1000 - now.timeIntervalSince1970).rounded(.up))
        guard sec > 0, sec < 18 * 3600 else { return nil }
        if sec < 3600 { return "in \((sec + 59) / 60)m" }
        let h = sec / 3600, m = (sec % 3600) / 60
        return m == 0 ? "in \(h)h" : String(format: "in %dh %02dm", h, m)
    }
}
