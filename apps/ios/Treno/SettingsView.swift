import SwiftUI

/// Settings tab: server, live source health, collected-data stats, about.
struct SettingsView: View {
    @State private var url = APIClient.shared.baseUrl
    @State private var health: HealthResponse?
    @State private var saving = false

    var body: some View {
        ZStack {
            Color.tBg.ignoresSafeArea()
            Form {
                Section {
                    TextField("API base URL", text: $url)
                        .keyboardType(.URL)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                        .font(.system(size: 14, design: .monospaced))
                    Button("Save") {
                        APIClient.shared.baseUrl = url
                        Task { await loadHealth() }
                    }
                    .foregroundStyle(.tPrimary)
                } header: {
                    Text("Server")
                } footer: {
                    Text("The collector on your Mac — http://127.0.0.1:8787 from the simulator, http://<mac-lan-ip>:8787 from a device.")
                }

                Section("Sources") {
                    if let providers = health?.providers, !providers.isEmpty {
                        ForEach(providers) { p in
                            HStack(spacing: 10) {
                                Circle()
                                    .fill(p.healthState == "HEALTHY" ? Color.tPrimary : (p.healthState == "DEGRADED" ? Color.tLate : Color.tDanger))
                                    .frame(width: 7, height: 7)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(p.source)
                                        .font(.system(size: 14, weight: .medium))
                                    Text("\(p.okCount) ok · \(p.errCount) err · \(p.changedLastHour ?? 0) updates last hour")
                                        .font(.system(size: 11))
                                        .foregroundStyle(.tDim)
                                }
                                Spacer()
                                if let ms = p.lastLatencyMs {
                                    Text("\(ms) ms")
                                        .font(.system(size: 11).monospacedDigit())
                                        .foregroundStyle(.tMuted)
                                }
                            }
                        }
                    } else {
                        Text("no provider data")
                            .font(.system(size: 13))
                            .foregroundStyle(.tDim)
                    }
                }

                if let c = health?.counts {
                    Section("Collected so far") {
                        statRow("train runs seen", c.runs)
                        statRow("raw snapshots", c.snapshots)
                        statRow("observations", c.observations)
                        statRow("stop events", c.stopEvents)
                        statRow("predictions recorded", c.predictions)
                        statRow("predictions scored", c.scoredOutcomes)
                        statRow("segments with stats", c.segmentsWithStats)
                        statRow("service alerts", c.alerts)
                    }
                }

                Section("About") {
                    LabeledContent("Version", value: "0.1.0")
                    LabeledContent("Model", value: "heuristic-v1")
                    Text("Prediction quality claims appear only after the benchmark proves them against the operator's own ETAs. Times in Europe/Rome. Unofficial app built on public Trenord/RFI data.")
                        .font(.system(size: 11.5))
                        .foregroundStyle(.tDim)
                }
            }
            .scrollContentBackground(.hidden)
        }
        .navigationTitle("Settings")
        .task { await loadHealth() }
        .refreshable { await loadHealth() }
    }

    private func loadHealth() async {
        health = try? await APIClient.shared.health()
    }

    private func statRow(_ label: String, _ value: Int?) -> some View {
        HStack {
            Text(label).foregroundStyle(.tMuted)
            Spacer()
            Text((value ?? 0).formatted())
                .monospacedDigit()
                .foregroundStyle(.tFg)
        }
        .font(.system(size: 13.5))
    }
}
