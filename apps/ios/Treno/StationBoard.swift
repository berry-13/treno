import Foundation
import SwiftUI

// MARK: - board models (GET /api/stops/:id/departures)

struct Station: Codable, Hashable, Identifiable {
    let stopId: String
    let name: String
    var network: String?
    var id: String { stopId }
    enum CodingKeys: String, CodingKey { case stopId = "stop_id", name = "stop_name", network }
    var isAtm: Bool { network == "atm" }
}

// MARK: - ATM board models (GET /api/atm/stops/:id/board) — the live values
// are the operator's own quantized WaitMessages, not our estimates (GOAL §21)

struct AtmBoardDeparture: Codable, Identifiable, Hashable {
    let line: String?
    let routeType: Int?
    let destinationName: String?
    let scheduledInSec: Int?
    let liveEtaSec: Int?
    let flag: String?
    var id: String { (line ?? "?") + "@" + String(scheduledInSec ?? 0) + "@" + (destinationName ?? "") }
}

struct AtmBoardResponse: Codable {
    struct StationRef: Codable { let stopId: String; let name: String }
    let station: StationRef
    let generatedAt: Double
    let departures: [AtmBoardDeparture]
    let liveLines: [AtmLiveLine]?
    struct AtmLiveLine: Codable { let line: String; let etaSec: Int?; let flag: String? }
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

extension BoardDeparture {
    var effectiveDelay: Int? {
        boardingDelay(depDelaySec: depDelaySec, actualDepEpoch: actualDepEpoch, state: state)
    }
    var isLive: Bool { state?.isFresh == true }
}

// MARK: - Departures

struct StationBoardView: View {
    @AppStorage("stationId") private var stationId = "S01700"
    @AppStorage("stationName") private var stationName = "Milano Centrale"
    @AppStorage("stationNetwork") private var stationNetwork = "rail"
    @StateObject private var store = TripStore.shared
    @State private var board: BoardResponse?
    @State private var atmBoard: AtmBoardResponse?
    @State private var failed = false
    @State private var loading = false
    @State private var requestID = UUID()
    @State private var showPicker = false
    @State private var now = Date.now
    private let refresh = Timer.publish(every: 15, on: .main, in: .common).autoconnect()

    private var departures: [BoardDeparture] {
        let nowMs = now.timeIntervalSince1970 * 1000
        return (board?.departures ?? []).filter { departure in
            if let actual = departure.actualDepEpoch { return actual >= nowMs }
            let expected = departure.depEpoch + Double(departure.effectiveDelay ?? 0) * 1000
            return expected >= nowMs - 60_000
        }
    }

    private var anyLive: Bool { departures.contains { $0.isLive } }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                stationSelector
                HStack(spacing: 8) {
                    SectionHeading(title: "Departures")
                    if loading && board == nil { ProgressView() }
                    else if anyLive {
                        Circle().fill(Color.tGood).frame(width: 7, height: 7)
                        Text("Live").font(.caption.weight(.semibold)).foregroundStyle(.tMuted)
                    }
                }
                if failed {
                    TravelNotice(title: "Updates are unavailable", message: board == nil ? "Check your connection and try again." : "These are the last available departures. Pull down to try again.")
                    if board == nil {
                        Button("Try again") { Task { await load(stationId) } }
                            .buttonStyle(.bordered).frame(maxWidth: .infinity)
                    }
                }
                if board != nil && departures.isEmpty && atmBoard == nil {
                    ContentUnavailableView("No upcoming departures", systemImage: "tram", description: Text("Try another station or check back later."))
                } else if !departures.isEmpty {
                    VStack(spacing: 0) {
                        ForEach(Array(departures.enumerated()), id: \.element.id) { index, departure in
                            if let runId = departure.runId {
                                NavigationLink(value: TrainRef(runId: runId, fromStopId: stationId)) { DepartureRow(departure: departure) }
                                    .buttonStyle(.plain)
                            } else {
                                DepartureRow(departure: departure)
                            }
                            if index < departures.count - 1 { Divider().padding(.leading, 20) }
                        }
                    }.background(Color.tCard, in: RoundedRectangle(cornerRadius: 22))
                }
                if let atm = atmBoard {
                    let rows = atm.departures.filter { d in
                        (d.liveEtaSec ?? d.scheduledInSec ?? 0) > -60
                    }
                    if !rows.isEmpty {
                        VStack(spacing: 0) {
                            ForEach(Array(rows.prefix(12).enumerated()), id: \.element.id) { index, departure in
                                AtmDepartureRow(departure: departure)
                                if index < min(rows.count, 12) - 1 { Divider().padding(.leading, 20) }
                            }
                        }.background(Color.tCard, in: RoundedRectangle(cornerRadius: 22))
                    }
                }
            }.padding(.horizontal, 20).padding(.bottom, 28)
        }
        .background { TrenoBackground() }
        .navigationTitle("Stations")
        .sheet(isPresented: $showPicker) {
            StationPickerSheet(currentId: stationId) { station in
                stationName = station.name
                stationId = station.id
                stationNetwork = station.network ?? "rail"
                store.noteUse(station.id)
            }
        }
        .task(id: stationId) {
            board = nil
            atmBoard = nil
            failed = false
            await load(stationId)
        }
        .onAppear {
            if ProcessInfo.processInfo.arguments.contains("--picker") || ProcessInfo.processInfo.arguments.contains("--map") { showPicker = true }
        }
        .refreshable { await load(stationId) }
        .onReceive(refresh) { date in
            now = date
            if !loading { Task { await load(stationId) } }
        }
    }

    private var stationSelector: some View {
        GlassEffectContainer(spacing: 12) {
            HStack(spacing: 12) {
                Button { showPicker = true } label: {
                    HStack(spacing: 12) {
                        Image(systemName: "tram.fill").foregroundStyle(.tPrimary)
                        Text(stationName).font(.title3.weight(.semibold)).foregroundStyle(.tFg)
                        Spacer(minLength: 0)
                        Image(systemName: "chevron.down").font(.caption.weight(.semibold)).foregroundStyle(.tMuted)
                    }
                    .padding(.horizontal, 20).frame(minHeight: 60)
                    .trenoGlass(cornerRadius: 30)
                }.buttonStyle(.plain).accessibilityHint("Choose another station")
                Button(store.favorites.contains(stationId) ? "Remove favorite" : "Favorite station",
                       systemImage: store.favorites.contains(stationId) ? "star.fill" : "star") {
                    store.toggleFavorite(stationId)
                }
                .labelStyle(.iconOnly).foregroundStyle(.tPrimary)
                .frame(width: 54, height: 54).trenoGlass(cornerRadius: 27)
                .buttonStyle(.plain)
            }
        }
    }

    private func load(_ requestedId: String) async {
        let request = UUID()
        requestID = request
        loading = true
        defer { if requestID == request { loading = false } }
        if stationNetwork == "atm" {
            do {
                let response = try await APIClient.shared.atmBoard(stopId: requestedId)
                guard requestID == request, requestedId == stationId, !Task.isCancelled else { return }
                atmBoard = response
                failed = false
            } catch {
                guard requestID == request, requestedId == stationId, !Task.isCancelled else { return }
                failed = true
            }
            return
        }
        do {
            let response = try await APIClient.shared.stationBoard(stopId: requestedId)
            guard requestID == request, requestedId == stationId, !Task.isCancelled else { return }
            board = response
            failed = false
        } catch {
            guard requestID == request, requestedId == stationId, !Task.isCancelled else { return }
            failed = true
        }
    }
}

/// ATM tram/bus lines with live countdowns (operator WaitMessages)
private struct AtmDepartureRow: View {
    let departure: AtmBoardDeparture
    var body: some View {
        HStack(spacing: 14) {
            Text(departure.line ?? "?")
                .font(.body.weight(.semibold)).monospacedDigit()
                .frame(minWidth: 36, minHeight: 28)
                .overlay(RoundedRectangle(cornerRadius: 7).strokeBorder(Color.tBorder, lineWidth: 1))
            VStack(alignment: .leading, spacing: 4) {
                Text(departure.destinationName ?? " ").font(.body.weight(.medium)).lineLimit(1)
                if departure.flag != nil {
                    Text("Recalculating").font(.footnote).foregroundStyle(.tMuted)
                }
            }
            Spacer(minLength: 4)
            if let eta = departure.liveEtaSec {
                Text(eta <= 60 ? "Arriving" : "\(Int((Double(eta) / 60.0).rounded())) min")
                    .font(.body.weight(.semibold)).foregroundStyle(.tPrimary)
            } else if let sched = departure.scheduledInSec, sched >= 0 {
                Text(sched <= 60 ? "Due" : "\(Int((Double(sched) / 60.0).rounded())) min")
                    .font(.body).foregroundStyle(.tMuted)
            }
        }.padding(16)
    }
}

private struct DepartureRow: View {
    let departure: BoardDeparture
    private var delay: Int? { departure.effectiveDelay }
    private var isLive: Bool { departure.isLive && delay != nil }
    private var cancelled: Bool { departure.state?.status == "cancelled" }

    var body: some View {
        let showSub = cancelled || (delay != nil && abs(delay!) >= 60)
        return VStack(alignment: .leading, spacing: showSub ? 12 : 0) {
            HStack(alignment: .top, spacing: 14) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(Fmt.hhmm(departure.depEpoch + Double(delay ?? 0) * 1000))
                        .font(.title2.weight(.semibold)).monospacedDigit().foregroundStyle(.tFg)
                        .strikethrough(cancelled)
                    if let delay, abs(delay) >= 60 {
                        Text(Fmt.hhmm(departure.depEpoch)).font(.footnote).strikethrough().foregroundStyle(.tMuted)
                    }
                }.frame(minWidth: 65, alignment: .leading)
                VStack(alignment: .leading, spacing: 6) {
                    Text(departure.destinationName ?? departure.state?.destination?.name ?? "Destination unavailable")
                        .font(.body.weight(.semibold)).foregroundStyle(.tFg).fixedSize(horizontal: false, vertical: true)
                    HStack(spacing: 7) {
                        if let line = departure.line { TBadge(line, .tPrimary) }
                        else { Text("Train \(departure.trainNumber)").font(.footnote).foregroundStyle(.tMuted) }
                        if isLive {
                            Circle().fill(Color.tGood).frame(width: 6, height: 6)
                        }
                    }
                }
                Spacer(minLength: 0)
                if let platform = Fmt.platform(departure.platform) { PlatformChip(platform: platform).padding(.top, 4) }
                else if departure.runId != nil { Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(.tertiary).padding(.top, 6) }
            }
            if cancelled || (delay != nil && abs(delay!) >= 60) {
                Text(cancelled ? "Cancelled" : Fmt.delayShort(delay))
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(cancelled ? Color.tDanger : StatusUI.delayColor(delay))
            }
        }.padding(20).contentShape(Rectangle())
    }
}
