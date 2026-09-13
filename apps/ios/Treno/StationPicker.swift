import MapKit
import SwiftUI

/// Station chooser: favorites and frequently-used stations first, full-text
/// search, and an Apple Maps view for picking by geography instead of name.
struct StationPickerSheet: View {
    let currentId: String
    let onSelect: (Station) -> Void

    @Environment(\.dismiss) private var dismiss
    @StateObject private var store = TripStore.shared
    @State private var query = ""
    @State private var results: [Station] = []
    @State private var searchTask: Task<Void, Never>?
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

    var body: some View {
        NavigationStack {
            List {
                if trimmed.count >= 2 {
                    Section("Results") {
                        ForEach(results) { st in stationRow(st) }
                        if results.isEmpty {
                            Text("No stations found").foregroundStyle(.tDim)
                        }
                    }
                } else {
                    if !favoriteStations.isEmpty {
                        Section("Favorites") {
                            ForEach(favoriteStations) { st in stationRow(st) }
                        }
                    }
                    if !frequentStations.isEmpty {
                        Section("Frequent") {
                            ForEach(frequentStations) { st in stationRow(st) }
                        }
                    }
                    Section("Main stations") {
                        ForEach(Self.suggested) { st in stationRow(st) }
                    }
                }
            }
            .scrollContentBackground(.hidden)
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
                        Image(systemName: "map")
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .navigationTitle("Choose station")
            .navigationBarTitleDisplayMode(.inline)
        }
        .preferredColorScheme(.dark)
        .tint(.tPrimary)
        .fullScreenCover(isPresented: $showMap) {
            MapStationsView { lite in
                let st = Station(stopId: lite.stopId, name: lite.name)
                onSelect(st)
                dismiss()
            }
        }
        .onChange(of: query) { _, q in
            searchTask?.cancel()
            searchTask = Task {
                try? await Task.sleep(for: .milliseconds(250))
                guard !Task.isCancelled else { return }
                if let r = try? await APIClient.shared.stations(query: q) {
                    results = r
                }
            }
        }
        .task {
            // warm the catalog so favorites/frequent rows can resolve names
            _ = try? await StationCatalog.shared.stations()
        }
        .onAppear {
            if ProcessInfo.processInfo.arguments.contains("--map") { showMap = true }
        }
    }

    /// favorites/frequent are stored as ids; resolve against the catalog and
    /// fall back to names we already know (suggested + trips + saved station)
    private var favoriteStations: [Station] {
        store.favorites
            .sorted()
            .compactMap { id in knownStations[id].map { Station(stopId: id, name: $0) } }
    }

    private var frequentStations: [Station] {
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
        if let cache = StationCatalog.shared.cache {
            for st in cache { m[st.stopId] = st.name }
        }
        return m
    }

    private func stationRow(_ st: Station) -> some View {
        Button {
            onSelect(st)
            dismiss()
        } label: {
            HStack {
                Text(st.name)
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(.tFg)
                Spacer()
                if st.stopId == currentId {
                    Image(systemName: "checkmark")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(.tPrimary)
                }
                Button {
                    store.toggleFavorite(st.stopId)
                } label: {
                    Image(systemName: store.favorites.contains(st.stopId) ? "star.fill" : "star")
                        .font(.system(size: 14))
                        .foregroundStyle(store.favorites.contains(st.stopId) ? Color.tLate : Color.tDim)
                }
                .buttonStyle(.borderless)
            }
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
            VStack(spacing: 16) {
                VStack(spacing: 4) {
                    Text(sel.name)
                        .font(.system(size: 19, weight: .bold))
                        .foregroundStyle(.tFg)
                    Text("\(sel.depCount) departures today")
                        .font(.system(size: 12.5))
                        .foregroundStyle(.tMuted)
                }
                Button {
                    onSelect(sel)
                } label: {
                    Text("Choose")
                        .font(.system(size: 15, weight: .bold))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 13)
                }
                .buttonStyle(.glass)
                .tint(.tPrimary)
            }
            .padding(.horizontal, 20)
            .padding(.top, 14)
            .padding(.bottom, 20)
            .presentationDetents([.height(200)])
            .presentationBackground(.thinMaterial)
            .presentationDragIndicator(.visible)
        }
        .overlay(alignment: .topLeading) {
            Button {
                locateMe()
            } label: {
                Image(systemName: locating ? "location.fill" : "location")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(.tPrimary)
                    .frame(width: 42, height: 42)
                    .glassEffect(.clear.interactive(), in: Circle())
            }
            .buttonStyle(.plain)
            .disabled(locating)
            .padding(.leading, 16)
            .padding(.top, 10)
        }
        .overlay(alignment: .topTrailing) {
            Button {
                dismiss()
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 15, weight: .bold))
                    .foregroundStyle(.white.opacity(0.92))
                    .frame(width: 42, height: 42)
                    .glassEffect(.clear.interactive(), in: Circle())
            }
            .buttonStyle(.plain)
            .padding(.trailing, 16)
            .padding(.top, 10)
        }
        .preferredColorScheme(.dark)
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
