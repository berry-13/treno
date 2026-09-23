import SwiftUI

/// Transient trip finder: pick a start and a stop station, optionally a
/// different day/hour, and see the direct trains. Nothing is saved.
struct TripSearchSheet: View {
    /// opens the train as a full page (sheet closes itself first)
    let onOpenTrain: (TrainRef) -> Void

    @Environment(\.dismiss) private var dismiss

    @State private var from: Station?
    @State private var to: Station?
    @State private var when = Date.now
    @State private var pickingFrom = false
    @State private var pickingTo = false
    @State private var journeys: [JourneyRow] = []
    @State private var loading = false
    @State private var failed = false
    private let refresh = Timer.publish(every: 20, on: .main, in: .common).autoconnect()

    private var isNow: Bool { abs(when.timeIntervalSinceNow) < 120 }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Button(action: { pickingFrom = true }) { endpointRow("From", from) }
                        .buttonStyle(.plain)
                    Button(action: { pickingTo = true }) { endpointRow("To", to) }
                        .buttonStyle(.plain)
                    HStack {
                        DatePicker("When", selection: $when, displayedComponents: [.date, .hourAndMinute])
                            .labelsHidden()
                            .environment(\.locale, Locale(identifier: "it_IT"))
                        if !isNow {
                            Button("Now") {
                                when = Date.now
                                Task { await load() }
                            }
                            .font(.subheadline.weight(.semibold))
                            .buttonStyle(.bordered)
                            .controlSize(.small)
                        }
                    }
                    Button {
                        let f = from
                        from = to
                        to = f
                        Task { await load() }
                    } label: {
                        Label("Swap direction", systemImage: "arrow.up.arrow.down")
                            .font(.body)
                            .foregroundStyle(.tPrimary)
                    }
                }
                if from != nil && to != nil {
                    Section {
                        if loading {
                            HStack(spacing: 10) {
                                ProgressView().controlSize(.small)
                                Text("Searching trains…").foregroundStyle(.tMuted)
                            }
                        } else if failed {
                            Text("Can't reach the server — pull to retry.")
                                .foregroundStyle(.tMuted)
                        } else if journeys.isEmpty {
                            Text("No direct trains found for this pair.")
                                .foregroundStyle(.tMuted)
                        }
                        ForEach(journeys) { j in
                            if let runId = j.runId {
                                Button {
                                    onOpenTrain(TrainRef(runId: runId, fromStopId: from?.stopId, toStopId: to?.stopId))
                                } label: {
                                    journeyRow(j)
                                }
                                .buttonStyle(.plain)
                            } else {
                                journeyRow(j).opacity(0.7)
                            }
                        }
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(Color.tBg)
            .navigationTitle("Find a trip")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .refreshable { await load() }
        }
        .tint(.tPrimary)
        .onChange(of: when) { _, _ in Task { await load(silent: true) } }
        .onReceive(refresh) { _ in Task { await load(silent: true) } }
        .sheet(isPresented: $pickingFrom) {
            StationPickerSheet(currentId: from?.stopId ?? "") { st in
                from = st
                Task { await load() }
            }
            .presentationDetents([.medium, .large])
        }
        .sheet(isPresented: $pickingTo) {
            StationPickerSheet(currentId: to?.stopId ?? "") { st in
                to = st
                Task { await load() }
            }
            .presentationDetents([.medium, .large])
        }
        .task {
            if from == nil,
               let id = UserDefaults.standard.string(forKey: "stationId"),
               let name = UserDefaults.standard.string(forKey: "stationName") {
                from = Station(stopId: id, name: name)
            }
            await load()
        }
    }

    // MARK: rows

    private func endpointRow(_ label: String, _ station: Station?) -> some View {
        HStack(spacing: 12) {
            Text(label.uppercased())
                .font(.caption.weight(.semibold))
                .tracking(1.2)
                .foregroundStyle(.tDim)
                .frame(width: 44, alignment: .leading)
            Text(station?.name ?? "Choose station")
                .font(.body.weight(station == nil ? .regular : .semibold))
                .foregroundStyle(station == nil ? Color.tMuted : Color.tFg)
            Spacer()
            Image(systemName: "chevron.right")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.tertiary)
        }
        .contentShape(Rectangle())
    }

    private func journeyRow(_ j: JourneyRow) -> some View {
        let delay = j.departureDelay
        let late = delay != nil && abs(delay!) >= 60
        return HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 5) {
                HStack(spacing: 6) {
                    if let line = j.line {
                        Text(line)
                            .font(.caption.weight(.bold))
                            .foregroundStyle(.tPrimary)
                    }
                    if j.state?.isFresh == true && j.state?.status == "running" {
                        Circle().fill(Color.tGood).frame(width: 5, height: 5)
                    }
                    // §19/§62: the option the server ranks best by expected
                    // real arrival gets a quiet mark, never a reorder hint
                    if j.recommended == true {
                        TBadge("Recommended", .tPrimary)
                    }
                }
                if let dest = j.finalDestinationName, dest != to?.name {
                    Text("via " + dest)
                        .font(.caption)
                        .foregroundStyle(.tMuted)
                        .lineLimit(1)
                }
                if let platform = Fmt.platform(j.platform) {
                    PlatformChip(platform: platform)
                }
            }
            Spacer(minLength: 8)
            Text(Fmt.hhmm(j.expectedDeparture))
                .font(.body.weight(.semibold).monospacedDigit())
                .foregroundStyle(late ? StatusUI.delayColor(delay) : Color.tFg)
            Image(systemName: "arrow.right")
                .font(.caption2.weight(.bold))
                .foregroundStyle(.tDim)
            // §19/§62: expected real arrival — the server's ranked estimate
            // when it moves the scheduled time by more than a minute, with
            // the timetable time struck through underneath
            VStack(alignment: .trailing, spacing: 2) {
                Text(Fmt.hhmm(j.showsExpectedArrival ? j.rankedArrival : j.expectedArrival))
                    .font(.body.weight(.semibold).monospacedDigit())
                    .foregroundStyle(.tFg)
                if j.showsExpectedArrival {
                    Text(Fmt.hhmm(j.arrEpoch))
                        .font(.caption.monospacedDigit()).strikethrough()
                        .foregroundStyle(.tMuted)
                }
            }
        }
    }

    /// silent reloads keep the list steady — no spinner, keep stale rows on error
    private func load(silent: Bool = false) async {
        guard let f = from, let t = to else { return }
        if !silent { loading = true; failed = false }
        do {
            journeys = try await APIClient.shared.journeys(from: f.stopId, to: t.stopId, at: isNow ? nil : when, limit: 8)
        } catch {
            if !silent { failed = true; journeys = [] }
        }
        if !silent { loading = false }
    }
}

// MARK: - §19/§62 smart-alternative ranking

extension JourneyRow {
    /// Server-ranked expected real arrival; falls back to the client-side
    /// estimate (scheduled + observed delay) when the server sent none.
    var rankedArrival: Double { expectedArrivalEpoch ?? expectedArrival }
    /// Expected minus scheduled arrival, ms — nil when the server sent no
    /// estimate for this option.
    var rankedArrivalDeltaMs: Double? {
        guard let expectedArrivalEpoch else { return nil }
        return expectedArrivalEpoch - arrEpoch
    }
    /// The expected time is worth printing only when it moves the scheduled
    /// one by more than a minute (§19: show expected arrival where it differs).
    var showsExpectedArrival: Bool {
        guard let d = rankedArrivalDeltaMs else { return false }
        return abs(d) > 60_000
    }
}
