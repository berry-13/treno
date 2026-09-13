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
            .mapControlVisibility(.hidden)

            if stations.isEmpty {
                ProgressView().tint(.tPrimary).frame(maxHeight: .infinity)
            }

            if let sel = selection {
                VStack(spacing: 10) {
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(sel.name).font(.system(size: 17, weight: .bold))
                            Text("\(sel.depCount) departures today")
                                .font(.system(size: 11.5))
                                .foregroundStyle(.tMuted)
                        }
                        Spacer()
                        Button {
                            onSelect(sel)
                        } label: {
                            Text("Choose")
                                .font(.system(size: 14, weight: .bold))
                                .padding(.horizontal, 18)
                                .padding(.vertical, 9)
                                .background(Color.tPrimary, in: Capsule())
                                .foregroundStyle(.black)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(16)
                .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                .padding(16)
            }
        }
        .overlay(alignment: .topTrailing) {
            HStack(spacing: 10) {
                Button {
                    locateMe()
                } label: {
                    Image(systemName: locating ? "location.fill" : "location")
                        .font(.system(size: 15, weight: .semibold))
                }
                .disabled(locating)
                Button {
                    dismiss()
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 22))
                        .foregroundStyle(.white.opacity(0.75))
                }
            }
            .padding(16)
        }
        .preferredColorScheme(.dark)
        .tint(.tPrimary)
        .task {
            stations = (try? await StationCatalog.shared.stations()) ?? []
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
