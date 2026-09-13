import Foundation
import SwiftUI

// MARK: - board models (GET /api/stops/:id/departures)

struct Station: Codable, Hashable, Identifiable {
    let stopId: String
    let name: String
    var id: String { stopId }
    enum CodingKeys: String, CodingKey { case stopId = "stop_id", name = "stop_name" }
}

struct BoardDeparture: Codable, Identifiable, Hashable {
    let runId: Int?
    let trainNumber: String
    let line: String?
    let destinationName: String?
    let depEpoch: Double
    let platform: String?
    let depDelaySec: Int?
    let actualDepEpoch: Double?
    let state: TrainState?
    var id: String { trainNumber + "@" + String(Int(depEpoch)) }
}

struct BoardResponse: Codable {
    struct StationRef: Codable { let stopId: String; let name: String }
    let station: StationRef
    let generatedAt: Double
    let departures: [BoardDeparture]
}

// MARK: - board

/// The passenger's question is "what leaves from here next?" — not "which of
/// the 80 tracked trains is mine". The board is station-scoped and sorted by
/// departure, with the user's saved trips live-summarized above it.
struct StationBoardView: View {
    @Binding var path: NavigationPath

    @AppStorage("stationId") private var stationId = "S01700"
    @AppStorage("stationName") private var stationName = "Milano Centrale"

    @StateObject private var store = TripStore.shared
    @State private var board: BoardResponse?
    @State private var nextByTrip: [UUID: JourneyRow?] = [:]
    @State private var errorText: String?
    @State private var loading = false
    @State private var showPicker = false
    @State private var showSettings = false
    @State private var showAddTrip = false
    @State private var now = Date.now

    private let refresh = Timer.publish(every: 15, on: .main, in: .common).autoconnect()
    private let ticker = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

    private var nowMs: Double { now.timeIntervalSince1970 * 1000 }

    /// upcoming departures, plus trains that left this station in the last 10
    /// minutes (still useful: "just missed it" / track it)
    private var visible: [BoardDeparture] {
        guard let board else { return [] }
        let cut = nowMs - 10 * 60_000
        return board.departures.filter { d in
            if let a = d.actualDepEpoch { return a > cut }
            return d.depEpoch > cut
        }
    }

    var body: some View {
        ZStack {
            Color.tBg.ignoresSafeArea()
            if let errorText, board == nil {
                ContentUnavailableView {
                    Label("Can't reach treno", systemImage: "wifi.exclamationmark")
                } description: {
                    Text(errorText)
                }
            } else if let board, visible.isEmpty, store.trips.isEmpty {
                ContentUnavailableView(
                    "No departures",
                    systemImage: "tram.fill",
                    description: Text("Nothing is leaving \(stationName) in the next few hours.")
                )
            } else {
                ScrollViewReader { proxy in
                    List {
                        if !store.trips.isEmpty {
                            tripsSection
                        }
                        departuresSection
                    }
                    .scrollContentBackground(.hidden)
                    .onAppear { maybeDebugScroll(proxy) }
                    .onChange(of: board == nil) { _, _ in maybeDebugScroll(proxy) }
                }
            }
        }
        .navigationTitle(stationName)
        // solid bar once the large title collapses — no Liquid Glass mirror of
        // scrolling rows, and no forced visibility (forcing it renders the
        // inline title over the half-collapsed large title)
        .toolbarBackground(Color.tBg, for: .navigationBar)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button {
                    showPicker = true
                } label: {
                    Image(systemName: "building.2")
                }
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    showAddTrip = true
                } label: {
                    Image(systemName: "heart")
                }
            }
        }
        .overlay(alignment: .top) {
            if loading && board == nil {
                ProgressView().tint(.tPrimary).padding(.top, 80)
            }
        }
        .sheet(isPresented: $showPicker) {
            StationPickerSheet(currentId: stationId) { st in
                stationId = st.stopId
                stationName = st.name
                store.noteUse(st.stopId)
                board = nil
                Task { await load() }
            }
        }
        .sheet(isPresented: $showSettings) { SettingsSheet() }
        .sheet(isPresented: $showAddTrip) { AddTripView() }
        .refreshable { await load() }
        .onAppear {
            if ProcessInfo.processInfo.arguments.contains("--picker") { showPicker = true }
            Task { await load() }
        }
        .onReceive(refresh) { _ in
            guard !loading else { return }
            Task { await load() }
        }
        .onReceive(ticker) { now = $0 }
    }

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            board = try await APIClient.shared.stationBoard(stopId: stationId)
            errorText = nil
        } catch {
            errorText = error.localizedDescription
        }
        await loadTripSummaries()
    }

    /// next direct train for every saved trip (board-level live summary)
    private func loadTripSummaries() async {
        guard !store.trips.isEmpty else { return }
        await withTaskGroup(of: (UUID, JourneyRow?).self) { group in
            for trip in store.trips where trip.runsToday {
                group.addTask {
                    let next = try? await APIClient.shared.journeys(from: trip.fromStopId, to: trip.toStopId, limit: 3)
                    let best = next?.first { j in
                        (j.actualDepEpoch == nil || j.state?.status == "running") && j.depEpoch + 10 * 60_000 > Date.now.timeIntervalSince1970 * 1000
                    } ?? next?.last
                    return (trip.id, best)
                }
            }
            for await (id, next) in group {
                nextByTrip[id] = next
            }
        }
    }

    /// debug hook: `simctl launch <dev> com.treno.Treno --scroll` scrolls the
    /// board so collapsed-header states can be screenshotted
    private func maybeDebugScroll(_ proxy: ScrollViewProxy) {
        guard ProcessInfo.processInfo.arguments.contains("--scroll"),
              let last = visible.last?.id else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) {
            proxy.scrollTo(last, anchor: .top)
        }
    }

    // MARK: trips section

    private var tripsSection: some View {
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
        } header: {
            Text("YOUR TRIPS")
                .font(.system(size: 10.5, weight: .semibold))
                .tracking(1.4)
                .foregroundStyle(.tDim)
        }
    }

    private var departuresSection: some View {
        Section {
            ForEach(visible) { d in
                row(d)
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
                    .listRowInsets(EdgeInsets(top: 9, leading: 20, bottom: 9, trailing: 20))
            }
            Text("Trenord MIA + Viaggiatreno · auto-refresh · times in Europe/Rome")
                .font(.system(size: 10.5))
                .foregroundStyle(.tDim)
                .frame(maxWidth: .infinity, alignment: .center)
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
        } header: {
            Text("DEPARTURES")
                .font(.system(size: 10.5, weight: .semibold))
                .tracking(1.4)
                .foregroundStyle(.tDim)
        }
    }

    // MARK: departure row

    @ViewBuilder
    private func row(_ d: BoardDeparture) -> some View {
        let status = d.state?.status
        let cancelled = status == "cancelled"
        let departed = d.actualDepEpoch != nil && d.actualDepEpoch! < nowMs
        let delay = d.depDelaySec ?? d.state?.operatorDelaySec
        let hasDelay = delay != nil && abs(delay!) >= 60
        let estEpoch = d.depEpoch + Double(delay ?? 0) * 1000

        let content = HStack(spacing: 12) {
            // time: live estimate when delayed, scheduled below struck through
            VStack(alignment: .leading, spacing: 1) {
                if hasDelay {
                    Text(Fmt.hhmm(estEpoch))
                        .font(.system(size: 17, weight: .bold, design: .rounded))
                        .monospacedDigit()
                        .foregroundStyle(cancelled ? Color.tDanger : StatusUI.delayColor(delay))
                    Text(Fmt.hhmm(d.depEpoch))
                        .font(.system(size: 11))
                        .monospacedDigit()
                        .strikethrough()
                        .foregroundStyle(.tDim)
                } else {
                    Text(Fmt.hhmm(d.depEpoch))
                        .font(.system(size: 17, weight: departed ? .medium : .semibold, design: .rounded))
                        .monospacedDigit()
                        .foregroundStyle(departed ? Color.tDim : Color.tFg)
                }
            }
            .frame(width: 58, alignment: .leading)

            VStack(alignment: .leading, spacing: 3) {
                Text(d.destinationName ?? d.state?.destination?.name ?? "—")
                    .font(.system(size: 16, weight: departed ? .regular : .semibold))
                    .foregroundStyle(departed ? Color.tMuted : Color.tFg)
                    .strikethrough(cancelled, color: .tDanger)
                    .lineLimit(1)
                HStack(spacing: 7) {
                    if let line = d.line {
                        TBadge(line, .tPrimary)
                    }
                    Text(d.trainNumber)
                        .font(.system(size: 11.5, weight: .medium))
                        .monospacedDigit()
                        .foregroundStyle(.tDim)
                    if status == "running" && !departed {
                        HStack(spacing: 4) {
                            Circle().fill(Color.tPrimary).frame(width: 5, height: 5)
                            Text("live").font(.system(size: 10.5, weight: .semibold))
                        }
                        .foregroundStyle(.tPrimary)
                    }
                    if cancelled {
                        TBadge("cancelled", .tDanger)
                    } else if departed {
                        Text("departed").font(.system(size: 11)).foregroundStyle(.tDim)
                    }
                }
            }

            Spacer(minLength: 8)
            trailing(d, delay: delay)
            if d.runId != nil {
                Image(systemName: "chevron.right")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(.tDim)
            }
        }

        if let runId = d.runId {
            Button {
                path.append(runId)
            } label: {
                content
            }
            .buttonStyle(.plain)
        } else {
            content.opacity(0.85)
        }
    }

    /// platform when known, otherwise the delay itself
    @ViewBuilder
    private func trailing(_ d: BoardDeparture, delay: Int?) -> some View {
        if let plat = d.platform, let n = Int(plat), n >= 1, n <= 30 {
            VStack(spacing: 0) {
                Text(plat)
                    .font(.system(size: 15, weight: .bold, design: .rounded))
                    .monospacedDigit()
                    .foregroundStyle(.tFg)
                Text("bin")
                    .font(.system(size: 8.5))
                    .foregroundStyle(.tDim)
            }
            .frame(width: 30)
        } else if let s = delay, abs(s) >= 60 {
            Text(Fmt.delayShort(s))
                .font(.system(size: 15, weight: .bold, design: .rounded))
                .monospacedDigit()
                .foregroundStyle(StatusUI.delayColor(s))
                .frame(width: 30, alignment: .trailing)
        }
    }
}

// MARK: - trip summary row (board-level)

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
                    Text("arr " + Fmt.hhmm(j.arrEpoch + Double(arrDelay(j)) * 1000))
                        .font(.system(size: 10.5))
                        .monospacedDigit()
                        .foregroundStyle(.tDim)
                }
            }
        }
        .onReceive(Timer.publish(every: 30, on: .main, in: .common).autoconnect()) { now = $0 }
    }

    private func arrDelay(_ j: JourneyRow) -> Int {
        // prefer our p50 arrival delta vs schedule at the destination
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

// MARK: - settings

struct SettingsSheet: View {
    @Environment(\.dismiss) private var dismiss
    @State private var url = APIClient.shared.baseUrl

    var body: some View {
        NavigationStack {
            Form {
                Section("Server") {
                    TextField("API base URL", text: $url)
                        .keyboardType(.URL)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                        .font(.system(size: 14, design: .monospaced))
                    Text("The collector on your Mac — http://127.0.0.1:8787 from the simulator, http://<mac-lan-ip>:8787 from a device.")
                        .font(.system(size: 11.5))
                        .foregroundStyle(.tDim)
                }
            }
            .scrollContentBackground(.hidden)
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        APIClient.shared.baseUrl = url
                        dismiss()
                    }
                    .foregroundStyle(.tPrimary)
                }
            }
        }
        .preferredColorScheme(.dark)
    }
}
