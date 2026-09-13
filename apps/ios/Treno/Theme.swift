import SwiftUI

// Shared look & feel: dark, tabular numerals, Liquid Glass surfaces.

extension ShapeStyle where Self == Color {
    static var trenoAccent: Color { Color(red: 0.30, green: 0.64, blue: 1.0) }
    static var trenoGood: Color { Color(red: 0.24, green: 0.81, blue: 0.56) }
    static var trenoWarn: Color { Color(red: 0.96, green: 0.77, blue: 0.32) }
    static var trenoBad: Color { Color(red: 1.0, green: 0.42, blue: 0.42) }
    static var trenoDim: Color { Color(white: 0.62) }
    static var trenoPanel: Color { Color(white: 0.09) }
}

extension View {
    /// Card on a Liquid Glass surface (iOS 26 design).
    func glassCard(interactive: Bool = false) -> some View {
        self
            .padding(14)
            .glassEffect(interactive ? .regular.interactive() : .regular)
            .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
    }
}

enum StatusUI {
    static func color(_ status: String?) -> Color {
        switch status {
        case "running": return .trenoGood
        case "scheduled": return .trenoAccent
        case "arrived": return .trenoDim
        case "cancelled": return .trenoBad
        default: return .trenoDim
        }
    }

    static func label(_ status: String?) -> String {
        switch status {
        case "running": return "RUNNING"
        case "scheduled": return "SCHEDULED"
        case "arrived": return "ARRIVED"
        case "cancelled": return "CANCELLED"
        default: return (status ?? "UNKNOWN").uppercased()
        }
    }

    static func delayColor(_ sec: Int?) -> Color {
        guard let s = sec else { return .trenoDim }
        if s >= 300 { return .trenoBad }
        if s >= 60 { return .trenoWarn }
        return .trenoGood
    }

    static func confidenceColor(_ c: String?) -> Color {
        switch c {
        case "HIGH": return .trenoGood
        case "MEDIUM": return .trenoWarn
        case "LOW": return .trenoBad
        default: return .trenoDim
        }
    }
}

struct StatusBadge: View {
    let status: String?
    var body: some View {
        Text(StatusUI.label(status))
            .font(.caption2.weight(.bold))
            .foregroundStyle(StatusUI.color(status))
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(
                Capsule().fill(StatusUI.color(status).opacity(0.14))
            )
            .overlay(
                Capsule().strokeBorder(StatusUI.color(status).opacity(0.4), lineWidth: 0.8)
            )
    }
}

struct SectionLabel: View {
    let text: String
    init(_ text: String) { self.text = text }
    var body: some View {
        Text(text.uppercased())
            .font(.caption2.weight(.semibold))
            .foregroundStyle(.trenoDim)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}
