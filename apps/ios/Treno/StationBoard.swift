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

/// The departures board for one station (the Stations tab). The passenger's
/// question is "what leaves from here next?" — destination-first rows,
/// live delays, quiet chrome.
struct StationBoardView: View {
    @AppStorage("stationId") private var stationId = "S01700"
    @AppStorage("stationName") private var stationName = "Milano Centrale"

    @State private var board: BoardResponse?
    @State private var errorText: String?
    @State private var loading = false
    @State private var showPicker = false
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
            } else if let board, visible.isEmpty {
                ContentUnavailableView(
                    "No departures",
                    systemImage: "tram.fill",
                    description: Text("Nothing is leaving \(stationName) in the next few hours.")
                )
            } else {
                ScrollViewReader { proxy in
                    List {
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
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    showPicker = true
                } label: {
                    Image(systemName: "building.2")
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
                TripStore.shared.noteUse(st.stopId)
                board = nil
                Task { await load() }
            }
        }
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
            NavigationLink(value: runId) {
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
