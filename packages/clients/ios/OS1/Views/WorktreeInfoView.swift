import SwiftUI

#if os(iOS)
import AVFoundation
import AVKit
import ImageIO
import UIKit

/// The chat's overview page, opened from its title. Pushed onto the stack
/// the conversation is on, like a messaging app's contact page, so the
/// chevron and the edge swipe come back to the chat. A host that presents it
/// on its own (the sidebar row's menu) wraps it in a stack and asks for a
/// close button.
struct WorktreeInfoView: View {
    @Bindable var viewModel: SessionViewModel
    let sessions: [Session]
    let catalog: ModelCatalog?
    /// Draw a close button: set when this is a sheet rather than a push.
    var showsClose = false

    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    /// A detail of this session opened one level deeper than this page: its
    /// assets, one of those files, its pull request. Pushed on the same
    /// stack, so the chevron comes back here rather than to the chat.
    @State private var panel: SessionPanel?
    @State private var gitStatus: OS1API.GitStatus?
    @State private var diff: OS1API.SessionDiff?
    @State private var assets: [OS1API.SessionAsset] = []
    @State private var overview: OS1API.WorkspaceOverview?
    @State private var conversationImage: WorkspaceImageSelection?
    @State private var conversationVideo: OS1API.WorkspaceOverview.Media?
    #if DEBUG
    /// Lets the native capture tool reach this tap-only viewer on a simulator.
    @State private var didOpenImageForCapture = false
    #endif
    @State private var sandboxStatus: SessionSandboxStatus?
    @State private var sandboxLoading = false
    @State private var sandboxAction: SessionSandboxAction?
    @State private var sandboxError: String?
    @State private var confirmingSandboxRecreate = false
    @State private var sandboxMove = SandboxMoveViewModel()
    /// A move lands before the sessions poll carries it back; held here and
    /// read through `currentSession` until the polled row agrees, so the
    /// Sandbox section says Preparing the moment the server does.
    @State private var attachedSandbox: SessionSandbox?
    @State private var loading = true
    @State private var loadFailed = false
    @State private var repos: [OS1API.RepoInfo] = []
    @State private var repoSwitchable = false
    @State private var repoHasWork = false
    @State private var switchingRepo: String?
    @State private var confirmRepoTarget: String?
    @State private var switchError: String?
    /// A switch lands before the 5s sessions poll carries it back, so the
    /// answer is held here and read through `currentSession` until the polled
    /// row agrees. Without it the page keeps showing the repo just left.
    @State private var switchedRepo: OS1API.SwitchedRepo?
    /// Account pools as this device last fetched them, for the Speed row.
    @State private var accountPools = SettingsAPI.cachedProviderAccountPools()
    /// The merge method waiting on its confirmation, from the merge card.
    @State private var pendingMerge: String?
    /// How the slide merges; picked from the menu beside the branches.
    @State private var mergeMethod = "squash"
    @State private var merging = false
    @State private var mergeError: String?

    var body: some View {
        ScrollViewReader { proxy in
        ScrollView {
            // Ordered by what the page is opened to find out: what this
            // workspace is doing and what came out of it. The worktree's
            // own metadata — branch, path, mode — changes once and is
            // reference material, so it sits below the answer rather than
            // filling the first screen with it.
            // The top answers "can this ship?": the title and its state,
            // the pull request with its one action, where it is deployed,
            // and what it looks like. Everything else is reference below.
            LazyVStack(alignment: .leading, spacing: 22) {
                hero
                mergeSection
                deploymentsSection
                demosSection
                overviewSection
                reviewSection
                    .id("review")
                pullRequestSection
                workSection
                assetsSection
                worktreeSection
                sandboxSection
                    .id("sandbox")
                runtimeSection
                    .id("runtime")
                runnerSection
                runSettingsSection
                    .id("run-settings")
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 28)
        }
        #if DEBUG
        // `OS1_SCROLL_TO=review|sandbox|runtime|run-settings` brings a section below the fold
        // into the capture tool's screenshot once the page has loaded.
        .onChange(of: scrollToForCapture) { _, target in
            guard let target else { return }
            withAnimation(nil) { proxy.scrollTo(target, anchor: .top) }
        }
        #endif
        }
        .background(OS1VisualStyle.background)
        // The page carries its own large title, so the bar is only its
        // floating buttons. The title still names the back button of
        // anything pushed from here.
        .navigationTitle("Overview")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(.hidden, for: .navigationBar)
        .toolbar {
            ToolbarItem(placement: .principal) { Color.clear.frame(width: 1, height: 1) }
            if showsClose {
                ToolbarItem(placement: .cancellationAction) {
                    Button { dismiss() } label: {
                        Image(systemName: "xmark")
                    }
                    .accessibilityLabel("Close")
                }
            }
            if let url = viewModel.prDetails?.url.flatMap(URL.init(string:)) {
                ToolbarItem(placement: .primaryAction) {
                    ShareLink(item: url) {
                        Image(systemName: "square.and.arrow.up")
                    }
                    .accessibilityLabel("Share pull request")
                }
            }
        }
        .confirmationDialog(
            mergeConfirmationTitle,
            isPresented: Binding(
                get: { pendingMerge != nil },
                set: { if !$0 { pendingMerge = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button(Self.mergeButtonLabel(pendingMerge ?? "squash")) {
                merge(method: pendingMerge ?? "squash")
            }
            Button("Cancel", role: .cancel) { pendingMerge = nil }
        } message: {
            Text(mergeConfirmationMessage)
        }
        .alert(
            "Couldn’t merge pull request",
            isPresented: Binding(
                get: { mergeError != nil },
                set: { if !$0 { mergeError = nil } }
            )
        ) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(mergeError ?? "Please try again.")
        }
        .task(id: loadIdentity) { await load() }
        .refreshable { await refresh() }
        .onChange(of: viewModel.isRunning) { wasRunning, isRunning in
            if wasRunning && !isRunning {
                // The completed turn may have produced conversation media
                // and assets as well as worktree changes.
                Task { await load() }
            }
        }
        .navigationDestination(item: $panel) { panel in
            SessionPanelView(panel: panel, viewModel: viewModel)
        }
        .fullScreenCover(item: $conversationImage) { selection in
            // Opened from the overview page, so the viewer keeps saying
            // which workspace the picture belongs to.
            FullScreenImagePreview(
                items: conversationImageGallery,
                index: selection.index,
                title: workspaceTitle
            )
        }
        .fullScreenCover(item: $conversationVideo) { media in
            WorkspaceVideoPreview(media: media)
        }
        .confirmationDialog(
            "Recreate this sandbox?",
            isPresented: $confirmingSandboxRecreate,
            titleVisibility: .visible
        ) {
            Button("Recreate sandbox", role: .destructive) {
                Task { await performSandboxAction(.recreate) }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Unpushed files that exist only inside this sandbox will be deleted.")
        }
        .alert(
            "Couldn't update sandbox",
            isPresented: Binding(
                get: { sandboxError != nil },
                set: { if !$0 { sandboxError = nil } }
            )
        ) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(sandboxError ?? "Please try again.")
        }
        .sandboxMovePrompts(sandboxMove, onMoved: adoptSandboxMove)
        .confirmationDialog(
            "Switch repository?",
            isPresented: Binding(
                get: { confirmRepoTarget != nil },
                set: { if !$0 { confirmRepoTarget = nil } }
            ),
            titleVisibility: .visible,
            presenting: confirmRepoTarget
        ) { target in
            Button("Switch to \(RepoTile.label(for: target))") {
                Task { await switchRepo(to: target) }
            }
            Button("Cancel", role: .cancel) {}
        } message: { target in
            Text(repoSwitchWarning(target: target))
        }
        .alert(
            "Couldn't switch repository",
            isPresented: Binding(
                get: { switchError != nil },
                set: { if !$0 { switchError = nil } }
            )
        ) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(switchError ?? "Please try again.")
        }
    }

    /// The page's title block, left-aligned like a document: the name, then
    /// what state it is in as pills, then where it runs.
    private var hero: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(currentSession.displayTitle)
                .font(.largeTitle.weight(.bold))
                .foregroundStyle(OS1VisualStyle.text)
                .multilineTextAlignment(.leading)
                .fixedSize(horizontal: false, vertical: true)
            FlowLayout(spacing: 8) {
                if let stateLabel {
                    HStack(spacing: 5) {
                        Label(stateLabel.text, systemImage: stateLabel.icon)
                        // The state alone can't say whether this started a
                        // minute ago or an hour ago.
                        if viewModel.isRunning, let since = viewModel.runStartedAt {
                            Text("·").foregroundStyle(stateLabel.color.opacity(0.6))
                            RunElapsedLabel(since: since)
                        }
                    }
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(stateLabel.color)
                    .padding(.horizontal, 11)
                    .padding(.vertical, 6)
                    .background(stateLabel.color.opacity(0.12), in: Capsule())
                }
                if let diff, diff.totalAdditions + diff.totalDeletions > 0 {
                    Button {
                        panel = .changes(sessionId: currentSession.id)
                    } label: {
                        HStack(spacing: 6) {
                            Text(verbatim: "+\(diff.totalAdditions)")
                                .foregroundStyle(OS1VisualStyle.greenInk)
                            Text(verbatim: "−\(diff.totalDeletions)")
                                .foregroundStyle(OS1VisualStyle.redInk)
                        }
                        .font(.subheadline.weight(.semibold).monospacedDigit())
                        .padding(.horizontal, 11)
                            .padding(.vertical, 6)
                            .background(OS1VisualStyle.raised, in: Capsule())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Open changes")
                }
            }
            Text(heroSubtitle)
                .font(.subheadline)
                .foregroundStyle(OS1VisualStyle.textDim)
            if let heroFooter {
                Text(heroFooter)
                    .font(.caption)
                    .foregroundStyle(OS1VisualStyle.textFaint)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.top, 4)
    }

    /// The line under the state: how long ago this stopped, what is queued
    /// behind it, how many sessions share the worktree. Written as wrapping
    /// text rather than a row of pills on purpose — pills are intrinsically
    /// sized, and at accessibility type a row of them is wider than the
    /// scroll view, which centres the overflow and clips every sibling.
    private var heroFooter: String? {
        var parts: [String] = []
        if !viewModel.isRunning, let last = latestActivity {
            parts.append("Updated \(Self.ago(Date().timeIntervalSince(last)))")
        }
        let queued = viewModel.queuedCount
        if queued > 0 { parts.append("\(queued) queued") }
        if sessions.count > 1 { parts.append("\(sessions.count) sessions") }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    private var latestActivity: Date? {
        (sessions.isEmpty ? [currentSession] : sessions)
            .compactMap(\.lastActivityDate)
            .max()
    }

    private static func ago(_ elapsed: TimeInterval) -> String {
        let total = max(0, Int(elapsed))
        if total < 60 { return "just now" }
        if total < 3_600 { return "\(total / 60)m ago" }
        if total < 86_400 { return "\(total / 3_600)h ago" }
        return "\(total / 86_400)d ago"
    }

    private var worktreeSection: some View {
        // The Repository row is here as a CONTROL, not as a label: the hero
        // already reads "<repo> · <model>", so a row that only repeated it
        // would push the worktree's own details off the screen. It appears
        // only where the repo can still be changed.
        InfoSection(title: "Worktree") {
            repositoryRow
            if let branch = gitStatus?.branch ?? currentSession.branch, !branch.isEmpty {
                InfoRow(label: "Branch", value: branch, icon: "arrow.triangle.branch")
            }
            if let path = currentSession.worktreeDir, !path.isEmpty {
                InfoRow(label: "Path", value: path, icon: "folder", monospaced: true)
            }
            InfoRow(
                label: "Mode",
                value: (currentSession.mode ?? "ask").capitalized,
                icon: "terminal"
            )
            if let startedBy = oldestSession?.startedBy, !startedBy.isEmpty {
                InfoRow(label: "Started by", value: startedBy, icon: "person")
            }
            ForEach(currentSession.attachedRepos ?? []) { repo in
                InfoRow(
                    label: "Attached",
                    value: "\(RepoTile.label(for: repo.repo)) · \(repo.branch)",
                    icon: "link"
                )
            }
        }
    }

    /// Change the repo a session works in, for the wrong one picked at
    /// creation. Offered only where there is a worktree to repoint: an Ask
    /// session reads the main checkout, so it has no primary repo to move.
    @ViewBuilder
    private var repositoryRow: some View {
        if repoSwitchable && !repos.isEmpty {
            Menu {
                ForEach(repos) { option in
                    Button {
                        chooseRepo(option.id)
                    } label: {
                        Label {
                            Text(option.label ?? option.id)
                        } icon: {
                            // Same rule as the new-session chip: a menu row
                            // has one glyph, and which repo this session is
                            // in outranks drawing its icon twice.
                            if option.id == currentSession.effectiveRepo {
                                Image(systemName: "checkmark")
                            } else if let icon = RepoTile.menuIcon(for: option.id) {
                                icon
                            }
                        }
                    }
                }
            } label: {
                SettingsRow(
                    label: "Repository",
                    value: switchingRepo == nil
                        ? RepoTile.label(for: currentSession.effectiveRepo)
                        : "Switching…",
                    icon: "folder"
                )
            }
            .buttonStyle(.plain)
            .disabled(switchingRepo != nil)
        }
    }

    /// Says what the switch costs, in the terms the person is about to lose
    /// track of: the work is not deleted, it is left where it is.
    private func repoSwitchWarning(target: String) -> String {
        let branch = currentSession.branch.map { " (branch \($0))" } ?? ""
        return """
        Your changes stay in the \(RepoTile.label(for: currentSession.effectiveRepo)) worktree\(branch). \
        They won't move to \(RepoTile.label(for: target)).
        """
    }

    private func chooseRepo(_ repo: String) {
        guard repo != currentSession.effectiveRepo, switchingRepo == nil else { return }
        // Switching repoints the session at another worktree; the one it is
        // in now keeps its branch, commits and edits on disk. Confirm when
        // there is something to leave behind, go straight through when the
        // worktree is still clean.
        if repoHasWork {
            confirmRepoTarget = repo
        } else {
            Task { await switchRepo(to: repo) }
        }
    }

    private func switchRepo(to repo: String) async {
        switchingRepo = repo
        defer { switchingRepo = nil }
        do {
            // The reload this triggers (`loadIdentity` carries the worktree)
            // re-reads git status and the switchable answer for the new
            // worktree, so nothing here has to guess them.
            switchedRepo = try await OS1API.switchPrimaryRepo(
                sessionId: currentSession.id,
                repo: repo,
                force: repoHasWork
            )
        } catch {
            switchError = error.localizedDescription
        }
    }

    /// Remote sandboxes are separate compute workspaces; local sandboxes are
    /// the host worktree and add no useful lifecycle control here.
    @ViewBuilder
    private var sandboxSection: some View {
        if let sandbox = remoteSandbox {
            InfoSection(title: "Sandbox") {
                if sandboxLoading && sandboxStatus == nil {
                    HStack(spacing: 9) {
                        ProgressView().controlSize(.small)
                        Text("Checking sandbox…")
                            .font(.subheadline)
                            .foregroundStyle(OS1VisualStyle.textDim)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(12)
                } else {
                    InfoRow(
                        label: "Status",
                        value: sandboxStateLabel,
                        icon: sandboxStateIcon
                    )
                    Divider()
                    InfoRow(label: "Provider", value: sandboxStatus?.provider ?? sandbox.provider, icon: "shippingbox")
                    if let workspace = sandboxStatus?.workspace ?? sandbox.workspace,
                       !workspace.isEmpty {
                        Divider()
                        InfoRow(label: "Workspace", value: workspace.capitalized, icon: "externaldrive")
                    }
                    if let cwd = sandboxStatus?.cwd, !cwd.isEmpty {
                        Divider()
                        InfoRow(label: "Path", value: cwd, icon: "folder", monospaced: true)
                    }
                    if sandboxState == "awake", sandboxStatus?.canPause == true {
                        Divider()
                        sandboxActionButton(.pause, title: "Pause compute", icon: "pause.circle")
                    }
                    if sandboxState == "sleeping" || sandboxState == "needs_attention", sandboxStatus?.canResume == true {
                        Divider()
                        sandboxActionButton(.resume, title: "Wake sandbox", icon: "play.circle")
                    }
                    if canRecreateSandbox {
                        Divider()
                        Button {
                            confirmingSandboxRecreate = true
                        } label: {
                            HStack(spacing: 10) {
                                if sandboxAction == .recreate {
                                    ProgressView().controlSize(.small)
                                } else {
                                    Image(systemName: "arrow.clockwise")
                                }
                                Text(sandboxAction == .recreate ? "Recreating sandbox…" : "Recreate from clean image")
                                Spacer()
                            }
                            .font(.subheadline.weight(.medium))
                            .foregroundStyle(OS1VisualStyle.redInk)
                            .padding(.horizontal, 12)
                            .frame(minHeight: 48)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .disabled(sandboxAction != nil || sandboxStatus?.busy == true)
                    }
                    if sandboxError != nil {
                        Divider()
                        Button("Retry") { Task { await reloadSandbox() } }
                            .font(.subheadline.weight(.medium))
                            .foregroundStyle(OS1VisualStyle.link)
                            .padding(.horizontal, 12)
                            .frame(minHeight: 44)
                            .disabled(sandboxLoading || sandboxAction != nil)
                    }
                    if let error = sandboxStatus?.lastLifecycleError
                        ?? currentSession.sandbox?.lastLifecycleError,
                       !error.isEmpty {
                        Divider()
                        Text(error)
                            .font(.footnote)
                            .foregroundStyle(OS1VisualStyle.redInk)
                            .padding(12)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private var runnerSection: some View {
        if let runner = currentSession.runner {
            InfoSection(title: "Runner") {
                InfoRow(label: "Machine", value: runner.name, icon: "desktopcomputer")
                Divider()
                InfoRow(
                    label: "Status",
                    value: RunnerStatus(lifecycle: runner.lifecycle).label,
                    icon: RunnerStatus(lifecycle: runner.lifecycle).icon
                )
                Divider()
                InfoRow(label: "Workspace", value: runner.workspacePath, icon: "folder", monospaced: true)
                if let error = runner.lastLifecycleError, !error.isEmpty {
                    Divider()
                    Text(error)
                        .font(.footnote)
                        .foregroundStyle(OS1VisualStyle.redInk)
                        .padding(12)
                }
            }
        }
    }

    /// The pull request as one card: where it stands, who signed off and
    /// how its checks went, and its one action as a slide to merge.
    @ViewBuilder
    private var mergeSection: some View {
        if let pr = viewModel.prDetails {
            let tone = mergeTone(pr)
            VStack(alignment: .leading, spacing: 14) {
                Button {
                    panel = .review(sessionId: currentSession.id)
                } label: {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(mergeHeadline(pr))
                            .font(.headline)
                            .foregroundStyle(OS1VisualStyle.text)
                        HStack(spacing: 5) {
                            Text(verbatim: "#\(pr.number)").monospacedDigit()
                            Text(pr.title ?? "Pull request").lineLimit(1)
                        }
                        .font(.subheadline)
                        .foregroundStyle(OS1VisualStyle.textDim)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)

                Button {
                    panel = .review(sessionId: currentSession.id)
                } label: {
                    HStack(spacing: 12) {
                        // Each mark is cut to a circle and set in a ring of the
                        // card's own grey, outside it, so the overlap reads as
                        // a cut-out. A ring drawn on top of a squircle avatar
                        // left its corners poking out past the circle.
                        HStack(spacing: -8) {
                            Image(systemName: mergeStatusIcon(pr))
                                .font(.system(size: 15, weight: .bold))
                                .foregroundStyle(.white)
                                .frame(width: 32, height: 32)
                                .background(tone, in: Circle())
                                .padding(2)
                                .background(OS1VisualStyle.raised, in: Circle())
                            ForEach(mergeReviewers(pr), id: \.login) { reviewer in
                                UserAvatar(person: reviewer.login, login: reviewer.login, size: 32)
                                    .clipShape(Circle())
                                    .padding(2)
                                    .background(OS1VisualStyle.raised, in: Circle())
                            }
                        }
                        .fixedSize()
                        // The facepile is a fixed size, so the words get the
                        // rest of the row and wrap rather than truncate when
                        // that is not enough (larger text, three reviewers).
                        Text(mergeStatusLine(pr))
                            .font(.body.weight(.medium))
                            .foregroundStyle(OS1VisualStyle.text)
                            .lineLimit(3)
                            .multilineTextAlignment(.leading)
                            .fixedSize(horizontal: false, vertical: true)
                            .layoutPriority(1)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        Image(systemName: "chevron.right")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(OS1VisualStyle.textFaint)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)

                if pr.isOpen {
                    // Where it lands and how, then the slide that does it.
                    HStack(spacing: 10) {
                        if let head = pr.headRefName, let base = pr.baseRefName {
                            HStack(spacing: 5) {
                                Text(base).foregroundStyle(OS1VisualStyle.text)
                                Image(systemName: "arrow.left")
                                    .font(.caption2.weight(.semibold))
                                    .foregroundStyle(OS1VisualStyle.textFaint)
                                Text(head)
                                    .lineLimit(1)
                                    .truncationMode(.middle)
                            }
                            .font(.footnote.monospaced())
                            .foregroundStyle(OS1VisualStyle.textDim)
                            .accessibilityElement(children: .ignore)
                            .accessibilityLabel("\(head) into \(base)")
                        }
                        Spacer(minLength: 8)
                        Menu {
                            Picker("Merge method", selection: $mergeMethod) {
                                Text("Squash and merge").tag("squash")
                                Text("Create a merge commit").tag("merge")
                                Text("Rebase and merge").tag("rebase")
                            }
                        } label: {
                            HStack(spacing: 3) {
                                Text(Self.mergeMethodShortLabel(mergeMethod))
                                Image(systemName: "chevron.up.chevron.down")
                                    .font(.caption2.weight(.semibold))
                            }
                            .font(.footnote.weight(.medium))
                            .foregroundStyle(OS1VisualStyle.textDim)
                            .frame(minHeight: 32)
                            .contentShape(Rectangle())
                        }
                        .accessibilityLabel("Merge method, \(Self.mergeButtonLabel(mergeMethod))")
                        .disabled(merging)
                    }

                    // The slide is the confirmation. A PR with something
                    // wrong (conflicts, failing checks, a draft) still asks
                    // first, and says what.
                    SlideToMerge(
                        label: "Slide to merge",
                        tint: OS1VisualStyle.green,
                        busy: merging || pendingMerge != nil
                    ) {
                        if mergeWarnings(pr).isEmpty {
                            merge(method: mergeMethod)
                        } else {
                            pendingMerge = mergeMethod
                        }
                    }
                }
            }
            .padding(16)
            // A neutral card: the status mark carries the state, and the
            // slider's green thumb is the one colour on it.
            .background(
                OS1VisualStyle.raised,
                in: RoundedRectangle(cornerRadius: 22, style: .continuous)
            )
        }
    }

    private func mergeTone(_ pr: PrDetails) -> Color {
        if pr.isOpen, pr.mergeable == "CONFLICTING" || pr.reviewDecision == "CHANGES_REQUESTED" {
            return OS1VisualStyle.red
        }
        return pr.summary.color
    }

    private func mergeHeadline(_ pr: PrDetails) -> String {
        switch pr.summary {
        case .merged: return "Merged"
        case .closed: return "Closed"
        case .draft: return "Draft"
        case .failing: return "Checks failing"
        case .pending: return "Checks running"
        case .passing:
            if pr.mergeable == "CONFLICTING" { return "Merge conflicts" }
            if pr.reviewDecision == "CHANGES_REQUESTED" { return "Changes requested" }
            if pr.reviewDecision == "REVIEW_REQUIRED" { return "Waiting for review" }
            return "Ready to merge"
        }
    }

    private func mergeStatusIcon(_ pr: PrDetails) -> String {
        switch pr.summary {
        case .merged: "arrow.triangle.merge"
        case .closed, .failing: "xmark"
        case .draft: "pencil"
        case .pending: "clock"
        case .passing: pr.mergeable == "CONFLICTING" ? "exclamationmark" : "checkmark"
        }
    }

    /// People, not teams: a team row says nobody in particular looked.
    private func mergeReviewers(_ pr: PrDetails) -> [PrReviewer] {
        Array((pr.reviewers ?? []).filter { $0.isTeam != true }.prefix(3))
    }

    private func mergeStatusLine(_ pr: PrDetails) -> String {
        let checks = (pr.checks ?? []).filter { !Self.isDeployment($0) }
        let failed = checks.filter { $0.rank == .failure }.count
        let pending = checks.filter { $0.rank == .pending }.count
        if failed > 0 { return "\(failed) of \(checks.count) checks failed" }
        if pending > 0 { return "\(pending) of \(checks.count) checks running" }
        if !checks.isEmpty { return "All checks passed" }
        return pr.reviewDecision == "APPROVED" ? "Approved" : "No checks"
    }

    private var mergeConfirmationTitle: String {
        guard let number = viewModel.prDetails?.number else { return "Merge pull request?" }
        return "Merge PR #\(number)?"
    }

    private var mergeConfirmationMessage: String {
        guard let pr = viewModel.prDetails else { return "This cannot be undone." }
        let warnings = mergeWarnings(pr)
        let base = pr.baseRefName ?? "the base branch"
        guard !warnings.isEmpty else { return "This merges into \(base)." }
        return "This merges into \(base) even though \(warnings.joined(separator: ", "))."
    }

    /// What should make someone think twice before merging.
    private func mergeWarnings(_ pr: PrDetails) -> [String] {
        var warnings: [String] = []
        if pr.mergeable == "CONFLICTING" { warnings.append("it has conflicts") }
        if (pr.checks ?? []).contains(where: { $0.rank == .failure }) {
            warnings.append("checks are failing")
        } else if (pr.checks ?? []).contains(where: { $0.rank == .pending }) {
            warnings.append("checks are still running")
        }
        if pr.isDraft == true { warnings.append("it’s still a draft") }
        if pr.reviewDecision == "CHANGES_REQUESTED" { warnings.append("changes were requested") }
        return warnings
    }

    private static func mergeMethodShortLabel(_ method: String) -> String {
        switch method {
        case "merge": "Merge commit"
        case "rebase": "Rebase"
        default: "Squash"
        }
    }

    private static func mergeButtonLabel(_ method: String) -> String {
        switch method {
        case "merge": "Create a merge commit"
        case "rebase": "Rebase and merge"
        default: "Squash and merge"
        }
    }

    private func merge(method: String) {
        pendingMerge = nil
        guard !merging else { return }
        merging = true
        mergeError = nil
        Task {
            do {
                try await viewModel.mergePr(method: method)
                Haptics.play(.commit)
            } catch {
                mergeError = (error as? LocalizedError)?.errorDescription
                    ?? error.localizedDescription
            }
            merging = false
        }
    }

    /// A check that is a deploy rather than a test, as the web's
    /// `isDeployment` reads it: a provider's preview status, or a job named
    /// for deploying.
    private static func isDeployment(_ check: PrCheck) -> Bool {
        let name = check.name
        if check.workflowName == nil || check.workflowName?.isEmpty == true,
           name.range(of: "^(preview|vercel)\\s*([–—-]|/)", options: [.regularExpression, .caseInsensitive]) != nil {
            return true
        }
        return name.range(of: "^deploy\\b", options: [.regularExpression, .caseInsensitive]) != nil
    }

    private struct DeploymentRow: Identifiable {
        let id: String
        let name: String
        let detail: String
        let rank: PrCheck.Rank
        let url: URL?
    }

    private var deployments: [DeploymentRow] {
        guard let pr = viewModel.prDetails else { return [] }
        var rows: [DeploymentRow] = []
        if let href = pr.staging?.href(previewPath: currentSession.previewPath) {
            rows.append(DeploymentRow(
                id: "staging",
                name: "Preview environment",
                detail: href.host() ?? href.absoluteString,
                rank: .success,
                url: href
            ))
        }
        for check in (pr.checks ?? []) where Self.isDeployment(check) {
            let name = check.name.replacingOccurrences(
                of: "^(vercel|preview)\\s*([–—-]|/)\\s*",
                with: "",
                options: [.regularExpression, .caseInsensitive]
            )
            let state: String = switch check.rank {
            case .success: "Ready"
            case .failure: "Failed"
            case .pending: "Building"
            case .neutral: "Skipped"
            }
            rows.append(DeploymentRow(
                id: "check|\(check.name)",
                name: name.isEmpty ? check.name : name,
                detail: [state, Self.checkDuration(check)].compactMap { $0 }.joined(separator: " · "),
                rank: check.rank,
                url: check.url.flatMap(URL.init(string:))
            ))
        }
        return rows
    }

    private static func checkDuration(_ check: PrCheck) -> String? {
        guard let start = Session.parseISO(check.startedAt),
              let end = Session.parseISO(check.completedAt)
        else { return nil }
        let seconds = Int(end.timeIntervalSince(start).rounded())
        if seconds <= 0 { return nil }
        return seconds < 60 ? "\(seconds)s" : "\(Int((Double(seconds) / 60).rounded()))m"
    }

    /// Where this change runs: the PR's preview environment and every deploy
    /// its checks report.
    @ViewBuilder
    private var deploymentsSection: some View {
        let rows = deployments
        if !rows.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                OverviewHeading(title: "Deployments", count: rows.count)
                VStack(spacing: 0) {
                    ForEach(rows) { row in
                        Button {
                            if let url = row.url { openURL(url) }
                        } label: {
                            HStack(spacing: 12) {
                                Image(systemName: row.id == "staging" ? "globe" : "triangle.fill")
                                    .font(.system(size: row.id == "staging" ? 17 : 13, weight: .semibold))
                                    .foregroundStyle(OS1VisualStyle.text)
                                    .frame(width: 38, height: 38)
                                    .background(OS1VisualStyle.background, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(row.name)
                                        .font(.body.weight(.medium))
                                        .foregroundStyle(OS1VisualStyle.text)
                                        .lineLimit(1)
                                    HStack(spacing: 5) {
                                        Circle()
                                            .fill(Self.deployColor(row.rank))
                                            .frame(width: 7, height: 7)
                                        Text(row.detail)
                                            .lineLimit(1)
                                    }
                                    .font(.footnote)
                                    .foregroundStyle(OS1VisualStyle.textDim)
                                }
                                Spacer(minLength: 8)
                                if row.url != nil {
                                    Image(systemName: "arrow.up.right")
                                        .font(.caption.weight(.semibold))
                                        .foregroundStyle(OS1VisualStyle.textFaint)
                                }
                            }
                            .padding(.horizontal, 12)
                            .frame(minHeight: 62)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .disabled(row.url == nil)
                        if row.id != rows.last?.id { Divider().padding(.leading, 62) }
                    }
                }
                .background(OS1VisualStyle.raised, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            }
        }
    }

    private static func deployColor(_ rank: PrCheck.Rank) -> Color {
        switch rank {
        case .success: OS1VisualStyle.green
        case .failure: OS1VisualStyle.red
        case .pending: OS1VisualStyle.yellow
        case .neutral: OS1VisualStyle.textFaint
        }
    }

    /// Git state and the diff in one card. They answer the same question —
    /// what this workspace did to the tree — and on most workspaces each is a
    /// line or two, so two titled cards for them cost a third of the first
    /// screen and pushed the PR and the overview below the fold.
    @ViewBuilder
    private var workSection: some View {
        let files = diff?.files ?? []
        InfoSection(
            title: files.isEmpty
                ? "Git status"
                : "\(files.count) file\(files.count == 1 ? "" : "s") changed",
            trailing: files.isEmpty ? nil : diff.map { AnyView(diffTotals($0)) }
        ) {
            gitStatusRow
            changedFileRows(files)
        }
    }

    @ViewBuilder
    private var gitStatusRow: some View {
        if loading && gitStatus == nil {
            HStack(spacing: 9) {
                ProgressView().controlSize(.small)
                Text("Checking worktree…")
                    .font(.subheadline)
                    .foregroundStyle(OS1VisualStyle.textDim)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12)
        } else if let gitStatus {
            FlowLayout(spacing: 7) {
                    if gitStatus.uncommittedFiles > 0 {
                        StatusPill(
                            text: "\(gitStatus.uncommittedFiles) uncommitted",
                            icon: "pencil",
                            color: OS1VisualStyle.yellow
                        )
                    }
                    if gitStatus.ahead > 0 {
                        StatusPill(
                            text: "\(gitStatus.ahead) ahead",
                            icon: "arrow.up",
                            color: OS1VisualStyle.blue
                        )
                    }
                    if gitStatus.behind > 0 {
                        StatusPill(
                            text: "\(gitStatus.behind) behind upstream",
                            icon: "arrow.down",
                            color: OS1VisualStyle.yellow
                        )
                    } else if gitStatus.behindBase > 0,
                              currentSession.prState != "MERGED" {
                        StatusPill(
                            text: "\(gitStatus.behindBase) behind \(gitStatus.baseBranch)",
                            icon: "arrow.down",
                            color: OS1VisualStyle.yellow
                        )
                    }
                    if gitStatus.uncommittedFiles == 0,
                       gitStatus.ahead == 0,
                       gitStatus.behind == 0,
                       (gitStatus.behindBase == 0 || currentSession.prState == "MERGED") {
                        StatusPill(
                            text: "Up to date",
                            icon: "checkmark",
                            color: OS1VisualStyle.green
                        )
                    }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12)
        }
    }

    @ViewBuilder
    private func changedFileRows(_ files: [OS1API.DiffFile]) -> some View {
        if !files.isEmpty {
            let shown = Array(files.prefix(8))
            Divider()
                ForEach(shown) { file in
                    Button {
                        panel = .changes(
                            sessionId: currentSession.id,
                            path: file.path
                        )
                    } label: {
                        HStack(spacing: 10) {
                            Image(systemName: DiffFileStyle.icon(file.status))
                                .font(.system(size: 13, weight: .semibold))
                                .foregroundStyle(DiffFileStyle.color(file.status))
                                .frame(width: 20)
                            Text(file.path)
                                .font(.footnote.monospaced())
                                .foregroundStyle(OS1VisualStyle.text)
                                .lineLimit(1)
                                .truncationMode(.middle)
                            Spacer(minLength: 8)
                            if file.additions > 0 {
                                Text(verbatim: "+\(file.additions)")
                                    .foregroundStyle(OS1VisualStyle.greenInk)
                            }
                            if file.deletions > 0 {
                                Text(verbatim: "−\(file.deletions)")
                                    .foregroundStyle(OS1VisualStyle.redInk)
                            }
                            Image(systemName: "chevron.right")
                                .font(.caption2.weight(.semibold))
                                .foregroundStyle(OS1VisualStyle.textDim)
                        }
                        .font(.caption.monospacedDigit())
                        .padding(.horizontal, 12)
                        .frame(minHeight: 44)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    if file.id != shown.last?.id { Divider() }
                }
                Divider()
                Button {
                    panel = .changes(sessionId: currentSession.id)
                } label: {
                    HStack(spacing: 6) {
                        Text(
                            files.count > shown.count
                                ? "Show all \(files.count) files"
                                : "Open changes"
                        )
                        Image(systemName: "chevron.right")
                            .font(.caption2.weight(.semibold))
                    }
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(OS1VisualStyle.accentInk)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 12)
                    .frame(minHeight: 44)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
        }
    }

    /// The session's scratch artifacts. Only ever shown when there are some —
    /// most sessions write none, and an empty section would be noise on every
    /// workspace page.
    @ViewBuilder
    private var assetsSection: some View {
        if !fileAssets.isEmpty {
            InfoSection(
                title: "Files",
                trailing: AnyView(
                    Text(verbatim: "\(fileAssets.count)")
                        .font(.caption.weight(.semibold).monospacedDigit())
                        .foregroundStyle(OS1VisualStyle.textDim)
                )
            ) {
                let shown = Array(fileAssets.prefix(8))
                ForEach(shown) { asset in
                    Button {
                        panel = .asset(sessionId: currentSession.id, path: asset.path)
                    } label: {
                        HStack(alignment: asset.description == nil ? .center : .top, spacing: 10) {
                            Image(systemName: AssetKind.of(asset).symbol)
                                .symbolRenderingMode(.hierarchical)
                                .font(.system(size: 13))
                                .foregroundStyle(OS1VisualStyle.textDim)
                                .frame(width: 20)
                                .padding(.top, asset.description == nil ? 0 : 2)
                            VStack(alignment: .leading, spacing: 3) {
                                Text(asset.path)
                                    .font(.footnote.monospaced())
                                    .foregroundStyle(OS1VisualStyle.text)
                                    .lineLimit(1)
                                    .truncationMode(.middle)
                                if let description = asset.description, !description.isEmpty {
                                    Text(description)
                                        .font(.caption)
                                        .foregroundStyle(OS1VisualStyle.textDim)
                                        .lineLimit(2)
                                        .multilineTextAlignment(.leading)
                                }
                            }
                            Spacer(minLength: 8)
                            Text(ByteCountFormatter.string(
                                fromByteCount: Int64(asset.size),
                                countStyle: .file
                            ))
                            .font(.caption.monospacedDigit())
                            .foregroundStyle(OS1VisualStyle.textDim)
                            Image(systemName: "chevron.right")
                                .font(.caption2.weight(.semibold))
                                .foregroundStyle(OS1VisualStyle.textFaint)
                        }
                        .padding(.horizontal, 12)
                        .frame(minHeight: 44)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    if asset.id != shown.last?.id { Divider() }
                }
                if fileAssets.count > shown.count {
                    Text("\(fileAssets.count - shown.count) more in the Assets tab.")
                        .font(.caption)
                        .foregroundStyle(OS1VisualStyle.textDim)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(12)
                }
            }
        }
    }

    private var visualAssets: [OS1API.SessionAsset] {
        assets.filter { AssetVisualKind.of($0) != nil }
    }

    private var fileAssets: [OS1API.SessionAsset] {
        assets.filter { AssetVisualKind.of($0) == nil }
    }

    /// Both reviewers of this change in one section, above the pull request
    /// itself: whether anybody has looked at this is the question the page is
    /// opened with, and the PR's own details are what you read afterwards.
    private var reviewSection: some View {
        InfoSection(title: "Review") {
            WorkspaceReviewRows(
                sessionId: currentSession.id,
                sessions: sessions.isEmpty ? [currentSession] : sessions,
                pr: viewModel.prDetails,
                repo: currentSession.repo,
                onOpenPr: { panel = .review(sessionId: currentSession.id) },
                onOpenRun: { id in
                    // The run is a session of its own, so it opens where every
                    // other session link does: the list behind this page.
                    guard let url = SessionLinks.url(for: id) else { return }
                    dismiss()
                    openURL(url)
                }
            )
        }
    }

    @ViewBuilder
    private var pullRequestSection: some View {
        let rows = SessionPrSeries.rows(for: currentSession)
        // Once the merge card has the primary PR this lists only the others.
        let primaryNumber = viewModel.prDetails == nil ? currentSession.prNumber : nil
        if rows.contains(where: { !$0.isPrimary }) || primaryNumber != nil {
            InfoSection(
                title: rows.count == 1 ? "Pull request" : "Pull requests",
                trailing: primaryNumber.flatMap { number in
                    viewModel.prDetails.map { AnyView(prNumberLabel(number, summary: $0.summary)) }
                }
            ) {
                if let number = primaryNumber {
                    Button {
                        panel = .review(sessionId: currentSession.id)
                    } label: {
                        if let pr = viewModel.prDetails {
                            prSummary(pr)
                        } else {
                            prLoadingSummary(number)
                        }
                    }
                    .buttonStyle(.plain)
                    if rows.contains(where: { !$0.isPrimary }) { Divider() }
                }
                SessionPrSeriesRows(
                    session: currentSession,
                    includePrimary: primaryNumber == nil && viewModel.prDetails == nil
                ) { row in
                    if row.isPrimary {
                        panel = .review(sessionId: currentSession.id)
                    } else {
                        Task {
                            guard let url = await SessionPrSeries.destination(
                                for: row,
                                sessionId: currentSession.id
                            ) else { return }
                            openURL(url)
                        }
                    }
                }
            }
        }
    }

    private func prNumberLabel(_ number: Int, summary: PrDetails.Summary) -> some View {
        HStack(spacing: 5) {
            Circle()
                .fill(summary.color)
                .frame(width: 7, height: 7)
            Text(verbatim: "#\(number)")
                .font(.caption.weight(.semibold))
                .monospacedDigit()
        }
        .foregroundStyle(OS1VisualStyle.textDim)
    }

    private func prSummary(_ pr: PrDetails) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 11) {
                Image(systemName: pr.state == "MERGED" ? "arrow.triangle.merge" : "arrow.triangle.pull")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(pr.summary.color)
                    .frame(width: 34, height: 34)
                    .background(pr.summary.color.opacity(0.14), in: Circle())
                VStack(alignment: .leading, spacing: 4) {
                    Text(pr.title ?? "Pull request")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(OS1VisualStyle.text)
                        .multilineTextAlignment(.leading)
                        .lineLimit(2)
                    if let head = pr.headRefName, let base = pr.baseRefName {
                        Text("\(head) → \(base)")
                            .font(.caption.monospaced())
                            .foregroundStyle(OS1VisualStyle.textDim)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                }
                Spacer(minLength: 8)
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(OS1VisualStyle.textFaint)
                    .padding(.top, 10)
            }

            FlowLayout(spacing: 7) {
                StatusPill(text: pr.summary.label, icon: prSummaryIcon(pr.summary), color: pr.summary.color)
                if let review = prReviewStatus(pr.reviewDecision) {
                    StatusPill(text: review.text, icon: review.icon, color: review.color)
                }
                if pr.mergeable == "CONFLICTING" {
                    StatusPill(text: "Merge conflict", icon: "exclamationmark.triangle.fill", color: OS1VisualStyle.red)
                }
            }

            HStack(spacing: 14) {
                Label(
                    "+\(pr.additions ?? 0)",
                    systemImage: "plus"
                )
                .foregroundStyle(OS1VisualStyle.greenInk)
                Label(
                    "−\(pr.deletions ?? 0)",
                    systemImage: "minus"
                )
                .foregroundStyle(OS1VisualStyle.redInk)
                Label(
                    "\(pr.changedFiles ?? 0) file\((pr.changedFiles ?? 0) == 1 ? "" : "s")",
                    systemImage: "doc.on.doc"
                )
                .foregroundStyle(OS1VisualStyle.textDim)
            }
            .font(.caption.weight(.medium).monospacedDigit())
        }
        .padding(12)
        .contentShape(Rectangle())
    }

    private func prLoadingSummary(_ number: Int) -> some View {
        HStack(spacing: 11) {
            ProgressView().controlSize(.small)
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: "Pull request #\(number)")
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(OS1VisualStyle.text)
                Text("Loading status and checks…")
                    .font(.caption)
                    .foregroundStyle(OS1VisualStyle.textDim)
            }
            Spacer()
            Image(systemName: "chevron.right")
                .font(.caption.weight(.semibold))
                .foregroundStyle(OS1VisualStyle.textFaint)
        }
        .padding(12)
        .frame(minHeight: 58)
        .contentShape(Rectangle())
    }

    private func prSummaryIcon(_ summary: PrDetails.Summary) -> String {
        switch summary {
        case .merged: "arrow.triangle.merge"
        case .closed, .failing: "xmark.circle.fill"
        case .draft: "pencil.circle.fill"
        case .pending: "clock.fill"
        case .passing: "checkmark.circle.fill"
        }
    }

    private func prReviewStatus(_ decision: String?) -> (text: String, icon: String, color: Color)? {
        switch decision ?? "" {
        case "APPROVED": ("Approved", "checkmark.seal.fill", OS1VisualStyle.green)
        case "CHANGES_REQUESTED": ("Changes requested", "exclamationmark.bubble.fill", OS1VisualStyle.red)
        case "REVIEW_REQUIRED": ("Review required", "eye.fill", OS1VisualStyle.yellow)
        default: nil
        }
    }

    @ViewBuilder
    private var overviewSection: some View {
        if let overview, overview.prompt != nil || overview.lastMessage != nil {
            // Latest first: on a workspace you already know the shape of, what
            // it just said is the news, and the original ask is the thing you
            // scroll back to.
            InfoSection(title: "Overview") {
                if let lastMessage = overview.lastMessage {
                    SummaryBlock(label: "Latest update", content: lastMessage.content)
                }
                if let prompt = overview.prompt {
                    if overview.lastMessage != nil { Divider() }
                    SummaryBlock(label: "Started with", content: prompt.content, lines: 4)
                }
            }
        } else if loading {
            // The overview is the slowest thing on the page (it reads every
            // session's transcript) and now the topmost, so it holds its place
            // instead of shoving the whole page down when it lands.
            InfoSection(title: "Overview") {
                HStack(spacing: 9) {
                    ProgressView().controlSize(.small)
                    Text("Reading the transcript…")
                        .font(.subheadline)
                        .foregroundStyle(OS1VisualStyle.textDim)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(12)
            }
        } else if loadFailed {
            InfoSection(title: "Overview") {
                Text("Some worktree details could not be loaded. Pull down to retry.")
                    .font(.subheadline)
                    .foregroundStyle(OS1VisualStyle.textDim)
                    .padding(12)
            }
        }
    }

    /// What the work looks like: recordings first, then screenshots, from
    /// the conversation and the session's assets alike, as one large
    /// carousel. Called Demos when there is a recording to play.
    @ViewBuilder
    private var demosSection: some View {
        let media = conversationMedia
        let items = (
            media.map { WorkspaceMediaItem.conversation($0, label: mediaLabel($0)) }
            + visualAssets.map { WorkspaceMediaItem.asset($0, sessionId: currentSession.id) }
        )
        .enumerated()
        .sorted { lhs, rhs in
            let l = lhs.element.kind == .video ? 0 : 1
            let r = rhs.element.kind == .video ? 0 : 1
            return l == r ? lhs.offset < rhs.offset : l < r
        }
        .map(\.element)
        if !items.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                OverviewHeading(
                    title: items.contains { $0.kind == .video } ? "Demos" : "Screenshots",
                    count: items.count
                )
                WorkspaceMediaStrip(items: items, large: true) { item in
                    switch item.source {
                    case .conversation:
                        openConversationMedia(item)
                    case .asset(let asset):
                        panel = .asset(sessionId: currentSession.id, path: asset.path)
                    }
                }
            }
        }
    }

    /// Exact repeats carry no additional information and cannot safely share a
    /// SwiftUI identity. Keep the server's newest-first order while dropping
    /// only byte-for-byte duplicate references.
    private var conversationMedia: [OS1API.WorkspaceOverview.Media] {
        var seen: Set<String> = []
        return (overview?.media ?? []).filter { media in
            guard media.kind == "image" || media.kind == "video" else { return false }
            return seen.insert(media.id).inserted
        }
    }

    private var conversationImageGallery: [PreviewImage] {
        conversationMedia.filter { $0.kind == "image" }.map { media in
            PreviewImage(
                id: media.id,
                source: .conversation(source: media.src, sessionId: media.sessionId),
                label: mediaLabel(media)
            )
        }
    }

    /// Use the same name as the workspace header and sidebar. The selected
    /// session can have a different title when this workspace has several tabs.
    private var workspaceTitle: String {
        SessionsListViewModel.worktreeTitle(
            for: currentSession,
            in: sessions,
            workspaceNames: [:]
        )
    }

    private func openConversationMedia(_ item: WorkspaceMediaItem) {
        guard case .conversation(let media) = item.source else { return }
        if media.kind == "video" {
            conversationVideo = media
        } else if let index = conversationImageGallery.firstIndex(where: { $0.id == media.id }) {
            conversationImage = WorkspaceImageSelection(index: index)
        }
    }

    private func mediaLabel(_ media: OS1API.WorkspaceOverview.Media) -> String? {
        var parts: [String] = []
        if let title = media.sessionTitle, !title.isEmpty { parts.append(title) }
        if let date = Session.parseISO(media.at) {
            parts.append(date.formatted(date: .abbreviated, time: .shortened))
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    private var runSettingsSection: some View {
        InfoSection(title: "Run settings") {
            Menu {
                // Same slot as the session's own model menu: the running cost
                // sits with the choice that drives it.
                UsageMenuSection(usage: viewModel.usage)
                if let catalog {
                    ForEach(catalog.presets + catalog.regular) { option in
                        let routed = ModelCatalog.routedID(option.id, engine: currentEngine)
                        Button {
                            if let routed { viewModel.changeModel(to: routed, option: option) }
                        } label: {
                            if option.id == ModelCatalog.baseID(currentModel) {
                                Label(option.displayLabel, systemImage: "checkmark")
                            } else {
                                Text(option.displayLabel)
                            }
                        }
                        .disabled(routed == nil)
                    }
                }
            } label: {
                SettingsRow(
                    label: "Model",
                    value: catalog?.label(for: currentModel) ?? currentModel,
                    icon: "cpu"
                )
            }
            .buttonStyle(.plain)

            if engineChoices.count > 1 {
                Divider()
                Menu {
                    ForEach(engineChoices) { engine in
                        let routed = ModelCatalog.routedID(currentModel, engine: engine.id)
                        Button {
                            if let routed {
                                viewModel.changeModel(
                                    to: routed, option: catalog?.option(for: currentModel)
                                )
                            }
                        } label: {
                            if engine.id == currentEngine {
                                Label(engine.label, systemImage: "checkmark")
                            } else {
                                Text(engine.label)
                            }
                        }
                        .disabled(routed == nil)
                    }
                } label: {
                    SettingsRow(
                        label: "Engine",
                        value: currentEngineLabel,
                        icon: "gearshape.2"
                    )
                }
                .buttonStyle(.plain)
            }

            if let efforts = catalog?.option(for: currentModel)?.efforts,
               !efforts.isEmpty {
                Divider()
                Menu {
                    ForEach(efforts, id: \.self) { effort in
                        Button {
                            viewModel.effort = effort
                        } label: {
                            if viewModel.effort == effort {
                                Label(EffortLevel.label(effort), systemImage: "checkmark")
                            } else {
                                Text(EffortLevel.label(effort))
                            }
                        }
                    }
                } label: {
                    SettingsRow(
                        label: "Reasoning",
                        value: EffortLevel.label(viewModel.effort),
                        icon: "brain"
                    )
                }
                .buttonStyle(.plain)
            }

            let speeds = speedChoices
            if !speeds.isEmpty {
                let effective = speeds.effective(viewModel.speed)
                Divider()
                Menu {
                    ForEach(speeds.options) { option in
                        Button {
                            viewModel.selectSpeed(option, choices: speeds)
                        } label: {
                            if effective == option {
                                Label(option.label, systemImage: "checkmark")
                            } else {
                                Text(option.label)
                            }
                        }
                    }
                } label: {
                    SettingsRow(label: "Speed", value: effective.label, icon: effective.symbol)
                }
                .buttonStyle(.plain)
            }
        }
    }

    /// Speeds the current model, pin and pool can run at, from the pools
    /// this device last fetched (the session's own menu refreshes them).
    private var speedChoices: SpeedChoices {
        SpeedChoices(
            model: catalog?.option(for: currentModel),
            accounts: SpeedChoices.pool(
                for: currentModel,
                catalog: catalog,
                accounts: accountPools,
                viewer: ServerConfig.shared.userName
            ),
            accountId: viewModel.accountId
        )
    }

    private var currentModel: String {
        viewModel.model.isEmpty ? (catalog?.defaultModel ?? "") : viewModel.model
    }

    private var engineChoices: [ModelEngineOption] {
        catalog?.availableEngines ?? []
    }

    private var currentEngine: String {
        catalog?.routingEngine(for: currentModel) ?? ModelCatalog.engine(currentModel)
    }

    private var currentEngineLabel: String {
        engineChoices.first(where: { $0.id == currentEngine })?.label
            ?? currentEngine.capitalized
    }

    /// The host counterpart of the Sandbox section: a code session that runs
    /// on this machine, and the Ready Sandboxes it can move into. Once the
    /// move lands the session carries a `sandbox` record and the Sandbox
    /// section above takes over with Preparing.
    @ViewBuilder
    private var runtimeSection: some View {
        if remoteSandbox == nil, SandboxMove.canMove(currentSession) {
            InfoSection(title: "Runtime") {
                InfoRow(label: "Runs on", value: "This machine", icon: "desktopcomputer")
                Divider()
                if let providers = sandboxMove.providers {
                    if providers.isEmpty {
                        Text(SandboxMoveCopy.noneReady)
                            .font(.footnote)
                            .foregroundStyle(OS1VisualStyle.textDim)
                            .padding(12)
                    } else {
                        Text(SandboxMoveCopy.explanation)
                            .font(.footnote)
                            .foregroundStyle(OS1VisualStyle.textDim)
                            .padding(12)
                        ForEach(providers, id: \.self) { provider in
                            Divider()
                            sandboxMoveButton(provider)
                        }
                        if viewModel.isRunning {
                            Divider()
                            Text(SandboxMoveCopy.waitForAgent)
                                .font(.footnote)
                                .foregroundStyle(OS1VisualStyle.textDim)
                                .padding(12)
                        }
                    }
                } else {
                    HStack(spacing: 9) {
                        ProgressView().controlSize(.small)
                        Text(SandboxMoveCopy.checking)
                            .font(.subheadline)
                            .foregroundStyle(OS1VisualStyle.textDim)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(12)
                }
            }
        }
    }

    private func sandboxMoveButton(_ provider: String) -> some View {
        let working = sandboxMove.working == provider
        return Button {
            Task {
                if let status = await sandboxMove.move(sessionId: currentSession.id, to: provider) {
                    adoptSandboxMove(status)
                }
            }
        } label: {
            HStack(spacing: 10) {
                if working {
                    ProgressView().controlSize(.small)
                } else {
                    Image(systemName: "cube")
                }
                Text(SandboxMoveCopy.action(provider, working: working))
                Spacer()
            }
            .font(.subheadline.weight(.medium))
            .foregroundStyle(OS1VisualStyle.link)
            .padding(.horizontal, 12)
            .frame(minHeight: 48)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(
            sandboxMove.working != nil || sandboxMove.hasMoved(currentSession) || viewModel.isRunning
        )
    }

    /// Show the Sandbox section as Preparing now: the live status is what the
    /// server answered, and the row overlay keeps `remoteSandbox` non-nil
    /// until the sessions poll agrees.
    private func adoptSandboxMove(_ status: SessionSandboxStatus) {
        sandboxStatus = status
        sandboxError = nil
        attachedSandbox = SandboxMove.recorded(from: status)
        SandboxMoveViewModel.adopt(status, into: viewModel)
    }

    private var remoteSandbox: (provider: String, sandboxId: String?, workspace: String?)? {
        guard let sandbox = currentSession.sandbox,
              let provider = sandbox.provider,
              !provider.isEmpty,
              provider != "local"
        else { return nil }
        return (provider, sandbox.sandboxId, sandbox.workspace)
    }

    private var sandboxState: String {
        sandboxStatus?.lifecycle
            ?? currentSession.sandbox?.lifecycle
            ?? (remoteSandbox?.sandboxId == nil ? "preparing" : "awake")
    }

    private var sandboxStateLabel: String {
        switch sandboxState {
        case "awake": "Awake"
        case "sleeping": "Sleeping"
        case "waking": "Waking"
        case "needs_attention": "Needs attention"
        default: "Preparing"
        }
    }

    private var sandboxStateIcon: String {
        switch sandboxState {
        case "awake": "checkmark.circle"
        case "sleeping": "pause.circle"
        case "waking": "arrow.clockwise"
        case "needs_attention": "exclamationmark.triangle"
        default: "questionmark.circle"
        }
    }

    private var canRecreateSandbox: Bool {
        let id = sandboxStatus?.sandboxId ?? remoteSandbox?.sandboxId
        return id?.isEmpty == false
    }

    private func sandboxActionButton(
        _ action: SessionSandboxAction,
        title: String,
        icon: String
    ) -> some View {
        Button {
            Task { await performSandboxAction(action) }
        } label: {
            HStack(spacing: 10) {
                if sandboxAction == action {
                    ProgressView().controlSize(.small)
                } else {
                    Image(systemName: icon)
                }
                Text(sandboxAction == action ? "\(title)…" : title)
                Spacer()
            }
            .font(.subheadline.weight(.medium))
            .foregroundStyle(OS1VisualStyle.link)
            .padding(.horizontal, 12)
            .frame(minHeight: 48)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(sandboxAction != nil || sandboxStatus?.busy == true)
    }

    private var oldestSession: Session? {
        sessions.min { ($0.createdAt ?? "") < ($1.createdAt ?? "") }
    }

    private var repoLabel: String {
        var label = RepoTile.label(for: currentSession.effectiveRepo)
        let attached = currentSession.attachedRepos?.count ?? 0
        if attached > 0 { label += " +\(attached)" }
        return label
    }

    private var heroSubtitle: String {
        [repoLabel, catalog?.label(for: currentModel) ?? currentModel]
            .filter { !$0.isEmpty }
            .joined(separator: " · ")
    }

    private var stateLabel: (text: String, icon: String, color: Color)? {
        if viewModel.pendingQuestion != nil {
            return ("Waiting for input", "questionmark", OS1VisualStyle.blue)
        }
        if viewModel.isRunning {
            return ("Working", "sparkles", OS1VisualStyle.green)
        }
        switch viewModel.prDetails?.state ?? currentSession.prState {
        case "OPEN":
            return viewModel.prDetails?.isDraft == true
                ? ("Draft", "pencil", OS1VisualStyle.textDim)
                : ("Open", "arrow.triangle.pull", OS1VisualStyle.green)
        case "MERGED": return ("Merged", "arrow.triangle.merge", OS1VisualStyle.purple)
        case "CLOSED": return ("Closed", "xmark", OS1VisualStyle.red)
        default: return nil
        }
    }

    private func load() async {
        loading = true
        loadFailed = false
        sandboxLoading = remoteSandbox != nil
        async let gitResult = try? OS1API.gitStatus(
            sessionId: currentSession.id,
            repo: currentSession.effectiveRepo
        )
        async let diffResult = try? OS1API.sessionDiff(sessionId: currentSession.id)
        async let assetsResult = try? OS1API.assets(sessionId: currentSession.id)
        async let overviewResult = loadOverview()
        async let sandboxResult = loadSandboxResult()
        async let reposResult = try? OS1API.repos()
        async let switchableResult = try? OS1API.repoSwitchable(sessionId: currentSession.id)
        // Which Sandboxes a host session could move into. Not asked for a
        // session that cannot move, or one that already has a Sandbox.
        async let movesResult: Void = remoteSandbox == nil && SandboxMove.canMove(currentSession)
            ? sandboxMove.loadProviders()
            : ()
        let (nextGit, nextDiffResponse, nextAssets, nextOverview, nextSandbox) = await (
            gitResult,
            diffResult,
            assetsResult,
            overviewResult,
            sandboxResult
        )
        let (nextRepos, nextSwitchable, _) = await (reposResult, switchableResult, movesResult)
        guard !Task.isCancelled else { return }
        if let nextRepos {
            repos = nextRepos
            // A row can only draw art the cache already holds, so ask for it
            // now rather than when the menu opens.
            for repo in nextRepos { RepoTile.prefetchIcon(for: repo.id) }
        }
        repoSwitchable = nextSwitchable?.switchable ?? false
        repoHasWork = nextSwitchable?.hasWork ?? false
        if let nextGit { gitStatus = nextGit }
        if let nextDiffResponse {
            diff = nextDiffResponse.repos.first(where: \.primary)?.diff
        }
        // Newest first, like the tab lists them.
        assets = (nextAssets ?? []).sorted { $0.mtime > $1.mtime }
        if let nextOverview { overview = nextOverview }
        applySandboxResult(nextSandbox)
        sandboxLoading = false
        loadFailed = gitStatus == nil && diff == nil && overview == nil
        loading = false
        #if DEBUG
        openImageForCaptureIfRequested()
        await moveForCaptureIfRequested()
        if let target = ProcessInfo.processInfo.environment["OS1_SCROLL_TO"], !target.isEmpty {
            // The rows above settle first; a lazy stack scrolled at once
            // lands short of the section.
            try? await Task.sleep(for: .milliseconds(400))
            scrollToForCapture = target
        }
        #endif
    }

    #if DEBUG
    @State private var scrollToForCapture: String?

    /// Lets the native capture tool drive the real move on a simulator that
    /// takes no taps: `OS1_SANDBOX_MOVE=<provider>` presses the row, so a
    /// worktree with unpushed work shows the server's confirmation, and
    /// `OS1_SANDBOX_MOVE_CONFIRM=1` with it presses Move anyway.
    @State private var didMoveForCapture = false

    private func moveForCaptureIfRequested() async {
        let env = ProcessInfo.processInfo.environment
        guard !didMoveForCapture,
              let provider = env["OS1_SANDBOX_MOVE"], !provider.isEmpty,
              remoteSandbox == nil, SandboxMove.canMove(currentSession)
        else { return }
        didMoveForCapture = true
        if let status = await sandboxMove.move(
            sessionId: currentSession.id,
            to: provider,
            confirm: env["OS1_SANDBOX_MOVE_CONFIRM"] == "1"
        ) {
            adoptSandboxMove(status)
        }
    }
    #endif

    #if DEBUG
    private func openImageForCaptureIfRequested() {
        guard !didOpenImageForCapture,
              ProcessInfo.processInfo.environment["OS1_OPEN_WORKSPACE_IMAGE"] == "1",
              !conversationImageGallery.isEmpty
        else { return }
        didOpenImageForCapture = true
        conversationImage = WorkspaceImageSelection(index: 0)
    }
    #endif

    private func loadSandboxResult() async -> Result<SessionSandboxStatus?, Error> {
        guard remoteSandbox != nil else { return .success(nil) }
        do {
            return .success(try await OS1API.sandbox(sessionId: currentSession.id))
        } catch {
            return .failure(error)
        }
    }

    private func refresh() async {
        await load()
    }

    private func applySandboxResult(_ result: Result<SessionSandboxStatus?, Error>) {
        switch result {
        case .success(let status):
            sandboxStatus = status
            sandboxError = nil
        case .failure(let error):
            sandboxError = error.localizedDescription
        }
    }

    private func reloadSandbox() async {
        guard remoteSandbox != nil, !sandboxLoading else { return }
        sandboxLoading = true
        defer { sandboxLoading = false }
        applySandboxResult(await loadSandboxResult())
    }

    private func performSandboxAction(_ action: SessionSandboxAction) async {
        guard sandboxAction == nil else { return }
        sandboxAction = action
        sandboxError = nil
        defer { sandboxAction = nil }
        do {
            sandboxStatus = try await OS1API.sandboxAction(
                sessionId: currentSession.id,
                action: action
            )
        } catch {
            sandboxError = error.localizedDescription
        }
    }

    private func loadOverview() async -> OS1API.WorkspaceOverview? {
        if let id = currentSession.workspaceId, !id.isEmpty {
            return try? await OS1API.workspaceOverview(workspaceId: id)
        }

        var transcripts: [(Session, [TranscriptEntry]?)] = []
        for session in sessions {
            transcripts.append((
                session,
                try? await OS1API.transcript(sessionId: session.id)
            ))
        }
        let ordered = transcripts.sorted {
            ($0.0.createdAt ?? "") < ($1.0.createdAt ?? "")
        }
        var prompt: OS1API.WorkspaceOverview.Message?
        var lastMessage: OS1API.WorkspaceOverview.Message?
        for (session, entries) in ordered {
            guard let entries else { continue }
            if prompt == nil,
               let entry = entries.first(where: {
                   $0.isUser && !$0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                       && !$0.text.hasPrefix("/")
               }) {
                prompt = .init(
                    content: entry.text,
                    sessionId: session.id,
                    at: entry.timestamp ?? session.createdAt ?? ""
                )
            }
            if let entry = entries.last(where: {
                $0.isAssistant && !$0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            }) {
                let candidate = OS1API.WorkspaceOverview.Message(
                    content: entry.text,
                    sessionId: session.id,
                    at: entry.timestamp ?? session.lastActivity ?? ""
                )
                if lastMessage == nil || candidate.at > lastMessage!.at {
                    lastMessage = candidate
                }
            }
        }
        return .init(prompt: prompt, lastMessage: lastMessage)
    }

    private func loadGitDetails() async {
        async let gitResult = try? OS1API.gitStatus(
            sessionId: currentSession.id,
            repo: currentSession.effectiveRepo
        )
        async let diffResult = try? OS1API.sessionDiff(sessionId: currentSession.id)
        let (nextGit, nextDiffResponse) = await (gitResult, diffResult)
        guard !Task.isCancelled else { return }
        if let nextGit { gitStatus = nextGit }
        if let nextDiffResponse {
            diff = nextDiffResponse.repos.first(where: \.primary)?.diff
        }
    }

    /// The navigation value is a snapshot. Prefer the latest polled row so an
    /// optimistic session gains its worktree metadata without being reopened.
    private var currentSession: Session {
        var session = sessions.first(where: { $0.id == viewModel.session.id }) ?? viewModel.session
        // Carry a switch that the sessions poll hasn't returned yet. Every
        // part of this page reads the session (the hero tile, the branch and
        // path rows, the git status keyed on `loadIdentity`), so the whole
        // page moves to the new worktree at once rather than in pieces.
        if let switchedRepo, session.repo != switchedRepo.repo {
            session.repo = switchedRepo.repo
            session.branch = switchedRepo.branch
            session.worktreeDir = switchedRepo.worktreeDir
        }
        // Same for a move into a Sandbox: the row keeps saying "this machine"
        // until the poll returns the provider the server already recorded.
        if let attachedSandbox, session.sandbox?.provider != attachedSandbox.provider {
            session.sandbox = attachedSandbox
        }
        return session
    }

    private var loadIdentity: String {
        [
            currentSession.id,
            currentSession.workspaceId ?? "",
            currentSession.worktreeDir ?? "",
            currentSession.branch ?? "",
            String(currentSession.attachedRepos?.count ?? 0),
        ].joined(separator: "|")
    }

    /// `verbatim:` on every count here and in the file rows: `Text("+\(n)")`
    /// goes through LocalizedStringKey, which formats the number for the
    /// device's locale — a 1174-line diff read "+1.174" on a Dutch phone.
    private func diffTotals(_ diff: OS1API.SessionDiff) -> some View {
        HStack(spacing: 6) {
            if diff.totalAdditions > 0 {
                Text(verbatim: "+\(diff.totalAdditions)").foregroundStyle(OS1VisualStyle.greenInk)
            }
            if diff.totalDeletions > 0 {
                Text(verbatim: "−\(diff.totalDeletions)").foregroundStyle(OS1VisualStyle.redInk)
            }
        }
        .font(.caption.weight(.semibold).monospacedDigit())
    }

}

/// The overview as a pushed page. The conversation hands over its live view
/// model; the model list the run settings pick from is fetched here, once.
struct WorktreeOverviewPage: View {
    let viewModel: SessionViewModel
    let sessions: [Session]
    @State private var catalog: ModelCatalog?

    var body: some View {
        WorktreeInfoView(viewModel: viewModel, sessions: sessions, catalog: catalog)
            .task(id: viewModel.session.workspaceId) {
                catalog = try? await OS1API.models(
                    workspaceId: viewModel.session.workspaceId
                )
            }
    }
}

/// Opens workspace details directly from a list-row context menu while still
/// giving its model controls the live session socket they use in SessionView.
struct WorktreeInfoSheet: View {
    @State private var viewModel: SessionViewModel
    @State private var catalog: ModelCatalog?
    @Bindable private var listViewModel: SessionsListViewModel
    private let fallbackWorkspace: SidebarWorkspace

    init(workspace: SidebarWorkspace, listViewModel: SessionsListViewModel) {
        _viewModel = State(initialValue: SessionViewModel(session: workspace.mainSession))
        self.listViewModel = listViewModel
        fallbackWorkspace = workspace
    }

    var body: some View {
        let workspace = SessionsListViewModel.sidebarWorkspaces(
            in: listViewModel.sessions,
            workspaceNames: listViewModel.workspaceNames
        ).first { workspace in
            workspace.sessions.contains { $0.id == viewModel.session.id }
        } ?? fallbackWorkspace

        NavigationStack {
            WorktreeInfoView(
                viewModel: viewModel,
                sessions: workspace.sessions,
                catalog: catalog,
                showsClose: true
            )
        }
            .task {
                viewModel.start()
                if !AppLifecycle.isActive { viewModel.appDidEnterBackground() }
                catalog = try? await OS1API.models(
                    workspaceId: viewModel.session.workspaceId
                )
            }
            .task {
                for await _ in NotificationCenter.default.notifications(
                    named: AppLifecycle.didBecomeActiveNotification
                ) {
                    viewModel.appDidBecomeActive()
                }
            }
            .task {
                for await _ in NotificationCenter.default.notifications(
                    named: AppLifecycle.willResignActiveNotification
                ) {
                    viewModel.appDidEnterBackground()
                }
            }
            .onDisappear { viewModel.stop() }
    }
}

private struct InfoSection<Content: View>: View {
    let title: String
    var trailing: AnyView? = nil
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(title)
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(OS1VisualStyle.textDim)
                Spacer()
                trailing
            }
            VStack(spacing: 0) { content }
                .background(
                    OS1VisualStyle.raised,
                    in: RoundedRectangle(cornerRadius: 14, style: .continuous)
                )
        }
    }
}

/// A section title on the overview: larger than the reference sections'
/// labels, because these are the page's main answers.
private struct OverviewHeading: View {
    let title: String
    var count: Int? = nil

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(title)
                .font(.title3.weight(.bold))
                .foregroundStyle(OS1VisualStyle.text)
            if let count {
                Text(verbatim: "\(count)")
                    .font(.subheadline.weight(.semibold).monospacedDigit())
                    .foregroundStyle(OS1VisualStyle.textDim)
            }
        }
    }
}

private struct WorkspaceImageSelection: Identifiable {
    let index: Int
    var id: Int { index }
}

private struct WorkspaceMediaItem: Identifiable {
    enum Source {
        case conversation(OS1API.WorkspaceOverview.Media)
        case asset(OS1API.SessionAsset)
    }

    let id: String
    let source: Source
    let kind: AssetVisualKind
    let sessionId: String
    let src: String
    let caption: String?
    let accessibilityLabel: String

    static func conversation(
        _ media: OS1API.WorkspaceOverview.Media,
        label: String?
    ) -> WorkspaceMediaItem {
        let kind = media.kind == "video" ? "recording" : "image"
        return WorkspaceMediaItem(
            id: media.id,
            source: .conversation(media),
            kind: media.kind == "video" ? .video : .image,
            sessionId: media.sessionId,
            src: media.src,
            caption: nil,
            accessibilityLabel: ["Open conversation \(kind)", label]
                .compactMap { $0 }
                .joined(separator: ", ")
        )
    }

    static func asset(
        _ asset: OS1API.SessionAsset,
        sessionId: String
    ) -> WorkspaceMediaItem {
        WorkspaceMediaItem(
            id: "asset|\(asset.path)|\(asset.mtime)",
            source: .asset(asset),
            kind: AssetVisualKind.of(asset) ?? .image,
            sessionId: sessionId,
            src: asset.path,
            caption: asset.name,
            accessibilityLabel: ["Open \(asset.name)", asset.description]
                .compactMap { $0 }
                .joined(separator: ", ")
        )
    }
}

/// A glanceable row of pictures and recordings on the overview page. This
/// follows native canvas grammar rather than copying the browser's responsive
/// arithmetic: stable touch-sized cards, view-aligned horizontal scrolling,
/// and a clipped next card that leaves the continuation discoverable.
private struct WorkspaceMediaStrip: View {
    let items: [WorkspaceMediaItem]
    /// The overview's carousel: cards most of the page wide, one at a time.
    var large = false
    let onOpen: (WorkspaceMediaItem) -> Void

    private var frameWidth: CGFloat { large ? 300 : 152 }
    private var frameHeight: CGFloat { large ? 188 : 96 }

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            LazyHStack(alignment: .top, spacing: 10) {
                ForEach(items) { item in
                    Button { onOpen(item) } label: {
                        VStack(alignment: .leading, spacing: 6) {
                            WorkspaceMediaFrame(item: item, fill: large)
                                .frame(width: frameWidth, height: frameHeight)
                                            if let caption = item.caption {
                                Text(caption)
                                    .font(.caption)
                                    .foregroundStyle(OS1VisualStyle.textDim)
                                    .lineLimit(1)
                                    .frame(width: frameWidth, alignment: .leading)
                            }
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(item.accessibilityLabel)
                }
            }
            .scrollTargetLayout()
        }
        .contentMargins(.horizontal, large ? 0 : 12, for: .scrollContent)
        .contentMargins(.vertical, large ? 0 : 12, for: .scrollContent)
        // On the overview the strip keeps the page's margin, so the first
        // card lines up with the text above, and draws past it so the next
        // card peeks in from the screen edge.
        .scrollClipDisabled(large)
        .scrollTargetBehavior(.viewAligned(limitBehavior: .always))
    }
}

private struct WorkspaceMediaFrame: View {
    let item: WorkspaceMediaItem
    /// Fill the frame edge to edge (the overview's carousel) rather than
    /// letterboxing the whole picture inside it.
    var fill = false

    @State private var image: UIImage?
    @State private var failed = false

    private static let cache = NSCache<NSString, UIImage>()
    private static let maximumVideoDownload = 32 * 1024 * 1024

    var body: some View {
        ZStack {
            OS1VisualStyle.background
            if let image, fill {
                // Sized by the frame, not the picture, so filling it cannot
                // grow the card past its slot.
                Color.clear.overlay {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFill()
                }
                .clipped()
            } else if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
                    .padding(4)
            } else if failed {
                Image(systemName: item.kind == .video ? "play.rectangle" : "photo")
                    .font(.title3)
                    .foregroundStyle(OS1VisualStyle.textFaint)
            } else {
                ProgressView().controlSize(.small)
            }
            if item.kind == .video {
                Image(systemName: "play.fill")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: 34, height: 34)
                    .background(.black.opacity(0.55), in: Circle())
                    .offset(x: 1)
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: fill ? 18 : 10, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: fill ? 18 : 10, style: .continuous)
                .stroke(OS1VisualStyle.border, lineWidth: 0.5)
        }
        .task(id: item.id) { await load() }
    }

    private func load() async {
        if let cached = Self.cache.object(forKey: item.id as NSString) {
            image = cached
            failed = false
            return
        }
        image = nil
        failed = false
        do {
            switch item.kind {
            case .image:
                let data = try await imageData()
                guard !Task.isCancelled else { return }
                image = Self.thumbnail(from: data)
            case .video:
                image = try await videoFrame()
            }
            if let image { Self.cache.setObject(image, forKey: item.id as NSString) }
            failed = image == nil
        } catch {
            guard !Task.isCancelled else { return }
            failed = true
        }
    }

    private func imageData() async throws -> Data {
        switch item.source {
        case .conversation:
            return try await DisplayableImageData.prepared(
                OS1API.conversationImage(source: item.src, sessionId: item.sessionId)
            )
        case .asset:
            return try await DisplayableImageData.prepared(
                OS1API.assetData(sessionId: item.sessionId, path: item.src)
            )
        }
    }

    private func videoFrame() async throws -> UIImage? {
        let asset: AVURLAsset
        switch item.source {
        case .conversation:
            guard let url = OS1API.conversationImageURL(
                source: item.src,
                base: ServerConfig.shared.baseURL
            ) else { return nil }
            asset = AVURLAsset(url: url)
        case .asset:
            if case .asset(let asset) = item.source,
               asset.size > Self.maximumVideoDownload {
                return nil
            }
            guard let url = OS1API.assetURL(sessionId: item.sessionId, path: item.src)
            else { return nil }
            let request = ServerConfig.shared.authorizedRequest(url)
            let (temporaryURL, response) = try await URLSession.shared.download(for: request)
            defer { try? FileManager.default.removeItem(at: temporaryURL) }
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode)
            else { return nil }
            asset = AVURLAsset(url: temporaryURL)
        }
        let generator = AVAssetImageGenerator(asset: asset)
        generator.appliesPreferredTrackTransform = true
        generator.maximumSize = CGSize(width: 960, height: 600)
        let result = try await generator.image(at: CMTime(seconds: 0.1, preferredTimescale: 600))
        return UIImage(cgImage: result.image)
    }

    private static func thumbnail(from data: Data) -> UIImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let image = CGImageSourceCreateThumbnailAtIndex(
                  source,
                  0,
                  [
                      kCGImageSourceCreateThumbnailFromImageAlways: true,
                      kCGImageSourceCreateThumbnailWithTransform: true,
                      kCGImageSourceThumbnailMaxPixelSize: 960,
                  ] as CFDictionary
              )
        else { return nil }
        return UIImage(cgImage: image)
    }
}

private struct WorkspaceVideoPreview: View {
    let media: OS1API.WorkspaceOverview.Media

    @Environment(\.dismiss) private var dismiss
    @State private var player: AVPlayer?

    var body: some View {
        NavigationStack {
            Group {
                if let player {
                    VideoPlayer(player: player)
                        .background(.black)
                        .onDisappear { player.pause() }
                } else {
                    ProgressView().controlSize(.large)
                }
            }
            .navigationTitle(media.sessionTitle ?? "Recording")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .task {
                guard player == nil,
                      let url = OS1API.conversationImageURL(
                          source: media.src,
                          base: ServerConfig.shared.baseURL
                      )
                else { return }
                player = AVPlayer(url: url)
            }
        }
    }
}

private struct InfoRow: View {
    let label: String
    let value: String
    let icon: String
    var monospaced = false

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Label(label, systemImage: icon)
                .font(.subheadline)
                .foregroundStyle(OS1VisualStyle.textDim)
            Spacer(minLength: 12)
            Text(value)
                .font(monospaced ? .caption.monospaced() : .subheadline)
                .foregroundStyle(OS1VisualStyle.text)
                .multilineTextAlignment(.trailing)
                .textSelection(.enabled)
        }
        .padding(.horizontal, 12)
        .frame(minHeight: 46)
    }
}

private struct SettingsRow: View {
    let label: String
    let value: String
    let icon: String

    var body: some View {
        HStack(spacing: 10) {
            Label(label, systemImage: icon)
                .font(.subheadline)
                .foregroundStyle(OS1VisualStyle.text)
            Spacer()
            Text(value)
                .font(.subheadline)
                .foregroundStyle(OS1VisualStyle.textDim)
                .lineLimit(1)
            Image(systemName: "chevron.up.chevron.down")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(OS1VisualStyle.textFaint)
        }
        .padding(.horizontal, 12)
        .frame(minHeight: 48)
        .contentShape(Rectangle())
    }
}

private struct StatusPill: View {
    let text: String
    let icon: String
    let color: Color

    var body: some View {
        Label(text, systemImage: icon)
            .font(.caption.weight(.semibold))
            .foregroundStyle(color)
            .padding(.horizontal, 9)
            .padding(.vertical, 6)
            .background(color.opacity(0.12), in: Capsule())
    }
}

private struct SummaryBlock: View {
    let label: String
    let content: String
    var lines = 5

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(label)
                .font(.caption.weight(.semibold))
                .foregroundStyle(OS1VisualStyle.textDim)
            Text(Self.inline(content))
                .font(.subheadline)
                .foregroundStyle(OS1VisualStyle.text)
                .lineLimit(lines)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
    }

    /// Agent messages are markdown, and a preview that prints the syntax —
    /// `**The rail was wrong**`, backticked shas — reads worse than no
    /// formatting at all. Inline-only: this is a few lines of a message, so
    /// headings and list markers have nowhere to go, and stripping their
    /// leading punctuation keeps the first line from starting on a "#".
    private static func inline(_ content: String) -> AttributedString {
        let stripped = content
            .split(separator: "\n", omittingEmptySubsequences: false)
            .map { line -> Substring in
                var line = line
                while let first = line.first, first == "#" || first == ">" {
                    line = line.dropFirst()
                    if line.first == " " { line = line.dropFirst() }
                }
                return line
            }
            .joined(separator: "\n")
        let parsed = try? AttributedString(
            markdown: stripped,
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        )
        return parsed ?? AttributedString(stripped)
    }
}

#endif
