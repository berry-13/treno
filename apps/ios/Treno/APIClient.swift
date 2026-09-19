import Foundation

/// Thin async client for the treno API (packages/api). The base URL points at
/// the local collector by default; devices on the same LAN can override it in
/// Settings (e.g. http://192.168.1.20:8787).
@MainActor
final class APIClient {
    static let shared = APIClient()

    private let session: URLSession
    private let defaultsKey = "apiBaseUrl"

    init() {
        let cfg = URLSessionConfiguration.ephemeral
        cfg.timeoutIntervalForRequest = 10
        cfg.waitsForConnectivity = false
        session = URLSession(configuration: cfg)
    }

    var baseUrl: String {
        get {
            UserDefaults.standard.string(forKey: defaultsKey) ?? "http://192.168.1.242:8787"
        }
        set {
            var trimmed = newValue.trimmingCharacters(in: .whitespacesAndNewlines)
            while trimmed.hasSuffix("/") { trimmed.removeLast() }
            UserDefaults.standard.set(trimmed, forKey: defaultsKey)
        }
    }

    enum APIError: LocalizedError {
        case badStatus(Int)
        var errorDescription: String? {
            switch self {
            case .badStatus(let code): return "server returned HTTP \(code)"
            }
        }
    }

    private func get<T: Decodable>(_ path: String) async throws -> T {
        guard let url = URL(string: baseUrl + path) else {
            throw URLError(.badURL)
        }
        let (data, response) = try await session.data(from: url)
        if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            throw APIError.badStatus(http.statusCode)
        }
        return try JSONDecoder().decode(T.self, from: data)
    }

    func trains(query: String = "", limit: Int = 40) async throws -> [TrainSummary] {
        let enc = "q=\(query.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? "")&limit=\(limit)"
        return try await get("/api/trains?\(enc)")
    }

    func train(id: Int) async throws -> TrainDetail {
        try await get("/api/trains/\(id)")
    }

    func stations(query: String) async throws -> [Station] {
        let enc = "q=" + (query.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? "")
        return try await get("/api/stops/search?\(enc)")
    }

    func stationBoard(stopId: String) async throws -> BoardResponse {
        try await get("/api/stops/\(stopId)/departures")
    }

    func atmBoard(stopId: String) async throws -> AtmBoardResponse {
        try await get("/api/atm/stops/\(stopId)/board")
    }

    func allStations() async throws -> [StationLite] {
        try await get("/api/stations")
    }

    func journeys(from: String, to: String, at: Date? = nil, limit: Int = 8) async throws -> [JourneyRow] {
        var path = "/api/journeys?from=\(from)&to=\(to)&limit=\(limit)"
        if let at {
            path += "&at=" + String(Int(at.timeIntervalSince1970 * 1000))
        }
        let r: JourneysResponse = try await get(path)
        return r.journeys
    }

    func health() async throws -> HealthResponse {
        try await get("/api/health")
    }

    func corridors() async throws -> [CorridorRow] {
        struct R: Decodable { let corridors: [CorridorRow] }
        let r: R = try await get("/api/corridors?limit=3")
        return r.corridors
    }

    func reliability(trainNumber: String) async throws -> TrainReliability? {
        try await get("/api/reliability/train/\(trainNumber.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? trainNumber)")
    }
}
