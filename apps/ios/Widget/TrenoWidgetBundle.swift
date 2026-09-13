import SwiftUI
import WidgetKit

@main
struct TrenoWidgetBundle: WidgetBundle {
    var body: some Widget {
        TrenoTripWidget()
        TripLiveActivity()
    }
}

// MARK: - home-screen widget (follows the first saved trip)

struct TripEntry: TimelineEntry {
    let date: Date
    let config: WTripConfig?
    let journey: WJourney?
}

struct TripProvider: TimelineProvider {
    func placeholder(in context: Context) -> TripEntry {
        TripEntry(date: .now, config: nil, journey: nil)
    }

    func getSnapshot(in context: Context, completion: @escaping @Sendable (TripEntry) -> Void) {
        Task {
            completion(await Self.load())
        }
    }

    func getTimeline(in context: Context, completion: @escaping @Sendable (Timeline<TripEntry>) -> Void) {
        Task {
            let entry = await Self.load()
            // WidgetKit budgets refreshes; 15 min is a sane live-ish cadence
            let next = Calendar.current.date(byAdding: .minute, value: 15, to: .now) ?? .now.addingTimeInterval(900)
            completion(Timeline(entries: [entry], policy: .after(next)))
        }
    }

    private static func load() async -> TripEntry {
        guard let cfg = WFetch.tripConfig() else {
            return TripEntry(date: .now, config: nil, journey: nil)
        }
        let j = await WFetch.nextJourney(cfg)
        return TripEntry(date: .now, config: cfg, journey: j)
    }
}

struct TrenoTripWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "TrenoTripWidget", provider: TripProvider()) { entry in
            TripWidgetView(entry: entry)
                .containerBackground(WColor.bg, for: .widget)
        }
        .configurationDisplayName("Trip")
        .description("Next train for your first saved trip, with our live estimate.")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}

struct TripWidgetView: View {
    let entry: TripEntry

    var body: some View {
        if let cfg = entry.config, let j = entry.journey {
            content(cfg, j)
        } else {
            VStack(alignment: .leading, spacing: 6) {
                Image(systemName: "heart")
                    .font(.system(size: 20, weight: .semibold))
                    .foregroundStyle(WColor.primary)
                Text("Open Treno and save a trip")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(WColor.muted)
                Spacer()
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
    }

    @ViewBuilder
    private func content(_ cfg: WTripConfig, _ j: WJourney) -> some View {
        let delay = j.depDelaySec ?? j.state?.operatorDelaySec
        let running = j.state?.status == "running"
        let estDep = j.depEpoch + Double(delay ?? 0) * 1000
        let oursArr = j.state?.ourEstimate?.p50
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(cfg.fromName)
                    .font(.system(size: 13, weight: .bold))
                    .lineLimit(1)
                Image(systemName: "arrow.right")
                    .font(.system(size: 10, weight: .bold))
                    .foregroundStyle(WColor.primary)
                Text(cfg.toName)
                    .font(.system(size: 13, weight: .bold))
                    .lineLimit(1)
                Spacer()
                if running {
                    Circle().fill(WColor.primary).frame(width: 6, height: 6)
                }
            }
            .foregroundStyle(WColor.fg)

            HStack(alignment: .firstTextBaseline, spacing: 10) {
                VStack(alignment: .leading, spacing: 1) {
                    Text(WFmt.hhmm(estDep))
                        .font(.system(size: 26, weight: .heavy, design: .rounded))
                        .monospacedDigit()
                        .foregroundStyle(WColor.delayColor(delay))
                    Text(delay != nil && abs(delay!) >= 60 ? "sched " + WFmt.hhmm(j.depEpoch) : "departs")
                        .font(.system(size: 10))
                        .monospacedDigit()
                        .foregroundStyle(WColor.dim)
                }
                Spacer()
                VStack(alignment: .trailing, spacing: 1) {
                    Text(WFmt.hhmm(oursArr ?? j.arrEpoch))
                        .font(.system(size: 20, weight: .bold, design: .rounded))
                        .monospacedDigit()
                        .foregroundStyle(oursArr != nil ? WColor.primary : WColor.fg)
                    Text(oursArr != nil ? "ours · arr" : "arrives")
                        .font(.system(size: 10))
                        .foregroundStyle(WColor.dim)
                }
            }

            HStack(spacing: 6) {
                if let line = j.line {
                    Text(line)
                        .font(.system(size: 10.5, weight: .semibold))
                        .foregroundStyle(WColor.primary)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(WColor.primary.opacity(0.14), in: RoundedRectangle(cornerRadius: 5))
                }
                Text(j.trainNumber)
                    .font(.system(size: 10.5, weight: .medium))
                    .monospacedDigit()
                    .foregroundStyle(WColor.dim)
                if let p = j.platform, let n = Int(p), n >= 1, n <= 30 {
                    Text("bin \(p)")
                        .font(.system(size: 10.5, weight: .medium))
                        .monospacedDigit()
                        .foregroundStyle(WColor.muted)
                }
                Spacer()
                if let d = delay, abs(d) >= 60 {
                    Text(WFmt.delayShort(d))
                        .font(.system(size: 11, weight: .bold))
                        .foregroundStyle(WColor.delayColor(d))
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

// MARK: - Dynamic Island live activity

struct TripLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: TripActivityAttributes.self) { context in
            // lock screen / banner
            LockScreenActivityView(context: context)
                .activityBackgroundTint(WColor.bg.opacity(0.92))
                .activitySystemActionForegroundColor(WColor.primary)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(context.attributes.originName)
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(WColor.muted)
                            .lineLimit(1)
                        Image(systemName: "arrow.down")
                            .font(.system(size: 9, weight: .bold))
                            .foregroundStyle(WColor.primary)
                        Text(context.attributes.destinationName)
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(WColor.muted)
                            .lineLimit(1)
                    }
                }
                DynamicIslandExpandedRegion(.trailing) {
                    VStack(alignment: .trailing, spacing: 2) {
                        Text(WFmt.hhmm(context.state.ourArrEpoch ?? context.state.arrEpoch))
                            .font(.system(size: 17, weight: .heavy, design: .rounded))
                            .monospacedDigit()
                            .foregroundStyle(context.state.ourArrEpoch != nil ? WColor.primary : WColor.fg)
                        Text(context.state.ourArrEpoch != nil ? "ours" : "arrives")
                            .font(.system(size: 9))
                            .foregroundStyle(WColor.dim)
                    }
                }
                DynamicIslandExpandedRegion(.center) {
                    ActivityProgressBar(state: context.state)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    HStack(spacing: 8) {
                        if let line = context.state.line {
                            Text(line)
                                .font(.system(size: 11, weight: .bold))
                                .foregroundStyle(WColor.primary)
                        }
                        Text("train " + context.state.trainNumber)
                            .font(.system(size: 11, weight: .medium))
                            .monospacedDigit()
                            .foregroundStyle(WColor.fg)
                        if let p = context.state.platform {
                            Text("bin \(p)")
                                .font(.system(size: 11))
                                .monospacedDigit()
                                .foregroundStyle(WColor.muted)
                        }
                        Spacer()
                        if let d = context.state.delaySec, d != 0 {
                            Text(WFmt.delayShort(d))
                                .font(.system(size: 12, weight: .bold))
                                .foregroundStyle(WColor.delayColor(d))
                        } else {
                            Text("on time")
                                .font(.system(size: 11))
                                .foregroundStyle(WColor.dim)
                        }
                        Text(WFmt.hhmm(context.state.depEpoch + Double(context.state.delaySec ?? 0) * 1000))
                            .font(.system(size: 11, weight: .semibold))
                            .monospacedDigit()
                            .foregroundStyle(WColor.fg)
                    }
                }
            } compactLeading: {
                Text(context.state.line ?? context.state.trainNumber)
                    .font(.system(size: 12, weight: .bold))
                    .foregroundStyle(WColor.primary)
                    .frame(maxHeight: 40)
            } compactTrailing: {
                Text(WFmt.delayShort(context.state.delaySec).isEmpty ? "on time" : WFmt.delayShort(context.state.delaySec))
                    .font(.system(size: 12, weight: .semibold))
                    .monospacedDigit()
                    .foregroundStyle(WColor.delayColor(context.state.delaySec))
                    .frame(maxHeight: 40)
            } minimal: {
                Text(context.state.line ?? context.state.trainNumber)
                    .font(.system(size: 11, weight: .bold))
                    .foregroundStyle(WColor.primary)
                    .frame(maxHeight: 40)
            }
            .keylineTint(WColor.primary)
        }
    }
}

/// journey progress: fraction between departure and arrival
struct ActivityProgressBar: View {
    let state: TripActivityAttributes.ContentState
    @State private var now = Date.now

    private var fraction: Double {
        let nowMs = now.timeIntervalSince1970 * 1000
        let dep = state.depEpoch
        let arr = state.arrEpoch
        guard arr > dep else { return 0 }
        return min(max((nowMs - dep) / (arr - dep), 0), 1)
    }

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(Color.white.opacity(0.12))
                Capsule().fill(LinearGradient(colors: [WColor.primary.opacity(0.7), WColor.primary], startPoint: .leading, endPoint: .trailing))
                    .frame(width: max(6, geo.size.width * fraction))
                Circle()
                    .fill(WColor.primary)
                    .frame(width: 10, height: 10)
                    .overlay(Circle().strokeBorder(WColor.bg, lineWidth: 2))
                    .offset(x: max(0, geo.size.width * fraction - 5))
            }
        }
        .frame(height: 12)
        .onReceive(Timer.publish(every: 30, on: .main, in: .common).autoconnect()) { now = $0 }
    }
}

struct LockScreenActivityView: View {
    let context: ActivityViewContext<TripActivityAttributes>

    var body: some View {
        let s = context.state
        let delay = s.delaySec
        HStack(spacing: 14) {
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(context.attributes.tripName)
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(WColor.muted)
                        .lineLimit(1)
                    if s.status == "running" {
                        Circle().fill(WColor.primary).frame(width: 6, height: 6)
                    }
                }
                HStack(spacing: 8) {
                    Text(WFmt.hhmm(s.depEpoch + Double(delay ?? 0) * 1000))
                        .font(.system(size: 24, weight: .heavy, design: .rounded))
                        .monospacedDigit()
                        .foregroundStyle(WColor.delayColor(delay))
                    Image(systemName: "arrow.right")
                        .font(.system(size: 12, weight: .bold))
                        .foregroundStyle(WColor.primary)
                    Text(WFmt.hhmm(s.ourArrEpoch ?? s.arrEpoch))
                        .font(.system(size: 24, weight: .heavy, design: .rounded))
                        .monospacedDigit()
                        .foregroundStyle(s.ourArrEpoch != nil ? WColor.primary : WColor.fg)
                }
                HStack(spacing: 8) {
                    if let line = s.line {
                        Text(line).font(.system(size: 11, weight: .bold)).foregroundStyle(WColor.primary)
                    }
                    Text("train " + s.trainNumber).font(.system(size: 11)).monospacedDigit().foregroundStyle(WColor.dim)
                    if let d = delay, abs(d) >= 60 {
                        Text(WFmt.delayShort(d)).font(.system(size: 11, weight: .bold)).foregroundStyle(WColor.delayColor(d))
                    }
                    if let p = s.platform {
                        Text("bin \(p)").font(.system(size: 11)).monospacedDigit().foregroundStyle(WColor.muted)
                    }
                }
            }
            Spacer()
            VStack(spacing: 4) {
                if s.ourArrEpoch != nil {
                    Text("ours")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(WColor.primary)
                }
                Image(systemName: s.status == "arrived" ? "checkmark.circle.fill" : "tram.fill")
                    .font(.system(size: 22))
                    .foregroundStyle(s.status == "arrived" ? WColor.primary : WColor.muted)
            }
        }
        .padding(14)
    }
}
