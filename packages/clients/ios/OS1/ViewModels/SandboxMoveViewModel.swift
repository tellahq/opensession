import Foundation

/// One move of a host session into a Sandbox, from the list of places it can
/// go to the server's answer. Owned by whichever surface offers the move (the
/// session overflow menu, the Mac toolbar, the worktree details sheet), so
/// each keeps its own in-flight state while the rules stay in one place.
@MainActor
@Observable
final class SandboxMoveViewModel {
    /// A 428: the server named the work that would stay behind, and waits
    /// for an explicit "move anyway" before doing it.
    struct Confirmation: Identifiable, Equatable {
        let sessionId: String
        let provider: String
        let message: String
        var id: String { "\(sessionId)|\(provider)" }
    }

    /// Nil until the instance has answered which Sandboxes are Ready.
    private(set) var providers: [String]?
    /// The provider a move is in flight to.
    private(set) var working: String?
    /// The session a move has landed for. The row records the provider too,
    /// but a sessions poll that has not caught up yet can hand back the host
    /// snapshot, and this keeps the rows from offering a second move then.
    private(set) var movedSessionId: String?
    var confirmation: Confirmation?
    var error: String?

    func loadProviders() async {
        let status = try? await OS1API.sandboxStatus()
        providers = SandboxMove.choices(status)
    }

    /// Ask the server to move the session. Returns the new Sandbox state on
    /// success; nil when the server wants a confirmation first (now held in
    /// `confirmation`) or refused (held in `error`).
    func move(
        sessionId: String,
        to provider: String,
        confirm: Bool = false
    ) async -> SessionSandboxStatus? {
        guard working == nil else { return nil }
        working = provider
        error = nil
        defer { working = nil }
        do {
            switch try await OS1API.attachSandbox(
                sessionId: sessionId,
                provider: provider,
                confirm: confirm
            ) {
            case .moved(let status):
                movedSessionId = sessionId
                return status
            case .confirmRequired(let message):
                confirmation = Confirmation(
                    sessionId: sessionId,
                    provider: provider,
                    message: message
                )
                return nil
            }
        } catch {
            self.error = error.localizedDescription
            return nil
        }
    }

    func hasMoved(_ sessionId: String) -> Bool {
        movedSessionId == sessionId
    }

    /// Record the server's answer on the open session now, then take the row
    /// the server has. The refresh is a round trip that can fail or arrive
    /// late; the offer must be gone before it starts, not after it lands.
    static func adopt(_ status: SessionSandboxStatus, into viewModel: SessionViewModel) {
        var session = viewModel.session
        session.sandbox = SandboxMove.recorded(from: status)
        viewModel.updateSessionSnapshot(session)
        Task { await refresh(viewModel) }
    }

    /// The row the server has after a move, so the open session shows the
    /// Sandbox preparing now rather than on the next sessions poll.
    static func refresh(_ viewModel: SessionViewModel) async {
        guard let fresh = try? await OS1API.session(id: viewModel.session.id) else { return }
        viewModel.updateSessionSnapshot(fresh)
    }
}
