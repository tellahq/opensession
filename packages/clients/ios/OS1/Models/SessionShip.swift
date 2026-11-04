import Foundation

/// One button the Ship band offers: Ship, Create PR, Update PR, or a
/// repository's own `shipActions` entry. Pressing it sends `prompt` to the
/// session's agent as an ordinary message.
struct ShipButton: Decodable, Sendable, Equatable, Identifiable {
    let id: String
    let label: String
    let prompt: String
    var primary: Bool = false

    init(id: String, label: String, prompt: String, primary: Bool = false) {
        self.id = id
        self.label = label
        self.prompt = prompt
        self.primary = primary
    }

    private enum CodingKeys: String, CodingKey { case id, label, prompt, primary }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        label = try c.decode(String.self, forKey: .label)
        prompt = try c.decode(String.self, forKey: .prompt)
        primary = (try? c.decodeIfPresent(Bool.self, forKey: .primary)) ?? false
    }
}

/// A push straight to the target branch, and whether the remote confirmed it.
struct DirectShip: Decodable, Sendable, Equatable {
    let repo: String
    let branch: String
    let target: String
    let sha: String
    var previousSha: String?
    var commits: [String]
    let pushedAt: String
    /// Set once the remote's default branch was confirmed to contain `sha`.
    var shippedAt: String?

    var shortSha: String { String(sha.prefix(7)) }
    var isShipped: Bool { shippedAt?.isEmpty == false }
    var shippedDate: Date? { shippedAt.flatMap(Self.parse) }

    private static func parse(_ value: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return fractional.date(from: value) ?? ISO8601DateFormatter().date(from: value)
    }
}

/// `GET /api/sessions/:id/ship`. `available: false` carries nothing else, so
/// every other field decodes leniently and `info` is nil for that shape.
struct SessionShipInfo: Decodable, Sendable, Equatable {
    struct OpenPr: Decodable, Sendable, Equatable {
        let number: Int
        var url: String?
    }

    struct Details: Sendable, Equatable {
        let repo: String
        let target: String
        /// `worktree` or `shared`.
        let checkout: String
        /// `pull-request` or `direct`.
        let mode: String
        let requested: String
        let reason: String
        var openPr: OpenPr?
        var buttons: [ShipButton]
        var ships: [DirectShip]

        var isDirect: Bool { mode == "direct" }
        var latestShip: DirectShip? { ships.last }
    }

    let available: Bool
    let info: Details?

    static let unavailable = SessionShipInfo(available: false, info: nil)

    init(available: Bool, info: Details?) {
        self.available = available
        self.info = info
    }

    private enum CodingKeys: String, CodingKey {
        case available, repo, target, checkout, mode, requested, reason, openPr, buttons, ships
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let available = (try? c.decodeIfPresent(Bool.self, forKey: .available)) ?? false
        guard available,
              let repo = try? c.decode(String.self, forKey: .repo),
              let target = try? c.decode(String.self, forKey: .target) else {
            self.available = false
            self.info = nil
            return
        }
        func string(_ key: CodingKeys, _ fallback: String) -> String {
            (try? c.decodeIfPresent(String.self, forKey: key)) ?? fallback
        }
        let mode = string(.mode, "pull-request")
        self.available = true
        self.info = Details(
            repo: repo,
            target: target,
            checkout: string(.checkout, "worktree"),
            mode: mode,
            requested: string(.requested, mode),
            reason: string(.reason, "repository"),
            openPr: try? c.decodeIfPresent(OpenPr.self, forKey: .openPr),
            buttons: (try? c.decodeIfPresent([ShipButton].self, forKey: .buttons)) ?? [],
            ships: (try? c.decodeIfPresent([DirectShip].self, forKey: .ships)) ?? []
        )
    }
}

extension SessionShipInfo.Details {
    /// Why a Direct choice fell back to the PR flow, as a short clause.
    static func forcedPrReason(_ reason: String) -> String? {
        switch reason {
        case "open-pr": "this branch already has a PR"
        case "stacked": "this branch is stacked"
        case "existing-branch": "this branch came from a PR"
        case "pstack": "pstack sessions open PRs"
        case "automation": "automations open PRs"
        default: nil
        }
    }

    /// Where Ship sends the change, in the person's terms. Mirrors the web's
    /// `shipDestination`.
    var destination: String {
        if checkout == "shared" { return "Pushes to \(target) from this checkout" }
        if isDirect { return "Pushes to \(target)" }
        let forced = requested == "direct" ? Self.forcedPrReason(reason) : nil
        let base: String
        if let openPr {
            base = "Updates PR #\(openPr.number)"
        } else if buttons.first?.label == "Push branch" {
            base = "Pushes the branch for review"
        } else {
            base = "Opens a pull request"
        }
        return forced.map { "\(base), since \($0)" } ?? base
    }
}
