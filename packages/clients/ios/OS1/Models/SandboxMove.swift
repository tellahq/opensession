import Foundation

/// Moving a session that runs on this machine into a Sandbox
/// (`POST /api/sessions/:id/sandbox/attach`).
///
/// The rules mirror the server's `sandboxAttachRefusal` (routes/sandbox.ts)
/// so the app never offers a move the server would answer 409 to. Kept out
/// of the views so they can be tested against real session payloads.
enum SandboxMove {
    /// Why a session cannot move, in the server's order.
    enum Refusal: Equatable {
        /// A Sandbox exists for it, or is on its way. The server would accept
        /// a second move while the first is still preparing, and then
        /// provision twice; the Sandbox that lands second is never recorded
        /// or destroyed. The one recorded state that may move again is a
        /// failed provision (`needs_attention` without an id): nothing was
        /// made, Recreate has no id to work from, and the server permits the
        /// retry.
        case inSandbox
        case runner
        case automation
        case notCode
        case noRepo
    }

    static func refusal(_ session: Session) -> Refusal? {
        if let sandbox = session.sandbox,
           let provider = sandbox.provider, !provider.isEmpty, provider != "local" {
            let materialized = !(sandbox.sandboxId ?? "").isEmpty
            if materialized || sandbox.lifecycle != "needs_attention" { return .inSandbox }
        }
        if let runner = session.runner, !runner.id.isEmpty { return .runner }
        if session.automation?.isAutomation == true
            || !(session.automationId ?? "").isEmpty {
            return .automation
        }
        if session.mode != "code" { return .notCode }
        if session.repoLess == true || (session.repo ?? "").isEmpty { return .noRepo }
        return nil
    }

    static func canMove(_ session: Session) -> Bool {
        refusal(session) == nil
    }

    /// The row's record of the Sandbox the attach route answered with, so the
    /// open session carries the provider from the moment the server does and
    /// `refusal` says `.inSandbox` before any refresh lands.
    static func recorded(from status: SessionSandboxStatus) -> SessionSandbox {
        SessionSandbox(
            provider: status.provider,
            sandboxId: status.sandboxId,
            workspace: status.workspace,
            lifecycle: status.lifecycle ?? "preparing",
            lastLifecycleError: status.lastLifecycleError
        )
    }

    /// Where a session may move to: the composer's own list, which is the
    /// Ready connections, minus the host it is already on.
    static func choices(_ status: InstanceSandboxStatus?) -> [String] {
        SandboxOffering.choices(status).filter { $0 != SandboxOffering.host && $0 != "local" }
    }
}

/// What the attach route answered. A 428 is not a failure: work exists only
/// on this machine, and the person decides whether to leave it behind.
enum SandboxAttachOutcome: Equatable {
    case moved(SessionSandboxStatus)
    /// The server's own sentence about the unpushed work.
    case confirmRequired(String)
}
