import SwiftUI

/// Something belonging to a session that opens ONE LEVEL DEEPER than the
/// conversation: its scratch assets, one of those files, its pull request.
///
/// A push, not a tab and not a sheet. Everything here is a detail of the
/// session you are already in, so the stack you are already in is where it
/// belongs: the chevron says what you'd go back to, the edge swipe gets you
/// there without aiming at anything, and nothing has to be closed afterwards.
/// Tabs and sheets both ask you to manage them; a push asks nothing.
///
/// Adding a kind is a case here plus its content in the host's
/// `navigationDestination` — the strip, the transcript and the workspace
/// sheet learn nothing new.
enum SessionPanel: Hashable, Identifiable {
    /// Everything in the session's scratch folder.
    case assets(sessionId: String)
    /// One file in it, opened directly — what a chat row's chip points at.
    case asset(sessionId: String, path: String)
    /// The session's pull request, read-only.
    case review(sessionId: String)
    /// Everything the worktree has changed. `path` opens one file's diff
    /// straight away — the workspace sheet already lists the files, so a tap
    /// there should land on the diff rather than on the list again.
    case changes(sessionId: String, path: String? = nil)
    /// The services the session exposes. Each live one opens in the browser
    /// sheet; a supervised one swipes for stop and restart.
    case portals(sessionId: String)
    /// A shell in the session's worktree: run a command, read the output.
    /// A push like the rest, and for the same reason: it is a detail of this
    /// session, and leaving it should be the gesture you already know.
    case terminal(sessionId: String)
    /// The batches of agents this session sent out, and what each came back
    /// with. A run belongs to the session that started it — the server has no
    /// way to ask for anyone else's — so this is a detail of the conversation
    /// in exactly the way the others are.
    case agents(sessionId: String)

    var id: String {
        switch self {
        case .assets(let sessionId): "assets-\(sessionId)"
        case .asset(let sessionId, let path): "asset-\(sessionId)-\(path)"
        case .review(let sessionId): "review-\(sessionId)"
        case .changes(let sessionId, let path): "changes-\(sessionId)-\(path ?? "")"
        case .portals(let sessionId): "portals-\(sessionId)"
        case .terminal(let sessionId): "terminal-\(sessionId)"
        case .agents(let sessionId): "agents-\(sessionId)"
        }
    }

    var sessionId: String {
        switch self {
        case .assets(let sessionId), .review(let sessionId), .portals(let sessionId),
             .terminal(let sessionId), .agents(let sessionId): sessionId
        case .asset(let sessionId, _): sessionId
        case .changes(let sessionId, _): sessionId
        }
    }
}

/// Push one of those panels for the session the caller is inside.
///
/// An environment action rather than a callback threaded down through the
/// transcript: the deepest caller is a tool-call row, several layers below the
/// session view, and none of the rows in between have any business knowing
/// what a navigation stack is. `isAvailable` is what a caller checks before
/// drawing a button — surfaces with nothing to push onto (the Mac app) install
/// no handler, and an entry that does nothing is worse than no entry.
struct OpenPanelAction: Equatable {
    /// The session whose panels this pushes — and the action's identity.
    ///
    /// Equatable on purpose, and keyed on something stable: the handler is a
    /// fresh closure on every parent update, and an environment value that
    /// never compares equal would re-evaluate `SessionView.body` — transcript
    /// and all — every time the sessions poll landed.
    let sessionId: String?
    fileprivate let handler: ((SessionPanel) -> Void)?

    var isAvailable: Bool { handler != nil }

    /// `openPanel(.review)`, `openPanel(.asset(path: "report.html"))` — the
    /// session is the one this action was installed for.
    func callAsFunction(_ panel: SessionPanel) { handler?(panel) }

    static let unavailable = OpenPanelAction(sessionId: nil, handler: nil)

    static func pushing(
        sessionId: String,
        _ handler: @escaping (SessionPanel) -> Void
    ) -> OpenPanelAction {
        OpenPanelAction(sessionId: sessionId, handler: handler)
    }

    static func == (lhs: OpenPanelAction, rhs: OpenPanelAction) -> Bool {
        lhs.sessionId == rhs.sessionId && lhs.isAvailable == rhs.isAvailable
    }
}

#if os(iOS)
/// What a pushed panel draws.
///
/// Both hosts render through here — the session's own stack and the workspace
/// sheet's — so a new kind lands in both at once instead of in whichever one
/// its author happened to be looking at.
struct SessionPanelView: View {
    let panel: SessionPanel
    /// The session's live view model, for the panels that need more than an
    /// id: review reads and re-fetches the PR through it.
    let viewModel: SessionViewModel

    var body: some View {
        switch panel {
        case .assets(let sessionId):
            AssetsListView(sessionId: sessionId)
        case .asset(let sessionId, let path):
            AssetDetailView(sessionId: sessionId, path: path)
        case .review:
            // Pushed, so the navigation bar is already there: no stack of its
            // own, and the chevron replaces the Done button.
            PrPanelView(viewModel: viewModel, chrome: .pushed)
        case .changes(let sessionId, let path):
            ChangesView(
                sessionId: sessionId,
                focus: path,
                isRunning: viewModel.session.id == sessionId && viewModel.isRunning
            )
        case .portals(let sessionId):
            PortalsListView(sessionId: sessionId)
        case .terminal(let sessionId):
            TerminalView(sessionId: sessionId)
        case .agents:
            WorkflowRunsView(viewModel: viewModel)
        }
    }
}
#endif

private struct OpenPanelKey: EnvironmentKey {
    static let defaultValue = OpenPanelAction.unavailable
}

extension EnvironmentValues {
    var openPanel: OpenPanelAction {
        get { self[OpenPanelKey.self] }
        set { self[OpenPanelKey.self] = newValue }
    }
}
