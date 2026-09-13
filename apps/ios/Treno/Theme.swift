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
        let m = Int((Double(s) / 60).rounded())
        return m > 0 ? "+\(m)" : "−\(-m)"
    }
}
