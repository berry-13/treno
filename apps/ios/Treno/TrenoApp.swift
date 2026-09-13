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
        }
        .tint(.tPrimary)
        .onAppear {
            // debug deep link: xcrun simctl launch <dev> com.treno.Treno --train <runId>
            let args = ProcessInfo.processInfo.arguments
            if let i = args.firstIndex(of: "--train"), i + 1 < args.count, let id = Int(args[i + 1]) {
                path.append(id)
            }
        }
    }
}
