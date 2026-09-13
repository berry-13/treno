import SwiftUI

/// Saved trips management: list with live summaries, add, edit, delete.
struct TripsView: View {
    @StateObject private var store = TripStore.shared
    @State private var nextByTrip: [UUID: JourneyRow?] = [:]
    @State private var showAdd = false
    @State private var now = Date.now

    private let refresh = Timer.publish(every: 30, on: .main, in: .common).autoconnect()

    var body: some View {
        ZStack {
            Color.tBg.ignoresSafeArea()
            if store.trips.isEmpty {
                ContentUnavailableView {
                    Label("No trips yet", systemImage: "heart")
                } description: {
                    Text("Save a route like Sesto S.Giovanni → Arcore and its next train follows you everywhere — home, widget, Dynamic Island.")
                } actions: {
                    Button("New trip") { showAdd = true }
                        .buttonStyle(.borderedProminent)
                        .tint(.tPrimary)
                }
            } else {
                List {
                    Section {
                        ForEach(store.trips) { trip in
                            NavigationLink(value: trip) {
                                TripSummaryRow(trip: trip, next: nextByTrip[trip.id] ?? nil)
                            }
                            .buttonStyle(.plain)
                            .listRowBackground(Color.clear)
                            .listRowSeparator(.hidden)
                            .listRowInsets(EdgeInsets(top: 8, leading: 20, bottom: 8, trailing: 20))
                        }
                    }
                }
                .scrollContentBackground(.hidden)
            }
        }
        .navigationTitle("Trips")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    showAdd = true
                } label: {
                    Image(systemName: "plus.circle.fill")
                        .font(.system(size: 20))
                }
            }
        }
        .sheet(isPresented: $showAdd) { AddTripView() }
        .refreshable { await loadSummaries() }
        .task { await loadSummaries() }
        .onReceive(refresh) { _ in Task { await loadSummaries() } }
    }

    private func loadSummaries() async {
        guard !store.trips.isEmpty else { return }
        await withTaskGroup(of: (UUID, JourneyRow?).self) { group in
            for trip in store.trips where trip.runsToday {
                group.addTask {
                    let js = (try? await APIClient.shared.journeys(from: trip.fromStopId, to: trip.toStopId, limit: 3)) ?? []
                    let best = js.first { j in
                        (j.actualDepEpoch == nil || j.state?.status == "running") && j.depEpoch + 10 * 60_000 > Date.now.timeIntervalSince1970 * 1000
                    } ?? js.last
                    return (trip.id, best)
                }
            }
            for await (id, next) in group {
                nextByTrip[id] = next
            }
        }
    }
}

// MARK: - trip summary row

struct TripSummaryRow: View {
    let trip: Trip
    let next: JourneyRow?
    @State private var now = Date.now

    private var nowMs: Double { now.timeIntervalSince1970 * 1000 }

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "heart.fill")
                .font(.system(size: 13))
                .foregroundStyle(.tPrimary)
                .frame(width: 20)

            VStack(alignment: .leading, spacing: 3) {
                Text(trip.displayName)
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(.tFg)
                    .lineLimit(1)
                HStack(spacing: 7) {
                    if let j = next, trip.runsToday {
                        if let line = j.line { TBadge(line, .tPrimary) }
                        Text(j.trainNumber)
                            .font(.system(size: 11.5, weight: .medium))
                            .monospacedDigit()
                            .foregroundStyle(.tDim)
                        if j.state?.status == "running" {
                            HStack(spacing: 4) {
                                Circle().fill(Color.tPrimary).frame(width: 5, height: 5)
                                Text("live").font(.system(size: 10.5, weight: .semibold))
                            }
                            .foregroundStyle(.tPrimary)
                        } else if let mins = minutesUntil(j.depEpoch), mins >= 0 {
                            Text("in \(mins)m")
                                .font(.system(size: 11.5, weight: .medium))
                                .monospacedDigit()
                                .foregroundStyle(.tMuted)
                        }
                    } else if !trip.runsToday {
                        Text(daySummary)
                            .font(.system(size: 11.5))
                            .foregroundStyle(.tDim)
                    } else {
                        Text("no more trains today")
                            .font(.system(size: 11.5))
                            .foregroundStyle(.tDim)
                    }
                }
            }

            Spacer(minLength: 8)
            if let j = next, trip.runsToday {
                VStack(alignment: .trailing, spacing: 1) {
                    Text(Fmt.hhmm(j.depEpoch + Double(j.depDelaySec ?? j.state?.operatorDelaySec ?? 0) * 1000))
                        .font(.system(size: 17, weight: .semibold, design: .rounded))
                        .monospacedDigit()
                        .foregroundStyle((j.depDelaySec ?? j.state?.operatorDelaySec ?? 0) >= 60 ? StatusUI.delayColor(j.depDelaySec ?? j.state?.operatorDelaySec) : Color.tFg)
                    Text("→ " + Fmt.hhmm(j.arrEpoch + Double(arrDelay(j)) * 1000))
                        .font(.system(size: 10.5))
                        .monospacedDigit()
                        .foregroundStyle(.tDim)
                }
            }
        }
        .onReceive(Timer.publish(every: 30, on: .main, in: .common).autoconnect()) { now = $0 }
    }

    private func arrDelay(_ j: JourneyRow) -> Int {
        if let ours = j.state?.ourEstimate, let sched = j.state?.schedArrEpoch {
            return Int(((ours.p50 - sched) / 1000).rounded())
        }
        return j.depDelaySec ?? j.state?.operatorDelaySec ?? 0
    }

    private func minutesUntil(_ epochMs: Double) -> Int? {
        Int(((epochMs - nowMs) / 60_000).rounded())
    }

    private var daySummary: String {
        if trip.days.count == 7 { return "every day" }
        if trip.days == Set(1...5) { return "weekdays" }
        if trip.days == Set([6, 7]) { return "weekends" }
        let names = [1: "Mon", 2: "Tue", 3: "Wed", 4: "Thu", 5: "Fri", 6: "Sat", 7: "Sun"]
        return trip.days.sorted().compactMap { names[$0] }.joined(separator: " ")
    }
}
