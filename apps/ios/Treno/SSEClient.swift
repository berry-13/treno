import Foundation

/// Minimal Server-Sent Events consumer over URLSession.bytes (§60). SSE has
/// no first-class iOS API, but the wire format is two \n\n-separated fields:
/// `event:` names and `data:` payloads; comment lines start with ':'.
struct SSEEvent {
    let event: String
    let data: String
}

/// The stream Task hops threads freely; callback dispatch to actors is the
/// caller's job (every caller wraps in `Task { @MainActor in … }`).
final class SSEClient: NSObject, @unchecked Sendable {
    private var task: Task<Void, Never>?
    private(set) var isConnected = false

    /// Opens a stream and calls back for every event on a background queue.
    /// Reconnection (with delay) is the caller's job — keeps this type dumb.
    func open(url: URL, onEvent: @escaping @Sendable (SSEEvent) -> Void, onClose: @escaping @Sendable (Error?) -> Void) {
        task?.cancel()
        let child = Task { [weak self] in
            var request = URLRequest(url: url)
            request.timeoutInterval = 3600
            request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
            let cfg = URLSessionConfiguration.ephemeral
            cfg.timeoutIntervalForRequest = 3600
            cfg.waitsForConnectivity = false
            let session = URLSession(configuration: cfg)
            do {
                let (bytes, response) = try await session.bytes(for: request)
                if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
                    throw URLError(.badServerResponse)
                }
                self?.isConnected = true
                var event = "message"
                var data = ""
                for try await line in bytes.lines {
                    if Task.isCancelled { break }
                    if line.hasPrefix(":") { continue }            // heartbeat/comment
                    else if line.hasPrefix("event:") { event = String(line.dropFirst(6)).trimmingCharacters(in: .whitespaces) }
                    else if line.hasPrefix("data:") { data += (data.isEmpty ? "" : "\n") + String(line.dropFirst(5)).trimmingCharacters(in: .whitespaces) }
                    else if line.isEmpty, !data.isEmpty {           // event boundary
                        onEvent(SSEEvent(event: event, data: data))
                        event = "message"
                        data = ""
                    }
                }
                self?.isConnected = false
                onClose(nil)
            } catch {
                self?.isConnected = false
                onClose(error)
            }
        }
        task = child
    }

    func close() {
        task?.cancel()
        task = nil
        isConnected = false
    }
}
