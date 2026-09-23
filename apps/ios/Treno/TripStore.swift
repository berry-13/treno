import CoreLocation
import Foundation
import SwiftUI

// MARK: - shared API models

struct StationLite: Codable, Hashable, Identifiable {
    let stopId: String
    let name: String
    let lat: Double?
    let lon: Double?
    let depCount: Int
    var id: String { stopId }
}

struct JourneyRow: Codable, Identifiable, Hashable {
    let runId: Int?
    let trainNumber: String
    let line: String?
    let originName: String?
    let destinationName: String?
    let finalDestinationName: String?
    let depEpoch: Double
    let arrEpoch: Double
    let depDelaySec: Int?
    let actualDepEpoch: Double?
    let platform: String?
    let state: TrainState?
    // §19/§62 smart alternatives (server-ranked; all optional so older
    // payloads keep decoding): expected real arrival, whether a live or
    // predicted estimate backed it, the §19 risk penalty, and the flag on
    // the best still-catchable option.
    var expectedArrivalEpoch: Double?
    var expectedArrivalLive: Bool?
    var riskPenaltySec: Int?
    var recommended: Bool?
    var id: String { trainNumber + "@" + String(Int(depEpoch)) }
}

struct JourneysResponse: Codable {
    let from: String
    let to: String
    let generatedAt: Double
    let journeys: [JourneyRow]
}

// MARK: - saved trip

struct Trip: Codable, Identifiable, Hashable {
    var id = UUID()
    var fromStopId: String
    var fromName: String
    var toStopId: String
    var toName: String
    var name = ""
    /// ISO weekday numbers the trip applies to (1=Mon … 7=Sun)
    var days: Set<Int> = Set(1...7)

    var defaultName: String { fromName + " → " + toName }
    var displayName: String { name.isEmpty ? defaultName : name }

    var runsToday: Bool {
        // Calendar weekday is 1=Sun…7=Sat; trip days are ISO 1=Mon…7=Sun
        let wd = Calendar.current.component(.weekday, from: Date.now)
        return days.contains(wd == 1 ? 7 : wd - 1)
    }
}

// MARK: - store

/// Saved trips, favorite stations and frequency tracking. Local-first: this is
/// the user's personal data, it lives in UserDefaults (trips also mirrored into
/// the app-group container so the widget can read them).
@MainActor
final class TripStore: ObservableObject {
    static let shared = TripStore()
    static let suiteName = "group.com.berry13.treno"

    @Published var trips: [Trip] = []
    @Published var favorites: Set<String> = []
    @Published var useCounts: [String: Int] = [:]
    @Published var lastUsed: [String: Double] = [:]

    private let d = UserDefaults.standard
    let suite: UserDefaults?

    init() {
        suite = UserDefaults(suiteName: Self.suiteName)
        load()

    }

    private func load() {
        if let data = d.data(forKey: "savedTrips") {
            trips = (try? JSONDecoder().decode([Trip].self, from: data)) ?? []
        }
        favorites = Set(d.stringArray(forKey: "favoriteStations") ?? [])
        useCounts = d.dictionary(forKey: "stationUseCounts") as? [String: Int] ?? [:]
        lastUsed = d.dictionary(forKey: "stationLastUsed") as? [String: Double] ?? [:]
    }

    private func save() {
        d.set((try? JSONEncoder().encode(trips)) ?? Data(), forKey: "savedTrips")
        d.set(Array(favorites), forKey: "favoriteStations")
        d.set(useCounts, forKey: "stationUseCounts")
        d.set(lastUsed, forKey: "stationLastUsed")
        mirrorWidgetConfig()
    }

    /// the widget tracks the first trip
    private func mirrorWidgetConfig() {
        guard let suite else { return }
        if let first = trips.first {
            let cfg = ["fromId": first.fromStopId, "fromName": first.fromName, "toId": first.toStopId, "toName": first.toName]
            suite.set(cfg, forKey: "widgetTrip")
        } else {
            suite.removeObject(forKey: "widgetTrip")
        }
        suite.set(APIClient.shared.baseUrl, forKey: "apiBaseUrl")
    }

    func add(_ trip: Trip) {
        trips.append(trip)
        save()
    }

    func update(_ trip: Trip) {
        guard let i = trips.firstIndex(where: { $0.id == trip.id }) else { return }
        trips[i] = trip
        save()
    }

    func remove(_ trip: Trip) {
        trips.removeAll { $0.id == trip.id }
        save()
    }

    func toggleFavorite(_ stopId: String) {
        if favorites.contains(stopId) { favorites.remove(stopId) } else { favorites.insert(stopId) }
        save()
    }

    /// frequency signal: every station the user actually selects
    func noteUse(_ stopId: String) {
        useCounts[stopId, default: 0] += 1
        lastUsed[stopId] = Date.now.timeIntervalSince1970
        save()
    }

    /// frequent stations: usage count first, recency as tiebreak (min 1 use)
    func frequentStations(limit: Int = 6) -> [String] {
        lastUsed
            .filter { useCounts[$0.key] != nil }
            .sorted { (a, b) in
                let ca = useCounts[a.key] ?? 0, cb = useCounts[b.key] ?? 0
                if ca != cb { return ca > cb }
                return a.value > b.value
            }
            .prefix(limit)
            .map(\.key)
    }
}

// MARK: - station catalog (all stations w/ coords, cached)

@MainActor
final class StationCatalog {
    static let shared = StationCatalog()
    private(set) var cache: [StationLite]?

    func stations() async throws -> [StationLite] {
        if let cache { return cache }
        let list: [StationLite] = try await APIClient.shared.allStations()
        cache = list
        return list
    }

    func name(for stopId: String) -> String? {
        cache?.first { $0.stopId == stopId }?.name
    }

    func nearest(to coord: CLLocationCoordinate2D, maxKm: Double = 3) -> StationLite? {
        guard let cache else { return nil }
        var best: (StationLite, Double)?
        for st in cache {
            guard let lat = st.lat, let lon = st.lon else { continue }
            let d = distanceKm(coord, CLLocationCoordinate2D(latitude: lat, longitude: lon))
            if d <= maxKm, best == nil || d < best!.1 {
                best = (st, d)
            }
        }
        return best?.0
    }

    private func distanceKm(_ a: CLLocationCoordinate2D, _ b: CLLocationCoordinate2D) -> Double {
        let dLat = (b.latitude - a.latitude) * 111.32
        let dLon = (b.longitude - a.longitude) * 111.32 * cos((a.latitude + b.latitude) / 2 * .pi / 180)
        return (dLat * dLat + dLon * dLon).squareRoot()
    }
}

// MARK: - one-shot location

final class LocationFetcher: NSObject, CLLocationManagerDelegate {
    private let manager = CLLocationManager()
    private var completion: ((CLLocation?) -> Void)?

    func requestOnce(_ done: @escaping (CLLocation?) -> Void) {
        completion = done
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyHundredMeters
        switch manager.authorizationStatus {
        case .notDetermined:
            manager.requestWhenInUseAuthorization()
        case .denied, .restricted:
            done(nil)
            return
        default:
            break
        }
        manager.requestLocation()
    }

    func locationManager(_ m: CLLocationManager, didUpdateLocations locs: [CLLocation]) {
        completion?(locs.first)
        completion = nil
    }

    func locationManager(_ m: CLLocationManager, didFailWithError error: Error) {
        completion?(nil)
        completion = nil
    }

    func locationManagerDidChangeAuthorization(_ m: CLLocationManager) {
        if m.authorizationStatus == .authorizedWhenInUse || m.authorizationStatus == .authorizedAlways {
            manager.requestLocation()
        }
    }
}
