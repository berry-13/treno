import SwiftUI

/// Live board — flat, calm, shadcn-style: sections with sticky micro headers,
/// hairline-separated rows, one accent (Trenord green). Glass is reserved for
/// the search field and toolbar chrome.
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

    private var running: [TrainSummary] { trains.filter { $0.state?.status == "running" || $0.state?.status == "unknown" } }
    private var upcoming: [TrainSummary] { trains.filter { $0.state?.status != "running" && $0.state?.status != "unknown" } }

    var body: some View {
        ZStack(alignment: .top) {
            Color.tBg.ignoresSafeArea()
            ScrollView {
                LazyVStack(spacing: 0, pinnedViews: [.sectionHeaders]) {
                    header
                    if let errorText {
                        Text(errorText)
                            .font(.footnote)
                            .foregroundStyle(.tDanger)
                            .padding(.horizontal, 16)
                            .padding(.top, 10)
                    }
                    if trains.isEmpty && !loading && errorText == nil {
                        VStack(spacing: 6) {
                            Image(systemName: "tram")
                                .font(.system(size: 22))
                                .foregroundStyle(.tDim)
                            Text("no live runs yet")
                                .font(.footnote)
                                .foregroundStyle(.tDim)
                        }
                        .padding(.top, 80)
                    }
                    if !running.isEmpty {
                        Section {
                            ForEach(running) { train in
                                NavigationLink(value: train.id) { TrainRow(train: train) }
                                    .buttonStyle(.plain)
                            }
                        } header: {
                            sectionHeader("Running now", count: running.count)
                        }
                    }
                    if !upcoming.isEmpty {
                        Section {
                            ForEach(upcoming) { train in
                                NavigationLink(value: train.id) { TrainRow(train: train) }
                                    .buttonStyle(.plain)
                            }
                        } header: {
                            sectionHeader("Departing next", count: upcoming.count)
                        }
                    }
                    Rectangle().fill(Color.clear).frame(height: 40)
                }
                .padding(.horizontal, 0)
            }
            .backgroundExtensionEffect()
        }
        .navigationTitle("Live")
        .navigationDestination(for: Int.self) { id in
            TrainDetailView(runId: id)
        }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { showSettings = true } label: {
                    Image(systemName: "gearshape")
                        .foregroundStyle(.tMuted)
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

    private var header: some View {
        VStack(spacing: 12) {
            searchField
            HStack(spacing: 10) {
                ForEach(providers, id: \.source) { p in
                    HStack(spacing: 5) {
                        Circle()
                            .fill(p.healthState == "HEALTHY" ? Color.tPrimary : Color.tLate)
                            .frame(width: 5, height: 5)
                        Text(p.source)
                            .font(.system(size: 11))
                            .foregroundStyle(.tDim)
                    }
                }
                Spacer()
                Text("auto · 10s")
                    .font(.system(size: 11))
                    .foregroundStyle(.tDim)
            }
            .padding(.horizontal, 4)
        }
        .padding(.horizontal, 16)
        .padding(.top, 6)
        .padding(.bottom, 10)
    }

    private var searchField: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 13))
                .foregroundStyle(.tDim)
            TextField("train number", text: $query)
                .font(.system(size: 15))
                .keyboardType(.numbersAndPunctuation)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
                .onSubmit { Task { await load() } }
            if !query.isEmpty {
                Button {
                    query = ""
                    Task { await load() }
                } label: {
                    Image(systemName: "xmark.circle.fill").foregroundStyle(.tDim)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(11)
        .glassEffect()
        .clipShape(RoundedRectangle(cornerRadius: 13, style: .continuous))
    }

    private func sectionHeader(_ title: String, count: Int) -> some View {
        HStack(spacing: 6) {
            Text(title.uppercased())
                .font(.system(size: 11, weight: .semibold))
                .tracking(1.2)
                .foregroundStyle(.tDim)
            Text(String(count))
                .font(.system(size: 11, weight: .semibold))
                .monospacedDigit()
                .foregroundStyle(.tDim.opacity(0.7))
            Spacer()
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .background(Color.tBg.opacity(0.92))
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
            errorText = "collector unreachable — \(error.localizedDescription)"
        }
    }
}

/// One flat row: number · route on the left; delay + confidence on the right.
struct TrainRow: View {
    let train: TrainSummary
    var body: some View {
        let s = train.state
        HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 8) {
                    Text(train.trainNumber)
                        .font(.system(.title3, design: .rounded, weight: .bold))
                        .monospacedDigit()
                        .foregroundStyle(s?.status == "running" ? Color.tPrimary : Color.tFg)
                    if s?.status == "running" {
                        Circle().fill(Color.tPrimary).frame(width: 5, height: 5)
                    } else if s?.status == "cancelled" {
                        TBadge("cancelled", .tDanger)
                    }
                }
                Text("\(s?.origin?.name ?? train.originStop ?? "?") → \(s?.destination?.name ?? train.destinationStop ?? "?")")
                    .font(.system(size: 13))
                    .foregroundStyle(.tMuted)
                    .lineLimit(1)
            }
            Spacer(minLength: 8)
            VStack(alignment: .trailing, spacing: 3) {
                if let d = s?.operatorDelaySec {
                    Text(Fmt.delayShort(d))
                        .font(.system(.headline, design: .rounded))
                        .monospacedDigit()
                        .foregroundStyle(StatusUI.delayColor(d))
                } else {
                    Text("·")
                        .foregroundStyle(.tDim)
                }
                Text(Fmt.hhmm(s?.schedArrEpoch))
                    .font(.system(size: 12))
                    .monospacedDigit()
                    .foregroundStyle(.tDim)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 11)
        .contentShape(Rectangle())
        .overlay(alignment: .bottom) {
            Rectangle().fill(Color.tBorder).frame(height: 0.7).padding(.horizontal, 16)
        }
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
                    Text("Simulator: http://127.0.0.1:8787 · Device on same Wi-Fi: your Mac's IP, e.g. http://192.168.1.20:8787")
                }
                Section {
                    Button("Save") {
                        APIClient.shared.baseUrl = baseUrl
                        dismiss()
                    }
                    .foregroundStyle(.tPrimary)
                }
            }
            .scrollContentBackground(.hidden)
            .background(Color.tBg)
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel") { dismiss() }.foregroundStyle(.tMuted)
                }
            }
        }
        .preferredColorScheme(.dark)
        .presentationDetents([.medium])
    }
}
