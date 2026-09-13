import SwiftUI

@main
struct TrenoApp: App {
    var body: some Scene {
        WindowGroup {
            RootView()
            #if os(iOS)
                .preferredColorScheme(.dark)
            #endif
        }
    }
}

struct RootView: View {
    @State private var path = NavigationPath()
    var body: some View {
        NavigationStack(path: $path) {
            StationBoardView(path: $path)
                .navigationDestination(for: Int.self) { id in
                    TrainDetailView(runId: id)
                }
                .navigationDestination(for: Trip.self) { trip in
                    TripDetailView(trip: trip)
                }
        }
        .tint(.tPrimary)
        .onAppear {
            let args = ProcessInfo.processInfo.arguments
            // debug deep links:
            //   xcrun simctl launch <dev> com.treno.Treno --train <runId>
            //   xcrun simctl launch <dev> com.treno.Treno --track <fromId>,<toId>
            if let i = args.firstIndex(of: "--train"), i + 1 < args.count, let id = Int(args[i + 1]) {
                path.append(id)
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
            if args.contains("--open-trip"), let first = TripStore.shared.trips.first {
                path.append(first)
            }
        }
    }
}
