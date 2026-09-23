import SwiftUI
import MapKit

/// §48 "likely area" — the honest answer to "where is my train?" when no GPS
/// exists: a named stretch between the last known anchor and the next
/// scheduled stop, rendered as two stop endpoints joined by a DASHED line.
/// There is deliberately no train marker: a dot would fake precision the
/// sources cannot support. Muted colors and dashed strokes carry "inferred";
/// the whole section hides when the payload carries no area.
struct LikelyAreaSection: View {
    let area: LikelyArea

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text("Likely between")
                    .font(.subheadline.weight(.medium)).foregroundStyle(.tMuted)
                HStack(spacing: 8) {
                    Text(Self.displayName(area.fromName))
                        .font(.body.weight(.semibold)).foregroundStyle(.tFg)
                    Image(systemName: "arrow.right")
                        .font(.footnote.weight(.semibold)).foregroundStyle(.tPrimary)
                    Text(Self.displayName(area.toName))
                        .font(.body.weight(.semibold)).foregroundStyle(.tFg)
                }
            }
            if let from = area.fromCoordinate, let to = area.toCoordinate {
                LikelyAreaMap(
                    from: from, fromLabel: Self.displayName(area.fromName),
                    to: to, toLabel: Self.displayName(area.toName)
                )
                Text("Not a live position — the train is somewhere along this stretch.")
                    .font(.caption).foregroundStyle(.tMuted)
            }
            TimelineView(.periodic(from: .now, by: 30)) { context in
                sighting(context.date)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(18)
        .background(Color.tCard, in: RoundedRectangle(cornerRadius: 20))
    }

    /// The one confirmed fact behind the inference: where and when the train
    /// was last actually seen, with an age that ticks while the rider watches.
    private func sighting(_ now: Date) -> some View {
        HStack(spacing: 6) {
            Image(systemName: "location").font(.caption).foregroundStyle(.tMuted)
            if let name = area.detectedName, !name.isEmpty {
                Text("Detected at \(Self.displayName(name))")
            } else {
                Text("Last detected")
            }
            if let at = area.detectedAt {
                Text("·").foregroundStyle(.tBorder)
                Text("\(Fmt.hhmm(at)) · \(Fmt.age(Int(max(0, now.timeIntervalSince1970 * 1000 - at) / 1000)))")
            }
        }
        .font(.caption.monospacedDigit()).foregroundStyle(.tMuted)
    }

    /// Operator feeds shout location names ("BIVIO CASIRATE"); passenger copy
    /// shouldn't. Properly-cased names pass through untouched.
    private static func displayName(_ raw: String?) -> String {
        guard let raw, !raw.isEmpty else { return "—" }
        guard raw == raw.uppercased() else { return raw }
        let smallWords: Set<String> = ["di", "d", "del", "della", "dei", "degli", "de", "e",
                                       "a", "al", "alla", "ai", "agli", "sul", "sulla", "per", "in", "da"]
        return raw.lowercased().split(separator: " ").map { word in
            let w = String(word)
            return smallWords.contains(w) ? w : w.prefix(1).uppercased() + w.dropFirst()
        }.joined(separator: " ")
    }
}

/// The uncertainty itself, drawn: both endpoints are known stops (solid
/// markers), everything between them is the unanswered question (dashed).
private struct LikelyAreaMap: View {
    let from: CLLocationCoordinate2D
    let fromLabel: String
    let to: CLLocationCoordinate2D
    let toLabel: String

    var body: some View {
        Map(initialPosition: .region(Self.fittedRegion(from: from, to: to))) {
            Marker(fromLabel, coordinate: from)
            Marker(toLabel, coordinate: to)
            MapPolyline(coordinates: [from, to])
                .stroke(Color.tPrimary.opacity(0.85), style: StrokeStyle(lineWidth: 3, lineCap: .round, dash: [5, 5]))
        }
        .mapStyle(.standard)
        .frame(height: 180)
        .clipShape(RoundedRectangle(cornerRadius: 14))
        .overlay(
            RoundedRectangle(cornerRadius: 14)
                .strokeBorder(Color.tBorder, style: StrokeStyle(lineWidth: 1, dash: [4, 3]))
        )
        .accessibilityLabel("Likely stretch from \(fromLabel) to \(toLabel). The exact position is unknown.")
    }

    /// Region framing both endpoints with breathing room; a small floor keeps
    /// near-identical coordinates from zooming in to street level (that, too,
    /// would fake precision).
    private static func fittedRegion(from: CLLocationCoordinate2D, to: CLLocationCoordinate2D) -> MKCoordinateRegion {
        let minLat = min(from.latitude, to.latitude), maxLat = max(from.latitude, to.latitude)
        let minLon = min(from.longitude, to.longitude), maxLon = max(from.longitude, to.longitude)
        let padLat = max((maxLat - minLat) * 0.35, 0.02)
        let padLon = max((maxLon - minLon) * 0.35, 0.02)
        return MKCoordinateRegion(
            center: CLLocationCoordinate2D(latitude: (minLat + maxLat) / 2, longitude: (minLon + maxLon) / 2),
            span: MKCoordinateSpan(latitudeDelta: (maxLat - minLat) + padLat * 2, longitudeDelta: (maxLon - minLon) + padLon * 2),
        )
    }
}

extension LikelyArea {
    /// GTFS stop coordinates for the two anchors; nil (map hidden, text kept)
    /// whenever the schedule has no position for a stop.
    var fromCoordinate: CLLocationCoordinate2D? {
        guard let lat = fromLat, let lon = fromLon else { return nil }
        return CLLocationCoordinate2D(latitude: lat, longitude: lon)
    }

    var toCoordinate: CLLocationCoordinate2D? {
        guard let lat = toLat, let lon = toLon else { return nil }
        return CLLocationCoordinate2D(latitude: lat, longitude: lon)
    }
}
