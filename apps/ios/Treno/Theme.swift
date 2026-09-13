import SwiftUI

// Design system: shadcn/ui-inspired zinc-dark palette with Trenord green as
// the single accent. Neutral surfaces carry the layout; color is reserved for
// meaning (primary/green = ours & healthy, amber = late, red = risk).

extension ShapeStyle where Self == Color {
    // surfaces
    static var tBg: Color { Color(red: 0.035, green: 0.035, blue: 0.043) }        // zinc-950
    static var tCard: Color { Color(red: 0.055, green: 0.055, blue: 0.063) }      // zinc-900
    static var tElevated: Color { Color(red: 0.086, green: 0.086, blue: 0.098) }  // zinc-800
    // lines & text
    static var tBorder: Color { Color.white.opacity(0.07) }
    static var tFg: Color { Color(red: 0.98, green: 0.98, blue: 0.98) }           // zinc-50
    static var tMuted: Color { Color(red: 0.63, green: 0.63, blue: 0.67) }        // zinc-400
    static var tDim: Color { Color(red: 0.45, green: 0.45, blue: 0.49) }          // zinc-500
    // accent (Trenord green, tuned for dark surfaces)
    static var tPrimary: Color { Color(red: 0.0, green: 0.71, blue: 0.40) }       // #00B566
    static var tPrimaryDim: Color { Color(red: 0.0, green: 0.71, blue: 0.40).opacity(0.14) }
    // semantics
    static var tLate: Color { Color(red: 0.95, green: 0.65, blue: 0.15) }         // amber
    static var tVeryLate: Color { Color(red: 0.91, green: 0.30, blue: 0.30) }     // red
    static var tEarly: Color { Color(red: 0.0, green: 0.71, blue: 0.40) }
    static var tWarn: Color { Color(red: 0.95, green: 0.65, blue: 0.15) }
    static var tDanger: Color { Color(red: 0.91, green: 0.30, blue: 0.30) }
}

// MARK: - shared pieces

/// shadcn "muted label": micro uppercase, tracked, zinc-500.
struct MicroLabel: View {
    let text: String
    init(_ text: String) { self.text = text }
    var body: some View {
        Text(text.uppercased())
            .font(.system(size: 10.5, weight: .semibold))
            .tracking(1.4)
            .foregroundStyle(.tDim)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// shadcn badge: 10.5px medium, tinted fill, hairline border.
struct TBadge: View {
    let text: String
    let color: Color
    init(_ text: String, _ color: Color) {
        self.text = text
        self.color = color
    }
    var body: some View {
        Text(text)
            .font(.system(size: 10.5, weight: .medium))
            .foregroundStyle(color)
            .padding(.horizontal, 7)
            .padding(.vertical, 3)
            .background(color.opacity(0.10), in: RoundedRectangle(cornerRadius: 6, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 6, style: .continuous).strokeBorder(color.opacity(0.22), lineWidth: 0.8))
    }
}

enum StatusUI {
    static func color(_ status: String?) -> Color {
        switch status {
        case "running": return .tPrimary
        case "scheduled": return .tMuted
        case "arrived": return .tDim
        case "cancelled": return .tDanger
        default: return .tDim
        }
    }

    static func label(_ status: String?) -> String {
        switch status {
        case "running": return "Running"
        case "scheduled": return "Scheduled"
        case "arrived": return "Arrived"
        case "cancelled": return "Cancelled"
        default: return (status ?? "Unknown").capitalized
        }
    }

    static func delayColor(_ sec: Int?) -> Color {
        guard let s = sec else { return .tMuted }
        if s >= 300 { return .tVeryLate }
        if s >= 60 { return .tLate }
        if s < 0 { return .tEarly }
        return .tMuted
    }

    static func confidenceColor(_ c: String?) -> Color {
        switch c {
        case "HIGH": return .tPrimary
        case "MEDIUM": return .tLate
        case "LOW": return .tVeryLate
        default: return .tDim
        }
    }
}

extension Fmt {
    /// compact delay for row trailing: "+3", "−2", "on time", "—"
    static func delayShort(_ sec: Int?) -> String {
        guard let s = sec else { return "—" }
        if s == 0 { return "on time" }
        let m = Int((Double(s) / 60.0).rounded())
        return m > 0 ? "+\(m)" : "−\(-m)"
    }
}

// MARK: - prediction range visualization

/// Horizontal time axis showing scheduled / operator / our p10–p50–p90 as a
/// single picture — the three time levels stay distinct (GOAL.md §15) but are
/// read at a glance instead of as three naked numbers.
struct PredictionRangeBar: View {
    let sched: Double?
    let operatorEta: Double?
    let p10: Double?
    let p50: Double?
    let p90: Double?

    var body: some View {
        let domain = computeDomain()
        if domain == nil {
            Text("no estimate yet")
                .font(.footnote)
                .foregroundStyle(.tDim)
                .frame(maxWidth: .infinity, alignment: .center)
                .padding(.vertical, 18)
        } else {
            let (start, end) = domain!
            let span = max(end - start, 60_000)
            GeometryReader { geo in
                let w = geo.size.width
                let x = { (ms: Double) -> CGFloat in CGFloat((ms - start) / span) * w }
                ZStack(alignment: .topLeading) {
                    // baseline
                    Rectangle()
                        .fill(Color.white.opacity(0.09))
                        .frame(height: 2)
                        .offset(y: 34)
                    // our p10–p90 band
                    if let lo = p10, let hi = p90 {
                        RoundedRectangle(cornerRadius: 3, style: .continuous)
                            .fill(Color.tPrimary.opacity(0.18))
                            .frame(width: max(4, x(hi) - x(lo)), height: 22)
                            .overlay(RoundedRectangle(cornerRadius: 3).strokeBorder(Color.tPrimary.opacity(0.35), lineWidth: 0.8))
                            .position(x: (x(lo) + x(hi)) / 2, y: 35)
                    }
                    // scheduled tick + label (above)
                    if let s = sched {
                        tick(x: x(s), width: w, color: .tMuted, label: "sched", time: Fmt.hhmm(s))
                    }
                    // operator tick + label (above, amber)
                    if let o = operatorEta {
                        tick(x: x(o), width: w, color: .tLate, label: "trenord", time: Fmt.hhmm(o))
                    }
                    // ours: p50 marker + label (below, green)
                    if let m = p50 {
                        Circle()
                            .fill(Color.tPrimary)
                            .frame(width: 10, height: 10)
                            .overlay(Circle().strokeBorder(.tBg, lineWidth: 2))
                            .position(x: x(m), y: 35)
                        VStack(spacing: 1) {
                            Text("ours")
                                .font(.system(size: 9.5, weight: .semibold))
                                .foregroundStyle(.tPrimary)
                            Text(Fmt.hhmm(m))
                                .font(.system(size: 12, weight: .bold)).monospacedDigit()
                                .foregroundStyle(.tPrimary)
                        }.position(x: clampX(x(m), w), y: 58)
                    }
                    // range endpoints (below, dim)
                    if let lo = p10 {
                        Text(Fmt.hhmm(lo))
                            .font(.system(size: 9.5)).monospacedDigit()
                            .foregroundStyle(.tDim)
                            .position(x: clampX(x(lo), w), y: 12)
                    }
                    if let hi = p90 {
                        Text(Fmt.hhmm(hi))
                            .font(.system(size: 9.5)).monospacedDigit()
                            .foregroundStyle(.tDim)
                            .position(x: clampX(x(hi), w), y: 12)
                    }
                }
            }
            .frame(height: 74)
        }
    }

    private func clampX(_ v: CGFloat, _ w: CGFloat) -> CGFloat {
        min(max(v, 22), w - 22)
    }

    private func tick(x: CGFloat, width w: CGFloat, color: Color, label: String, time: String) -> some View {
        VStack(spacing: 1) {
            Text(time).font(.system(size: 11, weight: .semibold)).monospacedDigit().foregroundStyle(color)
            Text(label).font(.system(size: 9)).foregroundStyle(.tDim)
        }
        .position(x: min(max(x, 24), w - 24), y: 13)
    }

    private func computeDomain() -> (Double, Double)? {
        var vals: [Double] = []
        if let v = sched { vals.append(v) }
        if let v = operatorEta { vals.append(v) }
        if let v = p10 { vals.append(v) }
        if let v = p50 { vals.append(v) }
        if let v = p90 { vals.append(v) }
        guard let lo = vals.min(), let hi = vals.max() else { return nil }
        let pad = max((hi - lo) * 0.14, 120_000)
        return (lo - pad, hi + pad)
    }
}
