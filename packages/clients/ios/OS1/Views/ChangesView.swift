import SwiftUI

#if os(iOS)
/// Everything the session's worktree has changed — the native counterpart of
/// the web viewer's Changes tab.
///
/// The workspace sheet has always summarised this (a count, the first handful
/// of files) and then sent people to a browser for the rest. This is the rest:
/// every file, and the diff of any one of them.
///
/// One fetch does it. `GET /api/sessions/:id/diff` answers the file list and
/// the whole worktree's patch together, so a file's diff is a split of what is
/// already in hand rather than a request per row. The split runs once per
/// load, off the main actor, into a path-keyed index — a worktree diff is
/// routinely megabytes, and splitting it inside a row's body would do that
/// work once per file per redraw.
struct ChangesView: View {
    let sessionId: String
    /// Open this file's diff straight away instead of the list — what the
    /// workspace sheet's file rows pass, since they are already the list.
    var focus: String?
    /// The session is mid-run: the ship buttons wait for it to finish.
    var isRunning = false

    @State private var repos: [OS1API.RepoDiff] = []
    /// repo id → path → that file's section of the repo's patch.
    @State private var patchIndex: [String: [String: FilePatch]] = [:]
    @State private var selectedRepo: String?
    @State private var loading = true
    @State private var loadFailed = false
    /// The file being read, pushed one level deeper.
    @State private var openFile: FilePatch?
    /// repo id → path → hash of that file's diff.
    @State private var hashIndex: [String: [String: String]] = [:]
    /// repo id → this device's review marks for that repo's worktree.
    @State private var marksByRepo: [String: PrReviewMarks] = [:]
    /// Ship, Create PR or Update PR and the repo's own actions; nil when the
    /// session has nothing to ship to.
    @State private var ship: SessionShipInfo.Details?
    /// The ship button just pressed, held as sent for a few seconds.
    @State private var sentShip: String?
    @State private var shipError: String?

    /// Where the worktree diff comes from; the screenshot fixture swaps it.
    var loadDiff: @MainActor (String) async throws -> OS1API.SessionDiffResponse = {
        try await OS1API.sessionDiff(sessionId: $0)
    }
    /// A worktree has no provider-side viewed state, so review marks stay on
    /// this device, keyed by each file's diff: an agent edit to a reviewed
    /// file shows it as changed since review.
    var reviewStore = PrLocalReviewStore()
    /// Where the ship buttons come from; the screenshot fixture swaps it.
    var loadShip: @MainActor (String) async throws -> SessionShipInfo = {
        try await OS1API.sessionShip(sessionId: $0)
    }
    /// Sends a ship button's prompt through the session's outbox, the same
    /// path a typed message and the sidebar's PR actions take. False when the
    /// outbox refused it.
    var sendPrompt: @MainActor (String, String) -> Bool = { sessionId, prompt in
        let busyMode = UserDefaults.standard.string(forKey: "os1.composer.busySend") ?? "queue"
        return Outbox.shared.enqueue(
            sessionId: sessionId,
            content: prompt,
            busyMode: busyMode,
            user: ServerConfig.shared.userName
        ) != nil
    }

    var body: some View {
        Group {
            if let focus {
                focusedFile(focus)
            } else if loading && repos.isEmpty {
                ProgressView()
                    .controlSize(.large)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if loadFailed && repos.isEmpty {
                failedPlaceholder
            } else if activeDiff?.files.isEmpty ?? true {
                emptyPlaceholder
            } else {
                fileList
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(OS1VisualStyle.background)
        .navigationTitle(focus.map(Self.fileName) ?? "Changes")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                if let focus, let file = focusedPatch(focus) {
                    Button {
                        copyToPasteboard(file.patch)
                    } label: {
                        Label("Copy patch", systemImage: "doc.on.doc")
                    }
                } else if focus == nil {
                    Button {
                        Task { await load() }
                    } label: {
                        Label("Refresh", systemImage: "arrow.clockwise")
                    }
                }
            }
        }
        .navigationDestination(item: $openFile) { file in
            FileDiffView(file: file)
        }
        .task(id: sessionId) { await load() }
        // A run that just ended may have shipped or changed the worktree.
        .onChange(of: isRunning) { _, running in
            if !running {
                sentShip = nil
                if focus == nil { Task { await load() } }
            }
        }
        .alert(
            "Couldn't send",
            isPresented: Binding(get: { shipError != nil }, set: { if !$0 { shipError = nil } })
        ) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(shipError ?? "")
        }
    }

    // MARK: - Ship

    @ViewBuilder
    private var shipSections: some View {
        if let ship {
            if let latest = ship.latestShip {
                Section {
                    DirectShipNoticeView(ship: latest)
                }
            }
            if !ship.buttons.isEmpty {
                Section {
                    ShipActionsBand(
                        info: ship,
                        isRunning: isRunning,
                        sent: sentShip,
                        run: runShip
                    )
                }
            }
        }
    }

    private func runShip(_ button: ShipButton) {
        guard !isRunning, sentShip != button.id else { return }
        guard sendPrompt(sessionId, button.prompt) else {
            shipError = "Too many unsent messages. Send or delete some first."
            return
        }
        Haptics.play(.send)
        sentShip = button.id
        Task {
            try? await Task.sleep(for: .seconds(6))
            if sentShip == button.id { sentShip = nil }
        }
    }

    // MARK: - The list

    @ViewBuilder
    private var fileList: some View {
        if let diff = activeDiff {
            List {
                shipSections
                if changedRepos.count > 1 {
                    Section {
                        Picker("Repository", selection: repoSelection) {
                            ForEach(changedRepos, id: \.repo) { repo in
                                Text(RepoTile.label(for: repo.repo)).tag(repo.repo)
                            }
                        }
                        .pickerStyle(.segmented)
                    }
                }
                if let marks = activeMarks {
                    let paths = diff.files.map(\.path)
                    let reviewed = paths.filter(marks.reviewed.contains).count
                    let changed = paths.filter(marks.changed.contains).count
                    Section {
                        PrReviewProgressHeader(
                            total: paths.count,
                            reviewed: reviewed,
                            changed: changed,
                            bulk: { action in
                                let change = PrReviewGroups.bulkChanges(
                                    paths, reviewed: marks.reviewed, action: action
                                )
                                setReviewed(change.mark, reviewed: true)
                                setReviewed(change.unmark, reviewed: false)
                            }
                        )
                        .padding(.vertical, 4)
                        if changed > 0 {
                            PrReviewCallout(
                                tone: .warning,
                                symbol: "exclamationmark.arrow.circlepath",
                                title: "\(changed) file\(changed == 1 ? "" : "s") changed since you reviewed \(changed == 1 ? "it" : "them")",
                                message: "These files were edited after you marked them reviewed. Read them again."
                            )
                            .listRowInsets(EdgeInsets())
                        }
                    }
                }
                Section {
                    ForEach(diff.files) { file in
                        row(file)
                    }
                } header: {
                    Text(
                        "\(diff.files.count) file"
                        + "\(diff.files.count == 1 ? "" : "s") changed · "
                        + "+\(diff.totalAdditions) −\(diff.totalDeletions)"
                    )
                } footer: {
                    if diff.truncated == true {
                        Text("This diff is too large to send in full. The "
                             + "files above are what fit.")
                    } else if let base = diff.baseRef, !base.isEmpty {
                        Text(verbatim: "Against \(base), including uncommitted work.")
                    }
                }
            }
            .listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
            .background(OS1VisualStyle.background)
            .refreshable { await load() }
        }
    }

    private func row(_ file: OS1API.DiffFile) -> some View {
        let patch = patch(for: file)
        let state = activeMarks?.state(of: file.path) ?? .unreviewed
        return HStack(spacing: 10) {
            // Only a file with a diff has a hash to vouch for.
            if activeMarks != nil, patch != nil {
                PrReviewStateButton(state: state) {
                    setReviewed([file.path], reviewed: state != .reviewed)
                }
            }
            fileButton(file, patch: patch, state: state)
        }
        .listRowBackground(
            state == .changed ? OS1VisualStyle.yellow.opacity(0.10) : nil
        )
    }

    private func fileButton(_ file: OS1API.DiffFile, patch: FilePatch?, state: PrFileReviewState) -> some View {
        Button {
            openFile = patch
        } label: {
            HStack(spacing: 10) {
                Image(systemName: DiffFileStyle.icon(file.status))
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(DiffFileStyle.color(file.status))
                    .frame(width: 20)
                VStack(alignment: .leading, spacing: 1) {
                    if state == .changed {
                        PrChangedSinceReviewBadge().padding(.bottom, 2)
                    }
                    Text(Self.fileName(file.path))
                        .font(.subheadline)
                        .foregroundStyle(OS1VisualStyle.text)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    if let directory = Self.directory(file.path) {
                        Text(directory)
                            .font(.caption2.monospaced())
                            .foregroundStyle(OS1VisualStyle.textDim)
                            .lineLimit(1)
                            .truncationMode(.head)
                    }
                }
                Spacer(minLength: 8)
                Text(counts(file))
                    .font(.caption.monospacedDigit())
                if patch != nil {
                    Image(systemName: "chevron.right")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(OS1VisualStyle.textDim)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        // A binary file, or one the patch was truncated before reaching:
        // there is nothing to push, and a row that pushes nothing is worse
        // than one that doesn't offer to.
        .disabled(patch == nil)
    }

    private func counts(_ file: OS1API.DiffFile) -> AttributedString {
        if file.binary == true {
            var binary = AttributedString("binary")
            binary.foregroundColor = OS1VisualStyle.textDim
            return binary
        }
        var output = AttributedString()
        if file.additions > 0 {
            var additions = AttributedString("+\(file.additions)")
            additions.foregroundColor = OS1VisualStyle.greenInk
            output.append(additions)
        }
        if file.deletions > 0 {
            if !output.characters.isEmpty { output.append(AttributedString(" ")) }
            var deletions = AttributedString("−\(file.deletions)")
            deletions.foregroundColor = OS1VisualStyle.redInk
            output.append(deletions)
        }
        return output
    }

    /// The single file a workspace-sheet row asked for. Looked up across every
    /// repo in the session: that row doesn't say which repo it came from.
    @ViewBuilder
    private func focusedFile(_ path: String) -> some View {
        if let file = focusedPatch(path) {
            FileDiffView(file: file, chrome: .bare)
        } else if loading {
            ProgressView()
                .controlSize(.large)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            ListPlaceholder(
                symbol: "doc.text.magnifyingglass",
                title: "No diff for this file",
                message: "It may be binary, or the worktree may have moved on "
                    + "since this list was drawn."
            ) {
                Button("Reload") { Task { await load() } }
                    .buttonStyle(PlaceholderActionStyle())
            }
        }
    }

    // MARK: - Placeholders

    private var emptyPlaceholder: some View {
        VStack(spacing: 0) {
            // Shipping directly leaves the worktree level with its base, so
            // the empty state is where the latest ship is usually read.
            if let latest = ship?.latestShip {
                DirectShipNoticeView(ship: latest)
                    .padding(14)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(OS1VisualStyle.raised, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .padding(.horizontal, 16)
                    .padding(.top, 12)
            }
            ListPlaceholder(
                symbol: "checkmark.circle",
                title: "No changes",
                message: "This worktree matches its base branch."
            ) {
                EmptyView()
            }
        }
    }

    private var failedPlaceholder: some View {
        ListPlaceholder(
            symbol: "exclamationmark.triangle",
            title: "Couldn't load changes",
            message: "The server didn't answer for this session's diff."
        ) {
            Button("Try again") { Task { await load() } }
                .buttonStyle(PlaceholderActionStyle())
        }
    }

    // MARK: - Data

    /// Only repos with something to show. A session with an attached repo it
    /// never touched should get no picker at all.
    private var changedRepos: [OS1API.RepoDiff] {
        repos.filter { !$0.diff.files.isEmpty }
    }

    private var activeRepo: OS1API.RepoDiff? {
        if let selectedRepo,
           let match = changedRepos.first(where: { $0.repo == selectedRepo }) {
            return match
        }
        return changedRepos.first { $0.primary } ?? changedRepos.first
    }

    private var activeDiff: OS1API.SessionDiff? { activeRepo?.diff }

    private var activeMarks: PrReviewMarks? {
        activeRepo.flatMap { marksByRepo[$0.repo] }
    }

    private func setReviewed(_ paths: [String], reviewed: Bool) {
        guard !paths.isEmpty, let repo = activeRepo?.repo,
              case .local(let key) = marksByRepo[repo]?.source else { return }
        let hashes = hashIndex[repo] ?? [:]
        let stored = reviewStore.setReviewed(key, paths: paths, reviewed: reviewed, hashes: hashes)
        marksByRepo[repo] = .local(key: key, stored: stored, hashes: hashes)
    }

    private var repoSelection: Binding<String> {
        Binding(
            get: { activeRepo?.repo ?? "" },
            set: { selectedRepo = $0 }
        )
    }

    private func patch(for file: OS1API.DiffFile) -> FilePatch? {
        guard let repo = activeRepo?.repo else { return nil }
        return patchIndex[repo]?[file.path]
    }

    private func focusedPatch(_ path: String) -> FilePatch? {
        for repo in repos {
            if let match = patchIndex[repo.repo]?[path] { return match }
        }
        return nil
    }

    private func load() async {
        loading = true
        loadFailed = false
        // The ship info moves with the diff (a new commit, a push, a PR), so
        // every diff load refetches it alongside.
        let shipFetch = focus == nil ? Task { try? await loadShip(sessionId) } : nil
        let response = try? await loadDiff(sessionId)
        if let shipInfo = await shipFetch?.value {
            ship = shipInfo.info
        }
        guard !Task.isCancelled else { return }
        if let response {
            let loaded = response.repos
            // Splitting a multi-megabyte patch is the one expensive thing
            // here; keep it off the main actor like every other decode.
            let (index, hashes) = await Task.detached(priority: .userInitiated) {
                var index: [String: [String: FilePatch]] = [:]
                var hashes: [String: [String: String]] = [:]
                for repo in loaded {
                    let patches = PatchSplitter.split(repo.diff.rawPatch ?? "")
                    index[repo.repo] = Dictionary(
                        patches.map { ($0.path, $0) },
                        uniquingKeysWith: { first, _ in first }
                    )
                    hashes[repo.repo] = PrReviewHash.hashes(of: patches)
                }
                return (index, hashes)
            }.value
            guard !Task.isCancelled else { return }
            repos = loaded
            patchIndex = index
            hashIndex = hashes
            marksByRepo = Dictionary(uniqueKeysWithValues: loaded.map { repo in
                let key = PrLocalReviewStore.worktreeKey(sessionId: sessionId, repo: repo.repo)
                return (repo.repo, PrReviewMarks.local(
                    key: key,
                    stored: reviewStore.read(key),
                    hashes: hashes[repo.repo] ?? [:]
                ))
            })
            loadFailed = false
        } else {
            loadFailed = repos.isEmpty
        }
        loading = false
    }

    static func fileName(_ path: String) -> String {
        path.split(separator: "/").last.map(String.init) ?? path
    }

    static func directory(_ path: String) -> String? {
        let parts = path.split(separator: "/")
        guard parts.count > 1 else { return nil }
        return parts.dropLast().joined(separator: "/")
    }
}

/// One file's diff, full height.
private struct FileDiffView: View {
    let file: FilePatch
    /// `.bare` is for the case where this IS the panel: the panel already
    /// names the file in the navigation bar, and a second title would blank
    /// the first one.
    var chrome: Chrome = .titled

    enum Chrome { case titled, bare }

    var body: some View {
        ScrollView {
            DiffText(patch: file.patch, maxLines: 2_000)
                .padding(.horizontal, 14)
                .padding(.vertical, 12)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(OS1VisualStyle.background)
        .modifier(FileDiffChrome(file: file, chrome: chrome))
    }
}

/// The title + copy button, applied only when this view owns the bar.
private struct FileDiffChrome: ViewModifier {
    let file: FilePatch
    let chrome: FileDiffView.Chrome

    func body(content: Content) -> some View {
        if chrome == .titled {
            content
                .navigationTitle(ChangesView.fileName(file.path))
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button {
                            copyToPasteboard(file.patch)
                        } label: {
                            Label("Copy patch", systemImage: "doc.on.doc")
                        }
                    }
                }
        } else {
            content
        }
    }
}

/// How a changed file reads at a glance — shared so the workspace sheet's
/// summary and the full list can't drift apart.
enum DiffFileStyle {
    static func icon(_ status: String) -> String {
        switch status {
        case "added", "untracked": "plus"
        case "deleted": "minus"
        case "renamed": "arrow.right"
        default: "pencil"
        }
    }

    static func color(_ status: String) -> Color {
        switch status {
        case "added", "untracked": OS1VisualStyle.green
        case "deleted": OS1VisualStyle.red
        case "renamed": OS1VisualStyle.blue
        default: OS1VisualStyle.yellow
        }
    }
}
#endif
