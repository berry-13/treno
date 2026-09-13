import SwiftUI

/// Live runs + search. Auto-refreshes while visible (Flighty-style board).
struct TrainListView: View {
    var path: Binding<NavigationPath> = .constant(NavigationPath())

    @State private var trains: [TrainSummary] = []
    @State private var query = ""
    @State private var loading = false
    @State private var errorText: String?
    @State private var providers: [ProviderHealth] = []
    @State private var showSettings = false
    @State private var pushedInitialTrain = false

    private let refresh = Timer.publish(every: 10, on: .main, in: .common).autoconnect()

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 10) {
                providerBar
                searchField
                if let errorText {
                    Text(errorText)
                        .font(.footnote)
                        .foregroundStyle(.trenoBad)
                        .frame(maxWidth: .infinity, alignment: .center)
                }
                if trains.isEmpty && !loading && errorText == nil {
                    Text("no live runs yet — collector warming up")
                        .font(.footnote)
                        .foregroundStyle(.trenoDim)
                        .padding(.top, 40)
                }
                ForEach(trains) { train in
                    NavigationLink(value: train.id) {
                        TrainRow(train: train)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
        }
        .backgroundExtensionEffect()
        .navigationTitle("Treno")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    showSettings = true
                } label: {
                    Image(systemName: "gearshape")
                }
                .buttonStyle(.glass)
            }
        }
        .sheet(isPresented: $showSettings) {
            SettingsSheet()
        }
        .refreshable { await load() }
        .onAppear {
            Task { await load() }
            pushInitialTrainIfRequested()
        }
        .onReceive(refresh) { _ in
            guard !loading else { return }
            Task { await load() }
        }
    }

    private var providerBar: some View {
        HStack(spacing: 8) {
            ForEach(providers, id: \.source) { p in
                HStack(spacing: 4) {
                    Circle()
                        .fill(p.healthState == "HEALTHY" ? Color.trenoGood : (p.healthState == "DEGRADED" ? Color.trenoWarn : Color.trenoBad))
                        .frame(width: 6, height: 6)
                    Text(p.source)
                        .font(.caption2)
                        .foregroundStyle(.trenoDim)
                }
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
            }
            Spacer()
            Text("updated \(Date.now, style: .time)")
                .font(.caption2)
                .foregroundStyle(.trenoDim)
        }
    }

    private var searchField: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(.trenoDim)
            TextField("train number, e.g. 2174", text: $query)
                .keyboardType(.numbersAndPunctuation)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
                .onSubmit { Task { await load() } }
            if !query.isEmpty {
                Button {
                    query = ""
                    Task { await load() }
                } label: {
                    Image(systemName: "xmark.circle.fill").foregroundStyle(.trenoDim)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(10)
        .glassEffect()
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    /// Simulator/demo deep link: `simctl launch ... com.treno.Treno --train 493`
    private func pushInitialTrainIfRequested() {
        guard !pushedInitialTrain else { return }
        pushedInitialTrain = true
        let args = ProcessInfo.processInfo.arguments
        if let i = args.firstIndex(of: "--train"), i + 1 < args.count, let id = Int(args[i + 1]) {
            path.wrappedValue.append(id)
        }
    }

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            async let t = APIClient.shared.trains(query: query)
            async let h = APIClient.shared.health()
            trains = try await t
            providers = (try? await h)?.providers ?? []
            errorText = nil
        } catch {
            errorText = "api unreachable: \(error.localizedDescription)"
        }
    }
}

struct TrainRow: View {
    let train: TrainSummary
    var body: some View {
        let s = train.state
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Text(train.trainNumber)
                    .font(.title3.weight(.bold))
                    .monospacedDigit()
                StatusBadge(status: s?.status)
                if let d = s?.operatorDelaySec {
                    Text(Fmt.delay(d))
                        .font(.subheadline.weight(.semibold))
                        .monospacedDigit()
                        .foregroundStyle(StatusUI.delayColor(d))
                }
                Spacer()
                if let conf = s?.confidence {
                    Text(conf)
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(StatusUI.confidenceColor(conf))
                }
            }
            HStack(spacing: 6) {
                Text("\(s?.origin?.name ?? train.originStop ?? "?") → \(s?.destination?.name ?? train.destinationStop ?? "?")")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            if let loc = s?.latestLocation, let name = loc.name {
                Text("last: \(name)" + (loc.kind == "reporting_point" ? " · reporting point" : ""))
                    .font(.caption2)
                    .foregroundStyle(.trenoDim)
                    .lineLimit(1)
            }
        }
        .glassCard()
        .contentShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
    }
}

struct SettingsSheet: View {
    @State private var baseUrl = APIClient.shared.baseUrl
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("API base URL", text: $baseUrl)
                        .keyboardType(.URL)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                } header: {
                    Text("Collector endpoint")
                } footer: {
                    Text("Simulator uses http://127.0.0.1:8787. A device on the same Wi-Fi should point at your Mac (System Settings → Wi-Fi → IP), e.g. http://192.168.1.20:8787.")
                }
                Section {
                    Button("Save") {
                        APIClient.shared.baseUrl = baseUrl
                        dismiss()
                    }
                    .buttonStyle(.glass)
                }
            }
            .navigationTitle("Settings")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium])
    }
}
