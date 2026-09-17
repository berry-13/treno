import SwiftUI

@main
struct TrenoApp: App {
    @AppStorage("appearance") private var appearance = "system"

    var body: some Scene {
        WindowGroup {
            RootView()
            #if os(iOS)
                .preferredColorScheme(appearance == "light" ? .light : appearance == "dark" ? .dark : nil)
            #endif
        }
    }
}

enum TrenoTab: Int, Hashable {
    case home = 0
    case stations = 1
    case trips = 2
}

struct RootView: View {
    @State private var tab: TrenoTab = .home
    @State private var homePath = NavigationPath()
    @State private var boardPath = NavigationPath()
    @State private var tripsPath = NavigationPath()

    var body: some View {
        TabView(selection: $tab) {
            Tab("Home", systemImage: "house.fill", value: .home) {
                NavigationStack(path: $homePath) {
                    HomeView(openStation: { stationId, name in
                        UserDefaults.standard.set(stationId, forKey: "stationId")
                        UserDefaults.standard.set(name, forKey: "stationName")
                        boardPath = NavigationPath()
                        tab = .stations
                    }, onOpenTrain: { ref in
                        tab = .home
                        homePath.append(ref)
                    })
                    .navigationDestination(for: TrainRef.self) { ref in
                        TrainDetailView(ref: ref)
                    }
                    .navigationDestination(for: Trip.self) { trip in
                        TripDetailView(trip: trip)
                    }
                }
            }
            Tab("Stations", systemImage: "tram.fill", value: .stations) {
                NavigationStack(path: $boardPath) {
                    StationBoardView()
                        .navigationDestination(for: TrainRef.self) { ref in
                            TrainDetailView(ref: ref)
                        }
                }
            }
            Tab("Journeys", systemImage: "bookmark.fill", value: .trips) {
                NavigationStack(path: $tripsPath) {
                    TripsView()
                        .navigationDestination(for: Trip.self) { trip in
                            TripDetailView(trip: trip)
                        }
                        .navigationDestination(for: TrainRef.self) { ref in
                            TrainDetailView(ref: ref)
                        }
                }
            }

        }
        .tint(.tPrimary)
        .onAppear {
            let args = ProcessInfo.processInfo.arguments
            // debug deep links:
            //   xcrun simctl launch <dev> com.treno.Treno --train <runId>
            //   xcrun simctl launch <dev> com.treno.Treno --tab home|stations|trips
            //   xcrun simctl launch <dev> com.treno.Treno --trip-detail (first saved trip)
            //   xcrun simctl launch <dev> com.treno.Treno --track <fromId>,<toId>
            //   xcrun simctl launch <dev> com.treno.Treno --picker | --map | --find
            if let i = args.firstIndex(of: "--train"), i + 1 < args.count, let id = Int(args[i + 1]) {
                var fromId: String?
                var toId: String?
                if let j = args.firstIndex(of: "--segment"), j + 1 < args.count {
                    let parts = args[j + 1].split(separator: ",").map(String.init)
                    if parts.count == 2 { fromId = parts[0]; toId = parts[1] }
                }
                tab = .home
                homePath.append(TrainRef(runId: id, fromStopId: fromId, toStopId: toId))
            }
            if let i = args.firstIndex(of: "--tab"), i + 1 < args.count {
                switch args[i + 1] {
                case "stations": tab = .stations
                case "trips": tab = .trips
                default: tab = .home
                }
            }
            if args.contains("--trip-detail"), let first = TripStore.shared.trips.first {
                tab = .trips
                tripsPath.append(first)
            }
            if args.contains("--picker") || args.contains("--map") {
                tab = .stations
            }
            if args.contains("--open-trip") {
                tab = .trips
            }
            if let i = args.firstIndex(of: "--track"), i + 1 < args.count {
                let parts = args[i + 1].split(separator: ",").map(String.init)
                if parts.count == 2 {
                    Task {
                        _ = try? await StationCatalog.shared.stations()
                        await LiveTracker.debugStart(fromId: parts[0], toId: parts[1])
                    }
                }
            }
        }
    }
}
