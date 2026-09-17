import MapKit
import SwiftUI

// MARK: - local station search

/// Instant ranked search over the cached station catalog: word prefixes
/// ("mil cen" → Milano Centrale), word initials ("mc"), or substring, with
/// busier stations first. No round-trip per keystroke.
struct StationSearchIndex {
    private struct Entry {
        let station: StationLite
        let folded: String
        let words: [String]
        let initials: String
    }
    private let entries: [Entry]

    init(stations: [StationLite]) {
        entries = stations.map { st in
            let folded = Self.fold(st.name)
            let words = folded.split(whereSeparator: \.isWhitespace).map(String.init)
            let initials = words.compactMap(\.first).map(String.init).joined()
            return Entry(station: st, folded: folded, words: words, initials: initials)
        }
    }

    static func fold(_ s: String) -> String {
        s.folding(options: [.diacriticInsensitive, .caseInsensitive], locale: nil)
    }

    func search(_ rawQuery: String, limit: Int = 20) -> [StationLite] {
        let tokens = Self.fold(rawQuery).split(whereSeparator: \.isWhitespace).map(String.init)
        guard !tokens.isEmpty else { return [] }
        var scored: [(StationLite, Int)] = []
        for e in entries {
            var score = 0
            var matched = true
            for t in tokens {
                if e.words.contains(where: { $0.hasPrefix(t) }) { score += 10 + t.count }
                else if e.initials.hasPrefix(t) { score += 8 + t.count }
                else if e.folded.contains(t) { score += 4 + t.count }
                else { matched = false; break }
            }
            guard matched else { continue }
            if e.folded.hasPrefix(tokens.joined(separator: " ")) { score += 6 }
            scored.append((e.station, score * 1000 + min(e.station.depCount, 999)))
        }
        return scored.sorted { lhs, rhs in
            lhs.1 != rhs.1 ? lhs.1 > rhs.1 : lhs.0.name.count < rhs.0.name.count
        }.prefix(limit).map(\.0)
    }
}

/// Station chooser: favorites and recently-used stations first, instant
/// full-text search, and an Apple Maps view for picking by geography.
struct StationPickerSheet: View {
    let currentId: String
    let onSelect: (Station) -> Void

    @Environment(\.dismiss) private var dismiss
    @StateObject private var store = TripStore.shared
    @State private var query = ""
    @State private var remoteResults: [Station] = []
    @State private var searching = false
    @State private var searchFailed = false
    @State private var catalog: [StationLite] = []
    @State private var index: StationSearchIndex?
    @State private var showMap = false

    static let suggested: [Station] = [
        Station(stopId: "S01700", name: "Milano Centrale"),
        Station(stopId: "S01645", name: "Milano Porta Garibaldi"),
        Station(stopId: "S01066", name: "Milano Cadorna"),
        Station(stopId: "S01701", name: "Milano Lambrate"),
        Station(stopId: "S01820", name: "Milano Rogoredo"),
        Station(stopId: "S01642", name: "Milano Bovisa Politecnico"),
        Station(stopId: "S01322", name: "Monza"),
        Station(stopId: "S01933", name: "Saronno"),
        Station(stopId: "S09999", name: "Brescia"),
        Station(stopId: "S01030", name: "Gallarate"),
    ]

    private var trimmed: String { query.trimmingCharacters(in: .whitespaces) }

    /// synchronous matches from the cached catalog — the primary path
    private var localResults: [Station] {
        guard trimmed.count >= 2, let index else { return [] }
        return index.search(trimmed).map { Station(stopId: $0.stopId, name: $0.name) }
    }

    var body: some View {
        NavigationStack {
            List {
                if trimmed.count >= 2 {
                    Section("Results") {
                        if !localResults.isEmpty {
                            ForEach(localResults) { st in stationRow(st) }
                        } else {
                            ForEach(remoteResults) { st in stationRow(st) }
                            if remoteResults.isEmpty {
                                Text(searching ? "Searching…" : searchFailed ? "Search is unavailable. Please try again." : "No stations found").foregroundStyle(.tMuted)
                            }
                        }
                    }
                } else {
                    if !favoriteStations.isEmpty {
                        Section("Favorites") {
                            ForEach(favoriteStations) { st in stationRow(st) }
                        }
                    }
                    if !recentStations.isEmpty {
                        Section("Recent") {
                            ForEach(recentStations) { st in stationRow(st) }
                        }
                    }
                    Section("Main stations") {
                        ForEach(Self.suggested) { st in stationRow(st) }
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(Color.tBg)
            // breathing room between the header and the first station rows
            .safeAreaInset(edge: .top, spacing: 0) {
                Color.tBg.frame(height: 10)
            }
            .searchable(
                text: $query,
                placement: .navigationBarDrawer(displayMode: .always),
                prompt: "Station name"
            )
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button {
                        showMap = true
                    } label: {
                        Image(systemName: "map").accessibilityLabel("Browse station map")
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .navigationTitle("Choose station")
            .navigationBarTitleDisplayMode(.inline)
        }
        .tint(.tPrimary)
        .fullScreenCover(isPresented: $showMap) {
            MapStationsView { lite in
                let st = Station(stopId: lite.stopId, name: lite.name)
                onSelect(st)
                dismiss()
            }
        }
        // server search only covers the gaps: stations outside the cached
        // catalog (e.g. no service today). Local matches need no network.
        .task(id: query) {
            let text = trimmed
            searchFailed = false
            guard text.count >= 2, localResults.isEmpty else { searching = false; return }
            remoteResults = []
            searching = true
            do {
                try await Task.sleep(for: .milliseconds(300))
                guard !Task.isCancelled else { return }
                let matches = try await APIClient.shared.stations(query: text)
                guard !Task.isCancelled else { return }
                remoteResults = matches
                searching = false
            } catch {
                guard !Task.isCancelled else { return }
                searching = false
                searchFailed = true
            }
        }
        .task {
            catalog = (try? await StationCatalog.shared.stations()) ?? []
            index = StationSearchIndex(stations: catalog)
        }
        .onAppear {
            let args = ProcessInfo.processInfo.arguments
            if args.contains("--map") { showMap = true }
            // debug: `--picker-query "mil cen"` fills the search field so the
            // local index results are capturable without synthetic typing
            if let i = args.firstIndex(of: "--picker-query"), i + 1 < args.count {
                query = args[i + 1]
            }
        }
    }

    /// favorites/frequent are stored as ids; resolve against the catalog and
    /// fall back to names we already know (suggested + trips + saved station)
    private var favoriteStations: [Station] {
        store.favorites
            .sorted()
            .compactMap { id in knownStations[id].map { Station(stopId: id, name: $0) } }
    }

    private var recentStations: [Station] {
        store.frequentStations()
            .filter { !store.favorites.contains($0) }
            .compactMap { id in knownStations[id].map { Station(stopId: id, name: $0) } }
    }

    /// station names we can resolve locally without another request
    private var knownStations: [String: String] {
        var m: [String: String] = [:]
        for st in Self.suggested { m[st.stopId] = st.name }
        if let id = UserDefaults.standard.string(forKey: "stationId"),
           let n = UserDefaults.standard.string(forKey: "stationName") {
            m[id] = n
        }
        for t in store.trips {
            m[t.fromStopId] = t.fromName
            m[t.toStopId] = t.toName
        }
        for st in catalog { m[st.stopId] = st.name }
        return m
    }

    private func stationRow(_ station: Station) -> some View {
        HStack(spacing: 8) {
            Button {
                onSelect(station)
                dismiss()
            } label: {
                HStack(spacing: 12) {
                    Image(systemName: "tram.fill").foregroundStyle(.tPrimary)
                    Text(station.name).font(.body).foregroundStyle(.tFg)
                    Spacer(minLength: 0)
                    if station.id == currentId {
                        Image(systemName: "checkmark").font(.subheadline.weight(.semibold)).foregroundStyle(.tPrimary)
                    }
                }.frame(minHeight: 44).contentShape(Rectangle())
            }.buttonStyle(.plain)
            Button(store.favorites.contains(station.id) ? "Remove \(station.name) from favorites" : "Favorite \(station.name)",
                   systemImage: store.favorites.contains(station.id) ? "star.fill" : "star") {
                store.toggleFavorite(station.id)
            }
            .labelStyle(.iconOnly).buttonStyle(.borderless)
            .foregroundStyle(store.favorites.contains(station.id) ? Color.tStar : Color.tDim)
            .frame(minWidth: 44, minHeight: 44)
        }
    }

}

// MARK: - map station browser

/// All stations on an Apple map; tap a pin to preview, then choose.
struct MapStationsView: View {
    let onSelect: (StationLite) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var stations: [StationLite] = []
    @State private var selection: StationLite?
    @State private var camera: MapCameraPosition = .region(MKCoordinateRegion(
        center: CLLocationCoordinate2D(latitude: 45.52, longitude: 9.25),
        span: MKCoordinateSpan(latitudeDelta: 0.65, longitudeDelta: 0.65)
    ))
    @State private var locating = false
    private let loc = LocationFetcher()

    var body: some View {
        ZStack(alignment: .bottom) {
            Map(position: $camera, selection: $selection) {
                UserAnnotation()
                ForEach(stations) { st in
                    if let lat = st.lat, let lon = st.lon {
                        Marker(st.name, coordinate: CLLocationCoordinate2D(latitude: lat, longitude: lon))
                            .tint(.tPrimary)
                            .tag(st)
                    }
                }
            }
            .mapStyle(.standard(pointsOfInterest: .excludingAll))
            // MapKit's compass can't be repositioned and owns the top-right —
            // we draw our own chrome instead
            .mapControlVisibility(.hidden)

            if stations.isEmpty {
                ProgressView().tint(.tPrimary).frame(maxHeight: .infinity)
            }
        }
        // native bottom sheet: system spring entrance, system rounded corners,
        // grabber + drag-to-dismiss — no custom card drawing
        .sheet(item: $selection) { sel in
            StationSheet(station: sel, onSelect: onSelect)
                .presentationDetents([.height(265)])
                .presentationBackground(Color.tBg)
                .presentationDragIndicator(.visible)
        }
        .overlay(alignment: .top) {
            GlassEffectContainer(spacing: 12) {
                HStack {
                    Button { locateMe() } label: {
                        Image(systemName: locating ? "location.fill" : "location")
                            .font(.body.weight(.semibold)).foregroundStyle(.tPrimary)
                            .frame(width: 48, height: 48).trenoGlass(cornerRadius: 24)
                    }
                    .buttonStyle(.plain).disabled(locating)
                    .accessibilityLabel("Show my location")
                    Spacer()
                    Button { dismiss() } label: {
                        Image(systemName: "xmark")
                            .font(.body.weight(.semibold)).foregroundStyle(.tFg)
                            .frame(width: 48, height: 48).trenoGlass(cornerRadius: 24)
                    }
                    .buttonStyle(.plain).accessibilityLabel("Close map")
                }
            }.padding(.horizontal, 16).padding(.top, 10)
        }
        .tint(.tPrimary)
        .task {
            stations = (try? await StationCatalog.shared.stations()) ?? []
            // debug: `--map-select <stopId>` selects a pin so the card is capturable
            let args = ProcessInfo.processInfo.arguments
            if let i = args.firstIndex(of: "--map-select"), i + 1 < args.count {
                let id = args[i + 1]
                if let st = stations.first(where: { $0.stopId == id }), let lat = st.lat, let lon = st.lon {
                    selection = st
                    camera = .region(MKCoordinateRegion(
                        center: CLLocationCoordinate2D(latitude: lat, longitude: lon),
                        span: MKCoordinateSpan(latitudeDelta: 0.25, longitudeDelta: 0.25)
                    ))
                }
            }
        }
    }

    private func locateMe() {
        locating = true
        loc.requestOnce { location in
            Task { @MainActor in
                locating = false
                guard let location else { return }
                camera = .region(MKCoordinateRegion(
                    center: location.coordinate,
                    span: MKCoordinateSpan(latitudeDelta: 0.08, longitudeDelta: 0.08)
                ))
            }
        }
    }
}

// MARK: - station sheet (map place card)

/// Apple-Maps-style place card: satellite snapshot of the station melting
/// into the sheet, name beneath, full-width Choose at the bottom.
private struct StationSheet: View {
    let station: StationLite
    let onSelect: (StationLite) -> Void

    @State private var snapshot: Image?

    var body: some View {
        VStack(spacing: 14) {
            snapshotView
                .frame(height: 128)
                .frame(maxWidth: .infinity)
                .clipped()

            Text(station.name)
                .font(.system(size: 18, weight: .bold))
                .foregroundStyle(.tFg)
                .padding(.horizontal, 20)

            Button {
                onSelect(station)
            } label: {
                Text("View departures")
                    .font(.system(size: 15, weight: .bold))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 13)
            }
            .buttonStyle(.glassProminent)
            .tint(.tPrimary)
            .padding(.horizontal, 20)
        }
        .padding(.top, 4)
        .padding(.bottom, 20)
        .background(Color.tBg)
        .task { await loadSnapshot() }
    }

    @ViewBuilder
    private var snapshotView: some View {
        ZStack(alignment: .bottom) {
            if let snapshot {
                snapshot
                    .resizable()
                    .scaledToFill()
            } else {
                Color.tElevated
            }
            // two-stage dissolve: the photo first frosts over progressively,
            // then the surface color completes it — no seam at the bottom
            Rectangle()
                .fill(.ultraThinMaterial)
                .mask(
                    LinearGradient(stops: [
                        .init(color: .clear, location: 0.30),
                        .init(color: .black, location: 0.95),
                    ], startPoint: .top, endPoint: .bottom)
                )
            LinearGradient(stops: [
                .init(color: .clear, location: 0.34),
                .init(color: Color.tBg.opacity(0.9), location: 0.78),
                .init(color: Color.tBg, location: 1.0),
            ], startPoint: .top, endPoint: .bottom)
        }
    }

    private func loadSnapshot() async {
        guard let lat = station.lat, let lon = station.lon else { return }
        let coordinate = CLLocationCoordinate2D(latitude: lat, longitude: lon)
        // ground-level Look Around photo, like an Apple Maps place card;
        // satellite from above as fallback where Look Around has no coverage
        if let image = await lookAroundImage(at: coordinate) {
            snapshot = image
        } else if let image = await satelliteImage(at: coordinate) {
            snapshot = image
        }
    }

    private func lookAroundImage(at coordinate: CLLocationCoordinate2D) async -> Image? {
        let request = MKLookAroundSceneRequest(coordinate: coordinate)
        guard let scene = try? await request.scene else { return nil }
        let options = MKLookAroundSnapshotter.Options()
        options.size = CGSize(width: 480, height: 300)
        let snapshotter = MKLookAroundSnapshotter(scene: scene, options: options)
        guard let shot = try? await snapshotter.snapshot else { return nil }
        return Image(uiImage: shot.image)
    }

    private func satelliteImage(at coordinate: CLLocationCoordinate2D) async -> Image? {
        let options = MKMapSnapshotter.Options()
        options.camera = MKMapCamera(lookingAtCenter: coordinate, fromDistance: 900, pitch: 0, heading: 0)
        options.mapType = .satellite
        options.size = CGSize(width: 480, height: 256)
        guard let shot = try? await MKMapSnapshotter(options: options).start() else { return nil }
        return Image(uiImage: shot.image)
    }
}
