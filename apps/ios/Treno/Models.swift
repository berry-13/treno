import Foundation

// MARK: - API models (matching packages/api responses)

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
    let originStop: String?
    let destinationStop: String?
    let state: TrainState?
    let stops: [DetailStop]?
    let recentObservations: [ObservationRow]?
    let latestPrediction: LatestPrediction?
    let connections: [ConnectionOption]?

    enum CodingKeys: String, CodingKey {
        case id, trainNumber, serviceDate, state, stops, recentObservations, latestPrediction, connections
        case originStop = "origin"
        case destinationStop = "destination"
    }
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
        case cancelled
    }
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

struct ProviderHealth: Codable, Hashable {
    let source: String
    let okCount: Int
    let errCount: Int
    let lastLatencyMs: Int?
    let healthState: String

    enum CodingKeys: String, CodingKey {
        case source
        case okCount = "ok_count"
        case errCount = "err_count"
        case lastLatencyMs = "last_latency_ms"
        case healthState = "state"
    }
}

struct HealthResponse: Codable {
    let ok: Bool
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
}
