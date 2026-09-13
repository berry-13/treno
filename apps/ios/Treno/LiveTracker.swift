import ActivityKit
import Foundation

extension TripActivityAttributes.ContentState {
    static func from(_ j: JourneyRow) -> TripActivityAttributes.ContentState {
        TripActivityAttributes.ContentState(
            trainNumber: j.trainNumber,
            line: j.line,
            status: j.state?.status ?? "scheduled",
            delaySec: j.depDelaySec ?? j.state?.operatorDelaySec,
            ourArrEpoch: j.state?.ourEstimate?.p50,
            schedArrEpoch: j.arrEpoch,
            depEpoch: j.depEpoch,
            arrEpoch: j.arrEpoch,
            platform: j.platform
        )
    }
}

/// Starts and keeps alive the Dynamic Island Live Activity for a tracked
/// journey. Updates happen on a 15s loop while the app is alive (no push
/// infrastructure in this setup — that's the honest limit).
@MainActor
enum LiveTracker {
    private static var activity: Activity<TripActivityAttributes>?
    private static var updateTask: Task<Void, Never>?
    private static var trip: Trip?

    static var isTracking: Bool { activity != nil }

    static func start(trip: Trip, journey: JourneyRow) {
        stop()
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
        self.trip = trip
        let attributes = TripActivityAttributes(
            tripName: trip.displayName,
            originName: trip.fromName,
            destinationName: trip.toName
        )
        activity = try? Activity.request(
            attributes: attributes,
            content: .init(state: TripActivityAttributes.ContentState.from(journey), staleDate: nil)
        )
        let fromId = trip.fromStopId
        let toId = trip.toStopId
        let trainNumber = journey.trainNumber
        updateTask = Task { @MainActor in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(15))
                guard !Task.isCancelled, let act = LiveTracker.activity else { return }
                nonisolated(unsafe) let handle = act
                if let js = try? await APIClient.shared.journeys(from: fromId, to: toId, limit: 6),
                   let j = js.first(where: { $0.trainNumber == trainNumber }) {
                    await handle.update(.init(state: TripActivityAttributes.ContentState.from(j), staleDate: nil))
                    if j.state?.status == "arrived" {
                        await handle.end(nil, dismissalPolicy: .after(.now + 120))
                        return
                    }
                }
            }
        }
    }

    static func stop() {
        updateTask?.cancel()
        updateTask = nil
        Task { @MainActor in
            let act = LiveTracker.activity
            LiveTracker.activity = nil
            if let act {
                nonisolated(unsafe) let handle = act
                await handle.end(nil, dismissalPolicy: .immediate)
            }
        }
    }

    /// debug deep link: `simctl launch <dev> com.treno.Treno --track <fromId>,<toId>`
    static func debugStart(fromId: String, toId: String) async {
        guard let js = try? await APIClient.shared.journeys(from: fromId, to: toId, limit: 6),
              let j = js.first(where: { $0.state?.status == "running" }) ?? js.first else { return }
        let fromName = StationCatalog.shared.name(for: fromId) ?? fromId
        let toName = StationCatalog.shared.name(for: toId) ?? toId
        start(
            trip: Trip(fromStopId: fromId, fromName: fromName, toStopId: toId, toName: toName),
            journey: j
        )
    }
}
