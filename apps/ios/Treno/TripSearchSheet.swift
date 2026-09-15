import SwiftUI

/// Transient trip finder: pick a start and a stop station, see the next
/// direct trains. Nothing is saved — unlike saved journeys/trips.
struct TripSearchSheet: View {
    @Environment(\.dismiss) private var dismiss

    @State private var from: Station?
    @State private var to: Station?
    @State private var pickingFrom = false
    @State private var pickingTo = false
    @State private var journeys: [JourneyRow] = []
    @State private var loading = false
    @State private var failed = false

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Button(action: { pickingFrom = true }) { endpointRow("From", from) }
                        .buttonStyle(.plain)
                    Button(action: { pickingTo = true }) { endpointRow("To", to) }
                        .buttonStyle(.plain)
                    Button {
                        let f = from
                        from = to
                        to = f
                        Task { await load() }
                    } label: {
                        Label("Swap direction", systemImage: "arrow.up.arrow.down")
                            .font(.body)
                            .foregroundStyle(.tPrimary)
                    }
                }
                if from != nil && to != nil {
                    Section {
                        if loading {
                            HStack(spacing: 10) {
                                ProgressView().controlSize(.small)
                                Text("Searching trains…").foregroundStyle(.tMuted)
                            }
                        } else if failed {
                            Text("Can't reach the server — pull to retry.")
                                .foregroundStyle(.tMuted)
                        } else if journeys.isEmpty {
                            Text("No direct trains found for this pair.")
                                .foregroundStyle(.tMuted)
                        }
                        ForEach(journeys) { j in
                            if let runId = j.runId {
                                NavigationLink(value: runId) { journeyRow(j) }
                                    .buttonStyle(.plain)
                            } else {
                                journeyRow(j).opacity(0.7)
                            }
                        }
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(Color.tBg)
            .navigationTitle("Find a trip")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .navigationDestination(for: Int.self) { runId in
                TrainDetailView(runId: runId)
            }
            .refreshable { await load() }
        }
        .preferredColorScheme(.dark)
        .tint(.tPrimary)
        .sheet(isPresented: $pickingFrom) {
            StationPickerSheet(currentId: from?.stopId ?? "") { st in
                from = st
                Task { await load() }
            }
            .presentationDetents([.medium, .large])
        }
        .sheet(isPresented: $pickingTo) {
            StationPickerSheet(currentId: to?.stopId ?? "") { st in
                to = st
                Task { await load() }
            }
            .presentationDetents([.medium, .large])
        }
        .task {
            if from == nil,
               let id = UserDefaults.standard.string(forKey: "stationId"),
               let name = UserDefaults.standard.string(forKey: "stationName") {
                from = Station(stopId: id, name: name)
            }
            await load()
        }
    }

    // MARK: rows

    private func endpointRow(_ label: String, _ station: Station?) -> some View {
        HStack(spacing: 12) {
            Text(label.uppercased())
                .font(.caption.weight(.semibold))
                .tracking(1.2)
                .foregroundStyle(.tDim)
                .frame(width: 44, alignment: .leading)
            Text(station?.name ?? "Choose station")
                .font(.body.weight(station == nil ? .regular : .semibold))
                .foregroundStyle(station == nil ? Color.tMuted : Color.tFg)
            Spacer()
            Image(systemName: "chevron.right")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.tertiary)
        }
        .contentShape(Rectangle())
    }

    private func journeyRow(_ j: JourneyRow) -> some View {
        let delay = j.depDelaySec ?? j.state?.operatorDelaySec
        let est = j.depEpoch + Double(delay ?? 0) * 1000
        return HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    if let line = j.line {
                        Text(line)
                            .font(.caption.weight(.bold))
                            .foregroundStyle(.tPrimary)
                    }
                    Text(j.trainNumber)
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.tDim)
                    if j.state?.status == "running" {
                        Circle().fill(Color.tPrimary).frame(width: 5, height: 5)
                    }
                }
                if let dest = j.finalDestinationName, dest != to?.name {
                    Text("via " + dest)
                        .font(.caption)
                        .foregroundStyle(.tMuted)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 8)
            Text(Fmt.hhmm(est))
                .font(.body.weight(.semibold).monospacedDigit())
                .foregroundStyle(delay != nil && abs(delay!) >= 60 ? StatusUI.delayColor(delay) : Color.tFg)
            Image(systemName: "arrow.right")
                .font(.caption2.weight(.bold))
                .foregroundStyle(.tDim)
            Text(Fmt.hhmm(j.arrEpoch))
                .font(.body.weight(.semibold).monospacedDigit())
                .foregroundStyle(.tFg)
        }
    }

    private func load() async {
        guard let f = from, let t = to else { return }
        loading = true
        failed = false
        do {
            journeys = try await APIClient.shared.journeys(from: f.stopId, to: t.stopId, limit: 8)
        } catch {
            failed = true
            journeys = []
        }
        loading = false
    }
}
