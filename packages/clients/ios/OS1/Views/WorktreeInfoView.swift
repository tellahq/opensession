import SwiftUI

#if os(iOS)
import AVFoundation
import AVKit
import ImageIO
import UIKit

/// Native counterpart of mobile web's title-opened workspace info page.
struct WorktreeInfoView: View {
    @Bindable var viewModel: SessionViewModel
    let sessions: [Session]
    let catalog: ModelCatalog?

    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    /// A detail of this session opened one level deeper INSIDE this sheet —
    /// its assets, one of those files, its pull request. Pushed on the sheet's
    /// own stack rather than the session's: this page is where you are, so
    /// the chevron comes back here and the sheet never has to be dismissed.
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
    /// row agrees. Without it the sheet keeps showing the repo just left.
    @State private var switchedRepo: OS1API.SwitchedRepo?
    @State private var effectiveConfig = EffectiveConfigViewModel()

    var body: some View {
        NavigationStack {
            ScrollView {
                // Ordered by what the sheet is opened to find out: what this
                // workspace is doing and what came out of it. The worktree's
                // own metadata — branch, path, mode — changes once and is
                // reference material, so it sits below the answer rather than
                // filling the first screen with it.
                LazyVStack(alignment: .leading, spacing: 22) {
                    hero
                    overviewSection
                    conversationSection
                    reviewSection
                    pullRequestSection
                    workSection
                    assetsSection
                    worktreeSection
                    sandboxSection
                    runnerSection
                    runSettingsSection
                    effectiveConfigSection
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 28)
            }
            .background(OS1VisualStyle.background)
            .navigationTitle("Workspace")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .task(id: loadIdentity) { await load() }
            .task(id: effectiveConfigIdentity) {
                // Model controls update the session optimistically, then send
                // over the socket. Let that write land before forecasting it.
                try? await Task.sleep(for: .milliseconds(150))
                guard !Task.isCancelled else { return }
                await effectiveConfig.load(sessionId: currentSession.id)
            }
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
                // Opened from the workspace sheet, so the viewer keeps saying
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
    }

    private var hero: some View {
        VStack(spacing: 9) {
            RepoTile(name: currentSession.effectiveRepo, size: 52, round: true)
            Text(currentSession.displayTitle)
                .font(.title2.weight(.bold))
                .multilineTextAlignment(.center)
            Text(heroSubtitle)
                .font(.subheadline)
                .foregroundStyle(OS1VisualStyle.textDim)
                .multilineTextAlignment(.center)
            if let stateLabel {
                HStack(spacing: 5) {
                    Label(stateLabel.text, systemImage: stateLabel.icon)
                    // The state alone can't say whether this started a minute
                    // ago or has been going for an hour, which is the whole
                    // question when you open the sheet on a running workspace.
                    if viewModel.isRunning, let since = viewModel.runStartedAt {
                        Text("·").foregroundStyle(stateLabel.color.opacity(0.6))
                        RunElapsedLabel(since: since)
                    }
                }
                .font(.caption.weight(.semibold))
                .foregroundStyle(stateLabel.color)
                .padding(.horizontal, 10)
                .padding(.vertical, 5)
                .background(stateLabel.color.opacity(0.12), in: Capsule())
            }
            if let heroFooter {
                Text(heroFooter)
                    .font(.caption)
                    .foregroundStyle(OS1VisualStyle.textFaint)
                    .multilineTextAlignment(.center)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 18)
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
        if !assets.isEmpty {
            InfoSection(
                title: "Assets",
                trailing: AnyView(
                    Text(verbatim: "\(assets.count)")
                        .font(.caption.weight(.semibold).monospacedDigit())
                        .foregroundStyle(OS1VisualStyle.textDim)
                )
            ) {
                if !visualAssets.isEmpty {
                    WorkspaceMediaStrip(
                        items: visualAssets.map {
                            WorkspaceMediaItem.asset($0, sessionId: currentSession.id)
                        },
                        onOpen: { item in
                            guard case .asset(let asset) = item.source else { return }
                            panel = .asset(sessionId: currentSession.id, path: asset.path)
                        }
                    )
                }
                let shown = Array(fileAssets.prefix(8))
                if !visualAssets.isEmpty, !shown.isEmpty { Divider() }
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
    /// itself: whether anybody has looked at this is the question the sheet is
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
                    // other session link does: the list behind this sheet.
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
        let primaryNumber = viewModel.prDetails?.number ?? currentSession.prNumber
        if !rows.isEmpty || primaryNumber != nil {
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
                    includePrimary: primaryNumber == nil
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
            // The overview is the slowest thing on the sheet (it reads every
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

    @ViewBuilder
    private var conversationSection: some View {
        let media = conversationMedia
        if !media.isEmpty {
            // The strip carries recordings too, but screenshots are what people
            // call the set. Same word the web card and panel head it with.
            InfoSection(
                title: "Screenshots",
                trailing: AnyView(
                    Text(verbatim: "\(media.count)")
                        .font(.caption.weight(.semibold).monospacedDigit())
                        .foregroundStyle(OS1VisualStyle.textDim)
                )
            ) {
                WorkspaceMediaStrip(
                    items: media.map {
                        WorkspaceMediaItem.conversation($0, label: mediaLabel($0))
                    },
                    onOpen: openConversationMedia
                )
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
                            if let routed { viewModel.changeModel(to: routed) }
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
                            if let routed { viewModel.changeModel(to: routed) }
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

            if catalog?.option(for: currentModel)?.fastModeSupported == true {
                Divider()
                Toggle(isOn: $viewModel.fastMode) {
                    Label("Fast mode", systemImage: "bolt")
                        .font(.subheadline)
                }
                .padding(.horizontal, 12)
                .frame(minHeight: 48)
            }
        }
    }

    private var effectiveConfigSection: some View {
        InfoSection(title: "Effective config") {
            EffectiveConfigInfoContent(
                model: effectiveConfig,
                retry: {
                    Task { await effectiveConfig.load(sessionId: currentSession.id) }
                }
            )
        }
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
        switch currentSession.prState {
        case "OPEN": return ("In review", "arrow.triangle.pull", OS1VisualStyle.yellow)
        case "MERGED": return ("Merged", "checkmark", OS1VisualStyle.purple)
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
        let (nextGit, nextDiffResponse, nextAssets, nextOverview, nextSandbox) = await (
            gitResult,
            diffResult,
            assetsResult,
            overviewResult,
            sandboxResult
        )
        let (nextRepos, nextSwitchable) = await (reposResult, switchableResult)
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
        #endif
    }

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
        async let details: Void = load()
        async let config: Void = effectiveConfig.load(sessionId: currentSession.id)
        await details
        await config
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
        // part of this sheet reads the session (the hero tile, the branch and
        // path rows, the git status keyed on `loadIdentity`), so the whole
        // page moves to the new worktree at once rather than in pieces.
        if let switchedRepo, session.repo != switchedRepo.repo {
            session.repo = switchedRepo.repo
            session.branch = switchedRepo.branch
            session.worktreeDir = switchedRepo.worktreeDir
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

    private var effectiveConfigIdentity: String {
        [
            currentSession.id,
            currentModel,
            viewModel.effort,
            String(viewModel.fastMode),
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

        WorktreeInfoView(viewModel: viewModel, sessions: workspace.sessions, catalog: catalog)
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

/// A glanceable row of pictures and recordings in the workspace sheet. This
/// follows native canvas grammar rather than copying the browser's responsive
/// arithmetic: stable touch-sized cards, view-aligned horizontal scrolling,
/// and a clipped next card that leaves the continuation discoverable.
private struct WorkspaceMediaStrip: View {
    let items: [WorkspaceMediaItem]
    let onOpen: (WorkspaceMediaItem) -> Void

    private let frameWidth: CGFloat = 152
    private let frameHeight: CGFloat = 96

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            LazyHStack(alignment: .top, spacing: 10) {
                ForEach(items) { item in
                    Button { onOpen(item) } label: {
                        VStack(alignment: .leading, spacing: 6) {
                            WorkspaceMediaFrame(item: item)
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
        .contentMargins(.horizontal, 12, for: .scrollContent)
        .contentMargins(.vertical, 12, for: .scrollContent)
        .scrollTargetBehavior(.viewAligned(limitBehavior: .always))
    }
}

private struct WorkspaceMediaFrame: View {
    let item: WorkspaceMediaItem

    @State private var image: UIImage?
    @State private var failed = false

    private static let cache = NSCache<NSString, UIImage>()
    private static let maximumVideoDownload = 32 * 1024 * 1024

    var body: some View {
        ZStack {
            OS1VisualStyle.background
            if let image {
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
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 10, style: .continuous)
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
            return try await OS1API.conversationImage(source: item.src, sessionId: item.sessionId)
        case .asset:
            return try await OS1API.assetData(sessionId: item.sessionId, path: item.src)
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
        generator.maximumSize = CGSize(width: 608, height: 384)
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
                      kCGImageSourceThumbnailMaxPixelSize: 608,
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
