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
                    }, onOpenTrain: { runId in
                        tab = .home
                        homePath.append(runId)
                    })
                    .navigationDestination(for: Int.self) { id in
                        TrainDetailView(runId: id)
                    }
                    .navigationDestination(for: Trip.self) { trip in
                        TripDetailView(trip: trip)
                    }
                }
            }
            Tab("Stations", systemImage: "tram.fill", value: .stations) {
                NavigationStack(path: $boardPath) {
                    StationBoardView()
                        .navigationDestination(for: Int.self) { id in
                            TrainDetailView(runId: id)
                        }
                }
            }
            Tab("Journeys", systemImage: "bookmark.fill", value: .trips) {
                NavigationStack(path: $tripsPath) {
                    TripsView()
                        .navigationDestination(for: Trip.self) { trip in
                            TripDetailView(trip: trip)
                        }
                        .navigationDestination(for: Int.self) { id in
                            TrainDetailView(runId: id)
                        }
                }
            }

        }
        .tint(.tPrimary)
        .onAppear {
            let args = ProcessInfo.processInfo.arguments
            // debug deep links:
            //   xcrun simctl launch <dev> com.treno.Treno --train <runId>
            //   xcrun simctl launch <dev> com.treno.Treno --track <fromId>,<toId>
            //   xcrun simctl launch <dev> com.treno.Treno --open-trip
            //   xcrun simctl launch <dev> com.treno.Treno --picker | --map | --scroll
            if let i = args.firstIndex(of: "--train"), i + 1 < args.count, let id = Int(args[i + 1]) {
                tab = .home
                homePath.append(id)
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
