import SwiftUI

// Semantic system colors keep every surface legible in light and dark mode.
// Blue identifies actions; green, orange, and red describe service conditions.
extension ShapeStyle where Self == Color {
    static var tBg: Color { Color(uiColor: .systemGroupedBackground) }
    static var tCard: Color { Color(uiColor: .secondarySystemGroupedBackground) }
    static var tElevated: Color { Color(uiColor: .tertiarySystemGroupedBackground) }
    static var tBorder: Color { Color(uiColor: .separator).opacity(0.35) }
    static var tFg: Color { Color(uiColor: .label) }
    static var tMuted: Color { Color(uiColor: .secondaryLabel) }
    static var tDim: Color { Color(uiColor: .secondaryLabel) }
    static var tPrimary: Color { .blue }
    static var tPrimaryDim: Color { Color.blue.opacity(0.08) }
    static var tGood: Color { Color(uiColor: UIColor { $0.userInterfaceStyle == .dark ? .systemGreen : UIColor(red: 0.12, green: 0.46, blue: 0.27, alpha: 1) }) }
    static var tLate: Color { Color(uiColor: UIColor { $0.userInterfaceStyle == .dark ? .systemOrange : UIColor(red: 0.64, green: 0.34, blue: 0.02, alpha: 1) }) }
    static var tVeryLate: Color { .red }
    static var tEarly: Color { .tGood }
    static var tWarn: Color { .tLate }
    static var tDanger: Color { .red }
    /// favorites star — proper yellow, distinct from the orange "late" semantic
    static var tStar: Color { Color(uiColor: UIColor { $0.userInterfaceStyle == .dark ? UIColor(red: 1.0, green: 0.8, blue: 0.27, alpha: 1) : UIColor(red: 0.85, green: 0.62, blue: 0.02, alpha: 1) }) }
}

// Quiet color behind the controls gives the native material something to
// refract. Accessibility settings restore a plain, opaque system surface.
struct TrenoBackground: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.colorSchemeContrast) private var contrast

    var body: some View {
        ZStack {
            Color.tBg
            if !reduceTransparency && contrast != .increased {
                GeometryReader { geometry in
                    RadialGradient(colors: [.blue.opacity(colorScheme == .dark ? 0.16 : 0.10), .clear],
                                   center: .topLeading, startRadius: 0, endRadius: geometry.size.height * 0.75)
                    RadialGradient(colors: [.cyan.opacity(colorScheme == .dark ? 0.07 : 0.06), .clear],
                                   center: .bottomTrailing, startRadius: 0, endRadius: geometry.size.height * 0.6)
                }
            }
        }.ignoresSafeArea().allowsHitTesting(false).accessibilityHidden(true)
    }
}

private struct TrenoGlass: ViewModifier {
    let cornerRadius: CGFloat
    let interactive: Bool
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.colorSchemeContrast) private var contrast

    func body(content: Content) -> some View {
        if reduceTransparency || contrast == .increased {
            content.background(Color.tCard, in: RoundedRectangle(cornerRadius: cornerRadius))
                .overlay(RoundedRectangle(cornerRadius: cornerRadius).strokeBorder(Color.tBorder))
        } else {
            content.glassEffect(.regular.interactive(interactive), in: .rect(cornerRadius: cornerRadius))
        }
    }
}

extension View {
    func trenoGlass(cornerRadius: CGFloat = 26, interactive: Bool = true) -> some View {
        modifier(TrenoGlass(cornerRadius: cornerRadius, interactive: interactive))
    }
}

struct MicroLabel: View {
    let text: String
    init(_ text: String) { self.text = text }
    var body: some View {
        Text(text).font(.subheadline.weight(.semibold)).foregroundStyle(.tMuted)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct TBadge: View {
    let text: String
    let color: Color
    init(_ text: String, _ color: Color) { self.text = text; self.color = color }
    var body: some View {
        Text(text).font(.caption.weight(.semibold))
            .foregroundStyle(color).padding(.horizontal, 8).padding(.vertical, 4)
            .background(color.opacity(0.09), in: RoundedRectangle(cornerRadius: 6))
    }
}

/// Bare platform number chip — the number is the whole message.
struct PlatformChip: View {
    let platform: String
    var body: some View {
        Text(platform).font(.footnote.weight(.semibold)).monospacedDigit()
            .foregroundStyle(.tMuted)
            .frame(minWidth: 30, minHeight: 26)
            .overlay(RoundedRectangle(cornerRadius: 7).strokeBorder(Color.tBorder, lineWidth: 1))
    }
}

struct SectionHeading: View {
    let title: String
    var body: some View {
        Text(title).font(.title3.weight(.bold)).foregroundStyle(.tFg)
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityAddTraits(.isHeader)
    }
}

struct TravelNotice: View {
    let title: String
    let message: String
    var icon = "wifi.exclamationmark"
    var body: some View {
        Label {
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.subheadline.weight(.semibold))
                Text(message).font(.footnote).foregroundStyle(.tMuted)
            }
        } icon: {
            Image(systemName: icon).foregroundStyle(.tMuted)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(18).background(Color.tCard, in: RoundedRectangle(cornerRadius: 20))
    }
}

struct RouteEndpoints: View {
    let from: String
    let to: String
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Label { Text(from).foregroundStyle(.tMuted) } icon: {
                Image(systemName: "circle").font(.caption.weight(.semibold))
            }
            Label { Text(to).font(.title2.weight(.semibold)).foregroundStyle(.tFg) } icon: {
                Image(systemName: "mappin.circle.fill")
            }
        }
        .font(.body).foregroundStyle(.tPrimary)
        .labelStyle(.titleAndIcon)
    }
}

enum StatusUI {
    static func color(_ status: String?) -> Color {
        switch status {
        case "running": return .tGood
        case "cancelled": return .tDanger
        default: return .tMuted
        }
    }
    static func label(_ status: String?) -> String {
        switch status {
        case "running": return "On its way"
        case "scheduled": return "Scheduled"
        case "arrived": return "Arrived"
        case "cancelled": return "Cancelled"
        default: return "Timetable"
        }
    }
    static func delayColor(_ sec: Int?) -> Color {
        guard let sec else { return .tMuted }
        if sec >= 300 { return .tVeryLate }
        if sec >= 60 { return .tLate }
        return .tGood
    }
    static func confidenceColor(_ confidence: String?) -> Color {
        switch confidence {
        case "HIGH": return .tGood
        case "MEDIUM": return .tLate
        default: return .tMuted
        }
    }
}

extension Fmt {
    static func delayShort(_ sec: Int?) -> String {
        guard let sec else { return "Timetable" }
        if abs(sec) < 60 { return "On time" }
        let mins = Int((Double(abs(sec)) / 60).rounded())
        return sec > 0 ? "\(mins) min late" : "\(mins) min early"
    }
    static func platform(_ value: String?) -> String? {
        guard let value, let number = Int(value), (1...30).contains(number) else { return nil }
        return value
    }
    static func departure(_ epoch: Double, now: Date = .now) -> String {
        let minutes = Int(ceil((epoch - now.timeIntervalSince1970 * 1000) / 60_000))
        if minutes < 0 { return "Departed" }
        if minutes == 0 { return "Due now" }
        if minutes < 60 { return "In \(minutes) min" }
        return "In \(minutes / 60) hr\(minutes % 60 == 0 ? "" : " \(minutes % 60) min")"
    }
}

extension TrainState {
    /// seconds since the run was last actually observed (nil = never)
    var observedAgeSec: Int? {
        latestObservedAt.map { max(0, Int((Date.now.timeIntervalSince1970 * 1000 - $0) / 1000)) }
    }
    /// live signal only counts while fresh — a run last seen hours ago says
    /// nothing about the train in front of you now. 30 min keeps genuinely
    /// late trains visible between observations while excluding day-old state.
    var isFresh: Bool { observedAgeSec.map { $0 <= 1800 } ?? false }
    var liveDelaySec: Int? { isFresh ? operatorDelaySec : nil }
}

/// Effective delay for boarding at a stop, fusing stop-level and run-level
/// signals. Stop rows are seeded with delay 0 from the timetable, so before
/// the train has actually departed the stop a zero there means "unknown", not
/// "on time" — the run's fresh live delay is the real signal.
func boardingDelay(depDelaySec: Int?, actualDepEpoch: Double?, state: TrainState?) -> Int? {
    if actualDepEpoch != nil { return depDelaySec }
    if let depDelaySec, depDelaySec != 0 { return depDelaySec }
    return state?.liveDelaySec
}

extension JourneyRow {
    var departureDelay: Int? { boardingDelay(depDelaySec: depDelaySec, actualDepEpoch: actualDepEpoch, state: state) }
    var expectedDeparture: Double { actualDepEpoch ?? depEpoch + Double(departureDelay ?? 0) * 1000 }
    // A run's prediction is for its final destination. Intermediate journeys
    // use their own scheduled arrival with the observed delay instead.
    var expectedArrival: Double {
        if destinationName == state?.destination?.name {
            return state?.ourEstimate?.p50 ?? state?.destinationOperatorEta ?? arrEpoch + Double(departureDelay ?? 0) * 1000
        }
        return arrEpoch + Double(departureDelay ?? 0) * 1000
    }
    func canBoard(at now: Date = .now) -> Bool {
        state?.status != "cancelled" && state?.status != "arrived"
            && actualDepEpoch == nil && expectedDeparture >= now.timeIntervalSince1970 * 1000 - 30_000
    }
}

extension Trip {
    var daySummary: String {
        if days.count == 7 { return "Every day" }
        if days == Set(1...5) { return "Weekdays" }
        if days == Set([6, 7]) { return "Weekends" }
        if days.isEmpty { return "No days selected" }
        let names = [1: "Mon", 2: "Tue", 3: "Wed", 4: "Thu", 5: "Fri", 6: "Sat", 7: "Sun"]
        return days.sorted().compactMap { names[$0] }.joined(separator: ", ")
    }
}
