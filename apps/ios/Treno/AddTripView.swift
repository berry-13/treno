import CoreLocation
import SwiftUI

/// Create a saved trip: pick origin (or use current location → nearest
/// station), pick destination, name it, choose days.
struct AddTripView: View {
    @Environment(\.dismiss) private var dismiss
    @StateObject private var store = TripStore.shared

    @State private var from: Station?
    @State private var to: Station?
    @State private var name = ""
    @State private var pickingFrom = false
    @State private var pickingTo = false
    @State private var locating = false
    @State private var locHint: String?

    private let loc = LocationFetcher()

    var body: some View {
        NavigationStack {
            Form {
                Section("Route") {
                    Button {
                        pickingFrom = true
                    } label: {
                        endpointRow(label: "From", station: from, icon: "play.circle")
                    }
                    Button {
                        useCurrentLocation()
                    } label: {
                        HStack {
                            if locating {
                                ProgressView().controlSize(.small)
                            } else {
                                Image(systemName: "location")
                            }
                            Text(locating ? "Locating…" : "Use my current location")
                                .font(.system(size: 14))
                            Spacer()
                            if let locHint {
                                Text(locHint).font(.system(size: 11)).foregroundStyle(.tDim)
                            }
                        }
                        .foregroundStyle(.tPrimary)
                    }
                    .disabled(locating)
                    Button {
                        pickingTo = true
                    } label: {
                        endpointRow(label: "To", station: to, icon: "mappin.circle")
                    }
                }
                Section("Name (optional)") {
                    TextField("e.g. Home → Office", text: $name)
                }
                Section {
                    Text("Trips appear on the board with a live next-train summary. The first trip also drives the home-screen widget.")
                        .font(.system(size: 11.5))
                        .foregroundStyle(.tDim)
                }
            }
            .scrollContentBackground(.hidden)
            .navigationTitle("New trip")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        guard let from, let to else { return }
                        store.add(Trip(fromStopId: from.stopId, fromName: from.name, toStopId: to.stopId, toName: to.name, name: name))
                        dismiss()
                    }
                    .foregroundStyle(.tPrimary)
                    .disabled(from == nil || to == nil)
                }
            }
            .sheet(isPresented: $pickingFrom) {
                StationPickerSheet(currentId: from?.stopId ?? "") { st in
                    from = st
                    store.noteUse(st.stopId)
                }
                .presentationDetents([.medium, .large])
            }
            .sheet(isPresented: $pickingTo) {
                StationPickerSheet(currentId: to?.stopId ?? "") { st in
                    to = st
                    store.noteUse(st.stopId)
                }
                .presentationDetents([.medium, .large])
            }
        }
        .preferredColorScheme(.dark)
        .tint(.tPrimary)
    }

    private func endpointRow(label: String, station: Station?, icon: String) -> some View {
        HStack(spacing: 12) {
            Image(systemName: icon)
                .font(.system(size: 16))
                .foregroundStyle(station == nil ? Color.tDim : Color.tPrimary)
                .frame(width: 24)
            VStack(alignment: .leading, spacing: 2) {
                Text(label)
                    .font(.system(size: 11))
                    .foregroundStyle(.tDim)
                Text(station?.name ?? "Choose station")
                    .font(.system(size: 15, weight: station == nil ? .regular : .semibold))
                    .foregroundStyle(station == nil ? Color.tMuted : Color.tFg)
            }
            Spacer()
            Image(systemName: "chevron.right").font(.system(size: 11)).foregroundStyle(.tDim)
        }
    }

    private func useCurrentLocation() {
        locating = true
        locHint = nil
        loc.requestOnce { location in
            Task { @MainActor in
                locating = false
                guard let location else {
                    locHint = "unavailable"
                    return
                }
                let coord = location.coordinate
                if let nearest = StationCatalog.shared.nearest(to: coord) {
                    from = Station(stopId: nearest.stopId, name: nearest.name)
                    store.noteUse(nearest.stopId)
                } else {
                    locHint = "no station within 3 km"
                }
            }
        }
    }
}
