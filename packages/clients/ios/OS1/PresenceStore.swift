import Foundation
import Observation

/// Who on the team is focused on which session, app-wide. One passive socket
/// stays connected for every configured account, so inactive organizations can
/// still deliver mention events and badge the account picker.
@MainActor
@Observable
final class PresenceStore {
    static let shared = PresenceStore()

    private(set) var bySession: [String: [String]] = [:]
    private(set) var connectedAccountIDs: Set<String> = []

    /// Where the active account's `session_row` / `session_row_removed`
    /// frames go: the sessions list, which applies them in place. One slot,
    /// because there is one list. Frames for a passive account are dropped;
    /// its list is rebuilt from a poll when it becomes active.
    @ObservationIgnored var onSessionRow: ((SessionRowChange) -> Void)?

    private var sockets: [String: OS1Socket] = [:]
    /// Accounts whose socket has sent `sessions_subscribe` on its current
    /// connection. Only the active account subscribes: an unscoped
    /// subscription hears about every live row, and a passive account has
    /// no list to spend that traffic on.
    private var subscribedAccountIDs: Set<String> = []
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
            subscribedAccountIDs.remove(id)
            reconnectTasks.removeValue(forKey: id)?.cancel()
            presenceByAccount[id] = nil
        }
        bySession = presenceByAccount[config.activeId] ?? [:]

        for (account, connection) in connections where sockets[account.id] == nil {
            connect(account: account, connection: connection)
        }
        // Switching accounts keeps the sockets; the newly active one has to
        // start hearing about its rows now, not on its next reconnect.
        subscribeToSessionRows(accountID: config.activeId)
    }

    /// Send `sessions_subscribe` on the active account's socket, once per
    /// connection. A socket that hasn't said `hello` yet subscribes when it
    /// does; an already subscribed one is left alone.
    private func subscribeToSessionRows(accountID: String) {
        guard accountID == ServerConfig.shared.activeId,
              connectedAccountIDs.contains(accountID),
              !subscribedAccountIDs.contains(accountID),
              let socket = sockets[accountID]
        else { return }
        subscribedAccountIDs.insert(accountID)
        socket.subscribeSessions(query: OS1API.liveSessionsQuery)
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
        subscribedAccountIDs.removeAll()
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
            subscribeToSessionRows(accountID: account.id)
        case .sessionRow(let row):
            if account.id == config.activeId { onSessionRow?(.row(row)) }
        case .sessionRowRemoved(let id):
            if account.id == config.activeId { onSessionRow?(.removed(id: id)) }
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
        subscribedAccountIDs.remove(accountID)
        reconnectTasks[accountID]?.cancel()
        reconnectTasks[accountID] = Task { [weak self] in
            try? await Task.sleep(for: .seconds(3))
            guard !Task.isCancelled else { return }
            self?.reconnectTasks[accountID] = nil
            self?.start()
        }
    }
}
