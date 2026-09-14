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
                            NavigationLink(value: runId) { journeyContent(journey, isNext: index == 0) }.buttonStyle(.plain)
                        } else { journeyContent(journey, isNext: index == 0) }
                        if journey.runId != nil {
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
        .navigationTitle(trip.name.isEmpty ? "Journey" : trip.name)
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

    private func journeyContent(_ journey: JourneyRow, isNext: Bool) -> some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack {
                if let line = journey.line { TBadge(line, .tPrimary) }
                Text("Train \(journey.trainNumber)").font(.footnote).foregroundStyle(.tMuted)
                Spacer()
                Text(Fmt.delayShort(journey.departureDelay)).font(.footnote.weight(.medium)).foregroundStyle(StatusUI.delayColor(journey.departureDelay))
            }
            HStack {
                journeyTime(journey.expectedDeparture, label: "Departure")
                Spacer()
                VStack(spacing: 6) {
                    Text("\(max(1, Int((journey.arrEpoch - journey.depEpoch) / 60_000))) min").font(.caption).foregroundStyle(.tMuted)
                    Image(systemName: "arrow.right").font(.subheadline).foregroundStyle(.tertiary)
                }
                Spacer()
                journeyTime(journey.expectedArrival, label: "Arrival", alignment: .trailing)
            }
            HStack {
                Text(Fmt.departure(journey.expectedDeparture, now: now))
                Spacer()
                if let platform = Fmt.platform(journey.platform) { Text("Platform \(platform)") }
                if journey.runId != nil { Image(systemName: "chevron.right").font(.caption.weight(.semibold)) }
            }.font(.subheadline).foregroundStyle(.tMuted)
        }.padding(20).contentShape(Rectangle())
    }

    private func journeyTime(_ epoch: Double, label: String, alignment: HorizontalAlignment = .leading) -> some View {
        VStack(alignment: alignment, spacing: 5) {
            Text(label).font(.footnote).foregroundStyle(.tMuted)
            Text(Fmt.hhmm(epoch)).font(.title.weight(.medium)).monospacedDigit().foregroundStyle(.tFg)
        }
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
