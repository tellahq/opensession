import Foundation
import Observation

/// One change to the sessions list, pushed by the active account's socket.
/// `SessionsListViewModel` applies these between polls.
enum SessionListEvent: Sendable {
    /// A server snapshot of one row the list shows.
    case row(Session)
    /// A row the list no longer shows: archived, deleted, or filtered out.
    case removed(sessionId: String)
    /// A bulk change with no row to send. Re-read the list.
    case invalidated
    /// The socket (re)connected and subscribed. Frames sent while it was
    /// down are gone, so the list should re-read once.
    case subscribed
}

/// Who on the team is focused on which session, app-wide. One passive socket
/// stays connected for every configured account, so inactive organizations can
/// still deliver mention events and badge the account picker. The active
/// account's socket also carries the sessions list's row frames.
@MainActor
@Observable
final class PresenceStore {
    static let shared = PresenceStore()

    private(set) var bySession: [String: [String]] = [:]
    private(set) var connectedAccountIDs: Set<String> = []

    @ObservationIgnored
    private var sessionListObservers: [UUID: @MainActor (SessionListEvent) -> Void] = [:]

    private var sockets: [String: OS1Socket] = [:]
    private var connectedAccounts: [String: ServerConnection] = [:]
    private var reconnectTasks: [String: Task<Void, Never>] = [:]
    private var presenceByAccount: [String: [String: [String]]] = [:]

    var presentKeys: Set<String> {
        var keys: Set<String> = []
        for users in bySession.values {
            for user in users {
                guard let first = user.split(separator: " ").first else { continue }
                keys.insert(first.lowercased())
            }
        }
        return keys
    }

    func isPresent(_ name: String) -> Bool {
        guard let first = name.trimmingCharacters(in: .whitespacesAndNewlines)
            .split(separator: " ").first
        else { return false }
        return presentKeys.contains(first.lowercased())
    }

    func isConnected(accountID: String) -> Bool {
        connectedAccountIDs.contains(accountID)
    }

    /// Hear the active account's list changes. Returns the token to remove
    /// the observer with; the list view model holds one while it polls.
    @discardableResult
    func addSessionListObserver(
        _ handler: @escaping @MainActor (SessionListEvent) -> Void
    ) -> UUID {
        let token = UUID()
        sessionListObservers[token] = handler
        return token
    }

    func removeSessionListObserver(_ token: UUID) {
        sessionListObservers[token] = nil
    }

    private func notifySessionList(_ event: SessionListEvent) {
        for handler in sessionListObservers.values { handler(event) }
    }

    /// Ask the active account's socket for row frames. Only that account's
    /// list is on screen, so only its socket subscribes; a socket that is
    /// still connecting subscribes from its hello instead. Idempotent on the
    /// server, so a switch back to an already subscribed account is harmless.
    private func subscribeActiveAccount() {
        let activeId = ServerConfig.shared.activeId
        guard connectedAccountIDs.contains(activeId) else { return }
        sockets[activeId]?.subscribeSessions(query: OS1API.liveSessionsQuery)
        notifySessionList(.subscribed)
    }

    func viewers(of sessions: [Session]) -> [String] {
        guard !bySession.isEmpty else { return [] }
        var seen = Set<String>()
        var viewers: [String] = []
        for session in sessions {
            for user in bySession[session.id] ?? [] where seen.insert(user).inserted {
                viewers.append(user)
            }
        }
        return viewers
    }

    func start() {
        let config = ServerConfig.shared
        let connections = config.accounts.compactMap { account in
            config.connection(for: account).map { (account, $0) }
        }
        let desiredConnections = Dictionary(
            uniqueKeysWithValues: connections.map { ($0.0.id, $0.1) }
        )

        for id in Array(sockets.keys) where connectedAccounts[id] != desiredConnections[id] {
            sockets.removeValue(forKey: id)?.disconnect()
            connectedAccounts[id] = nil
            connectedAccountIDs.remove(id)
            reconnectTasks.removeValue(forKey: id)?.cancel()
            presenceByAccount[id] = nil
        }
        bySession = presenceByAccount[config.activeId] ?? [:]

        for (account, connection) in connections where sockets[account.id] == nil {
            connect(account: account, connection: connection)
        }
        // An account switch lands here with the new account's socket already
        // up: it has to start sending row frames now, not at its next hello.
        subscribeActiveAccount()
    }

    /// iOS cannot retain network execution indefinitely in the background.
    /// Suspend every account together, then reconnect all of them on activation.
    func suspend() {
        for task in reconnectTasks.values { task.cancel() }
        reconnectTasks.removeAll()
        let connected = sockets.values
        sockets.removeAll()
        connectedAccounts.removeAll()
        connectedAccountIDs.removeAll()
        for socket in connected { socket.disconnect() }
    }

    func stop() {
        suspend()
        presenceByAccount.removeAll()
        clearPresence()
    }

    /// Applies the active account's global-presence snapshot. Kept as the
    /// direct seam used by tests and by any non-socket snapshot source.
    func apply(_ viewing: [PresenceEntry]) {
        let config = ServerConfig.shared
        let mapped = mappedPresence(viewing, me: config.userName)
        presenceByAccount[config.activeId] = mapped
        bySession = mapped
        if !mapped.isEmpty {
            Task { await TeamDirectory.shared.ensureLoaded() }
        }
    }

    private func connect(account: ServerAccount, connection: ServerConnection) {
        let socket = OS1Socket(connection: connection)
        socket.onEvent = { [weak self] event in
            self?.received(event, account: account)
        }
        socket.onClose = { [weak self] _ in
            self?.socketClosed(accountID: account.id)
        }
        sockets[account.id] = socket
        connectedAccounts[account.id] = connection
        socket.connect()
    }

    private func received(_ event: ServerEvent, account: ServerAccount) {
        let config = ServerConfig.shared
        switch event {
        case .hello:
            connectedAccountIDs.insert(account.id)
            if account.id == config.activeId { subscribeActiveAccount() }
        case .sessionRow(let row):
            if account.id == config.activeId { notifySessionList(.row(row)) }
        case .sessionRowRemoved(let sessionId):
            if account.id == config.activeId {
                notifySessionList(.removed(sessionId: sessionId))
            }
        case .sessionsInvalidated:
            if account.id == config.activeId { notifySessionList(.invalidated) }
        case .globalPresence(let viewing):
            let mapped = mappedPresence(viewing, me: account.userName)
            presenceByAccount[account.id] = mapped
            if account.id == config.activeId {
                bySession = mapped
                if !mapped.isEmpty {
                    Task { await TeamDirectory.shared.ensureLoaded() }
                }
            }
        case .mention(let user, let mention):
            if account.id == config.activeId {
                MentionStore.shared.receive(user: user, mention: mention)
            } else {
                config.incrementBadge(for: account.id)
            }
        case .mentionsCleared(let user, let sessionId):
            if account.id == config.activeId {
                MentionStore.shared.receiveCleared(user: user, sessionId: sessionId)
            }
        case .userMapChanged(let map, let user):
            // A passive account's maps are re-read when it becomes active;
            // only the account on screen has stores to refresh.
            if account.id == config.activeId {
                Task { await UserMapSync.receive(map: map, user: user) }
            }
        default:
            break
        }
    }

    private func mappedPresence(
        _ viewing: [PresenceEntry],
        me: String
    ) -> [String: [String]] {
        let me = me.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        var next: [String: [String]] = [:]
        for entry in viewing {
            let first = entry.user.split(separator: " ").first?.lowercased() ?? ""
            guard !first.isEmpty, first != me else { continue }
            next[entry.sessionId, default: []].append(entry.user)
        }
        return next
    }

    private func clearPresence() {
        guard !bySession.isEmpty else { return }
        bySession = [:]
    }

    private func socketClosed(accountID: String) {
        sockets[accountID] = nil
        connectedAccounts[accountID] = nil
        connectedAccountIDs.remove(accountID)
        reconnectTasks[accountID]?.cancel()
        reconnectTasks[accountID] = Task { [weak self] in
            try? await Task.sleep(for: .seconds(3))
            guard !Task.isCancelled else { return }
            self?.reconnectTasks[accountID] = nil
            self?.start()
        }
    }
}
