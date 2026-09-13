import ActivityKit
import Foundation

/// Shared between the app (starts/updates) and the widget extension (renders).
/// This file must stay dependency-free: it compiles in both targets.
struct TripActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        var trainNumber: String
        var line: String?
        var status: String
        var delaySec: Int?
        var ourArrEpoch: Double?
        var schedArrEpoch: Double?
        var depEpoch: Double
        var arrEpoch: Double
        var platform: String?
    }

    var tripName: String
    var originName: String
    var destinationName: String
}
