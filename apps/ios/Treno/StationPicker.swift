import SwiftUI

/// Station chooser: search lives here (Contacts-style), not on the board —
/// passengers know their station, not their train number.
struct StationPickerSheet: View {
    let currentId: String
    let onSelect: (Station) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var results: [Station] = []
    @State private var searchTask: Task<Void, Never>?

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
                if trimmed.count < 2 {
                    Section("Main stations") {
                        ForEach(Self.suggested) { st in stationRow(st) }
                    }
                } else {
                    Section {
                        ForEach(results) { st in stationRow(st) }
                        if results.isEmpty {
                            Text("No stations found")
                                .foregroundStyle(.tDim)
                        }
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .searchable(
                text: $query,
                placement: .navigationBarDrawer(displayMode: .always),
                prompt: "Station name"
            )
            .navigationTitle("Choose station")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .preferredColorScheme(.dark)
        .tint(.tPrimary)
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
    }

    private func stationRow(_ st: Station) -> some View {
        Button {
            onSelect(st)
            dismiss()
        } label: {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(st.name)
                        .font(.system(size: 15, weight: .medium))
                        .foregroundStyle(.tFg)
                    Text(st.stopId)
                        .font(.system(size: 10.5))
                        .monospacedDigit()
                        .foregroundStyle(.tDim)
                }
                Spacer()
                if st.stopId == currentId {
                    Image(systemName: "checkmark")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(.tPrimary)
                }
            }
        }
    }
}
