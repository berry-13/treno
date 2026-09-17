import SwiftUI

struct TripDetailView: View {
    @State var trip: Trip
    @Environment(\.dismiss) private var dismiss
    @State private var journeys: [JourneyRow] = []
    @State private var failed = false
    @State private var loading = true
    @State private var requestID = UUID()
    @State private var editing = false
    @State private var trackingRunId: Int?
    @State private var now = Date.now
    @State private var trackingUnavailable = false
    private let store = TripStore.shared
    private let refresh = Timer.publish(every: 20, on: .main, in: .common).autoconnect()
    private var upcoming: [JourneyRow] {
        journeys.filter { $0.canBoard(at: now) || $0.runId != nil && $0.runId == trackingRunId }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                VStack(alignment: .leading, spacing: 20) {
                    RouteEndpoints(from: trip.fromName, to: trip.toName)
                    if trip.days.count != 7 { Text(trip.daySummary).font(.subheadline).foregroundStyle(.tMuted) }
                }.frame(maxWidth: .infinity, alignment: .leading)
                    .padding(22).background(Color.tCard, in: RoundedRectangle(cornerRadius: 24))
                HStack {
                    SectionHeading(title: "Next trains")
                    if loading { ProgressView() }
                }
                if failed {
                    TravelNotice(title: "Updates are unavailable", message: "Check your connection and pull down to try again.")
                    Button("Try again") { Task { await load() } }.buttonStyle(.bordered).frame(maxWidth: .infinity)
                }
                if !loading && !failed && upcoming.isEmpty {
                    ContentUnavailableView("No upcoming direct trains", systemImage: "tram", description: Text("There are no direct services on this route in the current timetable window."))
                }
                ForEach(Array(upcoming.enumerated()), id: \.element.id) { index, journey in
                    VStack(spacing: 0) {
                        if let runId = journey.runId {
                            NavigationLink(value: TrainRef(runId: runId, fromStopId: trip.fromStopId, toStopId: trip.toStopId)) { journeyContent(journey) }.buttonStyle(.plain)
                        } else { journeyContent(journey) }
                        // the glass follow action belongs to the train you're
                        // about to catch, not to every row
                        if journey.runId != nil && index == 0 {
                            Button {
                                guard let runId = journey.runId else { return }
                                if trackingRunId == runId {
                                    LiveTracker.stop()
                                    trackingRunId = nil
                                } else {
                                    if LiveTracker.start(trip: trip, journey: journey) {
                                        trackingRunId = runId
                                    } else { trackingUnavailable = true }
                                }
                            } label: {
                                Label(trackingRunId == journey.runId ? "Stop following" : "Follow this train",
                                      systemImage: trackingRunId == journey.runId ? "stop.circle" : "livephoto")
                                    .font(.subheadline.weight(.semibold))
                                    .frame(maxWidth: .infinity).frame(minHeight: 44)
                            }
                            .buttonStyle(.glass).tint(.tPrimary)
                            .padding(.horizontal, 16).padding(.bottom, 16)
                        }
                    }.background(Color.tCard, in: RoundedRectangle(cornerRadius: 22))
                }
            }.padding(.horizontal, 20).padding(.top, 12).padding(.bottom, 28)
        }
        .background { TrenoBackground() }
        .navigationTitle(trip.displayName)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Edit") { editing = true } } }
        .refreshable { await load() }
        .task { trackingRunId = LiveTracker.trackedRunId; await load() }
        .onReceive(refresh) { date in now = date; trackingRunId = LiveTracker.trackedRunId; Task { await load() } }
        .alert("Live Activities are unavailable", isPresented: $trackingUnavailable) {
            Button("OK", role: .cancel) {}
        } message: {
            Text("Enable Live Activities for Treno in iPhone Settings to follow a train on your Lock Screen.")
        }
        .sheet(isPresented: $editing) {
            TripEditSheet(trip: trip) { updated, action in
                if action == .delete {
                    store.remove(trip)
                    dismiss()
                } else {
                    trip = updated
                    store.update(updated)
                    Task { await load() }
                }
            }
        }
    }

    private func journeyContent(_ journey: JourneyRow) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 10) {
                if let line = journey.line { TBadge(line, .tPrimary) }
                if let final = journey.finalDestinationName, final != trip.toName {
                    Text("via \(final)").font(.footnote).foregroundStyle(.tMuted).lineLimit(1)
                }
                Spacer()
                if let delay = journey.departureDelay, abs(delay) >= 60 {
                    Text(Fmt.delayShort(delay)).font(.footnote.weight(.semibold)).foregroundStyle(StatusUI.delayColor(delay))
                }
            }
            HStack(alignment: .firstTextBaseline, spacing: 14) {
                Text(Fmt.hhmm(journey.expectedDeparture)).font(.system(size: 34, weight: .semibold))
                    .monospacedDigit().foregroundStyle(.tFg)
                VStack(spacing: 2) {
                    Text("\(max(1, Int((journey.arrEpoch - journey.depEpoch) / 60_000))) min")
                        .font(.caption2).foregroundStyle(.tMuted)
                    Image(systemName: "arrow.right").font(.caption.weight(.semibold)).foregroundStyle(.tertiary)
                }
                Text(Fmt.hhmm(journey.expectedArrival)).font(.system(size: 34, weight: .semibold))
                    .monospacedDigit().foregroundStyle(.tFg)
                Spacer(minLength: 0)
            }
            HStack(spacing: 10) {
                if let delay = journey.departureDelay, abs(delay) >= 60 {
                    Text(Fmt.hhmm(journey.depEpoch)).strikethrough().font(.footnote.monospacedDigit()).foregroundStyle(.tMuted)
                }
                Text(Fmt.departure(journey.expectedDeparture, now: now)).font(.footnote.weight(.medium)).foregroundStyle(.tPrimary)
                Spacer()
                if let platform = Fmt.platform(journey.platform) { PlatformChip(platform: platform) }
                if journey.runId != nil { Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(.tertiary) }
            }
        }.padding(20).contentShape(Rectangle())
    }

    private func load() async {
        let request = UUID()
        requestID = request
        let currentTrip = trip
        loading = true
        defer { if requestID == request { loading = false } }
        do {
            let result = try await APIClient.shared.journeys(from: currentTrip.fromStopId, to: currentTrip.toStopId, limit: 10)
            guard requestID == request, !Task.isCancelled else { return }
            journeys = result
            failed = false
        } catch { if requestID == request, !Task.isCancelled { failed = true } }
    }
}

// MARK: - edit sheet

enum TripEditAction { case save, delete }

struct TripEditSheet: View {
    @State var trip: Trip
    let done: (Trip, TripEditAction) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var pickingFrom = false
    @State private var pickingTo = false

    private let dayLabels: [(Int, String)] = [(1, "M"), (2, "T"), (3, "W"), (4, "T"), (5, "F"), (6, "S"), (7, "S")]

    var body: some View {
        NavigationStack {
            Form {
                Section("Name") {
                    TextField("Custom name (optional)", text: $trip.name)
                }
                Section("Route") {
                    Button {
                        pickingFrom = true
                    } label: {
                        settingRow("From", trip.fromName)
                    }
                    Button {
                        pickingTo = true
                    } label: {
                        settingRow("To", trip.toName)
                    }
                    Button {
                        let f = trip.fromStopId, fn = trip.fromName
                        trip.fromStopId = trip.toStopId
                        trip.fromName = trip.toName
                        trip.toStopId = f
                        trip.toName = fn
                    } label: {
                        Label("Swap direction", systemImage: "arrow.up.arrow.down")
                            .foregroundStyle(.tPrimary)
                    }
                }
                Section("Runs on") {
                    HStack(spacing: 4) {
                        ForEach(dayLabels, id: \.0) { d, label in
                            Button {
                                if trip.days.contains(d) { trip.days.remove(d) } else { trip.days.insert(d) }
                            } label: {
                                Text(label)
                                    .font(.subheadline.weight(.semibold))
                                    .frame(minWidth: 32, minHeight: 44)
                                    .background(
                                        Circle().fill(trip.days.contains(d) ? Color.tPrimary.opacity(0.18) : Color.tBg)
                                    )
                                    .overlay(Circle().strokeBorder(trip.days.contains(d) ? Color.tPrimary : Color.tBorder, lineWidth: 1))
                                    .foregroundStyle(trip.days.contains(d) ? Color.tPrimary : Color.tMuted)
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"][d - 1])
                            .accessibilityValue(trip.days.contains(d) ? "Selected" : "Not selected")
                        }
                    }
                }
                Section {
                    Button(role: .destructive) {
                        done(trip, .delete)
                        dismiss()
                    } label: {
                        Label("Delete journey", systemImage: "trash")
                    }
                }
            }
            .navigationTitle("Edit journey")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        done(trip, .save)
                        dismiss()
                    }
                    .foregroundStyle(.tPrimary)
                    .disabled(trip.fromStopId == trip.toStopId || trip.days.isEmpty)
                }
            }
            .sheet(isPresented: $pickingFrom) {
                StationPickerSheet(currentId: trip.fromStopId) { st in
                    trip.fromStopId = st.stopId
                    trip.fromName = st.name
                }
                .presentationDetents([.medium, .large])
            }
            .sheet(isPresented: $pickingTo) {
                StationPickerSheet(currentId: trip.toStopId) { st in
                    trip.toStopId = st.stopId
                    trip.toName = st.name
                }
                .presentationDetents([.medium, .large])
            }
        }
    }

    private func settingRow(_ label: String, _ value: String) -> some View {
        HStack {
            Text(label).foregroundStyle(.tMuted)
            Spacer()
            Text(value).foregroundStyle(.tFg)
            Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tDim)
        }
    }
}
