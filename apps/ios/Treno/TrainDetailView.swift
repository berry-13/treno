import SwiftUI

struct TrainDetailView: View {
    let runId: Int
    @State private var detail: TrainDetail?
    @State private var failed = false
    @State private var loading = false
    private let refresh = Timer.publish(every: 15, on: .main, in: .common).autoconnect()

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                if let detail {
                    if failed { TravelNotice(title: "Updates are unavailable", message: "Showing the last update. Pull down to try again.") }
                    overview(detail)
                    if let state = detail.state, state.status != "cancelled" {
                        arrival(state)
                    }
                    if let stops = detail.stops, !stops.isEmpty {
                        VStack(alignment: .leading, spacing: 14) {
                            SectionHeading(title: "Stops")
                            stopList(stops, state: detail.state)
                        }
                    }
                    if let connections = detail.connections, !connections.isEmpty, detail.state?.status != "cancelled" {
                        connectionsSection(connections)
                    }
                    if let state = detail.state, state.status != "cancelled" { timingDetails(state) }
                } else if failed {
                    ContentUnavailableView {
                        Label("Train updates unavailable", systemImage: "wifi.exclamationmark")
                    } description: { Text("Check your connection and try again.") } actions: {
                        Button("Try again") { Task { await load() } }.buttonStyle(.bordered)
                    }
                } else { ProgressView("Finding your train…").frame(maxWidth: .infinity).padding(.top, 60) }
            }.padding(.horizontal, 20).padding(.top, 12).padding(.bottom, 28)
        }
        .background { TrenoBackground() }
        .navigationTitle(detail.map { "Train \($0.trainNumber)" } ?? "Train")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await load() }
        .task { await load() }
        .onReceive(refresh) { _ in Task { await load() } }
    }

    private func load() async {
        guard !loading else { return }
        loading = true
        defer { loading = false }
        do {
            let response = try await APIClient.shared.train(id: runId)
            guard !Task.isCancelled else { return }
            detail = response
            failed = false
        } catch { if !Task.isCancelled { failed = true } }
    }

    private func overview(_ detail: TrainDetail) -> some View {
        let state = detail.state
        let status = state?.status
        let cancelled = status == "cancelled"
        let color: Color = cancelled ? .tDanger : StatusUI.delayColor(state?.operatorDelaySec)
        return VStack(alignment: .leading, spacing: 22) {
            HStack(spacing: 10) {
                Image(systemName: "tram.fill").foregroundStyle(.tPrimary)
                Text(detail.operatorName?.capitalized ?? "Regional train").font(.subheadline.weight(.medium)).foregroundStyle(.tMuted)
                Spacer()
                Text(cancelled ? "Cancelled" : status == "arrived" ? "Arrived" : Fmt.delayShort(state?.operatorDelaySec))
                    .font(.subheadline.weight(.semibold)).foregroundStyle(color)
            }
            RouteEndpoints(from: state?.origin?.name ?? detail.originStop ?? "Origin unavailable",
                           to: state?.destination?.name ?? detail.destinationStop ?? "Destination unavailable")
            Divider()
            if cancelled {
                Label("This train is not running. Check departures for another service.", systemImage: "xmark.circle")
                    .font(.subheadline).foregroundStyle(.tDanger)
            } else {
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Departure").font(.footnote).foregroundStyle(.tMuted)
                        Text(Fmt.hhmm(detail.stops?.first?.actualDepEpoch ?? state?.schedDepEpoch))
                            .font(.title2.weight(.semibold)).monospacedDigit()
                    }
                    Spacer()
                    VStack(alignment: .trailing, spacing: 4) {
                        Text("Scheduled arrival").font(.footnote).foregroundStyle(.tMuted)
                        Text(Fmt.hhmm(state?.schedArrEpoch)).font(.title2.weight(.semibold)).monospacedDigit()
                    }
                }.foregroundStyle(.tFg)
            }
        }.padding(22).background(Color.tCard, in: RoundedRectangle(cornerRadius: 24))
    }

    @ViewBuilder
    private func arrival(_ state: TrainState) -> some View {
        let arrived = state.status == "arrived"
        let actual = detail?.stops?.last?.actualArrEpoch
        let expected = arrived ? actual : state.ourEstimate?.p50 ?? state.destinationOperatorEta
        if let expected {
            VStack(alignment: .leading, spacing: 12) {
                Label(arrived ? "Arrived at" : "Expected arrival", systemImage: arrived ? "checkmark.circle" : "clock")
                    .font(.subheadline.weight(.medium)).foregroundStyle(.tMuted)
                HStack(alignment: .firstTextBaseline) {
                    Text(Fmt.hhmm(expected)).font(.system(.largeTitle, weight: .semibold))
                        .monospacedDigit().foregroundStyle(.tFg)
                    Spacer()
                    if !arrived {
                        TimelineView(.periodic(from: .now, by: 30)) { context in
                            let minutes = Int(ceil((expected - context.date.timeIntervalSince1970 * 1000) / 60_000))
                            Text(minutes > 0 ? "In \(minutes) min" : "Due now")
                                .font(.subheadline.weight(.medium)).foregroundStyle(.tPrimary)
                        }
                    }
                }
                if !arrived, let next = state.nextStop?.name {
                    Label("Next stop: \(next)", systemImage: "mappin.and.ellipse")
                        .font(.subheadline).foregroundStyle(.tMuted)
                }
                if let observed = state.latestObservedAt {
                    TimelineView(.periodic(from: .now, by: 30)) { context in
                        let age = max(0, Int((context.date.timeIntervalSince1970 * 1000 - observed) / 1000))
                        Text("Updated \(Fmt.age(age))").font(.caption).foregroundStyle(.tMuted)
                    }
                }
            }.padding(22).background(Color.tPrimaryDim, in: RoundedRectangle(cornerRadius: 24))
        }
    }

    private func stopList(_ stops: [DetailStop], state: TrainState?) -> some View {
        let nextIndex = stops.firstIndex { stop in
            stop.cancelled != 1 && stop.actualArrEpoch == nil && stop.actualDepEpoch == nil
                && !(stop.id == stops.first?.id && (state?.status == "running" || state?.status == "arrived"))
        }
        return VStack(spacing: 0) {
            ForEach(Array(stops.enumerated()), id: \.element.id) { index, stop in
                StopTimelineRow(stop: stop, first: index == 0, last: index == stops.count - 1,
                                next: index == nextIndex && state?.status != "arrived",
                                passed: stop.actualArrEpoch != nil || stop.actualDepEpoch != nil || (index == 0 && (state?.status == "running" || state?.status == "arrived")))
            }
        }.padding(.vertical, 10).background(Color.tCard, in: RoundedRectangle(cornerRadius: 22))
    }

    private func connectionsSection(_ connections: [ConnectionOption]) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            SectionHeading(title: "Onward connections")
            VStack(spacing: 0) {
                ForEach(Array(connections.prefix(3).enumerated()), id: \.element.id) { index, connection in
                    HStack(alignment: .top, spacing: 12) {
                        Text(Fmt.hhmm(connection.depEpoch + Double(connection.operatorDelaySec ?? 0) * 1000))
                            .font(.body.weight(.semibold)).monospacedDigit()
                        VStack(alignment: .leading, spacing: 6) {
                            Text(connection.destinationName ?? "Connecting train").font(.body.weight(.medium))
                            Text("\(max(0, connection.transferSec / 60)) min minimum transfer · \(connection.probability >= 0.8 ? "Likely connection" : connection.probability >= 0.5 ? "Tight connection" : "Unlikely connection")")
                                .font(.footnote).foregroundStyle(connection.probability >= 0.8 ? Color.tMuted : .tLate)
                        }
                        Spacer(minLength: 0)
                    }.padding(18)
                    if index < min(connections.count, 3) - 1 { Divider().padding(.leading, 18) }
                }
            }.background(Color.tCard, in: RoundedRectangle(cornerRadius: 22))
        }
    }

    private func timingDetails(_ state: TrainState) -> some View {
        DisclosureGroup {
            VStack(alignment: .leading, spacing: 16) {
                LabeledContent("Scheduled", value: Fmt.hhmm(state.schedArrEpoch))
                if let operatorETA = state.destinationOperatorEta {
                    LabeledContent("Operator estimate", value: Fmt.hhmm(operatorETA))
                }
                if let estimate = state.ourEstimate {
                    LabeledContent("Treno estimate", value: Fmt.hhmm(estimate.p50))
                    LabeledContent("Likely arrival", value: "\(Fmt.hhmm(estimate.p10))–\(Fmt.hhmm(estimate.p90))")
                    Text("Estimates can change as new train updates arrive.").font(.footnote).foregroundStyle(.tMuted)
                }
                if let spread = state.sourceDelaySpreadSec, spread > 300 {
                    Text("Reports differ by \(spread / 60) minutes. Allow extra time for your connection.")
                        .font(.footnote).foregroundStyle(.tLate)
                }
            }.font(.subheadline).padding(.top, 16)
        } label: {
            Label("About these times", systemImage: "info.circle").font(.subheadline.weight(.medium))
        }
        .padding(20).background(Color.tCard, in: RoundedRectangle(cornerRadius: 20))
    }
}

private struct StopTimelineRow: View {
    let stop: DetailStop
    let first: Bool
    let last: Bool
    let next: Bool
    let passed: Bool

    var body: some View {
        let cancelled = stop.cancelled == 1
        let scheduled = first ? stop.schedDepEpoch : stop.schedArrEpoch
        let predicted = first ? stop.opPredDepEpoch : stop.opPredArrEpoch
        let actual = first ? stop.actualDepEpoch : stop.actualArrEpoch
        let shown = actual ?? predicted ?? scheduled
        HStack(alignment: .center, spacing: 14) {
            VStack(spacing: 0) {
                Rectangle().fill(first ? Color.clear : Color.tBorder).frame(width: 2)
                Image(systemName: cancelled ? "xmark.circle.fill" : passed ? "checkmark.circle.fill" : next ? "circle.inset.filled" : "circle")
                    .font(.system(size: 16)).foregroundStyle(cancelled ? Color.tDanger : next ? .tPrimary : passed ? .tGood : .tMuted)
                Rectangle().fill(last ? Color.clear : Color.tBorder).frame(width: 2)
            }.frame(width: 18)
            VStack(alignment: .leading, spacing: 5) {
                Text(stop.displayName).font(.body.weight(next ? .semibold : .regular))
                    .foregroundStyle(cancelled ? Color.tDanger : passed ? .tMuted : .tFg).strikethrough(cancelled)
                if next { Text("Next stop").font(.footnote.weight(.medium)).foregroundStyle(.tPrimary) }
                if let platform = Fmt.platform(stop.platformActual) {
                    Text("Platform \(platform)").font(.caption).foregroundStyle(.tMuted)
                }
            }.padding(.vertical, 16)
            Spacer(minLength: 4)
            VStack(alignment: .trailing, spacing: 4) {
                Text(Fmt.hhmm(shown)).font(.body.weight(next ? .semibold : .regular)).monospacedDigit()
                    .foregroundStyle(passed ? Color.tMuted : .tFg).strikethrough(cancelled)
                if let scheduled, let shown, abs(shown - scheduled) >= 60_000 {
                    Text(Fmt.hhmm(scheduled)).font(.caption).monospacedDigit().strikethrough().foregroundStyle(.tMuted)
                }
            }
        }
        .fixedSize(horizontal: false, vertical: true)
        .padding(.horizontal, 20)
        .background(next ? Color.tPrimaryDim : .clear)
    }
}
