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
            TrainListView(path: $path)
                .navigationDestination(for: Int.self) { id in
                    TrainDetailView(runId: id)
                }
        }
        .tint(.tPrimary)
    }
}
