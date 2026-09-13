import SwiftUI

/// The train page (GOAL.md §65): status, delay, last observation, the three
/// time levels (scheduled / operator / ours), confidence, and the full stop
/// timeline with provenance. Auto-refreshes while open.
struct TrainDetailView: View {
    let runId: Int

    @State private var detail: TrainDetail?
    @State private var errorText: String?
    @State private var now = Date.now

    private let refresh = Timer.publish(every: 10, on: .main, in: .common).autoconnect()
    private let ticker = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

    var body: some View {
        ScrollView {
            if let detail {
                LazyVStack(spacing: 12) {
                    header(detail)
                    arrivalTrio(detail)
                    observationChips(detail)
                    if let conns = detail.connections, !conns.isEmpty {
                        connectionsSection(conns)
                    }
                    stopTimeline(detail)
                    footer(detail)
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 8)
            } else if let errorText {
                Text(errorText)
                    .font(.footnote)
                    .foregroundStyle(.trenoBad)
                    .padding(.top, 40)
            } else {
                ProgressView().padding(.top, 60)
            }
        }
        .backgroundExtensionEffect()
        .navigationTitle(detail.map { $0.trainNumber } ?? "Train")
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

    private func header(_ d: TrainDetail) -> some View {
        let s = d.state
        return VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Text(d.trainNumber)
                    .font(.system(size: 34, weight: .bold))
                    .monospacedDigit()
                StatusBadge(status: s?.status)
                Spacer()
                if let conf = s?.confidence {
                    VStack(alignment: .trailing, spacing: 2) {
                        Text("confidence")
                            .font(.caption2)
                            .foregroundStyle(.trenoDim)
                        Text(conf)
                            .font(.headline.weight(.bold))
                            .foregroundStyle(StatusUI.confidenceColor(conf))
                    }
                }
            }
            Text("\(s?.origin?.name ?? d.originStop ?? "?") → \(s?.destination?.name ?? d.destinationStop ?? "?")")
                .font(.headline)
                .foregroundStyle(.secondary)
            HStack(spacing: 12) {
                if let dep = s?.schedDepEpoch {
                    Label(Fmt.hhmm(dep), systemImage: "arrow.right.circle")
                }
                if let delay = s?.operatorDelaySec {
                    Label(Fmt.delay(delay), systemImage: delay >= 60 ? "clock.badge.exclamationmark" : "clock.badge.checkmark")
                        .foregroundStyle(StatusUI.delayColor(delay))
                }
                Text(d.serviceDate)
                    .foregroundStyle(.trenoDim)
            }
            .font(.subheadline)
            .monospacedDigit()
        }
        .glassCard()
    }

    /// Scheduled vs Trenord vs our model — never collapse these into one number.
    private func arrivalTrio(_ d: TrainDetail) -> some View {
        let s = d.state
        let ours = s?.ourEstimate
        return VStack(spacing: 10) {
            SectionLabel("destination · \(s?.destination?.name ?? "arrival")")
            HStack(alignment: .top, spacing: 0) {
                trioCell(label: "Scheduled", value: Fmt.hhmm(s?.schedArrEpoch), sub: nil, color: .trenoDim)
                trioCell(label: "Operator", value: Fmt.hhmm(s?.destinationOperatorEta), sub: nil, color: .trenoWarn)
                trioCell(label: "Ours", value: Fmt.hhmm(ours?.p50),
                         sub: ours != nil ? "\(Fmt.hhmm(ours?.p10))–\(Fmt.hhmm(ours?.p90))" : nil,
                         color: .trenoAccent)
            }
            if let recovery = ours?.recoverySec, recovery != 0, let current = s?.operatorDelaySec {
                Label(
                    recovery > 0
                        ? "expected to recover ~\(abs(recovery / 60))m of the current \(Fmt.delay(current)) by arrival"
                        : "expected to lose another ~\(abs(recovery) / 60)m by arrival",
                    systemImage: recovery > 0 ? "arrow.down.right.circle.fill" : "arrow.up.right.circle.fill"
                )
                .font(.caption2)
                .foregroundStyle(recovery > 0 ? Color.trenoGood : Color.trenoWarn)
            }
            if let spread = s?.sourceDelaySpreadSec, spread > 60 {
                Label("sources disagree by \(spread / 60)m — lower confidence", systemImage: "exclamationmark.triangle")
                    .font(.caption2)
                    .foregroundStyle(.trenoWarn)
            }
            if let q = s?.quality, !q.isEmpty {
                Text("quality: " + q.joined(separator: ", "))
                    .font(.caption2)
                    .foregroundStyle(.trenoWarn)
            }
        }
        .glassCard()
    }

    private func trioCell(label: String, value: String, sub: String?, color: Color) -> some View {
        VStack(spacing: 4) {
            Text(label.uppercased())
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.trenoDim)
            Text(value)
                .font(.title2.weight(.bold))
                .monospacedDigit()
                .foregroundStyle(color)
                .contentTransition(.numericText())
            Text(sub ?? " ")
                .font(.caption2)
                .monospacedDigit()
                .foregroundStyle(.trenoDim)
                .lineLimit(1)
        }
        .frame(maxWidth: .infinity)
    }

    /// Connection risk at the destination (§18): P(making each next service).
    private func connectionsSection(_ conns: [ConnectionOption]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionLabel("connections at destination")
            ForEach(conns) { c in
                HStack(spacing: 10) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(c.trainNumber + (c.line.map { "  \($0)" } ?? ""))
                            .font(.footnote.weight(.semibold))
                            .monospacedDigit()
                        Text("→ \(c.destinationName ?? "?") · \(Fmt.hhmm(c.depEpoch))" + (c.operatorDelaySec != nil ? " (live)" : ""))
                            .font(.caption2)
                            .foregroundStyle(.trenoDim)
                    }
                    Spacer()
                    VStack(alignment: .trailing, spacing: 2) {
                        Text(probLabel(c.probability))
                            .font(.subheadline.weight(.bold))
                            .foregroundStyle(probColor(c.probability))
                        Text("transfer \(c.transferSec / 60)m")
                            .font(.caption2)
                            .foregroundStyle(.trenoDim)
                    }
                }
                .padding(.vertical, 4)
                if c.id != conns.last?.id { Divider().overlay(Color.white.opacity(0.06)) }
            }
        }
        .glassCard()
    }

    private func probLabel(_ p: Double) -> String {
        if p >= 0.999 { return "99%+" }
        return String(Int((p * 100).rounded())) + "%"
    }

    private func probColor(_ p: Double) -> Color {
        if p >= 0.8 { return .trenoGood }
        if p >= 0.5 { return .trenoWarn }
        return .trenoBad
    }

    private func observationChips(_ d: TrainDetail) -> some View {
        let s = d.state
        return GlassEffectContainer(spacing: 8) {
            VStack(alignment: .leading, spacing: 8) {
                SectionLabel("last observation")
                if let loc = s?.latestLocation, let name = loc.name {
                    chip(icon: "location.fill", text: name + (loc.kind == "reporting_point" ? " · reporting point" : ""),
                         sub: ageOf(s?.latestObservedAt) + " · " + (s?.latestSource ?? "?"))
                } else {
                    chip(icon: "location.slash", text: "no location reported", sub: "—")
                }
                ForEach(Array((s?.sources ?? [:]).keys.sorted()), id: \.self) { src in
                    if let o = s?.sources?[src] {
                        chip(icon: "dot.radiowaves.left.and.right",
                             text: "\(src): \(o.delaySec.map(Fmt.delay) ?? "n/d")",
                             sub: "age " + Fmt.age(o.ageSec) + (o.status.map { " · \($0)" } ?? ""))
                    }
                }
            }
        }
        .padding(14)
    }

    private func chip(icon: String, text: String, sub: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: icon)
                .font(.caption)
                .foregroundStyle(.trenoAccent)
            Text(text)
                .font(.footnote.weight(.medium))
                .lineLimit(1)
            Spacer()
            Text(sub)
                .font(.caption2)
                .foregroundStyle(.trenoDim)
                .monospacedDigit()
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .glassEffect()
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    private func stopTimeline(_ d: TrainDetail) -> some View {
        let stops = d.stops ?? []
        let nextIdx = stops.firstIndex { $0.actualArrEpoch == nil && $0.cancelled != 1 }
        return VStack(alignment: .leading, spacing: 0) {
            SectionLabel("stops")
            HStack(spacing: 8) {
                Text("stop").frame(maxWidth: .infinity, alignment: .leading)
                Text("sched").frame(width: 46, alignment: .trailing)
                Text("oper.").frame(width: 46, alignment: .trailing)
                Text("actual").frame(width: 46, alignment: .trailing)
                Text("delay").frame(width: 46, alignment: .trailing)
            }
            .font(.caption2.weight(.semibold))
            .foregroundStyle(.trenoDim)
            .padding(.bottom, 6)
            ForEach(Array(stops.enumerated()), id: \.element.id) { idx, stop in
                stopRow(stop, isNext: idx == nextIdx)
                if idx < stops.count - 1 { Divider().overlay(Color.white.opacity(0.06)) }
            }
        }
        .glassCard()
    }

    private func stopRow(_ stop: DetailStop, isNext: Bool) -> some View {
        let passed = stop.actualArrEpoch != nil
        return HStack(spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: passed ? "circle.fill" : (isNext ? "circle.dotted" : "circle"))
                    .font(.system(size: 7))
                    .foregroundStyle(isNext ? Color.trenoAccent : (passed ? Color.trenoGood : Color.trenoDim))
                Text(stopName(stop))
                    .font(passed ? .footnote : .subheadline.weight(isNext ? .semibold : .regular))
                    .foregroundStyle(passed ? Color.trenoDim : Color.primary)
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            Text(Fmt.hhmm(stop.schedArrEpoch)).frame(width: 46, alignment: .trailing)
            Text(Fmt.hhmm(stop.opPredArrEpoch)).frame(width: 46, alignment: .trailing)
                .foregroundStyle(.trenoWarn)
            Text(Fmt.hhmm(stop.actualArrEpoch)).frame(width: 46, alignment: .trailing)
                .foregroundStyle(passed ? Color.trenoGood : Color.trenoDim)
            Text(stop.arrDelaySec != nil ? Fmt.delay(stop.arrDelaySec) : "—").frame(width: 46, alignment: .trailing)
                .foregroundStyle(StatusUI.delayColor(stop.arrDelaySec))
        }
        .font(.footnote.monospacedDigit())
        .padding(.vertical, 5)
        .padding(.horizontal, isNext ? 8 : 0)
        .background((isNext ? Color.trenoAccent.opacity(0.08) : Color.clear), in: RoundedRectangle(cornerRadius: 8))
    }

    private func footer(_ d: TrainDetail) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            if let model = d.state?.ourEstimate?.modelVersion ?? d.latestPrediction?.modelVersion {
                Text("model: \(model) — independent segment-history estimate blended with the operator ETA (history coverage \((d.state?.ourEstimate?.statsCoverage ?? 0) * 100, specifier: "%.0f")%).")
            }
            Text("Accuracy claims only after the benchmark proves them (§34). Sources: Trenord MIA + ViaggiaTreno/RFI with per-source provenance. Times in Europe/Rome.")
        }
        .font(.caption2)
        .foregroundStyle(.trenoDim)
        .padding(.top, 6)
    }

    // MARK: helpers

    private func stopName(_ stop: DetailStop) -> String {
        let base = stop.displayName
        if let seq = stop.stopSequence { return "\(seq). \(base)" }
        return base
    }

    private func ageOf(_ epochMs: Double?) -> String {
        guard let ms = epochMs else { return "—" }
        return Fmt.age(Int((now.timeIntervalSince1970 - ms / 1000).rounded()))
    }
}
