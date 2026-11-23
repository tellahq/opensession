import Foundation

/// PR details from `GET /api/sessions/:id/pr` — a tolerant subset of the
/// server's PrDetails (src/server/pr-info.ts). The route answers a bare JSON
/// `null` when the session's branch has no PR; decoding is optional-heavy so
/// server-side additions never break the client.
struct PrDetails: Decodable, Equatable {
    var number: Int
    var title: String?
    var url: String?
    /// OPEN | MERGED | CLOSED
    var state: String?
    var isDraft: Bool?
    var baseRefName: String?
    var headRefName: String?
    var additions: Int?
    var deletions: Int?
    var changedFiles: Int?
    /// APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | ""
    var reviewDecision: String?
    var author: String?
    var checks: [PrCheck]?
    var reviewers: [PrReviewer]?
    /// MERGEABLE | CONFLICTING | UNKNOWN — the provider's conflict probe.
    var mergeable: String?
    /// CLEAN | BEHIND | BLOCKED | DIRTY | UNSTABLE | … — merge-box state.
    /// The server already reads past a rule that only bars its own bot, so a
    /// BLOCKED here is a real block for the person too.
    var mergeStateStatus: String?
    /// The commit the PR's head is at; a force merge refuses a moved head.
    var headRefOid: String?
    /// Auto-merge, when it is on: the host lands the PR once it may.
    var autoMerge: PrAutoMerge?
    /// The agent's last reading of this pull request, when one has run.
    var osReview: OsReviewSummary?
    /// A review pass is running on the PR right now.
    var reviewActive: Bool?
    /// The pull request's conversation, oldest first.
    var comments: [PrComment]?
    /// The description, as the author wrote it (markdown).
    var body: String?
    var commits: [PrCommit]?
    /// Per-file line counts, biggest churn first. The patch itself comes from
    /// the diff route; this is what the overview lists without loading it.
    var files: [PrFile]?
    var staging: PrStaging?
    /// What the PR's host supports. Absent on GitHub-only servers, which
    /// means everything is.
    var capabilities: PrHostCapabilities?
}

/// The host features the review surface branches on (`PrHostCapabilities`
/// in pr-contract.ts). A missing flag means supported, as on the web.
struct PrHostCapabilities: Decodable, Equatable {
    /// Per-viewer "Viewed" state. Without it, review marks stay on device.
    var viewedState: Bool?
    var reviewComments: Bool?
    /// Queue a merge that lands once requirements pass.
    var autoMerge: Bool?
    /// Merge past branch protection with the viewer's own rights.
    var forceMerge: Bool?
}

/// `PrAutoMerge` in pr-contract.ts (`parseAutoMerge` in pr-info.ts). The
/// server sends `null` when auto-merge is off.
struct PrAutoMerge: Decodable, Equatable {
    /// squash | merge | rebase
    var method: String?
    /// The GitHub login that turned it on; empty when unknown.
    var enabledBy: String?
    var enabledAt: String?
}

struct PrCommit: Decodable, Equatable, Identifiable {
    var oid: String
    var messageHeadline: String?
    var author: String?

    var id: String { oid }
    var shortOid: String { String(oid.prefix(7)) }
}

struct PrFile: Decodable, Equatable, Identifiable {
    var path: String
    var additions: Int?
    var deletions: Int?

    var id: String { path }
}

/// The PR's preview environment, when the repo builds one.
struct PrStaging: Decodable, Equatable {
    var url: String?
    /// The deployment's configured landing route, used when the session has
    /// not recorded one. Absent on servers that predate it.
    var defaultPath: String?
    /// The PR is merged and deployed, so the link is the production site
    /// rather than the PR's preview. Absent on servers that predate it.
    var production: Bool?

    /// The preview link: the session's recorded route when it has one, else
    /// the configured landing route, else the root. Mirrors the web's
    /// `stagingHref` (src/frontend/lib/preview-url.ts).
    func href(previewPath: String?) -> URL? {
        guard let url, !url.isEmpty else { return nil }
        let path = previewPath.flatMap { $0.isEmpty ? nil : $0 } ?? defaultPath
        return URL(string: Self.withPreviewPath(url, path))
    }

    /// Append a root-relative route to a base URL, string for string like the
    /// web's `withPreviewPath`: leading slashes on the route and trailing
    /// slashes on the base collapse to one, a query in the route is kept, and
    /// an empty or bare "/" route leaves the base unchanged.
    static func withPreviewPath(_ base: String, _ path: String?) -> String {
        guard let path, !path.isEmpty else { return base }
        let rel = "/" + path.drop(while: { $0 == "/" })
        if rel == "/" { return base }
        var trimmed = Substring(base)
        while trimmed.hasSuffix("/") { trimmed = trimmed.dropLast() }
        return trimmed + rel
    }
}

struct PrComment: Decodable, Equatable {
    var author: String?
    var body: String
    var createdAt: String?
    var url: String?

    /// The comment without the hidden markers bots use to find their own
    /// comments again. Mirrors the web's `stripHtmlComments`.
    var discussionBody: String {
        body
            .replacingOccurrences(
                of: "<!--[\\s\\S]*?-->",
                with: "",
                options: .regularExpression
            )
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// A superseded automated review stays on GitHub for history, not as
    /// something to read (`isOutdatedReviewComment` on the web).
    var isOutdatedReview: Bool {
        body.range(
            of: "<!--\\s*os-review-outdated\\s*-->",
            options: .regularExpression
        ) != nil
    }

    /// Worth showing in the conversation: it says something once its markers
    /// are stripped, and it has not been superseded.
    var isDiscussion: Bool {
        !discussionBody.isEmpty && !isOutdatedReview
    }
}

struct PrCheck: Decodable, Equatable {
    var name: String
    /// COMPLETED, IN_PROGRESS, QUEUED… ("" for StatusContexts).
    var status: String?
    /// SUCCESS, FAILURE, NEUTRAL, PENDING…
    var conclusion: String?
    var url: String?
    var startedAt: String?
    var completedAt: String?
    /// CheckRun workflow (e.g. "CI") — StatusContexts (Vercel deploys) have none.
    var workflowName: String?

    enum Rank {
        case success, failure, pending, neutral
    }

    /// Mirrors the web PrPanel's checkClass(): anything not completed is
    /// pending, and StatusContexts report PENDING/EXPECTED as a *conclusion*
    /// with an empty status, which must not read as neutral.
    var rank: Rank {
        let liveStatus = status ?? ""
        if liveStatus != "COMPLETED" && liveStatus != "" { return .pending }
        switch conclusion ?? "" {
        case "PENDING", "EXPECTED": return .pending
        case "SUCCESS": return .success
        case "FAILURE", "TIMED_OUT", "ERROR": return .failure
        default: return .neutral
        }
    }
}

/// A person on the PR's reviewer list; `state` is the review outcome
/// (APPROVED | CHANGES_REQUESTED | COMMENTED | DISMISSED) or PENDING for a
/// requested-but-not-yet-submitted review.
struct PrReviewer: Decodable, Equatable {
    var login: String
    var state: String?
    var isTeam: Bool?
}

extension PrDetails {
    /// One-dot summary for the toolbar chip: terminal states first, then the
    /// check rollup while open (no checks at all counts as passing — "no
    /// known CI blocker", matching the web list's treatment).
    enum Summary {
        case merged, closed, draft, failing, pending, passing
    }

    /// Still actionable: not merged and not closed. A server old enough to omit
    /// `state` counts as open — the actions it gates all fail loudly server-side
    /// rather than doing the wrong thing.
    var isOpen: Bool {
        state != "MERGED" && state != "CLOSED"
    }

    var summary: Summary {
        switch state ?? "" {
        case "MERGED": return .merged
        case "CLOSED": return .closed
        default: break
        }
        if isDraft == true { return .draft }
        let ranks = (checks ?? []).map(\.rank)
        if ranks.contains(.failure) { return .failing }
        if ranks.contains(.pending) { return .pending }
        return .passing
    }
}

extension PrDetails {
    /// What holds an open PR whose checks, review and conflicts all allow a
    /// merge, yet the host still refuses one (a ruleset, a required review,
    /// a required check that never reported). The web's `deriveHeadline`
    /// "blocked" branch.
    enum MergeBlock: Equatable {
        /// Auto-merge is on: the host lands it once the rules pass.
        case mergesWhenReady
        case reviewRequired
        case blocked

        /// The merge card's headline.
        var headline: String {
            switch self {
            case .mergesWhenReady: "Merges when ready"
            case .reviewRequired: "Review required"
            case .blocked: "Blocked"
            }
        }

        /// The Review tab's status line (`deriveStatus` qualifier).
        var statusLine: String {
            self == .mergesWhenReady ? "Merges when ready" : "Merge blocked"
        }

        /// Green once it will land by itself, yellow while it waits on
        /// someone.
        var isGreen: Bool { self == .mergesWhenReady }
    }

    /// Nil unless the host is holding back an otherwise clean merge. Earlier
    /// causes (draft, conflicts, failing or running checks, requested
    /// changes) keep their own labels, as on the web.
    var mergeBlock: MergeBlock? {
        guard summary == .passing,
              mergeable != "CONFLICTING",
              reviewDecision != "CHANGES_REQUESTED",
              mergeStateStatus == "BLOCKED"
        else { return nil }
        if autoMerge != nil { return .mergesWhenReady }
        return reviewDecision == "REVIEW_REQUIRED" ? .reviewRequired : .blocked
    }

    /// Whether the host can queue an auto-merge (absent means yes).
    var canAutoMerge: Bool { capabilities?.autoMerge != false }
    /// Whether the host can merge past protection (absent means yes).
    var canForceMerge: Bool { capabilities?.forceMerge != false }

    /// What a force merge goes around, for its confirmation. The web's
    /// `mergeChoices` bypasses.
    var forceMergeBypasses: [String] {
        var out: [String] = []
        if reviewDecision == "CHANGES_REQUESTED" {
            out.append("requested changes")
        } else if reviewDecision == "REVIEW_REQUIRED" {
            out.append("a required review")
        }
        if mergeStateStatus == "BLOCKED", out.isEmpty { out.append("branch protection") }
        return out
    }
}

extension PrDetails.Summary {
    /// How a PR named in prose is coloured. The same five meanings as
    /// `PrChipLabel`'s dot (PrPanel.swift), because one PR must not read one
    /// way in the toolbar and another in the sentence above it — but as a wash
    /// under the whole chip rather than a mark in front of it, which is what
    /// the web does too (`a.pr-ref[data-pr-tone]`).
    var chipTone: TranscriptChip.Tone {
        switch self {
        case .merged: .purple
        case .closed, .failing: .red
        case .draft: .gray
        case .pending: .yellow
        case .passing: .green
        }
    }
}
