import CoreLocation
import SwiftUI

struct AddTripView: View {
    @Environment(\.dismiss) private var dismiss
    @StateObject private var store = TripStore.shared
    @State private var from: Station?
    @State private var to: Station?
    @State private var name = ""
    @State private var endpoint: Endpoint?
    @State private var locating = false
    @State private var locationMessage: String?
    private let location = LocationFetcher()
    private enum Endpoint: String, Identifiable { case from, to; var id: String { rawValue } }
    private var canSave: Bool { from != nil && to != nil && from?.id != to?.id }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("Where do you travel?").font(.title2.weight(.bold))
                    Text("Save a route for quick access to its next trains.").foregroundStyle(.tMuted)
                }.listRowBackground(Color.clear).listRowSeparator(.hidden)
                Section {
                    Button { endpoint = .from } label: { endpointRow("From", station: from, icon: "circle") }
                    Button { endpoint = .to } label: { endpointRow("To", station: to, icon: "mappin.circle.fill") }
                    if from != nil || to != nil {
                        Button("Swap stations", systemImage: "arrow.up.arrow.down") { swap(&from, &to) }
                    }
                } header: { Text("Route") } footer: {
                    if from != nil && from?.id == to?.id { Text("Choose two different stations.").foregroundStyle(.tDanger) }
                }
                Section {
                    Button { useCurrentLocation() } label: {
                        HStack {
                            Label(locating ? "Finding your station…" : "Use nearest station", systemImage: "location")
                            Spacer()
                            if locating { ProgressView() }
                        }
                    }.disabled(locating)
                    if let locationMessage { Text(locationMessage).font(.footnote).foregroundStyle(.tMuted) }
                }
                Section("Name your journey") {
                    TextField("Optional, e.g. My commute", text: $name)
                }
            }
            .navigationTitle("New journey").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        guard let from, let to, canSave else { return }
                        store.add(Trip(fromStopId: from.id, fromName: from.name, toStopId: to.id, toName: to.name, name: name.trimmingCharacters(in: .whitespacesAndNewlines)))
                        dismiss()
                    }.disabled(!canSave)
                }
            }
            .sheet(item: $endpoint) { endpoint in
                StationPickerSheet(currentId: (endpoint == .from ? from?.id : to?.id) ?? "") { station in
                    if endpoint == .from { from = station } else { to = station }
                    store.noteUse(station.id)
                }
            }
        }.tint(.tPrimary)
    }

    private func endpointRow(_ label: String, station: Station?, icon: String) -> some View {
        HStack(spacing: 14) {
            Image(systemName: icon).foregroundStyle(.tPrimary).frame(width: 24)
            VStack(alignment: .leading, spacing: 5) {
                Text(label).font(.footnote).foregroundStyle(.tMuted)
                Text(station?.name ?? "Choose a station").font(.body).foregroundStyle(station == nil ? Color.tMuted : .tFg)
            }
            Spacer(minLength: 4)
            Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(.tertiary)
        }.padding(.vertical, 6)
    }

    private func useCurrentLocation() {
        locating = true
        locationMessage = nil
        location.requestOnce { result in
            Task { @MainActor in
                defer { locating = false }
                guard let result else {
                    locationMessage = "Location is unavailable. You can choose a station above."
                    return
                }
                _ = try? await StationCatalog.shared.stations()
                if let nearest = StationCatalog.shared.nearest(to: result.coordinate) {
                    from = Station(stopId: nearest.id, name: nearest.name)
                    store.noteUse(nearest.id)
                } else { locationMessage = "No station within 3 km. Choose a station above." }
            }
        }
    }
}
