import Foundation
import SwiftUI
import UserNotifications
import UIKit

/// §61 notifications controller: registers the APNs token when the user opts
/// in, posts it (plus the watched trip's next run when we know it) to the
/// server, and forgets it on opt-out. Off by default — alerts are earned,
/// not assumed.
@MainActor
final class NotificationsController: ObservableObject {
    static let shared = NotificationsController()
    static var pendingToken: String?

    func setOn(_ on: Bool) async {
        if on {
            let granted = (try? await UNUserNotificationCenter.current()
                .requestAuthorization(options: [.alert, .sound])) ?? false
            guard granted else { return }
            UIApplication.shared.registerForRemoteNotifications()
            // token arrives asynchronously in the delegate; registerToken
            // completes the handshake when it lands (or now if it already did)
            if let token = Self.pendingToken {
                Self.pendingToken = nil
                await registerToken(token)
            }
        } else {
            UIApplication.shared.unregisterForRemoteNotifications()
            if let token = Self.pendingToken {
                Self.pendingToken = nil
                await deleteToken(token)
            } else if let saved = UserDefaults.standard.string(forKey: "apnsToken") {
                await deleteToken(saved)
            }
            UserDefaults.standard.removeObject(forKey: "apnsToken")
        }
    }

    func registerToken(_ hex: String) async {
        UserDefaults.standard.set(hex, forKey: "apnsToken")
        // watch the first saved trip's next boardable run, when we can find one
        var runId: Int?
        if let trip = TripStore.shared.trips.first(where: { $0.runsToday }) {
            runId = (try? await APIClient.shared.journeys(from: trip.fromStopId, to: trip.toStopId, limit: 3))?
                .first { $0.canBoard() }?.runId
        }
        var body: [String: Any] = ["token": hex]
        if let runId { body["runId"] = runId }
        guard let url = URL(string: APIClient.shared.baseUrl + "/api/devices") else { return }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        _ = try? await URLSession.shared.data(for: req)
    }

    private func deleteToken(_ hex: String) async {
        guard let url = URL(string: APIClient.shared.baseUrl + "/api/devices/" + hex) else { return }
        var req = URLRequest(url: url)
        req.httpMethod = "DELETE"
        _ = try? await URLSession.shared.data(for: req)
    }
}

/// APNs token landing spot — attached as the app's delegate.
final class PushAppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication,
                     didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
        Task { @MainActor in
            if UserDefaults.standard.bool(forKey: "notificationsOn") {
                await NotificationsController.shared.registerToken(hex)
            } else {
                NotificationsController.pendingToken = hex
            }
        }
    }

    func application(_ application: UIApplication,
                     didFailToRegisterForRemoteNotificationsWithError error: Error) {
        // notifications are optional — log nothing, surface nothing
    }
}
