import Foundation
import Observation

/// REST calls behind the folder flap, injected so the model is testable
/// without a server.
@MainActor
struct LocalFoldersClient {
    var list: @MainActor (_ sessionId: String) async throws -> [LocalFolder]
    var disconnect: @MainActor (_ sessionId: String, _ key: String, _ user: String) async throws -> Void

    static let live = LocalFoldersClient(
        list: { try await OS1API.localFolders(sessionId: $0) },
        disconnect: {
            try await OS1API.disconnectLocalFolder(sessionId: $0, key: $1, user: $2)
        }
    )
}

/// The folders on people's own computers that one session can reach, as the
/// flap above the composer shows them.
///
/// One per `SessionViewModel`, and it checks every frame's session id itself,
/// so another session's `local_folders` broadcast can never replace this
/// list. The list is a snapshot: each frame carries the whole set, and the
/// REST read runs on every socket handshake (open, reconnect, server restart)
/// because a frame sent while this socket was down is gone. A load token
/// keeps a read that started before a newer frame or a disconnect from
/// overwriting it when it lands. Its own `@Observable` object so the flap
/// re-renders without invalidating the transcript.
@Observable
@MainActor
final class SessionLocalFoldersModel {
    let sessionId: String

    private(set) var folders: [LocalFolder] = []
    /// Keys with a disconnect in flight, so the button cannot fire twice.
    private(set) var disconnecting: Set<String> = []
    /// The server's words for the last failed disconnect, until dismissed or
    /// the next attempt.
    private(set) var error: String?

    @ObservationIgnored private let client: LocalFoldersClient
    @ObservationIgnored private let viewer: () -> (name: String, login: String)
    @ObservationIgnored private var active = false
    @ObservationIgnored private var load = 0

    init(
        sessionId: String,
        client: LocalFoldersClient = .live,
        viewer: @escaping () -> (name: String, login: String) = {
            (ServerConfig.shared.userName, ServerConfig.shared.githubLogin)
        }
    ) {
        self.sessionId = sessionId
        self.client = client
        self.viewer = viewer
    }

    // MARK: - Lifecycle

    /// The session's socket completed a handshake: re-read the list.
    func rehydrate() {
        active = true
        reload()
    }

    /// The session left the screen. The list clears, and any read still in
    /// flight is dropped when it lands.
    func deactivate() {
        active = false
        load += 1
        if !folders.isEmpty { folders = [] }
        disconnecting = []
        error = nil
    }

    // MARK: - Frames

    /// A `local_folders` frame, for any session: only this one's applies.
    func frame(sessionId: String, folders: [LocalFolder]) {
        guard active, sessionId == self.sessionId else { return }
        // A frame is newer than any list read still in flight.
        load += 1
        apply(folders)
    }

    // MARK: - Actions

    func canDisconnect(_ folder: LocalFolder) -> Bool {
        let viewer = viewer()
        return folder.isOwned(byName: viewer.name, login: viewer.login)
    }

    func disconnect(_ folder: LocalFolder) async {
        guard active, !disconnecting.contains(folder.key) else { return }
        disconnecting.insert(folder.key)
        error = nil
        defer { disconnecting.remove(folder.key) }
        do {
            let viewer = viewer()
            let claim = folder.ownerClaim(name: viewer.name, login: viewer.login) ?? viewer.name
            try await client.disconnect(sessionId, folder.key, claim)
        } catch {
            guard active else { return }
            self.error = (error as? LocalizedError)?.errorDescription
                ?? "Couldn't disconnect the folder"
            return
        }
        guard active else { return }
        // The server broadcasts the new list too; drop the row now so it does
        // not linger, and outrank any read that started before the change.
        load += 1
        apply(folders.filter { $0.key != folder.key })
    }

    func dismissError() { error = nil }

    // MARK: - Reads

    private func reload() {
        load += 1
        let token = load
        Task { [weak self] in
            guard let self else { return }
            guard let loaded = try? await self.client.list(self.sessionId),
                  token == self.load, self.active
            else { return }
            self.apply(loaded)
        }
    }

    private func apply(_ next: [LocalFolder]) {
        var seen = Set<String>()
        let unique = next.filter { seen.insert($0.key).inserted }
        if unique != folders { folders = unique }
    }
}
