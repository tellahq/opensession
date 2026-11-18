import Foundation

/// Keeps a handful of recently visited conversations warm without leaving
/// their WebSockets connected while they are off-screen.
@MainActor
final class SessionViewModelCache {
    struct Scope: Equatable {
        let serverURL: String
        let token: String
    }

    private struct Entry {
        let viewModel: SessionViewModel
        var lastAccess: UInt64
    }

    private let capacity: Int
    private var entries: [String: Entry] = [:]
    private var accessCounter: UInt64 = 0
    private var scope: Scope?

    init(capacity: Int = 6) {
        self.capacity = max(1, capacity)
    }

    func viewModel(
        for session: Session,
        scope: Scope,
        seed: SessionViewModel.OptimisticSeed? = nil,
        composerDraft: SessionViewModel.ComposerDraft? = nil
    ) -> SessionViewModel {
        if self.scope != scope {
            discardAll()
            self.scope = scope
        }

        accessCounter &+= 1
        if var entry = entries[session.id] {
            entry.lastAccess = accessCounter
            entries[session.id] = entry
            entry.viewModel.updateSessionSnapshot(session)
            return entry.viewModel
        }

        let viewModel = SessionViewModel(
            session: session,
            seed: seed,
            composerDraft: composerDraft
        )
        entries[session.id] = Entry(
            viewModel: viewModel,
            lastAccess: accessCounter
        )
        evictIfNeeded()
        return viewModel
    }

    /// An optimistic session resolved to its server id: keep its warm view
    /// model under the new key instead of building the conversation again.
    func rekey(from oldId: String, to session: Session) {
        guard let entry = entries.removeValue(forKey: oldId) else { return }
        entries.removeValue(forKey: session.id)?.viewModel.stop()
        entry.viewModel.adoptCreatedSession(session)
        entries[session.id] = entry
    }

    func remove(sessionId: String) {
        entries.removeValue(forKey: sessionId)?.viewModel.stop()
    }

    func removeAll() {
        discardAll()
        scope = nil
    }

    var cachedSessionIds: Set<String> {
        Set(entries.keys)
    }

    private func evictIfNeeded() {
        while entries.count > capacity,
              let oldest = entries.min(by: { $0.value.lastAccess < $1.value.lastAccess }) {
            remove(sessionId: oldest.key)
        }
    }

    private func discardAll() {
        entries.values.forEach { $0.viewModel.stop() }
        entries.removeAll()
    }
}
