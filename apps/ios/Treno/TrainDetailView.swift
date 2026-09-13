import SwiftUI

/// Train page, Flighty-style: a big route header, one colored status banner
/// that answers "am I fine?" in a glance, the prediction as two clean columns
/// (ours vs the operator — GOAL.md §47/§15: scheduled, operator, ours and the
/// likely range all stay visible, just without the chart), a one-line live
/// provenance strip (§97), and a quiet journey timeline. Color only ever
/// means something; zinc surfaces and hairlines carry everything else.
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
            ScrollViewReader { proxy in
                ScrollView {
                    if let detail {
                        VStack(spacing: 0) {
                            routeHeader(detail)
                            statusBanner(detail)
                            estimateCard(detail)
                            liveStrip(detail)
                            if let conns = detail.connections, !conns.isEmpty {
                                connections(conns, at: detail.state?.destination?.name ?? detail.destinationStop ?? "destination")
                                    .id("connections")
                            }
                            timeline(detail)
                                .id("journey")
                            footer
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
                .onAppear { maybeDebugScroll(proxy) }
            }
        }
        .navigationTitle("")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(Color.tBg, for: .navigationBar)
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

    /// debug hook: `simctl launch <dev> com.treno.Treno --train <id> --scroll-journey`
    /// scrolls a section into view so it can be screenshotted
    private func maybeDebugScroll(_ proxy: ScrollViewProxy) {
        let args = ProcessInfo.processInfo.arguments
        let target: String? = args.contains("--scroll-journey") ? "journey"
            : (args.contains("--scroll-connections") ? "connections" : nil)
        guard let target else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) {
            withAnimation { proxy.scrollTo(target, anchor: .top) }
        }
    }

    // MARK: route header

    private func routeHeader(_ d: TrainDetail) -> some View {
        let s = d.state
        let origin = s?.origin?.name ?? d.originStop ?? "?"
        let destination = s?.destination?.name ?? d.destinationStop ?? "?"
        let delay = s?.operatorDelaySec ?? 0
        // when meaningfully off-schedule, show live times; the banner and the
        // estimate card carry the color, the header stays calm zinc
        let dep = abs(delay) >= 60
            ? s?.schedDepEpoch.map { $0 + Double(delay) * 1000 }
            : s?.schedDepEpoch
        var arr = abs(delay) >= 60
            ? (s?.ourEstimate?.p50 ?? s?.destinationOperatorEta)
            : s?.schedArrEpoch
        if s?.status == "arrived", let last = d.stops?.last, let actual = last.actualArrEpoch {
            arr = actual
        }
        return VStack(spacing: 10) {
            HStack(alignment: .top, spacing: 10) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(Fmt.hhmm(dep))
                        .font(.system(size: 30, weight: .heavy, design: .rounded))
                        .monospacedDigit()
                        .foregroundStyle(.tFg)
                    Text(origin)
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(.tMuted)
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)
                }
                Spacer(minLength: 12)
                Image(systemName: "arrow.right")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(.tDim)
                    .padding(.top, 9)
                Spacer(minLength: 12)
                VStack(alignment: .trailing, spacing: 3) {
                    Text(Fmt.hhmm(arr))
                        .font(.system(size: 30, weight: .heavy, design: .rounded))
                        .monospacedDigit()
                        .foregroundStyle(.tFg)
                    Text(destination)
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(.tMuted)
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)
                }
            }
            Text(identityLine(d))
                .font(.system(size: 11.5, weight: .medium))
                .monospacedDigit()
                .foregroundStyle(.tDim)
        }
        .padding(.horizontal, 20)
        .padding(.top, 8)
        .padding(.bottom, 16)
    }

    private func identityLine(_ d: TrainDetail) -> String {
        var parts: [String] = []
        if let op = d.operatorName, !op.isEmpty { parts.append(op.capitalized) }
        parts.append("train \(d.trainNumber)")
        if let n = d.stops?.count, n > 1 { parts.append("\(n) stops") }
        return parts.joined(separator: " · ")
    }

    // MARK: status banner

    private func statusBanner(_ d: TrainDetail) -> some View {
        let (title, color, sub) = statusParts(d)
        return VStack(spacing: 4) {
            Text(title)
                .font(.system(size: 15, weight: .heavy, design: .rounded))
                .tracking(0.4)
                .foregroundStyle(color)
            if !sub.isEmpty {
                Text(sub)
                    .font(.system(size: 13, weight: .medium))
                    .monospacedDigit()
                    .foregroundStyle(.tFg.opacity(0.85))
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 13)
        .background(color.opacity(0.10), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(color.opacity(0.25), lineWidth: 0.8))
        .padding(.horizontal, 16)
    }

    private func statusParts(_ d: TrainDetail) -> (String, Color, String) {
        guard let s = d.state, let status = s.status else {
            return ("NO REALTIME DATA", .tDim, "timetable only for now")
        }
        let delay = s.operatorDelaySec ?? 0
        let originName = s.origin?.name ?? d.originStop ?? "origin"
        let destName = s.destination?.name ?? d.destinationStop ?? "destination"

        switch status {
        case "cancelled":
            return ("CANCELLED", .tDanger, "Trenord cancelled this service")
        case "arrived":
            let actual = d.stops?.last?.actualArrEpoch ?? s.schedArrEpoch
            return (delayTitle(delay), delayColor(delay), "Arrived \(destName) \(Fmt.hhmm(actual))")
        case "scheduled":
            let dep = s.schedDepEpoch.map { $0 + Double(delay) * 1000 }
            var sub = "Departs \(originName) \(Fmt.hhmm(dep))"
            if let c = Fmt.countdown(dep, now: now) { sub += " · \(c)" }
            return (delayTitle(delay), delayColor(delay), sub)
        case "running":
            let eta = s.ourEstimate?.p50 ?? s.destinationOperatorEta
                ?? s.schedArrEpoch.map { $0 + Double(delay) * 1000 }
            var sub = ""
            if let loc = s.previousStop?.name { sub = "Near \(loc) · " }
            sub += "arrives \(Fmt.hhmm(eta))"
            if let c = Fmt.countdown(eta, now: now) { sub += " · \(c)" }
            return (delayTitle(delay), delayColor(delay), sub)
        default:
            return (delayTitle(delay), delayColor(delay), "")
        }
    }

    private func delayTitle(_ sec: Int) -> String {
        let m = Int((Double(abs(sec)) / 60).rounded())
        if sec >= 60 { return "\(m) MIN LATE" }
        if sec <= -60 { return "\(m) MIN EARLY" }
        return "ON TIME"
    }

    private func delayColor(_ sec: Int) -> Color {
        if sec >= 300 { return .tVeryLate }
        if sec >= 60 { return .tLate }
        if sec <= -60 { return .tEarly }
        return .tPrimary
    }

    // MARK: estimate

    @ViewBuilder
    private func estimateCard(_ d: TrainDetail) -> some View {
        if let s = d.state, let ours = s.ourEstimate,
           s.status == "running" || s.status == "scheduled" {
            let destName = s.destination?.name ?? d.destinationStop ?? "destination"
            VStack(spacing: 13) {
                HStack(alignment: .firstTextBaseline) {
                    MicroLabel("our estimate · \(destName)")
                    Spacer()
                    if let conf = s.confidence {
                        TBadge(conf.capitalized, StatusUI.confidenceColor(conf))
                    }
                }
                HStack(alignment: .firstTextBaseline) {
                    Text(Fmt.hhmm(ours.p50))
                        .font(.system(size: 34, weight: .heavy, design: .rounded))
                        .monospacedDigit()
                        .foregroundStyle(.tPrimary)
                    Spacer(minLength: 16)
                    if let op = s.destinationOperatorEta {
                        VStack(alignment: .trailing, spacing: 2) {
                            Text(Fmt.hhmm(op))
                                .font(.system(size: 22, weight: .bold, design: .rounded))
                                .monospacedDigit()
                                .foregroundStyle(.tFg)
                            Text(d.operatorName?.isEmpty == false ? d.operatorName! : "TRENORD")
                                .font(.system(size: 9.5, weight: .semibold))
                                .tracking(1.1)
                                .foregroundStyle(.tDim)
                        }
                    }
                }
                // likely range + the scheduled time it replaces
                HStack(spacing: 8) {
                    Text("likely \(Fmt.hhmm(ours.p10))–\(Fmt.hhmm(ours.p90))")
                        .monospacedDigit()
                        .foregroundStyle(.tMuted)
                    if let sched = s.schedArrEpoch {
                        Text(Fmt.hhmm(sched))
                            .monospacedDigit()
                            .strikethrough()
                            .foregroundStyle(.tDim)
                    }
                }
                .font(.system(size: 12.5))
                .frame(maxWidth: .infinity, alignment: .leading)

                if let rec = ours.recoverySec, abs(rec) >= 60 {
                    deltaLine(icon: rec > 0 ? "arrow.down.right" : "arrow.up.right",
                              text: rec > 0 ? "recovering ~\(abs(rec) / 60)m before arrival"
                                            : "may lose ~\(abs(rec) / 60)m more",
                              color: rec > 0 ? .tPrimary : .tLate)
                }
                if let spread = s.sourceDelaySpreadSec, spread > 300 {
                    deltaLine(icon: "exclamationmark.triangle.fill",
                              text: "sources disagree by \(spread / 60)m",
                              color: .tLate)
                }
            }
            .padding(16)
            .background(Color.tCard, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(Color.tBorder, lineWidth: 0.8))
            .padding(.horizontal, 16)
            .padding(.top, 12)
        }
    }

    private func deltaLine(icon: String, text: String, color: Color) -> some View {
        HStack(spacing: 6) {
            Image(systemName: icon).font(.system(size: 10, weight: .bold))
            Text(text).font(.system(size: 12.5, weight: .medium))
        }
        .foregroundStyle(color)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: live provenance (§97 in one quiet line)

    @ViewBuilder
    private func liveStrip(_ d: TrainDetail) -> some View {
        let sources = (d.state?.sources ?? [:])
            .compactMapValues { $0.ageSec != nil ? $0 : nil }
            .sorted { ($0.value.ageSec ?? 0) < ($1.value.ageSec ?? 0) }
        guard !sources.isEmpty else { return AnyView(EmptyView()) }
        let running = d.state?.status == "running"
        let names = sources.map { key, o in
            let label = key == "mia" ? "Trenord" : (key == "viaggiatreno" ? "ViaggiaTreno" : key.capitalized)
            return "\(label) \(Fmt.age(o.ageSec))"
        }
        return AnyView(
            HStack(spacing: 6) {
                Circle().fill(running ? Color.tPrimary : Color.tDim).frame(width: 5, height: 5)
                Text(names.joined(separator: " · "))
                    .font(.system(size: 11.5))
                    .monospacedDigit()
                    .foregroundStyle(.tDim)
            }
            .frame(maxWidth: .infinity)
            .padding(.top, 12)
        )
    }

    // MARK: connections

    private func connections(_ conns: [ConnectionOption], at destName: String) -> some View {
        let bestId = conns.filter { $0.probability > 0.5 }.max { $0.probability < $1.probability }?.id
        return VStack(spacing: 0) {
            MicroLabel("connections at \(destName)").padding(.horizontal, 20).padding(.top, 24)
            VStack(spacing: 0) {
                ForEach(Array(conns.enumerated()), id: \.element.id) { i, c in
                    connectionRow(c, isBest: c.id == bestId)
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
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 6) {
                        if let badge = lineBadgeText(c.line) {
                            TBadge(badge, .tPrimary)
                        }
                        if isBest {
                            TBadge("best", .tPrimary)
                        }
                    }
                    Text("\(c.destinationName ?? "?") · \(Fmt.hhmm(c.depEpoch))")
                        .font(.system(size: 14, weight: .semibold))
                        .monospacedDigit()
                        .foregroundStyle(.tFg)
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

    private func lineBadgeText(_ line: String?) -> String? {
        guard let line, !line.isEmpty else { return nil }
        let prefix = line.components(separatedBy: " - ").first ?? line
        return prefix.replacingOccurrences(of: "_", with: " ")
    }

    private func probLabel(_ p: Double) -> String {
        if p >= 0.999 { return "99%+" }
        return String(Int((p * 100).rounded())) + "%"
    }

    // MARK: journey timeline

    private func timeline(_ d: TrainDetail) -> some View {
        let stops = d.stops ?? []
        guard !stops.isEmpty else { return AnyView(EmptyView()) }
        // the origin never gets an arrival event — mark it passed once the
        // run is underway or any later stop has one
        let hasLeftOrigin = d.state?.status == "running" || d.state?.status == "arrived"
            || stops.dropFirst().contains { $0.actualArrEpoch != nil }
        let nextIdx = stops.firstIndex {
            !($0.actualArrEpoch != nil || ($0.stopSequence == stops.first?.stopSequence && hasLeftOrigin))
                && $0.cancelled != 1
        }
        return AnyView(
            VStack(spacing: 0) {
                MicroLabel("journey").padding(.horizontal, 20).padding(.top, 24)
                VStack(spacing: 0) {
                    ForEach(Array(stops.enumerated()), id: \.element.id) { idx, stop in
                        stopRow(
                            stop,
                            passed: stop.actualArrEpoch != nil || (idx == 0 && hasLeftOrigin),
                            isNext: idx == nextIdx,
                            isFirst: idx == 0,
                            isLast: idx == stops.count - 1
                        )
                    }
                }
                .padding(.top, 6)
            }
        )
    }

    private func stopRow(_ stop: DetailStop, passed: Bool, isNext: Bool, isFirst: Bool, isLast: Bool) -> some View {
        let cancelled = stop.cancelled == 1
        // the origin has no arrival event — its row reads better as a departure
        let isOrigin = stop.stopSequence == 1 || (stop.schedArrEpoch == nil && stop.schedDepEpoch != nil)
        let pred = isOrigin ? stop.opPredDepEpoch : stop.opPredArrEpoch
        let sched = isOrigin ? stop.schedDepEpoch : stop.schedArrEpoch
        let actual = isOrigin ? stop.actualDepEpoch : stop.actualArrEpoch
        let showDelta = !passed && !cancelled && pred != nil && pred != sched
        let shownTime = passed ? actual : (showDelta ? pred : sched)
        let timeColor: Color = {
            if passed { return .tMuted }
            if showDelta, let p = pred, let s = sched {
                return StatusUI.delayColor(Int((p - s) / 1000))
            }
            return .tFg
        }()

        return HStack(alignment: .top, spacing: 12) {
            VStack(spacing: 0) {
                Rectangle()
                    .fill(isFirst ? Color.clear : Color.white.opacity(passed ? 0.16 : 0.08))
                    .frame(width: 1.5, height: 12)
                ZStack {
                    if cancelled {
                        Circle().fill(Color.tDanger).frame(width: 8, height: 8)
                    } else if passed {
                        Circle().fill(Color.tPrimary).frame(width: 8, height: 8)
                    } else if isNext {
                        Circle().strokeBorder(Color.tPrimary, lineWidth: 1.5)
                        Circle().fill(Color.tPrimary).frame(width: 4.5, height: 4.5)
                    } else {
                        Circle().strokeBorder(Color.white.opacity(0.22), lineWidth: 1.5)
                    }
                }
                .frame(width: 14, height: 14)
                Rectangle()
                    .fill(isLast ? Color.clear : Color.white.opacity(passed ? 0.16 : 0.08))
                    .frame(width: 1.5)
                    .frame(maxHeight: .infinity)
            }
            .frame(width: 14)
            .padding(.top, 6)

            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(stop.displayName)
                        .font(.system(size: 15, weight: isNext ? .bold : (passed ? .regular : .medium)))
                        .foregroundStyle(cancelled ? Color.tDanger : (passed && !isNext ? Color.tMuted : Color.tFg))
                        .strikethrough(cancelled, color: .tDanger)
                        .lineLimit(1)
                    if isNext {
                        TBadge("next", .tPrimary)
                    }
                }
                if showDelta {
                    Text(Fmt.hhmm(sched))
                        .font(.system(size: 11))
                        .monospacedDigit()
                        .strikethrough()
                        .foregroundStyle(.tDim)
                }
            }

            Spacer(minLength: 6)
            // platforms from this feed can be garbage ("1988") — only real bins
            if let plat = stop.platformActual, let n = Int(plat), (1...30).contains(n) {
                Text(plat)
                    .font(.system(size: 11, weight: .semibold))
                    .monospacedDigit()
                    .foregroundStyle(.tMuted)
                    .frame(width: 26, height: 20)
                    .background(Color.white.opacity(0.05), in: RoundedRectangle(cornerRadius: 6, style: .continuous))
            }
            Text(Fmt.hhmm(shownTime))
                .font(.system(size: 14.5, weight: isNext ? .bold : (passed ? .medium : .semibold)))
                .monospacedDigit()
                .foregroundStyle(cancelled ? Color.tDanger : timeColor)
                .frame(width: 52, alignment: .trailing)
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 8)
        .background(isNext ? Color.tPrimary.opacity(0.05) : Color.clear)
        .overlay(alignment: .bottom) { if !isLast { hairline.padding(.horizontal, 48) } }
    }

    // MARK: footer

    private var footer: some View {
        Text("Trenord MIA + Viaggiatreno · auto-refresh · times in Europe/Rome")
            .font(.system(size: 10.5))
            .foregroundStyle(.tDim)
            .frame(maxWidth: .infinity)
            .padding(.top, 18)
    }

    // MARK: helpers

    private var hairline: some View {
        Rectangle().fill(Color.tBorder).frame(height: 0.7)
    }
}
