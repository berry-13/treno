import SwiftUI

/// Train page (GOAL.md §65): strong typographic hero, the prediction as a
/// range picture (not three naked numbers), quiet provenance rows, connection
/// risk with slim bars, and a vertical journey timeline. Zinc surfaces,
/// hairlines, single green accent.
struct TrainDetailView: View {
    let runId: Int

    @State private var detail: TrainDetail?
    @State private var errorText: String?
    @State private var now = Date.now

    private let refresh = Timer.publish(every: 10, on: .main, in: .common).autoconnect()
    private let ticker = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

    var body: some View {
        ZStack(alignment: .top) {
            Color.tBg.ignoresSafeArea()
            ScrollView {
                if let detail {
                    VStack(spacing: 0) {
                        hero(detail)
                        predictionCard(detail)
                        provenance(detail)
                        if let conns = detail.connections, !conns.isEmpty {
                            connections(conns)
                        }
                        timeline(detail)
                        footer(detail)
                    }
                    .padding(.bottom, 48)
                } else if let errorText {
                    Text(errorText)
                        .font(.footnote)
                        .foregroundStyle(.tDanger)
                        .padding(.top, 60)
                } else {
                    ProgressView().tint(.tPrimary).padding(.top, 80)
                }
            }
            .backgroundExtensionEffect()
        }
        .navigationTitle("")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await load() }
        .onAppear { Task { await load() } }
        .onReceive(refresh) { _ in Task { await load() } }
        .onReceive(ticker) { now = $0 }
    }

    private func load() async {
        do {
            detail = try await APIClient.shared.train(id: runId)
            errorText = nil
        } catch {
            errorText = error.localizedDescription
        }
    }

    // MARK: sections

    private func hero(_ d: TrainDetail) -> some View {
        let s = d.state
        let origin = s?.origin?.name ?? d.originStop ?? "?"
        let destination = s?.destination?.name ?? d.destinationStop ?? "?"
        return VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Text("\(origin) → \(destination)")
                    .font(.system(size: 24, weight: .heavy, design: .rounded))
                    .foregroundStyle(.tFg)
                    .lineLimit(2)
                Spacer(minLength: 8)
                if let d2 = s?.operatorDelaySec {
                    Text(Fmt.delay(d2))
                        .font(.system(size: 22, weight: .bold, design: .rounded))
                        .monospacedDigit()
                        .foregroundStyle(StatusUI.delayColor(d2))
                }
            }
            HStack(spacing: 8) {
                TBadge(StatusUI.label(s?.status), StatusUI.color(s?.status))
                Text("train \(d.trainNumber)")
                    .font(.system(size: 13, weight: .medium))
                    .monospacedDigit()
                    .foregroundStyle(.tMuted)
            }
            HStack(spacing: 14) {
                if let dep = s?.schedDepEpoch {
                    meta("departs", Fmt.hhmm(dep))
                }
                if let arr = s?.schedArrEpoch {
                    meta("arrives", Fmt.hhmm(arr))
                }
                if let conf = s?.confidence {
                    meta("confidence", conf.capitalized, color: StatusUI.confidenceColor(conf))
                }
                Spacer()
            }
        }
        .padding(16)
        .overlay(alignment: .bottom) { hairline }
        .padding(.horizontal, 16)
        .padding(.top, 6)
    }

    private func meta(_ label: String, _ value: String, color: Color = .tMuted) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label.uppercased())
                .font(.system(size: 9.5, weight: .semibold))
                .tracking(1.1)
                .foregroundStyle(.tDim)
            Text(value)
                .font(.system(size: 13, weight: .semibold))
                .monospacedDigit()
                .foregroundStyle(color)
        }
    }

    /// The prediction, as a picture: scheduled vs operator vs our p10–p90.
    private func predictionCard(_ d: TrainDetail) -> some View {
        let s = d.state
        let ours = s?.ourEstimate
        return VStack(spacing: 14) {
            MicroLabel("predicted arrival · \(s?.destination?.name ?? "destination")")
            PredictionRangeBar(
                sched: s?.schedArrEpoch,
                operatorEta: s?.destinationOperatorEta,
                p10: ours?.p10,
                p50: ours?.p50,
                p90: ours?.p90
            )
            if let recovery = ours?.recoverySec, abs(recovery) >= 60, let current = s?.operatorDelaySec {
                HStack(spacing: 6) {
                    Image(systemName: recovery > 0 ? "arrow.down.right" : "arrow.up.right")
                        .font(.system(size: 10, weight: .bold))
                    Text(recovery > 0
                         ? "on track to recover ~\(abs(recovery) / 60)m of the current \(Fmt.delay(current))"
                         : "likely to lose another ~\(abs(recovery) / 60)m before arrival")
                        .font(.system(size: 12.5))
                }
                .foregroundStyle(recovery > 0 ? Color.tPrimary : Color.tLate)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            if let spread = s?.sourceDelaySpreadSec, spread > 300 {
                Text("sources disagree by \(spread / 60)m — treat estimates with care")
                    .font(.system(size: 12.5))
                    .foregroundStyle(.tLate)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(16)
        .background(Color.tCard, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Color.tBorder, lineWidth: 0.8))
        .padding(.horizontal, 16)
        .padding(.top, 14)
    }

    /// Quiet provenance rows (GOAL.md §97: where did this value come from).
    private func provenance(_ d: TrainDetail) -> some View {
        let s = d.state
        var rows: [TupleRow] = []
        if let loc = s?.latestLocation, let name = loc.name {
            let ageSec = s?.latestObservedAt.map { Int((now.timeIntervalSince1970 - $0 / 1000).rounded()) }
            rows.append(TupleRow(left: s?.latestSource ?? "—", mid: name + (loc.kind == "reporting_point" ? " · rpt" : ""), right: Fmt.age(ageSec)))
        }
        for src in (s?.sources ?? [:]).keys.sorted() {
            if let o = s?.sources?[src] {
                rows.append(TupleRow(left: src, mid: o.delaySec.map { "delay " + Fmt.delay($0) } ?? "no delay data", right: Fmt.age(o.ageSec)))
            }
        }
        guard !rows.isEmpty else { return AnyView(EmptyView()) }
        return AnyView(
            VStack(spacing: 0) {
                MicroLabel("last observation").padding(.horizontal, 20).padding(.top, 18)
                VStack(spacing: 0) {
                    ForEach(Array(rows.enumerated()), id: \.offset) { _, r in
                        HStack {
                            Text(r.left).font(.system(size: 12, weight: .medium)).foregroundStyle(.tFg.opacity(0.85))
                            Text(r.mid).font(.system(size: 12)).foregroundStyle(.tMuted).lineLimit(1)
                            Spacer()
                            Text(r.right).font(.system(size: 12)).monospacedDigit().foregroundStyle(.tDim)
                        }
                        .padding(.horizontal, 20).padding(.vertical, 7)
                        .overlay(alignment: .bottom) { hairline }
                    }
                }
                .padding(.top, 6)
            }
        )
    }

    private struct TupleRow { let left: String; let mid: String; let right: String }

    private func connections(_ conns: [ConnectionOption]) -> some View {
        VStack(spacing: 0) {
            MicroLabel("connections at destination").padding(.horizontal, 20).padding(.top, 18)
            VStack(spacing: 0) {
                ForEach(Array(conns.enumerated()), id: \.element.id) { i, c in
                    connectionRow(c, isBest: c.id == conns.filter { $0.probability > 0.5 }.max(by: { $0.probability < $1.probability })?.id)
                    if i < conns.count - 1 { hairline.padding(.horizontal, 20) }
                }
            }
            .padding(.top, 6)
        }
    }

    private func connectionRow(_ c: ConnectionOption, isBest: Bool) -> some View {
        let color = c.probability >= 0.8 ? Color.tPrimary : (c.probability >= 0.5 ? Color.tLate : Color.tDanger)
        return VStack(spacing: 7) {
            HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(c.trainNumber)
                            .font(.system(size: 15, weight: .bold, design: .rounded))
                            .monospacedDigit()
                            .foregroundStyle(.tFg)
                        if isBest {
                            TBadge("best", .tPrimary)
                        }
                    }
                    Text("→ \(c.destinationName ?? "?") · \(Fmt.hhmm(c.depEpoch))\(c.operatorDelaySec != nil ? " · live" : "")")
                        .font(.system(size: 12))
                        .foregroundStyle(.tMuted)
                }
                Spacer()
                VStack(alignment: .trailing, spacing: 1) {
                    Text(probLabel(c.probability))
                        .font(.system(size: 16, weight: .bold, design: .rounded))
                        .monospacedDigit()
                        .foregroundStyle(color)
                    Text("\(c.transferSec / 60)m transfer")
                        .font(.system(size: 10.5))
                        .foregroundStyle(.tDim)
                }
            }
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.white.opacity(0.07))
                    Capsule().fill(color.opacity(0.55)).frame(width: max(4, geo.size.width * c.probability))
                }
            }
            .frame(height: 3)
        }
        .padding(.horizontal, 20).padding(.vertical, 10)
    }

    private func probLabel(_ p: Double) -> String {
        if p >= 0.999 { return "99%+" }
        return String(Int((p * 100).rounded())) + "%"
    }

    /// Vertical journey timeline: leading rail, one line per stop.
    private func timeline(_ d: TrainDetail) -> some View {
        let stops = d.stops ?? []
        let nextIdx = stops.firstIndex { $0.actualArrEpoch == nil && $0.cancelled != 1 }
        return VStack(spacing: 0) {
            MicroLabel("journey").padding(.horizontal, 20).padding(.top, 18)
            VStack(spacing: 0) {
                ForEach(Array(stops.enumerated()), id: \.element.id) { idx, stop in
                    stopRow(stop, isNext: idx == nextIdx, isFirst: idx == 0, isLast: idx == stops.count - 1)
                }
            }
            .padding(.top, 8)
        }
    }

    private func stopRow(_ stop: DetailStop, isNext: Bool, isFirst: Bool, isLast: Bool) -> some View {
        let passed = stop.actualArrEpoch != nil
        let cancelled = stop.cancelled == 1
        let dotColor: Color = cancelled ? .tDanger : (passed ? .tPrimary : (isNext ? .tPrimary : Color.white.opacity(0.22)))
        return HStack(alignment: .top, spacing: 12) {
            // rail
            VStack(spacing: 0) {
                Rectangle().fill(isFirst ? Color.clear : Color.white.opacity(passed ? 0.16 : 0.08)).frame(width: 1.5, height: 12)
                Circle()
                    .strokeBorder(dotColor, lineWidth: passed ? 0 : 1.5)
                    .frame(width: passed ? 9 : 10, height: passed ? 9 : 10)
                    .overlay {
                        if passed { Circle().fill(dotColor).frame(width: 3.5, height: 3.5) }
                    }
                Rectangle().fill(isLast ? Color.clear : Color.white.opacity(passed ? 0.16 : 0.08)).frame(width: 1.5).frame(maxHeight: .infinity)
            }
            .frame(width: 14)
            .padding(.top, 4)

            HStack(alignment: .firstTextBaseline, spacing: 8) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(stop.displayName)
                        .font(.system(size: 15, weight: isNext ? .bold : (passed ? .regular : .medium)))
                        .foregroundStyle(passed && !isNext ? Color.tDim : Color.tFg)
                    if !passed && stop.opPredArrEpoch != nil && stop.opPredArrEpoch != stop.schedArrEpoch {
                        Text("oper \(Fmt.hhmm(stop.opPredArrEpoch))")
                            .font(.system(size: 11))
                            .monospacedDigit()
                            .foregroundStyle(.tLate)
                    }
                    if passed && stop.arrDelaySec != nil && stop.arrDelaySec != 0 {
                        Text(Fmt.delay(stop.arrDelaySec) + " late")
                            .font(.system(size: 11))
                            .monospacedDigit()
                            .foregroundStyle(StatusUI.delayColor(stop.arrDelaySec))
                    }
                }
                Spacer(minLength: 6)
                if let plat = stop.platformActual, plat != "0", plat != "—" {
                    Text("bin \(plat)")
                        .font(.system(size: 10.5, weight: .medium))
                        .monospacedDigit()
                        .foregroundStyle(.tMuted)
                        .padding(.horizontal, 6).padding(.vertical, 2)
                        .background(Color.white.opacity(0.05), in: RoundedRectangle(cornerRadius: 5))
                }
                Text(passed ? Fmt.hhmm(stop.actualArrEpoch) : Fmt.hhmm(stop.schedArrEpoch))
                    .font(.system(size: 14, weight: passed ? .semibold : .medium))
                    .monospacedDigit()
                    .foregroundStyle(passed ? Color.tPrimary : Color.tFg)
                    .frame(width: 52, alignment: .trailing)
            }
            .padding(.vertical, 8)
            .padding(.trailing, 4)
        }
        .padding(.horizontal, 20)
        .background(isNext ? Color.tPrimary.opacity(0.05) : Color.clear)
        .overlay(alignment: .bottom) { if !isLast { hairline.padding(.horizontal, 48) } }
    }

    private func footer(_ d: TrainDetail) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            if let model = d.state?.ourEstimate?.modelVersion ?? d.latestPrediction?.modelVersion {
                Text("model \(model) · independent segment history blended with the operator ETA · coverage \((d.state?.ourEstimate?.statsCoverage ?? 0) * 100, specifier: "%.0f")%")
            }
            Text("accuracy claims only after the benchmark proves them · sources: Trenord MIA + ViaggiaTreno · times in Europe/Rome")
        }
        .font(.system(size: 10.5))
        .foregroundStyle(.tDim)
        .padding(.horizontal, 20)
        .padding(.top, 16)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: helpers

    private var hairline: some View {
        Rectangle().fill(Color.tBorder).frame(height: 0.7)
    }
}
