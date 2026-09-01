import SwiftUI

/// The long-press preview for a sidebar row that has a pull request.
///
/// This is the iPhone's shape of the web sidebar's hover card
/// (`components/sidebar/HoverCards.tsx`). A pointer can dwell on a row and be
/// answered without committing to anything; a finger cannot, so the same
/// answer rides on the gesture a phone already has for "tell me more before I
/// choose": the long press that raises the row's menu. The menu is
/// unchanged; this floats above it.
///
/// It carries the web card's decisions rather than its markup:
///
/// - **The diff leads.** The row's own line is its title, and the head used to
///   be a branch name: often generated, always truncated, never the thing
///   being asked. What changed takes that line instead (web commit "Sidebar
///   cards lead with the diff, not the branch").
/// - **The facts are a strip, not a table.** State, checks, review verdict and
///   who is being waited on read as one wrapping run of short phrases. The web
///   card has 300px and a label column; a phone has neither, and a 74pt label
///   gutter would leave its values a dozen characters wide.
/// - **The review is compact.** Its score leads the verdict (`4/5 · approved`),
///   with blocking and stale context retained when present.
///
/// What deliberately did NOT come across is the web footer's centred Merge
/// button. A context menu preview is not interactive: taps go to the menu, so
/// a button here would be a picture of a button. Merge already lives one item
/// below in the same gesture (`prAction`), and the preview's job is to give
/// that item its evidence.
struct SessionRowPreview: View {
    let title: String
    let repo: String
    let session: Session

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    /// Roughly the web card's 300px. Wide enough for a two-number diff and a
    /// fact per line, narrow enough that the menu underneath still reads as
    /// the thing being chosen from.
    private static let width: CGFloat = 300

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            head
            strip
            Text(title)
                .font(.callout.weight(.semibold))
                .foregroundStyle(OS1VisualStyle.text)
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 8)
            provenance
            footer
        }
        .frame(width: Self.width, alignment: .leading)
        .padding(14)
        // The system platter behind a preview is transparent, so without a
        // fill the card would sit on whatever the row was over.
        .background(OS1VisualStyle.background)
    }

    /// What changed, and the PR's mark. The mark is the row's own status
    /// glyph, so the card and the row it grew out of read the same.
    private var head: some View {
        HStack(spacing: 7) {
            if let stats {
                LineStatsView(stats: stats)
            } else {
                Text(repo)
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(OS1VisualStyle.textDim)
            }
            if let files = session.prChangedFiles, files > 0 {
                // `verbatim` for the same reason as LineStatsView: an Int
                // interpolated into a literal is formatted for the locale.
                Text(verbatim: "\(files) file\(files == 1 ? "" : "s")")
                    .font(.caption2)
                    .foregroundStyle(OS1VisualStyle.textFaint)
                    .monospacedDigit()
            }
            Spacer(minLength: 4)
            mark
        }
    }

    private var stats: ToolLineStats? {
        let additions = session.prAdditions ?? 0
        let deletions = session.prDeletions ?? 0
        guard additions > 0 || deletions > 0 else { return nil }
        return ToolLineStats(additions: additions, deletions: deletions)
    }

    @ViewBuilder
    private var mark: some View {
        if session.prState == "MERGED" {
            WebIcon(kind: .gitMerge, size: 18, color: OS1VisualStyle.purple)
        } else if session.prState == "CLOSED" {
            WebIcon(kind: .pullRequest, size: 18, color: OS1VisualStyle.red)
        } else {
            WebIcon(kind: .pullRequest, size: 18, color: OS1VisualStyle.green)
        }
    }

    /// The facts, wrapped rather than truncated: at accessibility type sizes a
    /// single line would cut the one phrase that says what to do next.
    private var strip: some View {
        let facts = PrPreviewFacts.all(for: session)
        // Wide gaps, and no punctuation between facts: a fact can carry its
        // own "·" ("changes requested · 2 blocking"), so a separator of the
        // same weight between them would make one phrase of two. Proximity
        // does the grouping instead.
        return FlowLayout(spacing: 13) {
            ForEach(Array(facts.enumerated()), id: \.offset) { _, fact in
                Text(fact.text)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(fact.tone.color)
                    // One line is right while a fact is a few words wide. At
                    // an accessibility size a single fact can be wider than
                    // the whole card, and one line then means the end of the
                    // phrase is cut: "changes requested · 2 bl…". Wrapping
                    // costs a line and keeps the count, which is the half of
                    // that fact that changes what to do next.
                    .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 1)
            }
        }
        .padding(.top, facts.isEmpty ? 0 : 6)
    }

    /// Where the change lives. The branch is the web card's demoted fact and
    /// stays demoted: it is here for the many branches with a human name, and
    /// truncates from the middle so a generated one keeps both its prefix and
    /// its date rather than dissolving into one end of itself.
    @ViewBuilder
    private var provenance: some View {
        let branch = session.branch?.trimmingCharacters(in: .whitespaces)
        HStack(spacing: 5) {
            Text(repo)
            if let branch, !branch.isEmpty {
                Text(verbatim: "·")
                Text(branch)
                    .truncationMode(.middle)
            }
        }
        .font(.caption2)
        .foregroundStyle(OS1VisualStyle.textFaint)
        .lineLimit(1)
        .padding(.top, 3)
    }

    /// Where this leads on the left, when it last changed on the right. That
    /// is the web card's footer, and it carries no rule above it for the same
    /// reason: the card is narrow and already ranged left, so a full-width
    /// line would split it in two to separate things nothing was confusing.
    private var footer: some View {
        HStack(spacing: 6) {
            if let number = session.prNumber {
                Text(verbatim: "#\(number)")
                    .font(.caption.weight(.semibold))
                    .monospacedDigit()
                    .foregroundStyle(OS1VisualStyle.textDim)
            }
            Spacer(minLength: 4)
            if let updated {
                Text(updated)
                    .font(.caption2)
                    .foregroundStyle(OS1VisualStyle.textFaint)
                    .monospacedDigit()
            }
        }
        .padding(.top, 9)
    }

    private var updated: String? {
        guard let at = session.lastActivityDate else { return nil }
        return "Updated \(SessionRow.compactAgo(Date().timeIntervalSince(at)))"
    }
}

#if DEBUG
/// Deterministic visual proof for the native screenshot harness.
struct PrReviewCardsScreenshot: View {
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text("PR review readings")
                    .font(.title2.weight(.semibold))
                    .foregroundStyle(OS1VisualStyle.text)

                card(
                    title: "Ready after review",
                    review: OsReviewSummary(
                        verdict: "approve", confidence: 4, findings: 0, blocking: 0, stale: false
                    )
                )
                card(
                    title: "Address blocking feedback",
                    review: OsReviewSummary(
                        verdict: "request_changes", confidence: 2,
                        findings: 2, blocking: 1, stale: false
                    )
                )
                card(
                    title: "Review is behind the branch",
                    review: OsReviewSummary(
                        verdict: "comment", confidence: 3, findings: 1, blocking: 0, stale: true
                    )
                )
            }
            .padding(20)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(OS1VisualStyle.background)
    }

    private func card(title: String, review: OsReviewSummary) -> some View {
        var session = Session(id: title)
        session.repo = "opensession"
        session.branch = "review-score-parity"
        session.prNumber = 128
        session.prState = "OPEN"
        session.prMergeable = "MERGEABLE"
        session.prAdditions = 42
        session.prDeletions = 8
        session.prChangedFiles = 3
        session.prOsReview = review
        session.lastActivity = ISO8601DateFormatter().string(from: .now.addingTimeInterval(-180))
        return SessionRowPreview(title: title, repo: "opensession", session: session)
    }
}
#endif

// MARK: - Facts

/// One phrase on the preview's strip, and the tone it is said in.
struct PrPreviewFact: Equatable {
    enum Tone: Equatable {
        case green, red, yellow, purple, dim, faint

        var color: Color {
            switch self {
            case .green: OS1VisualStyle.greenInk
            case .red: OS1VisualStyle.redInk
            case .yellow: OS1VisualStyle.yellowInk
            case .purple: OS1VisualStyle.purpleInk
            case .dim: OS1VisualStyle.textDim
            case .faint: OS1VisualStyle.textFaint
            }
        }
    }

    let text: String
    let tone: Tone
}

/// Builds the preview's fact strip. Pure, and separated from the view so the
/// editorial calls below (which fact is redundant, when a verdict is stale)
/// can be tested without a screen.
enum PrPreviewFacts {
    static func all(for session: Session) -> [PrPreviewFact] {
        guard let state = session.pullRequestContextState else { return [] }
        var facts = [stateFact(state)]
        if let checks = checksFact(session.prChecks, state: state) {
            facts.append(checks)
        }
        if let review = reviewFact(session.prReviewDecision, state: state) {
            facts.append(review)
        }
        if let osReview = session.prOsReview.flatMap(osReviewFact) {
            facts.append(osReview)
        }
        if let waiting = reviewersFact(session.prReviewRequested, state: state) {
            facts.append(waiting)
        }
        return facts
    }

    /// The state the row's menu is about to offer an action for, said in the
    /// same words the menu uses. `PullRequestContextState.label` already
    /// mirrors the web strip's precedence, so the preview and the item under
    /// it can never disagree.
    static func stateFact(_ state: Session.PullRequestContextState) -> PrPreviewFact {
        PrPreviewFact(text: state.label, tone: tone(for: state))
    }

    private static func tone(for state: Session.PullRequestContextState) -> PrPreviewFact.Tone {
        switch state {
        case .merged: .purple
        case .closed, .conflicts, .failing, .changesRequested: .red
        case .running: .yellow
        case .draft: .faint
        case .ready: .green
        }
    }

    /// The check rollup, worded as the web's `checksLabel` words it.
    ///
    /// Skipped when the state IS the check fact: "Checks failed · 2 failing"
    /// and "3 checks running · 3 running" spend the strip's width saying one
    /// thing twice. Skipped again once the PR is merged or closed, where CI is
    /// history rather than something to act on. Under any other state the
    /// rollup is evidence the state cannot give: it is what makes "Ready to
    /// merge" believable.
    static func checksFact(
        _ checks: PrChecksSummary?,
        state: Session.PullRequestContextState
    ) -> PrPreviewFact? {
        switch state {
        case .failing, .running, .merged, .closed: return nil
        default: break
        }
        guard let checks, let total = checks.total, total > 0 else { return nil }
        if let failed = checks.failed, failed > 0 {
            return PrPreviewFact(text: "\(failed) failing", tone: .red)
        }
        if let pending = checks.pending, pending > 0 {
            return PrPreviewFact(text: "\(pending) running", tone: .yellow)
        }
        return PrPreviewFact(text: "all \(total) passing", tone: .green)
    }

    /// A human approval. Only APPROVED is worth a phrase: "changes requested"
    /// is already the state, and "review required" is what every unreviewed PR
    /// says, so it would sit on every strip carrying nothing.
    static func reviewFact(
        _ decision: String?,
        state: Session.PullRequestContextState
    ) -> PrPreviewFact? {
        guard decision == "APPROVED", state != .merged, state != .closed else {
            return nil
        }
        return PrPreviewFact(text: "approved", tone: .green)
    }

    /// The automated review's score and verdict. The score stays directly in
    /// the compact reading, followed by blocking and stale context when
    /// present. A verdict the branch has moved past goes faint instead of
    /// lending stale news the weight of fresh news.
    static func osReviewFact(_ review: OsReviewSummary) -> PrPreviewFact? {
        guard let verdict = review.verdict else { return nil }
        let word = switch verdict {
        case "approve": "approved"
        case "request_changes": "changes requested"
        case "comment": "commented"
        default: "reviewed"
        }
        var parts = [String]()
        if let confidence = review.confidence {
            parts.append("\(confidence)/5")
        }
        parts.append(word)
        if let blocking = review.blocking, blocking > 0 {
            parts.append("\(blocking) blocking")
        }
        let stale = review.stale == true
        if stale { parts.append("stale") }
        let tone: PrPreviewFact.Tone = if stale {
            .faint
        } else {
            switch verdict {
            case "approve": .green
            case "request_changes": .red
            default: .dim
            }
        }
        return PrPreviewFact(text: parts.joined(separator: " · "), tone: tone)
    }

    /// Who the PR is waiting on. Two names is the most that fits before the
    /// phrase stops naming anyone in particular, so a longer list counts the
    /// rest instead of truncating a name to its first letters.
    static func reviewersFact(
        _ requested: [String]?,
        state: Session.PullRequestContextState
    ) -> PrPreviewFact? {
        guard state != .merged, state != .closed else { return nil }
        let people = (requested ?? []).filter { !$0.isEmpty }
        guard !people.isEmpty else { return nil }
        if people.count <= 2 {
            return PrPreviewFact(
                text: "awaiting \(people.joined(separator: ", "))",
                tone: .dim
            )
        }
        return PrPreviewFact(
            text: "awaiting \(people[0]), \(people[1]) +\(people.count - 2)",
            tone: .dim
        )
    }
}
