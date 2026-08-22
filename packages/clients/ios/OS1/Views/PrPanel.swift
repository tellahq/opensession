import SwiftUI

/// Toolbar chip for a session's PR: the number plus one status dot — merged /
/// closed / draft, or the check rollup while open. Tapping it opens PrPanelView.
struct PrChipLabel: View {
    let number: Int
    /// nil while only the sessions-list snapshot is known (details still
    /// loading) — the dot goes neutral rather than guessing a check state.
    let summary: PrDetails.Summary?

    var body: some View {
        HStack(spacing: 5) {
            Circle()
                .fill(summary.map { $0.color } ?? Color.secondary)
                .frame(width: 7, height: 7)
            Text(verbatim: "#\(number)")
                .font(.subheadline.weight(.semibold))
                .monospacedDigit()
        }
    }
}

extension PrDetails.Summary {
    var color: Color {
        switch self {
        case .merged: .purple
        case .closed: .red
        case .draft: .gray
        case .failing: .red
        case .pending: .orange
        case .passing: .green
        }
    }

    var label: String {
        switch self {
        case .merged: "Merged"
        case .closed: "Closed"
        case .draft: "Draft"
        case .failing: "Checks failing"
        case .pending: "Checks running"
        case .passing: "Open"
        }
    }
}

/// The exact server target for one PR in a multi-repo or stacked session.
struct SessionPrTarget: Equatable, Hashable {
    let repo: String
    let branch: String
}

/// A display row derived from the session snapshot. Keeping ordering and target
/// selection outside SwiftUI makes the primary-plus-additional contract easy
/// to verify without rendering a view.
struct SessionPrRow: Identifiable, Equatable {
    let target: SessionPrTarget
    let number: Int?
    let title: String?
    let state: String
    let url: URL?
    let isPrimary: Bool

    var id: SessionPrTarget { target }

    @MainActor
    var identityLabel: String {
        let repo = RepoTile.label(for: target.repo)
        return number.map { "\(repo) #\($0)" } ?? "\(repo) · \(target.branch)"
    }
}

@MainActor
enum SessionPrSeries {
    static func rows(for session: Session) -> [SessionPrRow] {
        let refs = session.prs ?? []
        let primaryIndex = refs.firstIndex { ref in
            ref.source == "primary"
                || (ref.repo == session.effectiveRepo && ref.branch == session.branch)
        }
        var ordered = refs
        if let primaryIndex, primaryIndex != 0 {
            ordered.insert(ordered.remove(at: primaryIndex), at: 0)
        }

        if primaryIndex == nil,
           let number = session.prNumber,
           let branch = session.branch,
           !branch.isEmpty {
            ordered.insert(
                SessionPrRef(
                    repo: session.effectiveRepo,
                    branch: branch,
                    source: "primary",
                    url: session.prUrl,
                    state: session.prState,
                    number: number,
                    isDraft: session.prIsDraft,
                    reviewDecision: session.prReviewDecision,
                    additions: session.prAdditions,
                    deletions: session.prDeletions,
                    checks: session.prChecks
                ),
                at: 0
            )
        }

        var seen: Set<SessionPrTarget> = []
        return ordered.compactMap { ref in
            let target = SessionPrTarget(repo: ref.repo, branch: ref.branch)
            guard seen.insert(target).inserted else { return nil }
            return SessionPrRow(
                target: target,
                number: ref.number,
                title: ref.title,
                state: stateLabel(for: ref),
                url: ref.url.flatMap(URL.init(string:))
                    ?? ref.number.flatMap {
                        PrLinks.githubURL(for: .init(repo: ref.repo, number: $0))
                    },
                isPrimary: ref.source == "primary"
                    || (ref.repo == session.effectiveRepo && ref.branch == session.branch)
            )
        }
    }

    static func destination(for row: SessionPrRow, sessionId: String) async -> URL? {
        if let url = row.url { return url }
        let details = try? await OS1API.pr(
            sessionId: sessionId,
            repo: row.target.repo,
            branch: row.target.branch
        )
        return details?.url.flatMap(URL.init(string:))
    }

    private static func stateLabel(for ref: SessionPrRef) -> String {
        if ref.state == "MERGED" { return "Merged" }
        if ref.state == "CLOSED" { return "Closed" }
        if ref.isDraft == true { return "Draft" }
        if (ref.checks?.failed ?? 0) > 0 { return "Checks failed" }
        if ref.reviewDecision == "CHANGES_REQUESTED" { return "Changes requested" }
        let pending = ref.checks?.pending ?? 0
        if pending > 0 { return "\(pending) check\(pending == 1 ? "" : "s") pending" }
        if ref.reviewDecision == "APPROVED" { return "Approved" }
        return "Open"
    }
}

/// Compact native rows for the PRs beyond the primary panel target.
struct SessionPrSeriesRows: View {
    let session: Session
    var includePrimary = false
    let open: (SessionPrRow) -> Void

    private var rows: [SessionPrRow] {
        SessionPrSeries.rows(for: session).filter { includePrimary || !$0.isPrimary }
    }

    var body: some View {
        ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
            if index > 0 { Divider().padding(.leading, 44) }
            Button { open(row) } label: {
                HStack(spacing: 10) {
                    Image(systemName: row.state == "Merged"
                        ? "arrow.triangle.merge"
                        : "arrow.triangle.pull")
                        .font(.callout.weight(.semibold))
                        .foregroundStyle(tint(for: row.state))
                        .frame(width: 22)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(verbatim: row.identityLabel)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(OS1VisualStyle.text)
                        if let title = row.title, !title.isEmpty {
                            Text(title)
                                .font(.caption)
                                .foregroundStyle(OS1VisualStyle.textDim)
                                .lineLimit(2)
                                .multilineTextAlignment(.leading)
                        }
                    }
                    Spacer(minLength: 8)
                    Text(row.state)
                        .font(.caption.weight(.medium))
                        .foregroundStyle(tint(for: row.state))
                        .multilineTextAlignment(.trailing)
                    Image(systemName: "arrow.up.right")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(OS1VisualStyle.textFaint)
                }
                .padding(.horizontal, 12)
                .frame(minHeight: 52)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(
                Text(verbatim: "\(row.identityLabel), \(row.state)")
            )
        }
    }

    private func tint(for state: String) -> Color {
        switch state {
        case "Merged": OS1VisualStyle.purple
        case "Closed", "Draft": OS1VisualStyle.textDim
        case "Checks failed", "Changes requested": OS1VisualStyle.red
        case let value where value.contains("pending"): OS1VisualStyle.yellow
        default: OS1VisualStyle.green
        }
    }
}

/// The PR details sheet: title, state and review badges, branch/line stats,
/// conflict warning, every check with its status, the reviewer list — and,
/// while the PR is open, the same three actions the web panel offers: submit a
/// review, merge, close.
struct PrPanelView: View {
    var viewModel: SessionViewModel
    /// How this is being shown. `.pushed` brings no chrome of its own: the
    /// navigation stack is already there, and the way out is the chevron (or
    /// the edge swipe) rather than a Done button.
    var chrome: Chrome = .sheet
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL

    /// The action in flight, if any. One at a time: the section disables while
    /// it runs, so this doubles as "which row shows the spinner". Reviewing has
    /// no entry here — the review sheet owns its own submit state.
    @State private var busy: PrAction?
    /// The server's own sentence when an action failed (a GitHub error, or
    /// "Connect your GitHub account…" when this person hasn't).
    @State private var actionError: String?
    @State private var reviewing = false
    /// Merge method awaiting confirmation — merging is the one action here
    /// that can't be taken back, so it always passes through a dialog.
    @State private var pendingMerge: String?
    @State private var confirmingClose = false
    @State private var slackShare: PrSlackShareRequest?
    /// Which of the canvas's two pages is showing. Two, not the six tabs this
    /// had before: everything countable about a pull request answers a
    /// question ("is it green?", "what landed?") rather than being a place you
    /// go, so it rolls up on the overview and the code gets a page of its own.
    @State private var page: Page = .overview
    /// Owned here because the tab row draws its control, beside the pages.
    @State private var lens: PrReviewCanvas.Lens = .all
    /// The rollups start closed: the overview is meant to be readable in one
    /// screen, and each of these is a question with a one-line answer.
    @State private var checksExpanded = false
    @State private var commitsExpanded = false
    @State private var filesExpanded = false

    enum Chrome { case sheet, pushed }

    enum PrAction { case merge, close }

    /// Overview is the conversation, the way the web's is: the description
    /// and every comment under each other. What the web keeps in the rail
    /// beside it has a page of its own here, because a phone has no beside.
    enum Page: Hashable, CaseIterable {
        case overview, files, info

        var label: String {
            switch self {
            case .overview: "Overview"
            case .files: "Files"
            case .info: "Info"
            }
        }
    }

    var body: some View {
        Group {
            switch chrome {
            case .sheet:
                NavigationStack {
                    titled(content)
                        .toolbar {
                            ToolbarItem(placement: .topTrailingCompat) {
                                Button("Done") { dismiss() }
                            }
                        }
                }
            case .pushed:
                titled(content)
            }
        }
        // Checks move fast while CI runs; re-fetch on open (server-cached).
        .task {
            await viewModel.refreshPr()
            #if DEBUG && os(iOS)
            if ProcessInfo.processInfo.environment["OS1_OPEN_PR_INFO"] == "1" {
                page = .info
            }
            #endif
        }
        .sheet(item: $slackShare) { request in
            PrSlackShareSheet(request: request)
        }
        #if os(macOS)
        .frame(minWidth: 460, minHeight: 540)
        #endif
    }

    /// The pull request names itself in the bar the platform already gives
    /// us: its title on the title line, and who and what state on the
    /// subtitle under it. A row of our own below the bar said the same things
    /// twice and cost a band of the screen on every page.
    ///
    /// `Text(verbatim:)`, not a bare interpolation: inferred as a
    /// LocalizedStringKey, "#\(number)" runs the number through the device's
    /// locale — #5555 renders "#5.555" anywhere that groups thousands.
    private func titled(_ view: some View) -> some View {
        view
            .navigationTitle(Text(verbatim: viewModel.prDetails?.title ?? "Pull request"))
            .navigationSubtitle(subtitle)
            .inlineTitleBarCompat()
    }

    /// `#5755 · Open · octocat`. Plain ink: a navigation subtitle styles
    /// itself, and a per-run colour on it is ignored — the state wears its
    /// colour on the Info page, where it has a row of its own.
    private var subtitle: Text {
        guard let pr = viewModel.prDetails else {
            return Text(verbatim: viewModel.session.repo ?? "")
        }
        var parts = ["#\(pr.number)", stateLabel(pr)]
        if let author = pr.author, !author.isEmpty { parts.append(author) }
        return Text(verbatim: parts.joined(separator: " · "))
    }

    @ViewBuilder
    private var content: some View {
        if let pr = viewModel.prDetails {
            VStack(spacing: 0) {
                // The chat's own tab idiom, at the top where the session
                // strip puts it, so the two surfaces read as one app.
                PillTabBar(
                    selection: $page,
                    items: [
                        .init(
                            value: .overview,
                            title: "Overview",
                            symbol: "text.bubble",
                            count: conversation(pr).count
                        ),
                        .init(
                            value: .files,
                            title: "Files",
                            symbol: "doc.plaintext",
                            count: pr.changedFiles ?? pr.files?.count
                        ),
                        .init(value: .info, title: "Info", symbol: "info.circle"),
                    ]
                )
                pages(pr)
            }
            .toolbar {
                // The code page's own controls, only where they apply.
                if page == .files {
                    ToolbarItem(placement: .topTrailingCompat) {
                        PrViewOptionsMenu(lens: $lens, showsDiffDisplay: lens != .flow)
                            .labelStyle(.iconOnly)
                    }
                }
                ToolbarItem(placement: .topTrailingCompat) { actionsMenu(pr) }
            }
            .sheet(isPresented: $reviewing) {
                PrReviewSheet(canMerge: pr.isOpen) { event, summary, mergeAfter in
                    try await viewModel.submitPrReview(event: event, summary: summary)
                    if mergeAfter { try await viewModel.mergePr() }
                }
            }
            .confirmationDialog(
                mergeConfirmTitle(pr),
                isPresented: Binding(
                    get: { pendingMerge != nil },
                    set: { if !$0 { pendingMerge = nil } }
                ),
                titleVisibility: .visible
            ) {
                Button(mergeButtonLabel(pendingMerge ?? "squash")) {
                    let method = pendingMerge ?? "squash"
                    pendingMerge = nil
                    run(.merge) { try await viewModel.mergePr(method: method) }
                }
                Button("Cancel", role: .cancel) { pendingMerge = nil }
            } message: {
                Text(mergeConfirmMessage(pr))
            }
            .confirmationDialog(
                "Close this pull request?",
                isPresented: $confirmingClose,
                titleVisibility: .visible
            ) {
                Button("Close pull request", role: .destructive) {
                    run(.close) { try await viewModel.closePr() }
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("The branch keeps its commits. You can reopen the pull request on GitHub.")
            }
        } else if viewModel.prLoadFailed {
            ContentUnavailableView {
                Label("Couldn't load the pull request", systemImage: "exclamationmark.triangle")
            } description: {
                Text("GitHub may be rate-limited. Try again in a moment.")
            } actions: {
                Button("Retry") { viewModel.loadPr() }
            }
        } else {
            let rows = SessionPrSeries.rows(for: viewModel.session)
            if rows.isEmpty {
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Pull requests")
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(OS1VisualStyle.textDim)
                            .padding(.horizontal, 4)
                        VStack(spacing: 0) {
                            SessionPrSeriesRows(
                                session: viewModel.session,
                                includePrimary: true
                            ) { row in
                                openPrRow(row)
                            }
                        }
                        .background(
                            OS1VisualStyle.raised,
                            in: RoundedRectangle(cornerRadius: 14, style: .continuous)
                        )
                    }
                    .padding(16)
                }
                .background(OS1VisualStyle.background)
            }
        }
    }

    // MARK: - Identity

    private func stateSymbol(_ pr: PrDetails) -> String {
        switch pr.state ?? "" {
        case "MERGED": "arrow.triangle.merge"
        case "CLOSED": "xmark"
        default: pr.isDraft == true ? "circle.dashed" : "arrow.triangle.pull"
        }
    }

    private func stateLabel(_ pr: PrDetails) -> String {
        switch pr.state ?? "" {
        case "MERGED": "Merged"
        case "CLOSED": "Closed"
        default: pr.isDraft == true ? "Draft" : "Open"
        }
    }

    /// The three pages, swipeable between: a phone reader moving between the
    /// conversation and the code should be able to do it with a thumb, not
    /// only by aiming at a pill.
    @ViewBuilder
    private func pages(_ pr: PrDetails) -> some View {
        #if os(iOS)
        TabView(selection: $page) {
            overviewPage(pr).tag(Page.overview)
            PrReviewCanvas(viewModel: viewModel, lens: $lens).tag(Page.files)
            infoPage(pr).tag(Page.info)
        }
        .tabViewStyle(.page(indexDisplayMode: .never))
        #else
        switch page {
        case .overview: overviewPage(pr)
        case .files: PrReviewCanvas(viewModel: viewModel, lens: $lens)
        case .info: infoPage(pr)
        }
        #endif
    }

    // MARK: - Info

    /// How the pull request stands: who is on it, what ran, what landed, what
    /// changed. On the web this is the rail beside the conversation; a phone
    /// has no beside, so it is a page you go to for the numbers.
    ///
    /// Groups are cards on a tinted page rather than rows on a flat one. Each
    /// carries its label and the one-line answer ABOVE it, so the page can be
    /// read down the left edge — label, answer, detail — instead of as one
    /// long list where every line has the same weight.
    private func infoPage(_ pr: PrDetails) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                pullRequestsGroup
                statusGroup(pr)
                reviewersGroup(pr)
                checksGroup(pr)
                commitsGroup(pr)
                filesGroup(pr)
            }
            .padding(16)
        }
        .background(OS1VisualStyle.background)
        .refreshable { await viewModel.refreshPr() }
    }

    @ViewBuilder
    private var pullRequestsGroup: some View {
        let rows = SessionPrSeries.rows(for: viewModel.session).filter { !$0.isPrimary }
        if !rows.isEmpty {
            infoGroup(
                "Related pull requests",
                answer: Text("\(rows.count)").foregroundColor(OS1VisualStyle.textDim)
            ) {
                SessionPrSeriesRows(session: viewModel.session) { row in
                    openPrRow(row)
                }
            }
        }
    }

    private func openPrRow(_ row: SessionPrRow) {
        Task {
            guard let url = await SessionPrSeries.destination(
                for: row,
                sessionId: viewModel.session.id
            ) else { return }
            openURL(url)
        }
    }

    /// One group: its label and answer, then a card of rows.
    private func infoGroup(
        _ title: String,
        answer: Text? = nil,
        @ViewBuilder rows: () -> some View
    ) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Text(title)
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(OS1VisualStyle.textDim)
                Spacer(minLength: 8)
                answer?.font(.footnote.weight(.semibold))
            }
            .padding(.horizontal, 4)
            VStack(spacing: 0) { rows() }
                .background(
                    OS1VisualStyle.raised,
                    in: RoundedRectangle(cornerRadius: 14, style: .continuous)
                )
        }
    }

    /// A row inside a card, with the hairline that separates it from the next.
    private func infoRow(
        _ label: String,
        value: String,
        tint: Color? = nil,
        last: Bool = false
    ) -> some View {
        VStack(spacing: 0) {
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                Text(label)
                    .font(.subheadline)
                    .foregroundStyle(OS1VisualStyle.textDim)
                Spacer(minLength: 8)
                Text(value)
                    .font(.subheadline)
                    .foregroundStyle(tint ?? OS1VisualStyle.text)
                    .multilineTextAlignment(.trailing)
                    .lineLimit(2)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 11)
            if !last { Divider().padding(.leading, 14) }
        }
    }

    /// The button that opens the rest of a group, on the card's own last row.
    private func moreRow(_ title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack {
                Text(title)
                    .font(.subheadline)
                    .foregroundStyle(Color.accentColor)
                Spacer()
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 11)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder
    private func statusGroup(_ pr: PrDetails) -> some View {
        infoGroup(
            "Status",
            answer: Text(stateLabel(pr)).foregroundColor(pr.summary.color)
        ) {
            if let head = pr.headRefName { infoRow("Branch", value: head) }
            if let base = pr.baseRefName { infoRow("Into", value: base) }
            if pr.mergeable == "CONFLICTING" {
                infoRow(
                    "Merge",
                    value: "Conflicts with \(pr.baseRefName ?? "the base")",
                    tint: OS1VisualStyle.yellowInk,
                    last: reviewBadge(pr.reviewDecision) == nil
                )
            } else if pr.isOpen {
                infoRow(
                    "Merge",
                    value: "No conflicts",
                    tint: OS1VisualStyle.greenInk,
                    last: reviewBadge(pr.reviewDecision) == nil
                )
            }
            if let decision = reviewBadge(pr.reviewDecision) {
                infoRow("Review", value: decision.label, tint: decision.color, last: true)
            }
            if let error = actionError {
                Text(error)
                    .font(.footnote)
                    .foregroundStyle(OS1VisualStyle.redInk)
                    .padding(.horizontal, 14)
                    .padding(.bottom, 11)
            }
        }
    }

    @ViewBuilder
    private func reviewersGroup(_ pr: PrDetails) -> some View {
        if let reviewers = pr.reviewers, !reviewers.isEmpty {
            infoGroup("Reviewers") {
                ForEach(Array(reviewers.enumerated()), id: \.offset) { index, reviewer in
                    infoRow(
                        reviewer.isTeam == true ? "@\(reviewer.login)" : reviewer.login,
                        value: reviewerBadge(reviewer.state)?.label ?? "",
                        tint: reviewerBadge(reviewer.state)?.color,
                        last: index == reviewers.count - 1
                    )
                }
            }
        }
    }

    /// Checks, worst first: a card of green rows tells you nothing, and the
    /// one that failed is the reason you opened this.
    @ViewBuilder
    private func checksGroup(_ pr: PrDetails) -> some View {
        let checks = (pr.checks ?? []).sorted { rank($0) < rank($1) }
        if !checks.isEmpty {
            let shown = checksExpanded ? checks : Array(checks.prefix(4))
            let more = checks.count > shown.count || checksExpanded
            infoGroup(
                "Checks",
                answer: Text(checksHeader(checks))
                    .foregroundColor(checkTone(checksRank(checks)))
            ) {
                ForEach(Array(shown.enumerated()), id: \.offset) { index, check in
                    let isLast = !more && index == shown.count - 1
                    VStack(spacing: 0) {
                        Group {
                            if let url = check.url.flatMap(URL.init) {
                                Link(destination: url) { checkRow(check) }
                            } else {
                                checkRow(check)
                            }
                        }
                        // Rows in this card all breathe the same: the check
                        // row was drawn for a List, which supplied its own.
                        .padding(.horizontal, 14)
                        .padding(.vertical, 11)
                        if !isLast { Divider().padding(.leading, 14) }
                    }
                    .background(checkRowTint(check.rank))
                }
                if more {
                    moreRow(checksExpanded ? "Show fewer" : "Show all \(checks.count)") {
                        checksExpanded.toggle()
                    }
                }
            }
        }
    }

    /// What to show first: what went wrong, then what is still going, then
    /// what passed. Skipped sorts last — four grey rows are the least
    /// informative thing a run can say about itself.
    private func rank(_ check: PrCheck) -> Int {
        switch check.rank {
        case .failure: 0
        case .pending: 1
        case .success: 2
        case .neutral: 3
        }
    }

    private func checkTone(_ rank: PrCheck.Rank) -> Color {
        switch rank {
        case .failure: OS1VisualStyle.redInk
        case .pending: OS1VisualStyle.yellowInk
        case .success: OS1VisualStyle.greenInk
        case .neutral: OS1VisualStyle.textDim
        }
    }

    private func checksRank(_ checks: [PrCheck]) -> PrCheck.Rank {
        let ranks = checks.map(\.rank)
        if ranks.contains(.failure) { return .failure }
        if ranks.contains(.pending) { return .pending }
        return .success
    }

    private func checksHeader(_ checks: [PrCheck]) -> String {
        let passed = checks.filter { $0.rank == .success }.count
        if checks.contains(where: { $0.rank == .failure }) {
            let failed = checks.filter { $0.rank == .failure }.count
            return "\(failed) failed"
        }
        if checks.contains(where: { $0.rank == .pending }) { return "Running" }
        // Not "all \(passed) passed" when some were skipped: a count here
        // would disagree with the rows it opens.
        return passed == checks.count ? "All \(passed) passed" : "All passed"
    }

    @ViewBuilder
    private func commitsGroup(_ pr: PrDetails) -> some View {
        if let commits = pr.commits, !commits.isEmpty {
            let shown = commitsExpanded ? commits : Array(commits.prefix(3))
            let more = commits.count > shown.count || commitsExpanded
            infoGroup(
                "Commits",
                answer: Text("\(commits.count)").foregroundColor(OS1VisualStyle.textDim)
            ) {
                ForEach(Array(shown.enumerated()), id: \.offset) { index, commit in
                    VStack(spacing: 0) {
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(commit.messageHeadline ?? commit.shortOid)
                                    .font(.subheadline)
                                    .foregroundStyle(OS1VisualStyle.text)
                                    .lineLimit(2)
                                if let author = commit.author, !author.isEmpty {
                                    Text(author)
                                        .font(.caption2)
                                        .foregroundStyle(OS1VisualStyle.textDim)
                                }
                            }
                            Spacer(minLength: 8)
                            Text(commit.shortOid)
                                .font(.caption.monospaced())
                                .foregroundStyle(OS1VisualStyle.textDim)
                        }
                        .padding(.horizontal, 14)
                        .padding(.vertical, 11)
                        if more || index < shown.count - 1 {
                            Divider().padding(.leading, 14)
                        }
                    }
                }
                if more {
                    moreRow(commitsExpanded ? "Show fewer" : "Show all \(commits.count)") {
                        commitsExpanded.toggle()
                    }
                }
            }
        }
    }

    /// What changed, by size. Tapping one crosses to the code page, where the
    /// same file is already open — the info page never loads a patch of its own.
    @ViewBuilder
    private func filesGroup(_ pr: PrDetails) -> some View {
        if let files = pr.files, !files.isEmpty {
            let shown = filesExpanded ? files : Array(files.prefix(5))
            let more = files.count > shown.count || filesExpanded
            infoGroup(
                "Files",
                answer: Text("+\(pr.additions ?? 0) −\(pr.deletions ?? 0)")
                    .foregroundColor(OS1VisualStyle.textDim)
            ) {
                ForEach(Array(shown.enumerated()), id: \.offset) { index, file in
                    Button {
                        page = .files
                        Haptics.play(.selection)
                    } label: {
                        VStack(spacing: 0) {
                            HStack(spacing: 8) {
                                Text(file.path)
                                    .font(.footnote)
                                    .foregroundStyle(OS1VisualStyle.text)
                                    .lineLimit(1)
                                    .truncationMode(.head)
                                Spacer(minLength: 8)
                                Text("+\(file.additions ?? 0)")
                                    .font(.caption2.monospaced())
                                    .foregroundStyle(OS1VisualStyle.greenInk)
                                Text("−\(file.deletions ?? 0)")
                                    .font(.caption2.monospaced())
                                    .foregroundStyle(OS1VisualStyle.redInk)
                            }
                            .padding(.horizontal, 14)
                            .padding(.vertical, 11)
                            if more || index < shown.count - 1 {
                                Divider().padding(.leading, 14)
                            }
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
                if more {
                    moreRow(filesExpanded ? "Show fewer" : "Show all \(files.count)") {
                        filesExpanded.toggle()
                    }
                }
            }
        }
    }

    /// The description, then the discussion. Machine bookkeeping (a comment
    /// that is only a hidden marker, a superseded automated review) is not
    /// discussion, so it never reaches the feed.
    private func conversation(_ pr: PrDetails) -> [PrComment] {
        (pr.comments ?? []).filter(\.isDiscussion)
    }

    /// The conversation, and nothing else: the description, then every comment
    /// under it. This is the page the web's Overview is — a feed you read from
    /// the top — rather than a summary of counts, which is what Info holds.
    private func overviewPage(_ pr: PrDetails) -> some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 12) {
                descriptionCard(pr)
                let comments = conversation(pr)
                if comments.isEmpty {
                    Text("No comments yet.")
                        .font(.footnote)
                        .foregroundStyle(OS1VisualStyle.textDim)
                        .frame(maxWidth: .infinity, alignment: .center)
                        .padding(.vertical, 24)
                } else {
                    ForEach(Array(comments.enumerated()), id: \.offset) { _, comment in
                        commentCard(comment)
                    }
                }
            }
            .padding(16)
        }
        .background(OS1VisualStyle.background)
        .refreshable { await viewModel.refreshPr() }
    }

    @ViewBuilder
    private func descriptionCard(_ pr: PrDetails) -> some View {
        let body = (pr.body ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        conversationCard(
            author: pr.author,
            subtitle: "Opened this pull request",
            when: nil
        ) {
            if body.isEmpty {
                Text("This pull request has no description.")
                    .font(.footnote)
                    .foregroundStyle(OS1VisualStyle.textDim)
            } else {
                PrMarkdownBody(text: body, repo: viewModel.session.repo)
            }
        }
    }

    private func commentCard(_ comment: PrComment) -> some View {
        conversationCard(
            author: comment.author,
            subtitle: nil,
            when: Session.parseISO(comment.createdAt)
        ) {
            PrMarkdownBody(text: comment.discussionBody, repo: viewModel.session.repo)
        }
    }

    /// One card in the feed: who wrote it, when, and what they said.
    private func conversationCard(
        author: String?,
        subtitle: String?,
        when: Date?,
        @ViewBuilder content: () -> some View
    ) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                UserAvatar(person: author ?? "?", size: 24)
                VStack(alignment: .leading, spacing: 1) {
                    Text(author ?? "Unknown")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(OS1VisualStyle.text)
                        .lineLimit(1)
                    if let subtitle {
                        Text(subtitle)
                            .font(.caption2)
                            .foregroundStyle(OS1VisualStyle.textDim)
                    }
                }
                Spacer(minLength: 8)
                if let when {
                    Text(when.formatted(.relative(presentation: .numeric)))
                        .font(.caption2)
                        .foregroundStyle(OS1VisualStyle.textDim)
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            Divider()
            content()
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(14)
        }
        .background(
            OS1VisualStyle.raised,
            in: RoundedRectangle(cornerRadius: 14, style: .continuous)
        )
    }

    /// Review, merge, close and the ways out, on one control. The web keeps
    /// the same set behind the header's caret.
    @ViewBuilder
    private func actionsMenu(_ pr: PrDetails) -> some View {
        Menu {
            if pr.isOpen {
                Button {
                    actionError = nil
                    reviewing = true
                } label: {
                    Label("Review", systemImage: "checkmark.bubble")
                }
                Menu {
                    Button("Squash and merge") { pendingMerge = "squash" }
                    Button("Create a merge commit") { pendingMerge = "merge" }
                    Button("Rebase and merge") { pendingMerge = "rebase" }
                } label: {
                    Label("Merge", systemImage: "arrow.triangle.merge")
                }
            }
            Section {
                if let preview = pr.staging?.url.flatMap(URL.init) {
                    Link(destination: preview) {
                        Label("Open the preview", systemImage: "globe")
                    }
                }
                if let url = pr.url.flatMap(URL.init) {
                    Link(destination: url) {
                        Label("Open on GitHub", systemImage: "arrow.up.right")
                    }
                    Button {
                        copyToPasteboard(url.absoluteString)
                        Haptics.play(.selection)
                    } label: {
                        Label("Copy GitHub link", systemImage: "doc.on.doc")
                    }
                    Button {
                        slackShare = PrSlackShareRequest(
                            title: pr.title ?? "PR #\(pr.number)",
                            url: url,
                            sessionId: viewModel.session.id,
                            repo: viewModel.session.repo,
                            branch: viewModel.session.branch,
                            merged: pr.state == "MERGED",
                            walkthroughSummary: viewModel.session.walkthrough?.summary,
                            suggestedScreenshot: viewModel.session.walkthrough?.shots?
                                .first { $0.after != nil }?.after
                                ?? ShippedChangeMedia.latestScreenshot(in: viewModel.entries)
                        )
                    } label: {
                        Label("Share to Slack", systemImage: "paperplane")
                    }
                }
            }
            if pr.isOpen {
                Section {
                    Button(role: .destructive) {
                        actionError = nil
                        confirmingClose = true
                    } label: {
                        Label("Close pull request", systemImage: "xmark.circle")
                    }
                }
            }
        } label: {
            if busy != nil {
                ProgressView().controlSize(.small)
            } else {
                Label("Pull request actions", systemImage: "ellipsis.circle")
            }
        }
        .disabled(busy != nil)
    }

    /// Run one action, keeping its failure in the panel: the server answers a
    /// refusal (conflicts, a stack layer still open, no GitHub credential) with
    /// a sentence meant for a person, so show that rather than a status code.
    private func run(_ action: PrAction, _ work: @escaping () async throws -> Void) {
        guard busy == nil else { return }
        busy = action
        actionError = nil
        Task {
            do {
                try await work()
            } catch {
                actionError = (error as? LocalizedError)?.errorDescription
                    ?? error.localizedDescription
            }
            busy = nil
        }
    }

    private func mergeButtonLabel(_ method: String) -> String {
        switch method {
        case "merge": "Create a merge commit"
        case "rebase": "Rebase and merge"
        default: "Squash and merge"
        }
    }

    private func mergeConfirmTitle(_ pr: PrDetails) -> String {
        "Merge PR #\(pr.number)?"
    }

    /// Name what a merge would land on top of. GitHub is the authority — the
    /// server doesn't pre-empt it — so these are warnings, not blocks.
    private func mergeConfirmMessage(_ pr: PrDetails) -> String {
        var warnings: [String] = []
        if pr.mergeable == "CONFLICTING" { warnings.append("it has conflicts") }
        if (pr.checks ?? []).contains(where: { $0.rank == .failure }) {
            warnings.append("checks are failing")
        } else if (pr.checks ?? []).contains(where: { $0.rank == .pending }) {
            warnings.append("checks are still running")
        }
        if pr.isDraft == true { warnings.append("it's still a draft") }
        if pr.reviewDecision == "CHANGES_REQUESTED" {
            warnings.append("changes were requested")
        }
        let base = pr.baseRefName ?? "the base branch"
        guard !warnings.isEmpty else { return "This merges into \(base)." }
        return "This merges into \(base) even though \(warnings.joined(separator: ", "))."
    }

    private func checkRow(_ check: PrCheck) -> some View {
        HStack(spacing: 10) {
            checkIcon(check.rank)
            VStack(alignment: .leading, spacing: 1) {
                Text(check.name)
                    .font(.subheadline)
                    .lineLimit(1)
                if let workflow = check.workflowName, !workflow.isEmpty {
                    Text(workflow)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 8)
            if let duration = checkDuration(check) {
                Text(duration)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
            }
        }
    }
    /// Nil for a check that is fine. See `OS1VisualStyle.checkRowFailure` for
    /// why only the rows that want something are painted.
    private func checkRowTint(_ rank: PrCheck.Rank) -> Color? {
        switch rank {
        case .failure: OS1VisualStyle.checkRowFailure
        case .pending: OS1VisualStyle.checkRowPending
        case .success, .neutral: nil
        }
    }
    @ViewBuilder
    private func checkIcon(_ rank: PrCheck.Rank) -> some View {
        // The app's own status palette, not SwiftUI's stock green/red/orange:
        // the same five colours mean the same five things everywhere else in
        // both apps, and the stock ones render a different hue per platform.
        switch rank {
        case .success:
            Image(systemName: "checkmark.circle.fill")
                .foregroundStyle(OS1VisualStyle.green)
        case .failure:
            Image(systemName: "xmark.circle.fill")
                .foregroundStyle(OS1VisualStyle.red)
        case .pending:
            Image(systemName: "clock.fill")
                .foregroundStyle(OS1VisualStyle.yellow)
        case .neutral:
            Image(systemName: "minus.circle").foregroundStyle(.secondary)
        }
    }

    // MARK: - Small pieces

    private func badge(_ text: String, color: Color) -> some View {
        Text(text)
            .font(.caption.weight(.semibold))
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(color.opacity(0.14), in: Capsule())
            .foregroundStyle(color)
    }

    private func metaText(_ text: String) -> some View {
        Text(text)
            .font(.footnote)
            .foregroundStyle(.secondary)
    }

    private func reviewBadge(_ decision: String?) -> (label: String, color: Color)? {
        switch decision ?? "" {
        case "APPROVED": ("Approved", .green)
        case "CHANGES_REQUESTED": ("Changes requested", .red)
        case "REVIEW_REQUIRED": ("Review required", .orange)
        default: nil
        }
    }

    private func reviewerBadge(_ state: String?) -> (label: String, color: Color)? {
        switch state ?? "" {
        case "APPROVED": ("Approved", .green)
        case "CHANGES_REQUESTED": ("Changes requested", .red)
        case "COMMENTED": ("Commented", .secondary)
        case "DISMISSED": ("Dismissed", .secondary)
        case "PENDING": ("Requested", .orange)
        default: nil
        }
    }

    private func checkDuration(_ check: PrCheck) -> String? {
        guard let started = Session.parseISO(check.startedAt),
              let completed = Session.parseISO(check.completedAt) else { return nil }
        let secs = Int(completed.timeIntervalSince(started).rounded())
        guard secs > 0 else { return nil }
        if secs < 60 { return "\(secs)s" }
        return "\(Int((Double(secs) / 60).rounded()))m"
    }
}

/// Submit a review: the event, an optional summary, and — approving — the web
/// panel's "merge right after" shortcut, which is what a phone review usually
/// wants (approve and land it, without a second trip into the panel).
///
/// A failure keeps the sheet open with the text intact; only a success
/// dismisses, since a review body is real typing to lose.
private struct PrReviewSheet: View {
    /// False once the PR can no longer be merged — hides the shortcut.
    var canMerge: Bool
    var submit: (String, String, Bool) async throws -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var event = "APPROVE"
    @State private var summary = ""
    @State private var mergeAfter = false
    @State private var submitting = false
    @State private var errorText: String?
    @FocusState private var summaryFocused: Bool

    /// GitHub takes a bare approval, but a comment or a change request with no
    /// body is nothing to post — the server refuses it too.
    private var canSubmit: Bool {
        event == "APPROVE"
            || !summary.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("Review", selection: $event) {
                        Text("Approve").tag("APPROVE")
                        Text("Request changes").tag("REQUEST_CHANGES")
                        Text("Comment").tag("COMMENT")
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()
                }
                Section("Summary") {
                    TextEditor(text: $summary)
                        .frame(minHeight: 120)
                        .focused($summaryFocused)
                        .overlay(alignment: .topLeading) {
                            if summary.isEmpty {
                                Text(event == "APPROVE" ? "Optional" : "Required")
                                    .foregroundStyle(.tertiary)
                                    .padding(.top, 8)
                                    .allowsHitTesting(false)
                            }
                        }
                }
                if canMerge && event == "APPROVE" {
                    Section {
                        Toggle("Squash and merge after approving", isOn: $mergeAfter)
                    }
                }
                if let errorText {
                    Section {
                        Text(errorText).foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle("Review")
            .inlineTitleBarCompat()
            .toolbar {
                ToolbarItem(placement: .topLeadingCompat) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .topTrailingCompat) {
                    if submitting {
                        ProgressView().controlSize(.small)
                    } else {
                        Button("Submit") { send() }
                            .disabled(!canSubmit)
                    }
                }
            }
            .disabled(submitting)
        }
        #if os(macOS)
        .frame(minWidth: 420, minHeight: 420)
        #endif
    }

    private func send() {
        guard !submitting else { return }
        // On the tap, not on the result: the sheet dismisses itself the moment
        // the submit returns, and a review that fails says so in words.
        Haptics.play(.send)
        submitting = true
        errorText = nil
        summaryFocused = false
        let payload = (event, summary, mergeAfter && event == "APPROVE" && canMerge)
        Task {
            do {
                try await submit(payload.0, payload.1, payload.2)
                dismiss()
            } catch {
                errorText = (error as? LocalizedError)?.errorDescription
                    ?? error.localizedDescription
            }
            submitting = false
        }
    }
}
