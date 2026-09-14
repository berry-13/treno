import SwiftUI

struct SettingsView: View {
    @AppStorage("appearance") private var appearance = "system"
    @AppStorage("stationName") private var stationName = "Milano Centrale"

    var body: some View {
        Form {
            Section {
                HStack(spacing: 16) {
                    Image(systemName: "tram.fill").font(.largeTitle).foregroundStyle(.tPrimary)
                        .frame(width: 64, height: 64).background(Color.tPrimaryDim, in: RoundedRectangle(cornerRadius: 18))
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Treno").font(.title2.weight(.bold))
                    }
                }.padding(.vertical, 8)
            }
            Section("Preferences") {
                Picker("Appearance", selection: $appearance) {
                    Text("System").tag("system")
                    Text("Light").tag("light")
                    Text("Dark").tag("dark")
                }
                LabeledContent("Last station", value: stationName)
            }
            Section {
                Text("Live departures and journey updates for trains in Lombardy.")
                LabeledContent("Train times", value: "Italy time")
                LabeledContent("Version", value: "0.1.0")
            } header: { Text("About Treno") } footer: {
                Text("An independent app using public Trenord and RFI data. Times may change; check the station displays before boarding.")
            }
            Section {
                NavigationLink("Data connection") { DataConnectionView() }
            }
        }
        .navigationTitle("Settings")
        .navigationBarTitleDisplayMode(.inline)
    }
}

private struct DataConnectionView: View {
    @State private var url = APIClient.shared.baseUrl
    @State private var saved = false
    private var valid: Bool {
        guard let components = URLComponents(string: url.trimmingCharacters(in: .whitespacesAndNewlines)) else { return false }
        return ["http", "https"].contains(components.scheme ?? "") && components.host?.isEmpty == false
    }
    var body: some View {
        Form {
            Section {
                TextField("Server address", text: $url)
                    .keyboardType(.URL).autocorrectionDisabled().textInputAutocapitalization(.never)
                Button(saved ? "Saved" : "Save connection") {
                    APIClient.shared.baseUrl = url
                    TripStore.shared.suite?.set(APIClient.shared.baseUrl, forKey: "apiBaseUrl")
                    saved = true
                }.disabled(!valid || saved)
            } header: { Text("Server address") } footer: {
                Text("For a local Treno installation, enter the address of the computer providing your train updates.")
            }
        }
        .navigationTitle("Data connection")
        .navigationBarTitleDisplayMode(.inline)
        .onChange(of: url) { _, _ in saved = false }
    }
}
