import SwiftUI

/// The actual home: your trips live-summarized, favorite stations one tap
/// away, network health at a glance. Not a data dump — a answer to
/// "what do I care about right now?".
struct HomeView: View {
    /// set the board station and jump to the Stations tab
    let openStation: (String, String) -> Void

    @StateObject private var store = TripStore.shared
    @State private var nextByTrip: [UUID: JourneyRow?] = [:]
    @State private var nextByFavorite: [String: BoardDeparture?] = [:]
    @State private var showAddTrip = false
    @State private var now = Date.now

    private let refresh = Timer.publish(every: 30, on: .main, in: .common).autoconnect()

    private var greeting: String {
        let h = Calendar.current.component(.hour, from: now)
        if h < 6 { return "Good night" }
        if h < 12 { return "Good morning" }
        if h < 18 { return "Good afternoon" }
        return "Good evening"
    }

    private var favoriteStations: [(String, String)] {
        store.favorites.sorted().compactMap { id in
            guard let name = StationCatalog.shared.name(for: id) ?? knownName(id) else { return nil }
            return (id, name)
        }
    }

    var body: some View {
        ZStack {
            Color.tBg.ignoresSafeArea()
            ScrollView {
                VStack(alignment: .leading, spacing: 26) {
                    dateLine
                    tripsSection
                    if !favoriteStations.isEmpty {
                        favoritesSection
                    }
                }
                .padding(.top, 4)
                .padding(.bottom, 40)
            }
        }
        .navigationTitle(greeting)
        .toolbarBackground(Color.tBg, for: .navigationBar)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    showAddTrip = true
                } label: {
                    Image(systemName: "plus.circle.fill")
                        .font(.system(size: 20))
                }
            }
        }
        .sheet(isPresented: $showAddTrip) { AddTripView() }
        .refreshable { await load() }
        .task {
            _ = try? await StationCatalog.shared.stations()
            await load()
        }
        .onReceive(refresh) { _ in Task { await load() } }
    }

    private func load() async {
        await withTaskGroup(of: Void.self) { group in
            group.addTask { await loadTripSummaries() }
            group.addTask { await loadFavorites() }
        }
    }

    private func loadTripSummaries() async {
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

    private func loadFavorites() async {
        let favs = favoriteStations
        guard !favs.isEmpty else { return }
        await withTaskGroup(of: (String, BoardDeparture?).self) { group in
            for (id, _) in favs {
                group.addTask {
                    let board = try? await APIClient.shared.stationBoard(stopId: id)
                    let nowMs = Date.now.timeIntervalSince1970 * 1000
                    let next = board?.departures.first { $0.depEpoch > nowMs - 10 * 60_000 }
                    return (id, next)
                }
            }
            for await (id, next) in group {
                nextByFavorite[id] = next
            }
        }
    }

    // MARK: pieces

    private var dateLine: some View {
        Text(now.formatted(.dateTime.weekday(.wide).day().month(.wide)))
            .font(.system(size: 13, weight: .medium))
            .foregroundStyle(.tMuted)
            .padding(.horizontal, 20)
    }

    private var tripsSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            if store.trips.isEmpty {
                Button {
                    showAddTrip = true
                } label: {
                    VStack(spacing: 8) {
                        Image(systemName: "heart")
                            .font(.system(size: 24))
                            .foregroundStyle(.tPrimary)
                        Text("Save your first trip")
                            .font(.system(size: 16, weight: .semibold))
                            .foregroundStyle(.tFg)
                        Text("e.g. Sesto S.Giovanni → Arcore — you'll see the next train right here, every day.")
                            .font(.system(size: 12.5))
                            .foregroundStyle(.tMuted)
                            .multilineTextAlignment(.center)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(24)
                    .background(Color.tCard, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(Color.tBorder))
                }
                .buttonStyle(.plain)
            } else {
                VStack(spacing: 10) {
                    ForEach(store.trips) { trip in
                        NavigationLink(value: trip) {
                            TripCard(trip: trip, next: nextByTrip[trip.id] ?? nil)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal, 20)
            }
        }
    }

    private var favoritesSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(spacing: 0) {
                ForEach(Array(favoriteStations.enumerated()), id: \.element.0) { i, fav in
                    favoriteRow(fav)
                    if i < favoriteStations.count - 1 {
                        Rectangle().fill(Color.tBorder).frame(height: 0.7).padding(.horizontal, 20)
                    }
                }
            }
            .background(Color.tCard, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(Color.tBorder))
            .padding(.horizontal, 20)
        }
    }

    private func favoriteRow(_ fav: (String, String)) -> some View {
        let next = nextByFavorite[fav.0] ?? nil
        let delay = next?.depDelaySec ?? next?.state?.operatorDelaySec
        return Button {
            store.noteUse(fav.0)
            openStation(fav.0, fav.1)
        } label: {
            HStack(spacing: 12) {
                Image(systemName: "star.fill")
                    .font(.system(size: 12))
                    .foregroundStyle(.tLate)
                    .frame(width: 18)
                VStack(alignment: .leading, spacing: 2) {
                    Text(fav.1)
                        .font(.system(size: 15.5, weight: .semibold))
                        .foregroundStyle(.tFg)
                    if let n = next {
                        Text("\(n.trainNumber) · \(n.destinationName ?? "")")
                            .font(.system(size: 11.5))
                            .foregroundStyle(.tMuted)
                            .lineLimit(1)
                    }
                }
                Spacer()
                if let n = next {
                    VStack(alignment: .trailing, spacing: 1) {
                        Text(Fmt.hhmm(n.depEpoch + Double(delay ?? 0) * 1000))
                            .font(.system(size: 16, weight: .bold, design: .rounded))
                            .monospacedDigit()
                            .foregroundStyle(delay != nil && delay! >= 60 ? StatusUI.delayColor(delay) : Color.tFg)
                        if let l = n.line {
                            Text(l)
                                .font(.system(size: 10.5, weight: .semibold))
                                .foregroundStyle(.tPrimary)
                        }
                    }
                } else {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(.tDim)
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    /// names we know without the catalog (suggestions, current board station, trips)
    private func knownName(_ id: String) -> String? {
        if id == UserDefaults.standard.string(forKey: "stationId") {
            return UserDefaults.standard.string(forKey: "stationName")
        }
        for t in store.trips {
            if t.fromStopId == id { return t.fromName }
            if t.toStopId == id { return t.toName }
        }
        return nil
    }
}

// MARK: - trip card (home)

/// Big live card: route, countdown to departure, times with our estimate.
struct TripCard: View {
    let trip: Trip
    let next: JourneyRow?

    private var delay: Int? { next?.depDelaySec ?? next?.state?.operatorDelaySec }
    private var estDep: Double? {
        guard let j = next else { return nil }
        return j.depEpoch + Double(delay ?? 0) * 1000
    }
    private var arrDelay: Int? {
        guard let j = next else { return nil }
        if let ours = j.state?.ourEstimate, let sched = j.state?.schedArrEpoch {
            return Int(((ours.p50 - sched) / 1000).rounded())
        }
        return delay
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(trip.displayName)
                        .font(.system(size: 17, weight: .bold))
                        .foregroundStyle(.tFg)
                        .lineLimit(1)
                    HStack(spacing: 7) {
                        if let j = next {
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
                            }
                        } else if !trip.runsToday {
                            Text("not scheduled today")
                                .font(.system(size: 11.5))
                                .foregroundStyle(.tDim)
                        } else {
                            Text("no more trains today")
                                .font(.system(size: 11.5))
                                .foregroundStyle(.tDim)
                        }
                    }
                }
                Spacer(minLength: 10)
                if let j = next, trip.runsToday {
                    if j.state?.status == "running" {
                        Text("now")
                            .font(.system(size: 22, weight: .heavy, design: .rounded))
                            .foregroundStyle(.tPrimary)
                    } else if let est = estDep {
                        let mins = Int(((est - Date.now.timeIntervalSince1970 * 1000) / 60_000).rounded())
                        if mins >= 0 {
                            Text(mins < 60 ? "in \(mins)m" : "in \(mins / 60)h\(mins % 60 != 0 ? " \(mins % 60)m" : "")")
                                .font(.system(size: 22, weight: .heavy, design: .rounded))
                                .monospacedDigit()
                                .foregroundStyle(delay != nil && delay! >= 60 ? StatusUI.delayColor(delay) : Color.tPrimary)
                        } else {
                            Text("departed")
                                .font(.system(size: 14, weight: .semibold))
                                .foregroundStyle(.tDim)
                        }
                    }
                }
            }

            if let j = next, trip.runsToday {
                HStack(spacing: 10) {
                    Text(Fmt.hhmm(estDep ?? j.depEpoch))
                        .font(.system(size: 19, weight: .semibold, design: .rounded))
                        .monospacedDigit()
                        .foregroundStyle(delay != nil && abs(delay!) >= 60 ? StatusUI.delayColor(delay) : Color.tFg)
                    Image(systemName: "arrow.right")
                        .font(.system(size: 11, weight: .bold))
                        .foregroundStyle(.tDim)
                    Text(Fmt.hhmm(j.arrEpoch + Double(arrDelay ?? 0) * 1000))
                        .font(.system(size: 19, weight: .semibold, design: .rounded))
                        .monospacedDigit()
                        .foregroundStyle(arrDelay != nil && abs(arrDelay!) >= 60 ? StatusUI.delayColor(arrDelay) : (arrDelay != nil ? Color.tPrimary : Color.tFg))
                    Spacer()
                    if let p = j.platform, let n = Int(p), n >= 1, n <= 30 {
                        Text(p)
                            .font(.system(size: 13.5, weight: .bold, design: .rounded))
                            .monospacedDigit()
                            .foregroundStyle(.tFg)
                            .frame(width: 26, height: 24)
                            .background(Color.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 7, style: .continuous))
                    }
                }
            }
        }
        .padding(16)
        .background(Color.tCard, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(Color.tBorder))
    }
}
