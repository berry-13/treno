import SwiftUI

struct TrainDetailView: View {
    let ref: TrainRef
    @State private var detail: TrainDetail?
    @State private var failed = false
    @State private var loading = false
    @State private var reliability: TrainReliability?
    private let refresh = Timer.publish(every: 15, on: .main, in: .common).autoconnect()
    private let sse = SSEClient()

    private var arrived: Bool { detail?.state?.status == "arrived" }

    /// the rider's own boarding / alighting stops, when we know their segment
    private var boardStop: DetailStop? {
        ref.fromStopId.flatMap { id in detail?.stops?.first { $0.stopId == id } }
    }
    private var alightStop: DetailStop? {
        ref.toStopId.flatMap { id in detail?.stops?.first { $0.stopId == id } }
    }
    private var alightingAtTerminus: Bool {
        guard let last = detail?.stops?.last else { return true }
        return alightStop?.stopId == last.stopId
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                if let detail {
                    if failed { TravelNotice(title: "Updates are unavailable", message: "Showing the last update. Pull down to try again.") }
                    hero(detail)
                    // §48 likely area: the honest position under the
                    // last-detected line in the hero — running trains with a
                    // fresh sighting only; hides the moment either is missing.
                    if let area = detail.likelyArea, detail.state?.status == "running", detail.state?.isFresh == true {
                        LikelyAreaSection(area: area)
                    }
                    if let ours = comparison.ours, detail.state?.status != "cancelled" {
                        estimateComparison(ours)
                    }
                    if let stops = detail.stops, !stops.isEmpty {
                        VStack(alignment: .leading, spacing: 14) {
                            SectionHeading(title: "Stops")
                            stopList(stops, state: detail.state)
                        }
                    }
                    if let rel = reliability, arrived || detail.state?.status == "scheduled" || detail.state?.status == "running" {
                        reliabilitySection(rel)
                    }
                    if let connections = detail.connections, !connections.isEmpty, detail.state?.status != "cancelled" {
                        connectionsSection(connections)
                    }
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
        .navigationTitle(alightStop?.displayName
            ?? detail?.state?.destination?.name
            ?? detail?.destinationStop ?? "Train")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await load() }
        .task { await load(); startStream() }
        .onDisappear { sse.close() }
        .onReceive(refresh) { _ in Task { await load() } }
    }

    /// §60 live updates: consume the SSE state stream and patch the fused
    /// state in place; the 15 s timer stays as reconnect/fallback hygiene.
    private func startStream() {
        guard let url = URL(string: APIClient.shared.baseUrl + "/api/stream/trains/\(ref.runId)") else { return }
        sse.open(
            url: url,
            onEvent: { ev in
                guard ev.event == "state_update", let data = ev.data.data(using: .utf8) else { return }
                let state = try? JSONDecoder().decode(TrainState.self, from: data)
                Task { @MainActor in
                    if let state, var d = detail {
                        d.state = state
                        detail = d
                    }
                }
            },
            onClose: { _ in
                Task { @MainActor in
                    try? await Task.sleep(nanoseconds: 10_000_000_000)
                    startStream()
                }
            }
        )
    }

    private func load() async {
        guard !loading else { return }
        loading = true
        defer { loading = false }
        do {
            let response = try await APIClient.shared.train(id: ref.runId)
            guard !Task.isCancelled else { return }
            detail = response
            failed = false
            if reliability == nil {
                reliability = (try? await APIClient.shared.reliability(trainNumber: response.trainNumber)) ?? nil
            }
        } catch { if !Task.isCancelled { failed = true } }
    }

    /// §84: 30-day behaviour one-liner, expandable to segment hot spots.
    /// Thin-data fields arrive null and simply don't render.
    private func reliabilitySection(_ rel: TrainReliability) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            if let onTime = rel.onTimePct {
                Text("This train, last 30 days: on time \(Int(onTime.rounded()))%")
                    .font(.subheadline.weight(.medium)).foregroundStyle(.tFg)
                HStack(spacing: 14) {
                    if let late5 = rel.late5Pct { Text(">\(5)m late \(Int(late5.rounded()))%") }
                    if let late10 = rel.late10Pct { Text(">\(10)m late \(Int(late10.rounded()))%") }
                    if let cxl = rel.cancelledPct { Text("cancelled \(Int(cxl.rounded()))%") }
                    Text("\(rel.completedRuns) runs")
                }.font(.footnote).foregroundStyle(.tMuted)
            } else {
                Text("\(rel.completedRuns) completed runs in the last 30 days")
                    .font(.footnote).foregroundStyle(.tMuted)
            }
            if let worst = rel.worstSegment {
                Text("Slowest stretch: \(worst.fromName ?? "?") → \(worst.toName ?? "?") \(Fmt.delayShort(worst.medianDelayDeltaSec ?? 0))")
                    .font(.footnote).foregroundStyle(.tLate)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(18)
        .background(Color.tCard, in: RoundedRectangle(cornerRadius: 20))
    }

    // MARK: segment times

    /// Departure at the rider's boarding stop and arrival at their alighting
    /// stop — actual, else predicted, else schedule shifted by the live delay.
    /// Without a segment this is the whole-train view (origin → terminus).
    private var segmentTimes: (dep: Double?, depSched: Double?, arr: Double?, arrSched: Double?, platform: String?) {
        guard let detail else { return (nil, nil, nil, nil, nil) }
        let state = detail.state
        let liveMs = Double(state?.liveDelaySec ?? 0) * 1000
        if let b = boardStop {
            let depSched = b.schedDepEpoch
            let dep = b.actualDepEpoch ?? b.opPredDepEpoch ?? depSched.map { $0 + liveMs }
            var arr: Double?
            var arrSched: Double?
            if let a = alightStop {
                arrSched = a.schedArrEpoch
                arr = a.actualArrEpoch ?? a.opPredArrEpoch ?? arrSched.map { $0 + liveMs }
            } else {
                arrSched = state?.schedArrEpoch
                arr = arrived ? detail.stops?.last?.actualArrEpoch
                    : state?.ourEstimate?.p50 ?? state?.destinationOperatorEta ?? arrSched.map { $0 + liveMs }
            }
            return (dep, depSched, arr, arrSched, Fmt.platform(b.platformActual))
        }
        let first = detail.stops?.first
        let depSched = first?.schedDepEpoch ?? state?.schedDepEpoch
        let dep = first?.actualDepEpoch ?? first?.opPredDepEpoch ?? depSched
        let arrSched = state?.schedArrEpoch
        let arr = arrived ? detail.stops?.last?.actualArrEpoch
            : state?.ourEstimate?.p50 ?? state?.destinationOperatorEta ?? arrSched
        return (dep, depSched, arr, arrSched, nil)
    }

    /// Our estimate re-anchored to the rider's alighting stop: the run-level
    /// prediction is for the terminus, so the difference between our number and
    /// the operator's is carried over to the operator's per-stop prediction.
    private struct EstimateRange { let p10: Double; let p50: Double; let p90: Double }
    private var comparison: (operatorEta: Double?, ours: EstimateRange?) {
        guard let state = detail?.state else { return (nil, nil) }
        if alightingAtTerminus {
            guard let e = state.ourEstimate else { return (state.destinationOperatorEta, nil) }
            return (state.destinationOperatorEta, EstimateRange(p10: e.p10, p50: e.p50, p90: e.p90))
        }
        guard let a = alightStop else { return (nil, nil) }
        let opEta = a.actualArrEpoch ?? a.opPredArrEpoch
        guard let e = state.ourEstimate, let dest = state.destinationOperatorEta,
              let base = a.opPredArrEpoch ?? a.schedArrEpoch else { return (opEta, nil) }
        return (opEta, EstimateRange(
            p10: base + (e.p10 - dest),
            p50: base + (e.p50 - dest),
            p90: base + (e.p90 - dest),
        ))
    }

    // MARK: sections

    /// §51 disruption-propagation warning — amber, expandable evidence
    private func riskBanner(_ risk: RiskNotice) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Label {
                Text(risk.headline).font(.subheadline.weight(.semibold))
            } icon: {
                Image(systemName: "exclamationmark.triangle.fill")
            }
            .foregroundStyle(.tLate)
            if let detailText = risk.detail {
                Text(detailText).font(.footnote).foregroundStyle(.tMuted)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(Color.tLate.opacity(0.12), in: RoundedRectangle(cornerRadius: 16))
    }

    /// feed operators look like "TRENORD$:$FNM3" — show the company, not the route token
    private func cleanOperator(_ raw: String?) -> String {
        guard let raw, let first = raw.split(separator: "$").first.map(String.init), !first.isEmpty else { return "Regional train" }
        return first.count <= 4 && first == first.uppercased() ? first : first.capitalized
    }

    /// Route header + the rider's own clocks — one focal card.
    private func hero(_ detail: TrainDetail) -> some View {
        let state = detail.state
        let cancelled = state?.status == "cancelled"
        let delayForStatus = arrived ? state?.operatorDelaySec : state?.liveDelaySec
        let color: Color = cancelled ? .tDanger : StatusUI.delayColor(delayForStatus)
        let times = segmentTimes
        let late = (times.dep != nil && times.depSched != nil && abs(times.dep! - times.depSched!) >= 60_000)
            || (times.arr != nil && times.arrSched != nil && abs(times.arr! - times.arrSched!) >= 60_000)
        let fromName = boardStop?.displayName ?? state?.origin?.name ?? detail.originStop ?? "Origin unavailable"
        let toName = alightStop?.displayName ?? state?.destination?.name ?? detail.destinationStop ?? "Destination unavailable"
        // countdown follows the next thing that happens to the rider: their
        // departure while they can still catch it, then their arrival
        let nowMs = Date.now.timeIntervalSince1970 * 1000
        let countdown = (times.dep ?? 0) > nowMs ? times.dep : times.arr
        return VStack(alignment: .leading, spacing: 20) {
            HStack(spacing: 10) {
                Image(systemName: "tram.fill").foregroundStyle(.tPrimary)
                Text(cleanOperator(detail.operatorName)).font(.subheadline.weight(.medium)).foregroundStyle(.tMuted)
                Spacer()
                VStack(alignment: .trailing, spacing: 6) {
                    Text(cancelled ? "Cancelled" : arrived ? "Arrived" : Fmt.delayShort(delayForStatus))
                        .font(.subheadline.weight(.semibold)).foregroundStyle(color)
                    // §17/§62 recovery forecast: one inline chip, hidden when
                    // the server suppressed it (nothing to recover / thin data)
                    if let rec = detail.recovery, let prob = rec.probRecover2m, !arrived, !cancelled {
                        RecoveryChip(probability: prob, expectedDelaySec: rec.expectedDelaySec)
                    }
                }
            }
            RouteEndpoints(from: fromName, to: toName)
            if cancelled {
                Label("This train is not running. Check departures for another service.", systemImage: "xmark.circle")
                    .font(.subheadline).foregroundStyle(.tDanger)
            } else {
                if let dep = times.dep, let arr = times.arr {
                    HStack(alignment: .firstTextBaseline) {
                        VStack(alignment: .leading, spacing: 6) {
                            Text(Fmt.hhmm(dep)).font(.system(size: 44, weight: .semibold))
                                .monospacedDigit().foregroundStyle(.tFg)
                            if let platform = times.platform { PlatformChip(platform: platform) }
                            else if let top = boardStop?.platformPredicted?.first { PredictedPlatformChip(platform: top.n) }
                        }
                        Spacer()
                        VStack(alignment: .trailing, spacing: 6) {
                            Text(Fmt.hhmm(arr)).font(.system(size: 44, weight: .semibold))
                                .monospacedDigit().foregroundStyle(.tFg)
                            if !arrived {
                                TimelineView(.periodic(from: .now, by: 30)) { context in
                                    if let countdown {
                                        let minutes = Int(ceil((countdown - context.date.timeIntervalSince1970 * 1000) / 60_000))
                                        Text(minutes > 0 ? "In \(minutes) min" : "Due now")
                                            .font(.subheadline.weight(.semibold)).foregroundStyle(.tPrimary)
                                    }
                                }.frame(height: 26, alignment: .top)
                            }
                        }
                    }
                    if late {
                        HStack(spacing: 12) {
                            if let depSched = times.depSched { Text(Fmt.hhmm(depSched)).strikethrough() }
                            Image(systemName: "arrow.right").font(.caption2)
                            if let arrSched = times.arrSched { Text(Fmt.hhmm(arrSched)).strikethrough() }
                        }.font(.subheadline.monospacedDigit()).foregroundStyle(.tMuted)
                    }
                }
                if let next = state?.nextStop?.name, !arrived {
                    Label("Next stop: \(next)", systemImage: "mappin.and.ellipse")
                        .font(.subheadline).foregroundStyle(.tMuted)
                }
                if let cr = detail.crowding, let pct = cr.crowdingPct, !arrived, !cancelled {
                    Label(cr.crowdingLabel ?? (pct >= 80 ? "Very busy" : pct >= 55 ? "Busy" : nil) ?? "Busy",
                          systemImage: pct >= 55 ? "person.2.fill" : "person.2")
                        .font(.subheadline)
                        .foregroundStyle(pct >= 80 ? .tLate : pct >= 55 ? .tPrimary : .tMuted)
                }
                if let risk = detail.riskNotice, !arrived, !cancelled {
                    riskBanner(risk)
                }
                if let observed = state?.latestObservedAt {
                    TimelineView(.periodic(from: .now, by: 30)) { context in
                        let age = max(0, Int((context.date.timeIntervalSince1970 * 1000 - observed) / 1000))
                        Text("Updated \(Fmt.age(age))").font(.caption).foregroundStyle(.tMuted)
                    }
                }
            }
        }.padding(22).background(Color.tCard, in: RoundedRectangle(cornerRadius: 24))
    }

    /// Flighty-style two-column estimate: the operator's word against ours,
    /// at the stop the rider actually gets off.
    private func estimateComparison(_ ours: EstimateRange) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top, spacing: 0) {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Operator").font(.caption.weight(.semibold)).foregroundStyle(.tMuted)
                    Text(comparison.operatorEta.map(Fmt.hhmm) ?? "—")
                        .font(.title2.weight(.semibold)).monospacedDigit().foregroundStyle(.tFg)
                }
                Divider().padding(.horizontal, 20)
                VStack(alignment: .leading, spacing: 6) {
                    Text("Treno").font(.caption.weight(.semibold)).foregroundStyle(.tPrimary)
                    Text(Fmt.hhmm(ours.p50)).font(.title2.weight(.semibold)).monospacedDigit().foregroundStyle(.tFg)
                    Text("\(Fmt.hhmm(ours.p10))–\(Fmt.hhmm(ours.p90))")
                        .font(.caption.monospacedDigit()).foregroundStyle(.tMuted)
                }
                Spacer(minLength: 0)
            }
            if let spread = detail?.state?.sourceDelaySpreadSec, spread > 300 {
                Text("Reports differ by \(spread / 60) minutes. Allow extra time for your connection.")
                    .font(.footnote).foregroundStyle(.tLate)
            }
        }.padding(20).background(Color.tCard, in: RoundedRectangle(cornerRadius: 22))
    }

    private func stopList(_ stops: [DetailStop], state: TrainState?) -> some View {
        let yours: Set<String> = [ref.fromStopId, ref.toStopId].compactMap { $0 }.reduce(into: []) { $0.insert($1) }
        let nextIndex = stops.firstIndex { stop in
            stop.cancelled != 1 && stop.actualArrEpoch == nil && stop.actualDepEpoch == nil
                && !(stop.id == stops.first?.id && (state?.status == "running" || state?.status == "arrived"))
        }
        return VStack(spacing: 0) {
            ForEach(Array(stops.enumerated()), id: \.element.id) { index, stop in
                StopTimelineRow(stop: stop, first: index == 0, last: index == stops.count - 1,
                                next: index == nextIndex && state?.status != "arrived",
                                passed: stop.actualArrEpoch != nil || stop.actualDepEpoch != nil || (index == 0 && (state?.status == "running" || state?.status == "arrived")),
                                yours: yours.contains(stop.stopId))
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
}

/// §17/§62 recovery chip: "68% recovers ≥2m". The color carries the meaning
/// (green when recovery is likely, amber when uncertain, muted when unlikely)
/// and the chip disappears entirely when no honest probability exists.
private struct RecoveryChip: View {
    let probability: Double
    var expectedDelaySec: Int? = nil

    private var color: Color {
        probability >= 0.6 ? .tGood : probability >= 0.35 ? .tLate : .tMuted
    }

    var body: some View {
        let pct = Int((probability * 100).rounded())
        Text("\(pct)% recovers ≥2m")
            .font(.caption.weight(.semibold)).monospacedDigit()
            .foregroundStyle(color)
            .padding(.horizontal, 8).padding(.vertical, 4)
            .background(color.opacity(0.10), in: RoundedRectangle(cornerRadius: 6))
            .accessibilityLabel("Recovery forecast: \(pct) percent chance of recovering at least two minutes"
                + (expectedDelaySec != nil ? ", expected \(Fmt.delay(expectedDelaySec)) at arrival" : ""))
    }
}

private struct StopTimelineRow: View {
    let stop: DetailStop
    let first: Bool
    let last: Bool
    let next: Bool
    let passed: Bool
    /// one of the rider's own boarding / alighting stops
    var yours: Bool = false

    var body: some View {
        let cancelled = stop.cancelled == 1
        let scheduled = first ? stop.schedDepEpoch : stop.schedArrEpoch
        let predicted = first ? stop.opPredDepEpoch : stop.opPredArrEpoch
        let actual = first ? stop.actualDepEpoch : stop.actualArrEpoch
        let shown = actual ?? predicted ?? scheduled
        HStack(alignment: .center, spacing: 14) {
            VStack(spacing: 0) {
                Rectangle().fill(first ? Color.clear : Color.tBorder).frame(width: 2)
                Image(systemName: cancelled ? "xmark.circle.fill" : passed ? "checkmark.circle.fill" : next || yours ? "circle.inset.filled" : "circle")
                    .font(.system(size: 16)).foregroundStyle(cancelled ? Color.tDanger : next || yours ? .tPrimary : passed ? .tGood : .tMuted)
                Rectangle().fill(last ? Color.clear : Color.tBorder).frame(width: 2)
            }.frame(width: 18)
            VStack(alignment: .leading, spacing: 5) {
                Text(stop.displayName).font(.body.weight(next || yours ? .semibold : .regular))
                    .foregroundStyle(cancelled ? Color.tDanger : passed ? .tMuted : .tFg).strikethrough(cancelled)
                if next && !yours { Text("Next stop").font(.footnote.weight(.medium)).foregroundStyle(.tPrimary) }
                if let platform = Fmt.platform(stop.platformActual) {
                    PlatformChip(platform: platform)
                } else if let top = stop.platformPredicted?.first, !passed {
                    PredictedPlatformChip(platform: top.n)
                }
            }.padding(.vertical, 16)
            Spacer(minLength: 4)
            VStack(alignment: .trailing, spacing: 4) {
                Text(Fmt.hhmm(shown)).font(.body.weight(next || yours ? .semibold : .regular)).monospacedDigit()
                    .foregroundStyle(passed ? Color.tMuted : .tFg).strikethrough(cancelled)
                if let scheduled, let shown, abs(shown - scheduled) >= 60_000 {
                    Text(Fmt.hhmm(scheduled)).font(.caption).monospacedDigit().strikethrough().foregroundStyle(.tMuted)
                }
            }
        }
        .fixedSize(horizontal: false, vertical: true)
        .padding(.horizontal, 20)
        .background(next || yours ? Color.tPrimaryDim : .clear)
    }
}
