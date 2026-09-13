import SwiftUI

/// Settings: server connection and about. The engineering internals (source
/// health, ok/err counters, dataset stats) intentionally live in the web
/// dashboard, not here.
struct SettingsView: View {
    @AppStorage("stationId") private var stationId = "S01700"
    @AppStorage("stationName") private var stationName = "Milano Centrale"
    @State private var url = APIClient.shared.baseUrl

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
                    }
                    .foregroundStyle(.tPrimary)
                } header: {
                    Text("Server")
                } footer: {
                    Text("Where the live data comes from. On the simulator: http://127.0.0.1:8787 — on your iPhone: your Mac's address, e.g. http://192.168.1.20:8787")
                }

                Section("Default station") {
                    HStack {
                        Text(stationName)
                            .font(.system(size: 15, weight: .medium))
                        Spacer()
                        Image(systemName: "building.2")
                            .foregroundStyle(.tDim)
                    }
                    Text("Change it from the Stations tab.")
                        .font(.system(size: 11.5))
                        .foregroundStyle(.tDim)
                }

                Section("About") {
                    LabeledContent("Version", value: "0.1.0")
                    LabeledContent("Times", value: "Europe/Rome")
                    Text("Independent, unofficial app built on public Trenord and RFI ViaggiaTreno data. Predictions improve automatically as the system observes more trains — no accuracy is claimed until the benchmark proves it.")
                        .font(.system(size: 11.5))
                        .foregroundStyle(.tDim)
                }
            }
            .scrollContentBackground(.hidden)
        }
        .navigationTitle("Settings")
    }
}
