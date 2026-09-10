import Foundation

/// The sandbox recorded on a session row. Provider fields are optional because
/// session records and servers can predate sandbox materialization.
struct SessionSandbox: Decodable, Equatable, Hashable, Sendable {
    let provider: String?
    let sandboxId: String?
    let workspace: String?
    let lifecycle: String?
    let lastLifecycleError: String?
}

/// Live state from `GET /api/sessions/:id/sandbox`. Keep every field optional:
/// a new provider state or a server rollout must not make an older client fail
/// to decode a session's workspace details.
struct SessionSandboxStatus: Decodable, Equatable, Sendable {
    struct Logs: Decodable, Equatable, Sendable {
        let setup: String?
        let resume: String?
    }

    let enabled: Bool?
    let provider: String?
    let sandboxId: String?
    let workspace: String?
    let status: String?
    let lifecycle: String?
    let lastLifecycleError: String?
    let materialized: Bool?
    let busy: Bool?
    let cwd: String?
    let canPause: Bool?
    let canResume: Bool?
    /// The provider can show this Sandbox's screen; see `SandboxDesktopLink`.
    let canDesktop: Bool?
    let logs: Logs?
}

enum SessionSandboxAction: String, Equatable {
    case pause, resume, recreate
}

/// One viewer's link to a Sandbox desktop, from
/// `POST /api/sessions/:id/sandbox/desktop`. The URL is a bearer secret: the
/// server hands it out once and audits the request without it, so this value
/// is minted when someone taps Open desktop, opened, and dropped. Never store
/// it, and never let it into a log: the description redacts it so an
/// interpolated or printed link cannot leak it by accident.
struct SandboxDesktopLink: Decodable, Equatable, Sendable, CustomStringConvertible {
    let url: String
    /// Milliseconds since the epoch, when the provider bounds the link.
    let expiresAt: Double?

    /// The link as something the browser presentation can open. Only web
    /// URLs qualify: a provider answering anything else is a bug, and the
    /// system opener must not be handed a bearer link of an unknown scheme.
    var webURL: URL? {
        guard let parsed = URL(string: url) else { return nil }
        switch parsed.scheme?.lowercased() {
        case "http", "https": return parsed
        default: return nil
        }
    }

    var description: String { "SandboxDesktopLink(url: <redacted>)" }
}

/// Moving a session that runs on this machine into a Sandbox, which the
/// server provisions on the session's next turn. The rules mirror the web's
/// `MoveToSandboxMenu` so both clients offer the move to the same sessions.
enum SandboxMove {
    /// A code session on this machine, with a repository to clone and no
    /// automation or Runner pinning it here. Once it carries a Sandbox the
    /// move is done.
    static func canMove(_ session: Session) -> Bool {
        guard session.mode == "code",
              let repo = session.repo, !repo.isEmpty,
              session.automation?.isAutomation != true,
              session.runner == nil
        else { return false }
        guard let provider = session.sandbox?.provider, !provider.isEmpty else { return true }
        return provider == "local"
    }

    /// The Sandboxes the move may target: the same ready providers a new
    /// session could choose, in the server's order.
    static func providers(_ status: InstanceSandboxStatus?) -> [String] {
        SandboxOffering.choices(status).filter { $0 != SandboxOffering.host && $0 != "local" }
    }

    static func label(_ provider: String) -> String {
        SandboxOffering.label(provider)
    }

    /// What the server said to one attach request.
    enum Outcome: Equatable {
        /// The record now says the Sandbox is preparing.
        case moved(SessionSandboxStatus)
        /// Work exists only on this machine (uncommitted files, unpushed
        /// commits). The server refused with 428 and this sentence; a person
        /// has to accept leaving it behind before the request is repeated
        /// with `confirm`.
        case needsConfirmation(String)
        case failed(String)
    }

    /// Runs one attach and classifies the answer. The 428 is surfaced exactly
    /// once: an unconfirmed attempt turns it into `needsConfirmation`, while
    /// a confirmed retry that still meets it reports a failure rather than
    /// asking again.
    static func attempt(
        confirmed: Bool,
        request: (_ confirm: Bool) async throws -> SessionSandboxStatus
    ) async -> Outcome {
        do {
            return .moved(try await request(confirmed))
        } catch OS1API.APIError.confirmRequired(let message) where !confirmed {
            return .needsConfirmation(message)
        } catch {
            return .failed(
                (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            )
        }
    }
}
