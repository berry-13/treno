import Foundation
import SwiftUI

// Widget-side support: self-contained (the extension compiles only Theme.swift
// from the app target, plus the shared activity attributes).

enum WFmt {
    static let rome = TimeZone(identifier: "Europe/Rome")!

    static func hhmm(_ epochMs: Double?) -> String {
        guard let ms = epochMs else { return "—" }
        let f = DateFormatter()
        f.timeZone = rome
        f.locale = Locale(identifier: "en_GB")
        f.dateFormat = "HH:mm"
        return f.string(from: Date(timeIntervalSince1970: ms / 1000))
    }

    static func delayShort(_ sec: Int?) -> String {
        guard let s = sec else { return "" }
        if s == 0 { return "on time" }
        let m = Int((Double(s) / 60.0).rounded())
        return m > 0 ? "+\(m)m" : "−\(-m)m"
    }
}

enum WColor {
    static let bg = Color(red: 0.035, green: 0.035, blue: 0.043)
    static let card = Color(red: 0.055, green: 0.055, blue: 0.063)
    static let fg = Color(red: 0.98, green: 0.98, blue: 0.98)
    static let muted = Color(red: 0.63, green: 0.63, blue: 0.67)
    static let dim = Color(red: 0.45, green: 0.45, blue: 0.49)
    static let primary = Color.blue
    static let late = Color(red: 0.95, green: 0.65, blue: 0.15)
    static let veryLate = Color(red: 0.91, green: 0.30, blue: 0.30)

    static func delayColor(_ sec: Int?) -> Color {
        guard let s = sec else { return muted }
        if s >= 300 { return veryLate }
        if s >= 60 { return late }
        return muted
    }
}

struct WJourney: Codable {
    let trainNumber: String
    let line: String?
    let depEpoch: Double
    let arrEpoch: Double
    let destinationName: String?
    let actualDepEpoch: Double?
    let depDelaySec: Int?
    let platform: String?
    let state: WState?
    struct WState: Codable {
        let status: String?
        let operatorDelaySec: Int?
        let ourEstimate: WOurs?
        let destination: WPlace?
        struct WPlace: Codable { let name: String? }
        struct WOurs: Codable { let p10: Double?; let p50: Double?; let p90: Double? }
    }
}

struct WJourneysResponse: Codable { let journeys: [WJourney] }

struct WTripConfig: Codable {
    let fromId: String
    let fromName: String
    let toId: String
    let toName: String
}

enum WFetch {
    static func baseUrl() -> String {
        (UserDefaults(suiteName: "group.com.berry13.treno")?.string(forKey: "apiBaseUrl")) ?? "http://192.168.1.242:8787"
    }

    static func tripConfig() -> WTripConfig? {
        guard let suite = UserDefaults(suiteName: "group.com.berry13.treno"),
              let d = suite.dictionary(forKey: "widgetTrip"),
              let fromId = d["fromId"] as? String,
              let fromName = d["fromName"] as? String,
              let toId = d["toId"] as? String,
              let toName = d["toName"] as? String else { return nil }
        return WTripConfig(fromId: fromId, fromName: fromName, toId: toId, toName: toName)
    }

    static func nextJourney(_ cfg: WTripConfig) async -> WJourney? {
        guard let url = URL(string: baseUrl() + "/api/journeys?from=\(cfg.fromId)&to=\(cfg.toId)&limit=6") else { return nil }
        guard let (data, _) = try? await URLSession.shared.data(from: url),
              let r = try? JSONDecoder().decode(WJourneysResponse.self, from: data) else { return nil }
        let nowMs = Date.now.timeIntervalSince1970 * 1000
        return r.journeys.first {
            $0.state?.status != "cancelled" && $0.state?.status != "arrived"
                && $0.actualDepEpoch == nil
                && $0.depEpoch + Double($0.depDelaySec ?? $0.state?.operatorDelaySec ?? 0) * 1000 >= nowMs - 30_000
        }

    }
}
