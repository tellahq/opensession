import Foundation

/// The socket surface `SessionViewModel` drives, extracted so tests can
/// substitute a recording mock for the real WebSocket.
@MainActor
protocol SessionSocket: AnyObject {
    var onEvent: ((ServerEvent) -> Void)? { get set }
    var onClose: ((String?) -> Void)? { get set }
    func setMutationRejectedHandler(_ handler: @escaping (String) -> Void)
    func connect()
    func disconnect()
    func watch(sessionId: String, resume: TranscriptResumeCursor?)
    func setAway(_ away: Bool)
    func setTyping(sessionId: String, typing: Bool)
    func loadHistory(sessionId: String, beforeOffset: Int, beforeRev: String?)
    func loadHistory(sessionId: String, beforeSeq: Int, limit: Int?)
    func loadWholeHistory(sessionId: String)
    func prompt(
        sessionId: String, content: String, user: String,
        images: [String]?, effort: String?, fastMode: Bool?, busyMode: String?
    )
    func steerQueued(sessionId: String, queueId: String)
    func deleteQueued(sessionId: String, queueId: String)
    func interruptQueued(sessionId: String, queueId: String)
    func takeQueued(sessionId: String, queueId: String)
    func takeSteered(sessionId: String, queueId: String)
    func reorderQueued(sessionId: String, order: [String])
    func cancelWatchedRun()
    func answer(sessionId: String, questionId: String, answers: [String: String]?)
}

extension SessionSocket {
    func setMutationRejectedHandler(_ handler: @escaping (String) -> Void) {}
    func watch(sessionId: String) {
        watch(sessionId: sessionId, resume: nil)
    }

    /// Text-only convenience (slash commands and the like) — protocols can't
    /// carry default arguments, so the concrete method's defaults live here.
    func prompt(sessionId: String, content: String, user: String) {
        prompt(
            sessionId: sessionId, content: content, user: user,
            images: nil, effort: nil, fastMode: nil, busyMode: nil
        )
    }
}

/// One WebSocket connection to the Open Session server (`/ws`), authenticated
/// with the bearer token on the upgrade request.
///
/// The server never pings; clients are expected to send `{"type":"ping"}` and
/// treat a missed pong as a dead socket (half-open iOS sockets are the reason
/// this exists). Reconnect policy lives in the owner — on failure this class
/// reports `onClose` once and stops.
@MainActor
final class OS1Socket: SessionSocket {
    var onEvent: ((ServerEvent) -> Void)?
    var onClose: ((String?) -> Void)?
    private var onMutationRejected: ((String) -> Void)?
    private let connection: ServerConnection?

    init(connection: ServerConnection? = ServerConfig.shared.connection) {
        self.connection = connection
    }

    func setMutationRejectedHandler(_ handler: @escaping (String) -> Void) {
        onMutationRejected = handler
    }

    private var task: URLSessionWebSocketTask?
    private var receiveTask: Task<Void, Never>?
    private var pingTask: Task<Void, Never>?
    private var lastPong = Date()
    private var closed = false
    private var watchedSessionId: String?
    private var supportsCommandResults = false
    private var commandNegotiated = false
    private lazy var mutationOutbox = SocketMutationOutbox(
        key: SocketMutationOutbox.storageKey(
            server: connection?.baseURL.absoluteString ?? "",
            user: ServerConfig.shared.githubLogin.isEmpty
                ? ServerConfig.shared.userName
                : ServerConfig.shared.githubLogin
        )
    )

    func connect() {
        guard let connection, let url = connection.wsURL else {
            onClose?("Server URL not set")
            return
        }
        closed = false
        supportsCommandResults = false
        commandNegotiated = false
        lastPong = Date()
        let request = connection.authorizedRequest(url)
        let task = URLSession.shared.webSocketTask(with: request)
        // Default cap is 1 MB — a heavy session's transcript_init chunk (up
        // to ~120 entries × 32 KB wire clamp) blows past it, receive() throws,
        // and the watcher loops "Connection lost → reconnect" on that one
        // session forever. Match the web client, which has no such cap.
        task.maximumMessageSize = 32 * 1024 * 1024
        self.task = task
        task.resume()

        receiveTask = Task { [weak self] in
            await self?.receiveLoop(task)
        }
        pingTask = Task { [weak self] in
            await self?.pingLoop()
        }
    }

    func disconnect() {
        finish(reason: nil, notify: false)
    }

    // MARK: - Outgoing frames

    /// `supportsSeq` advertises seq-cursor paging (transcript v2), the same
    /// capability the web viewer sends: eligible watches are then served from
    /// the server's own transcript store, whose backward pages reach the first
    /// message. Without it the watch is served from the legacy mirror JSONL —
    /// and sessions whose mirror file no longer exists (every owned-store
    /// session now) answer with a 120-entry tail, `truncated: true` and NO byte
    /// cursor, which left the reader unable to page past the last 120 entries.
    func watch(sessionId: String, resume: TranscriptResumeCursor?) {
        watchedSessionId = sessionId
        var frame: [String: Any] = [
            "type": "watch",
            "sessionId": sessionId,
            "supportsSeq": true,
            "supportsChangeSeq": true,
        ]
        switch resume {
        case .seq(let lastSeq, let lastChangeSeq):
            frame["sinceSeq"] = lastSeq
            frame["sinceChangeSeq"] = lastChangeSeq
        case .offset(let endOffset, let rev):
            frame["sinceOffset"] = endOffset
            frame["sinceRev"] = rev
        case nil:
            break
        }
        send(frame)
    }

    /// Tell the server which sessions list this socket renders. From then on
    /// a metadata write reaches it as `session_row` / `session_row_removed`
    /// for that projection instead of a whole-list invalidation. The
    /// subscription belongs to one connection, so the owner re-sends it after
    /// every hello. `query` is the list request's query string, the same
    /// one the poll asks for.
    func subscribeSessions(query: String) {
        send(["type": "sessions_subscribe", "query": query])
    }

    /// Presence, not subscription: backgrounding the app keeps the watch (the
    /// transcript must keep streaming so unread counts and notifications still
    /// land) but takes our face off the session for everyone else. A client
    /// that never sends this remains present until its transport heartbeat
    /// expires, which is too long for a normal focus transition.
    func setAway(_ away: Bool) {
        send(["type": "away", "away": away])
    }

    /// Short-lived composer activity. The server expires it unless refreshed.
    func setTyping(sessionId: String, typing: Bool) {
        send(["type": "typing", "sessionId": sessionId, "typing": typing])
    }

    /// Page one window of earlier history (arrives as transcript_history).
    /// `beforeRev` guards against the mirror file rotating under the cursor —
    /// on mismatch the server re-sends a fresh transcript_init instead.
    func loadHistory(sessionId: String, beforeOffset: Int, beforeRev: String?) {
        var frame: [String: Any] = [
            "type": "load_history", "sessionId": sessionId, "beforeOffset": beforeOffset,
        ]
        if let beforeRev { frame["beforeRev"] = beforeRev }
        send(frame)
    }

    /// Seq-mode paging for sessions served from the transcript v2 store.
    /// `limit` asks for a fatter page than the server's default — what the
    /// backlog walk behind "jump to the start" uses to keep its round trips
    /// (and whole-transcript reconciliations) in single digits.
    func loadHistory(sessionId: String, beforeSeq: Int, limit: Int?) {
        var frame: [String: Any] = [
            "type": "load_history", "sessionId": sessionId, "beforeSeq": beforeSeq,
        ]
        if let limit { frame["limit"] = limit }
        send(frame)
    }

    /// The deliberately cursor-less request: byte-window (legacy) sessions
    /// have no cheap way to walk a backlog, and the server answers this with
    /// the entire transcript in one transcript_init.
    func loadWholeHistory(sessionId: String) {
        send(["type": "load_history", "sessionId": sessionId])
    }

    func prompt(
        sessionId: String,
        content: String,
        user: String,
        images: [String]? = nil,
        effort: String? = nil,
        fastMode: Bool? = nil,
        busyMode: String? = nil
    ) {
        // busyMode "queue" matches the web composer's default: a send during
        // a run is held as an editable queued message (visible as a chip)
        // until the run completes; steering it sooner is an explicit action.
        var frame: [String: Any] = [
            "type": "prompt", "sessionId": sessionId, "content": content,
            "user": user, "busyMode": busyMode == "steer" ? "steer" : "queue",
        ]
        // Image attachments as data URLs; effort/fastMode ride every send and
        // persist server-side (the web composer's pill semantics).
        if let images, !images.isEmpty { frame["images"] = images }
        if let effort, !effort.isEmpty { frame["effort"] = effort }
        if let fastMode { frame["fastMode"] = fastMode }
        send(frame)
    }

    /// Deliver a queued message at the run's next turn boundary instead of
    /// waiting for it to finish.
    func steerQueued(sessionId: String, queueId: String) {
        send(["type": "steer_queued_prompt", "sessionId": sessionId, "queueId": queueId])
    }

    func deleteQueued(sessionId: String, queueId: String) {
        send(["type": "delete_queued_prompt", "sessionId": sessionId, "queueId": queueId])
    }

    /// Deliver a steered message immediately: the server ends the run's
    /// current step and re-delivers this one message as the next turn, so it
    /// stops waiting out a long tool call. The agent resumes its work with
    /// the message in hand.
    func interruptQueued(sessionId: String, queueId: String) {
        send(["type": "interrupt_queued_prompt", "sessionId": sessionId, "queueId": queueId])
    }

    func takeQueued(sessionId: String, queueId: String) {
        send(["type": "take_queued_prompt", "sessionId": sessionId, "queueId": queueId])
    }

    func takeSteered(sessionId: String, queueId: String) {
        send(["type": "take_steered_prompt", "sessionId": sessionId, "queueId": queueId])
    }

    func reorderQueued(sessionId: String, order: [String]) {
        send(["type": "reorder_queued_prompt", "sessionId": sessionId, "order": order])
    }

    func cancelWatchedRun() {
        // The server stops the run of the session this socket is watching.
        var frame: [String: Any] = ["type": "cancel"]
        if let watchedSessionId { frame["sessionId"] = watchedSessionId }
        send(frame)
    }


    func answer(sessionId: String, questionId: String, answers: [String: String]?) {
        var frame: [String: Any] = ["type": "answer_question", "sessionId": sessionId, "questionId": questionId]
        frame["answers"] = answers ?? NSNull()
        send(frame)
    }

    private func finishCommandNegotiation(
        on task: URLSessionWebSocketTask,
        supported: Bool
    ) {
        guard self.task === task, !commandNegotiated else { return }
        commandNegotiated = true
        supportsCommandResults = supported
        for text in mutationOutbox.pendingTexts() {
            task.send(.string(text)) { _ in }
            if !supported, let data = text.data(using: .utf8),
               let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let requestId = object["requestId"] as? String {
                mutationOutbox.retireLegacy(id: requestId)
            }
        }
        if supported {
            for text in mutationOutbox.pendingAckTexts() {
                task.send(.string(text)) { _ in }
            }
        }
    }

    private func send(_ input: [String: Any]) {
        guard let prepared = mutationOutbox.prepare(
            input,
            persistMutation: !commandNegotiated || supportsCommandResults
        ) else {
            onMutationRejected?("Pending sends are using local storage. Reconnect or clear one before sending more.")
            return
        }
        if prepared.frame["requestId"] != nil, !commandNegotiated { return }
        guard let task
        else { return }
        task.send(.string(prepared.text)) { [weak self] error in
            if error != nil {
                Task { @MainActor in self?.finish(reason: "Send failed") }
            }
        }
    }

    // MARK: - Loops

    private func receiveLoop(_ task: URLSessionWebSocketTask) async {
        while !closed {
            do {
                let message = try await task.receive()
                let data: Data? = switch message {
                case .string(let text): Data(text.utf8)
                case .data(let raw): raw
                @unknown default: nil
                }
                guard let data else { continue }
                if !commandNegotiated,
                   let first = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                    if first["type"] as? String == "hello" {
                        let capabilities = first["capabilities"] as? [String: Any]
                        finishCommandNegotiation(
                            on: task,
                            supported: capabilities?["commandResults"] as? Bool == true
                        )
                    } else {
                        finishCommandNegotiation(on: task, supported: false)
                    }
                }
                if let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                   object["type"] as? String == "command_result",
                   let requestId = object["requestId"] as? String {
                    let completed = object["status"] as? String == "completed"
                    let terminal = object["terminal"] as? Bool == true
                    if completed || terminal {
                        if let sessionId = object["sessionId"] as? String,
                           mutationOutbox.acknowledge(id: requestId, sessionId: sessionId),
                           let ack = mutationOutbox.pendingAckTexts().first(where: {
                               guard let data = $0.data(using: .utf8),
                                     let frame = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
                               else { return false }
                               return frame["requestId"] as? String == requestId
                           }) {
                            task.send(.string(ack)) { _ in }
                        }
                    }
                }
                if let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                   object["type"] as? String == "command_ack_result",
                   let requestId = object["requestId"] as? String {
                    mutationOutbox.confirmAcknowledgement(id: requestId)
                }
                // A heavy session's transcript_init frame can be multiple
                // megabytes; decoding it on the main actor froze the UI for
                // the whole JSONDecoder pass (opening a session, resyncing
                // on foreground). Big frames decode on a background task;
                // small hot ones (stream_text at streaming rates) stay
                // inline to skip two executor hops per frame. Awaiting the
                // decode before the next receive() keeps frames ordered.
                let event: ServerEvent
                if data.count >= 16 * 1024 || Self.isSessionRowFrame(data) {
                    event = await Task.detached(priority: .userInitiated) {
                        ServerEvent.parse(data)
                    }.value
                } else {
                    event = ServerEvent.parse(data)
                }
                // Any inbound frame proves the socket is alive — during a
                // heavy stream the server may not answer pings promptly, and
                // stream frames are just as good a liveness signal.
                lastPong = Date()
                onEvent?(event)
            } catch {
                finish(reason: closed ? nil : "Connection lost")
                return
            }
        }
    }

    /// A `session_row` frame is small, but each one decodes a whole `Session`
    /// (dozens of optional fields) and a burst of them lands while the list
    /// is on screen, so they take the detached path like the poll's rows do.
    /// The server serializes `type` first, which makes a prefix check enough;
    /// a frame that misses it decodes inline, which is still correct. The
    /// same prefix also matches `session_row_removed`, which is fine.
    private static let sessionRowPrefix = Data(#"{"type":"session_row""#.utf8)

    nonisolated private static func isSessionRowFrame(_ data: Data) -> Bool {
        data.starts(with: sessionRowPrefix)
    }

    private func pingLoop() async {
        // 10s cadence / 30s deadline: a half-open socket (backgrounded app,
        // wifi→cellular switch) is detected within ~40s even if receive()
        // never throws. The old 20s/65s pair left the transcript silently
        // stale for up to ~85s.
        while !closed {
            try? await Task.sleep(for: .seconds(10))
            if closed { return }
            if Date().timeIntervalSince(lastPong) > 30 {
                finish(reason: "Connection timed out")
                return
            }
            send(["type": "ping"])
        }
    }

    private func finish(reason: String?, notify: Bool = true) {
        guard !closed else { return }
        closed = true
        receiveTask?.cancel()
        pingTask?.cancel()
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        if notify { onClose?(reason) }
    }
}
