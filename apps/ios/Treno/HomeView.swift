import SwiftUI

@MainActor
final class JourneySummaries: ObservableObject {
    @Published var next: [UUID: JourneyRow] = [:]
    @Published var failed: Set<UUID> = []
    @Published var hasLoaded = false
    private var requestID = UUID()

    func load(_ trips: [Trip]) async {
        let request = UUID()
        requestID = request
        var values: [UUID: JourneyRow] = [:]
        var errors: Set<UUID> = []
        await withTaskGroup(of: (UUID, JourneyRow?, Bool).self) { group in
            for trip in trips where trip.runsToday {
                group.addTask {
                    do {
                        let rows = try await APIClient.shared.journeys(from: trip.fromStopId, to: trip.toStopId, limit: 8)
                        return (trip.id, rows.first { $0.canBoard() }, false)
                    } catch { return (trip.id, nil, true) }
                }
            }
            for await (id, journey, failed) in group {
                if let journey { values[id] = journey }
                if failed { errors.insert(id) }
            }
        }
        guard requestID == request, !Task.isCancelled else { return }
        hasLoaded = true
        next = values
        failed = errors
    }
}

struct HomeView: View {
    let openStation: (String, String) -> Void
    @StateObject private var store = TripStore.shared
    @StateObject private var summaries = JourneySummaries()
    @State private var showAddTrip = false
    @State private var showStations = false
    @State private var showSettings = false
    @State private var catalog: [StationLite] = []
    private let refresh = Timer.publish(every: 30, on: .main, in: .common).autoconnect()

    private var nextTrip: Trip? {
        store.trips.filter { summaries.next[$0.id] != nil }
            .min { summaries.next[$0.id]!.expectedDeparture < summaries.next[$1.id]!.expectedDeparture }
            ?? store.trips.first
    }
    private var stations: [Station] {
        store.favorites.sorted().compactMap { id -> Station? in
            let name = catalog.first { $0.stopId == id }?.name
                ?? StationPickerSheet.suggested.first { $0.stopId == id }?.name
                ?? store.trips.first { $0.fromStopId == id }?.fromName
                ?? store.trips.first { $0.toStopId == id }?.toName
            return name.map { Station(stopId: id, name: $0) }
        }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                GlassEffectContainer(spacing: 12) {
                    HStack(spacing: 12) {
                        Button { showStations = true } label: {
                            Label("Find a trip", systemImage: "magnifyingglass")
                                .font(.body).foregroundStyle(.tFg)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.horizontal, 20).frame(minHeight: 54)
                                .trenoGlass(cornerRadius: 27)
                        }.buttonStyle(.plain)
                        Button("Add journey", systemImage: "plus") { showAddTrip = true }
                            .labelStyle(.iconOnly).font(.title3.weight(.medium))
                            .frame(width: 54, height: 54)
                            .trenoGlass(cornerRadius: 27)
                            .buttonStyle(.plain)
                    }
                }

                VStack(alignment: .leading, spacing: 14) {
                    if let trip = nextTrip {
                        NavigationLink(value: trip) {
                            TripCard(trip: trip, next: summaries.next[trip.id],
                                     loading: !summaries.hasLoaded, failed: summaries.failed.contains(trip.id))
                        }.buttonStyle(.plain)
                    } else {
                        VStack(alignment: .leading, spacing: 18) {
                            Image(systemName: "tram.fill").font(.largeTitle).foregroundStyle(.tPrimary)
                            Text("Make it your journey").font(.title2.weight(.semibold))
                            Text("Save a route. Your next train will be right here.")
                                .font(.body).foregroundStyle(.tMuted)
                            Button("Add a journey", systemImage: "plus") { showAddTrip = true }
                                .buttonStyle(.glassProminent).controlSize(.large)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(24).background(Color.tCard, in: RoundedRectangle(cornerRadius: 24))
                    }
                }

                if !stations.isEmpty {
                    VStack(alignment: .leading, spacing: 14) {
                        SectionHeading(title: "Your stations")
                        VStack(spacing: 0) {
                            ForEach(Array(stations.prefix(4).enumerated()), id: \.element.id) { index, station in
                                Button {
                                    store.noteUse(station.id)
                                    openStation(station.id, station.name)
                                } label: {
                                    HStack(spacing: 14) {
                                        Image(systemName: "star.fill")
                                            .font(.body).foregroundStyle(Color.tStar).frame(width: 24)
                                        Text(station.name).font(.body.weight(.medium)).foregroundStyle(.tFg)
                                        Spacer(minLength: 4)
                                        Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(.tertiary)
                                    }.padding(16).contentShape(Rectangle())
                                }.buttonStyle(.plain)
                                if index < min(stations.count, 4) - 1 { Divider().padding(.leading, 54) }
                            }
                        }.background(Color.tCard, in: RoundedRectangle(cornerRadius: 22))
                    }
                }
            }.padding(.horizontal, 20).padding(.top, 14).padding(.bottom, 28)
        }
        .background { TrenoBackground() }
        .navigationTitle("For you")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("Settings", systemImage: "gearshape") { showSettings = true }
            }
        }
        .sheet(isPresented: $showAddTrip) { AddTripView() }
        .sheet(isPresented: $showSettings) {
            NavigationStack {
                SettingsView().toolbar {
                    ToolbarItem(placement: .confirmationAction) { Button("Done") { showSettings = false } }
                }
            }
        }
        .sheet(isPresented: $showStations) {
            TripSearchSheet()
        }
        .task { catalog = (try? await StationCatalog.shared.stations()) ?? [] }
        // debug: `--find` opens the trip finder so the sheet is capturable
        .task {
            if ProcessInfo.processInfo.arguments.contains("--find") {
                try? await Task.sleep(for: .milliseconds(400))
                showStations = true
            }
        }
        .task(id: store.trips) { await summaries.load(store.trips) }
        .refreshable { await summaries.load(store.trips) }
        .onReceive(refresh) { _ in Task { await summaries.load(store.trips) } }
    }
}

struct TripCard: View {
    let trip: Trip
    let next: JourneyRow?
    var loading = false
    var failed = false

    var body: some View {
        VStack(alignment: .leading, spacing: 24) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Text(trip.name.isEmpty ? "Your next train" : trip.name)
                    .font(.subheadline.weight(.medium)).foregroundStyle(.tMuted)
                Spacer(minLength: 0)
                if let next {
                    TimelineView(.periodic(from: .now, by: 30)) { context in
                        Text(Fmt.departure(next.expectedDeparture, now: context.date))
                            .font(.subheadline.weight(.semibold)).foregroundStyle(.tPrimary)
                    }
                }
            }
            RouteEndpoints(from: trip.fromName, to: trip.toName)
            if let next {
                HStack(alignment: .center) {
                    time(next.expectedDeparture, title: "Departure")
                    Spacer()
                    Image(systemName: "arrow.right").font(.subheadline).foregroundStyle(.tertiary)
                    Spacer()
                    time(next.expectedArrival, title: "Arrival", alignment: .trailing)
                }
                HStack(spacing: 10) {
                    if let line = next.line { TBadge(line, .tPrimary) }
                    if let platform = Fmt.platform(next.platform) {
                        Text("Platform \(platform)").font(.footnote).foregroundStyle(.tMuted)
                    }
                    Spacer(minLength: 0)
                    if let delay = next.departureDelay {
                        Text(Fmt.delayShort(delay)).font(.footnote.weight(.medium))
                            .foregroundStyle(StatusUI.delayColor(delay))
                    }
                    Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(.tertiary)
                }
            } else {
                Text(loading ? "Finding your next train…" : failed ? "Updates unavailable · Tap to retry" : !trip.runsToday ? trip.daySummary : "No upcoming direct trains")
                    .font(.subheadline).foregroundStyle(.tMuted)
            }
        }
        .padding(24).background(Color.tCard, in: RoundedRectangle(cornerRadius: 28))
        .accessibilityHint("View trains for this journey")
    }

    private func time(_ value: Double, title: String, alignment: HorizontalAlignment = .leading) -> some View {
        VStack(alignment: alignment, spacing: 6) {
            Text(title).font(.footnote).foregroundStyle(.tMuted)
            Text(Fmt.hhmm(value)).font(.system(.largeTitle, weight: .medium))
                .monospacedDigit().foregroundStyle(.tFg)
        }
    }
}
