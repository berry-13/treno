import SwiftUI

/// A saved trip: the next direct trains origin→destination, live-fused, with
/// day-of-week rules, renaming, and one-tap Live Activity tracking.
struct TripDetailView: View {
    @State var trip: Trip

    @State private var journeys: [JourneyRow] = []
    @State private var errorText: String?
    @State private var editing = false
    @State private var now = Date.now
    @State private var trackingRunId: Int?

    private let store = TripStore.shared
    private let refresh = Timer.publish(every: 20, on: .main, in: .common).autoconnect()
    private let ticker = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

    private var nowMs: Double { now.timeIntervalSince1970 * 1000 }

    private var upcoming: [JourneyRow] {
        journeys.filter { j in
            j.depEpoch + 10 * 60_000 > nowMs || j.state?.status == "running"
        }
    }

    var body: some View {
        ZStack {
            Color.tBg.ignoresSafeArea()
            ScrollView {
                VStack(spacing: 0) {
                    header
                    if let errorText {
                        Text(errorText).font(.footnote).foregroundStyle(.tDanger).padding(.top, 40)
                    } else if upcoming.isEmpty {
                        Text(trip.runsToday ? "No more direct trains today" : "Not scheduled today (\(daySummary))")
                            .font(.system(size: 14))
                            .foregroundStyle(.tDim)
                            .padding(.top, 60)
                    } else {
                        ForEach(Array(upcoming.enumerated()), id: \.element.id) { i, j in
                            journeyRow(j, isNext: i == 0)
                        }
                    }
                }
                .padding(.bottom, 48)
            }
            .backgroundExtensionEffect()
        }
        .navigationTitle("")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(Color.tBg, for: .navigationBar)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("Edit") { editing = true }
            }
        }
        .refreshable { await load() }
        .onAppear { Task { await load() } }
        .onReceive(refresh) { _ in Task { await load() } }
        .onReceive(ticker) { now = $0 }
        .sheet(isPresented: $editing) {
            TripEditSheet(trip: trip) { updated, action in
                if action == .delete {
                    store.remove(trip)
                } else {
                    trip = updated
                    store.update(updated)
                }
                Task { await load() }
            }
        }
        .onDisappear { LiveTracker.stop() }
    }

    private func load() async {
        do {
            journeys = try await APIClient.shared.journeys(from: trip.fromStopId, to: trip.toStopId, limit: 10)
            errorText = nil
        } catch {
            errorText = error.localizedDescription
        }
    }

    // MARK: header

    private var header: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(trip.fromName)
                        .font(.system(size: 24, weight: .heavy, design: .rounded))
                    Image(systemName: "arrow.down")
                        .font(.system(size: 13, weight: .bold))
                        .foregroundStyle(.tPrimary)
                    Text(trip.toName)
                        .font(.system(size: 24, weight: .heavy, design: .rounded))
                }
                .foregroundStyle(.tFg)
                Spacer()
                if let next = upcoming.first {
                    trackButton(next)
                }
            }
            HStack(spacing: 8) {
                TBadge(daySummary, .tMuted)
                if let next = upcoming.first, let line = next.line {
                    TBadge(line, .tPrimary)
                }
            }
        }
        .padding(16)
        .overlay(alignment: .bottom) { hairline }
        .padding(.horizontal, 16)
        .padding(.top, 6)
    }

    private func trackButton(_ j: JourneyRow) -> some View {
        Button {
            if trackingRunId == j.runId {
                LiveTracker.stop()
                trackingRunId = nil
            } else {
                LiveTracker.start(trip: trip, journey: j)
                trackingRunId = j.runId
            }
        } label: {
            VStack(spacing: 3) {
                Image(systemName: trackingRunId == j.runId ? "stop.circle.fill" : "dot.radiowaves.left.and.right")
                    .font(.system(size: 24))
                Text(trackingRunId == j.runId ? "stop" : "track")
                    .font(.system(size: 9.5, weight: .semibold))
            }
            .foregroundStyle(trackingRunId == j.runId ? Color.tDanger : Color.tPrimary)
            .frame(width: 64)
        }
        .buttonStyle(.glass)
        .disabled(j.runId == nil)
    }

    // MARK: journey row

    private func journeyRow(_ j: JourneyRow, isNext: Bool) -> some View {
        let running = j.state?.status == "running"
        let delay = j.depDelaySec ?? j.state?.operatorDelaySec
        let hasDelay = delay != nil && abs(delay!) >= 60
        let estDep = j.depEpoch + Double(delay ?? 0) * 1000
        let oursArr = j.state?.ourEstimate?.p50

        let content = HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 1) {
                if hasDelay {
                    Text(Fmt.hhmm(estDep))
                        .font(.system(size: 17, weight: .bold, design: .rounded))
                        .monospacedDigit()
                        .foregroundStyle(StatusUI.delayColor(delay))
                    Text(Fmt.hhmm(j.depEpoch))
                        .font(.system(size: 11))
                        .monospacedDigit()
                        .strikethrough()
                        .foregroundStyle(.tDim)
                } else {
                    Text(Fmt.hhmm(j.depEpoch))
                        .font(.system(size: 17, weight: isNext ? .bold : .semibold, design: .rounded))
                        .monospacedDigit()
                        .foregroundStyle(.tFg)
                }
            }
            .frame(width: 58, alignment: .leading)

            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 7) {
                    if let line = j.line { TBadge(line, .tPrimary) }
                    Text(j.trainNumber)
                        .font(.system(size: 11.5, weight: .medium))
                        .monospacedDigit()
                        .foregroundStyle(.tDim)
                    if running {
                        HStack(spacing: 4) {
                            Circle().fill(Color.tPrimary).frame(width: 5, height: 5)
                            Text("live").font(.system(size: 10.5, weight: .semibold))
                        }
                        .foregroundStyle(.tPrimary)
                    }
                }
                if let final = j.finalDestinationName, final != trip.toName {
                    Text("via " + final)
                        .font(.system(size: 11.5))
                        .foregroundStyle(.tMuted)
                        .lineLimit(1)
                }
            }

            Spacer(minLength: 8)

            VStack(alignment: .trailing, spacing: 1) {
                if let ours = oursArr {
                    Text(Fmt.hhmm(ours))
                        .font(.system(size: 17, weight: .semibold, design: .rounded))
                        .monospacedDigit()
                        .foregroundStyle(.tPrimary)
                    if ours != j.arrEpoch {
                        Text(Fmt.hhmm(j.arrEpoch))
                            .font(.system(size: 9.5))
                            .monospacedDigit()
                            .strikethrough()
                            .foregroundStyle(.tDim)
                    }
                } else {
                    Text(Fmt.hhmm(j.arrEpoch))
                        .font(.system(size: 17, weight: .semibold, design: .rounded))
                        .monospacedDigit()
                        .foregroundStyle(.tFg)
                }
            }
            .frame(width: 78, alignment: .trailing)
        }
        .padding(isNext ? 12 : 0)
        .background {
            if isNext {
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(Color.tPrimary.opacity(0.06))
                    .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color.tPrimary.opacity(0.18)))
            }
        }

        return Group {
            if let runId = j.runId {
                NavigationLink(value: runId) { content }.buttonStyle(.plain)
            } else {
                content.opacity(0.8)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 7)
    }

    private var hairline: some View {
        Rectangle().fill(Color.tBorder).frame(height: 0.7)
    }

    private var daySummary: String {
        if trip.days.count == 7 { return "every day" }
        if trip.days == Set(1...5) { return "weekdays" }
        if trip.days == Set([6, 7]) { return "weekends" }
        let names = [1: "Mon", 2: "Tue", 3: "Wed", 4: "Thu", 5: "Fri", 6: "Sat", 7: "Sun"]
        return trip.days.sorted().compactMap { names[$0] }.joined(separator: " ")
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
                    HStack(spacing: 8) {
                        ForEach(dayLabels, id: \.0) { d, label in
                            Button {
                                if trip.days.contains(d) { trip.days.remove(d) } else { trip.days.insert(d) }
                            } label: {
                                Text(label)
                                    .font(.system(size: 14, weight: .semibold))
                                    .frame(width: 34, height: 34)
                                    .background(
                                        Circle().fill(trip.days.contains(d) ? Color.tPrimary.opacity(0.18) : Color.white.opacity(0.05))
                                    )
                                    .overlay(Circle().strokeBorder(trip.days.contains(d) ? Color.tPrimary : Color.tBorder, lineWidth: 1))
                                    .foregroundStyle(trip.days.contains(d) ? Color.tPrimary : Color.tMuted)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
                Section {
                    Button(role: .destructive) {
                        done(trip, .delete)
                        dismiss()
                    } label: {
                        Label("Delete trip", systemImage: "trash")
                    }
                }
                Section {
                    Text("The home-screen widget follows the first trip in Your Trips — reorder by dragging is coming; the first trip you keep is the widget trip.")
                        .font(.system(size: 11.5))
                        .foregroundStyle(.tDim)
                }
            }
            .scrollContentBackground(.hidden)
            .navigationTitle("Edit trip")
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
        .preferredColorScheme(.dark)
    }

    private func settingRow(_ label: String, _ value: String) -> some View {
        HStack {
            Text(label).foregroundStyle(.tMuted)
            Spacer()
            Text(value).foregroundStyle(.tFg)
            Image(systemName: "chevron.right").font(.system(size: 11)).foregroundStyle(.tDim)
        }
    }
}
