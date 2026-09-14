import SwiftUI

struct TripsView: View {
    @StateObject private var store = TripStore.shared
    @StateObject private var summaries = JourneySummaries()
    @State private var showAdd = false
    private let refresh = Timer.publish(every: 30, on: .main, in: .common).autoconnect()

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                if store.trips.isEmpty {
                    ContentUnavailableView {
                        Label("Make it your journey", systemImage: "bookmark")
                    } description: {
                        Text("Save the routes you travel. Your next departure will be a tap away.")
                    } actions: {
                        Button("Add a journey", systemImage: "plus") { showAdd = true }
                            .buttonStyle(.glassProminent)
                    }
                } else {
                    ForEach(store.trips) { trip in
                        VStack(alignment: .leading, spacing: 10) {
                            NavigationLink(value: trip) {
                                TripCard(trip: trip, next: summaries.next[trip.id],
                                         loading: !summaries.hasLoaded, failed: summaries.failed.contains(trip.id))
                            }.buttonStyle(.plain)
                        }
                    }
                }
            }.padding(.horizontal, 20).padding(.bottom, 28)
        }
        .background { TrenoBackground() }
        .navigationTitle("Journeys")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("Add journey", systemImage: "plus") { showAdd = true }
            }
        }
        .sheet(isPresented: $showAdd) { AddTripView() }
        .refreshable { await summaries.load(store.trips) }
        .task(id: store.trips) { await summaries.load(store.trips) }
        .onReceive(refresh) { _ in Task { await summaries.load(store.trips) } }
    }
}
