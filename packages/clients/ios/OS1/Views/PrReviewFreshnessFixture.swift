import SwiftUI

#if DEBUG
/// The native screenshot harness's review-progress fixture
/// (`OS1_PR_REVIEW_FRESHNESS_FIXTURE`). Canned answers drive the real review
/// surfaces into the states that are hard to reach on demand:
///
/// - `pushed`: files reviewed on GitHub that a later push changed (DIRTY),
///   resolved comments, and a file the push removed.
/// - `stale`: the guide lens with a guide written before the latest push.
/// - `worktree`: the worktree Changes view (iOS) with one review mark whose
///   file was edited since; on the Mac, a PR on a host without viewed state,
///   which keeps marks on the device the same way.
/// - `ship-pr`, `ship-direct`: the same Changes view with its Ship band, for
///   a pull-request repo and a direct one with an earlier ship.
struct PrReviewFreshnessFixture: View {
    let mode: String
    @State private var lens: PrReviewCanvas.Lens

    init(mode: String) {
        self.mode = mode
        _lens = State(initialValue: mode == "stale" ? .guide : .all)
    }

    var body: some View {
        NavigationStack {
            content
                .navigationTitle(title)
                .inlineTitleBarCompat()
        }
    }

    private var title: String {
        switch mode {
        case "stale": "Review guide"
        case "worktree", "ship-pr", "ship-direct": "Changes"
        default: "Files"
        }
    }

    @ViewBuilder
    private var content: some View {
        #if os(iOS)
        if mode == "worktree" || mode.hasPrefix("ship-") {
            let ship = Self.shipInfo(direct: mode == "ship-direct")
            ChangesView(
                sessionId: "fixture",
                loadDiff: { _ in Self.worktreeResponse },
                reviewStore: Self.seededStore(
                    key: PrLocalReviewStore.worktreeKey(sessionId: "fixture", repo: "acme"),
                    hashes: PrReviewHash.hashes(of: PatchSplitter.split(Self.worktreePatch))
                ),
                loadShip: { _ in ship },
                sendPrompt: { _, _ in true }
            )
        } else {
            canvas
        }
        #else
        canvas
        #endif
    }

    private var canvas: some View {
        PrReviewCanvas(
            viewModel: SessionViewModel(session: Session(id: "fixture")),
            lens: $lens,
            loader: loader
        )
    }

    private var loader: PrReviewLoader {
        let local = mode == "worktree"
        return PrReviewLoader(
            diff: { PrDiff(number: 42, baseRefOid: "base", headRefOid: "head2", patch: Self.prPatch, diffVersion: nil, skippedFiles: nil) },
            viewed: { _ in
                PrViewedFiles(
                    prId: "PR_fixture",
                    viewed: ["Sources/Review/ReviewGuide.swift", "Tests/ReviewProgressTests.swift"],
                    changed: ["Sources/Review/ReviewStore.swift"]
                )
            },
            setViewed: { _, _, _ in },
            guide: { Self.staleGuide },
            flow: { nil },
            threads: { _ in Self.threads },
            localStore: local
                ? Self.seededStore(
                    key: PrLocalReviewStore.pullRequestKey(repo: nil, number: 42),
                    hashes: PrReviewHash.hashes(of: PrPatchParser.files(in: Self.prPatch))
                )
                : PrLocalReviewStore(),
            viewedState: !local,
            previousFiles: Self.previousFiles
        )
    }

    /// A store with one file reviewed at its current diff and one reviewed
    /// at an earlier version, so it reads as changed since review.
    private static func seededStore(key: String, hashes: [String: String]) -> PrLocalReviewStore {
        let defaults = UserDefaults(suiteName: "os1.fixture.review") ?? .standard
        let store = PrLocalReviewStore(defaults: defaults)
        store.write(key, [
            "Sources/Review/ReviewGuide.swift": hashes["Sources/Review/ReviewGuide.swift"] ?? "",
            "Sources/Review/ReviewStore.swift": "reviewed-before-edit",
        ])
        return store
    }

    static func shipInfo(direct: Bool) -> SessionShipInfo {
        let buttons = [
            ShipButton(
                id: "ship",
                label: direct ? "Ship" : "Create PR",
                prompt: direct ? "Ship this change." : "Create a pull request.",
                primary: true
            ),
            ShipButton(id: "changelog", label: "Write changelog", prompt: "Write the changelog entry."),
        ]
        let ships = direct ? [DirectShip(
            repo: "acme",
            branch: "feature/review",
            target: "main",
            sha: "9cc7c8a48d1e2f",
            previousSha: nil,
            commits: ["a1", "b2", "c3"],
            pushedAt: "2026-11-04T09:12:00Z",
            shippedAt: "2026-11-04T09:13:00Z"
        )] : []
        return SessionShipInfo(available: true, info: .init(
            repo: "acme",
            target: "main",
            checkout: "worktree",
            mode: direct ? "direct" : "pull-request",
            requested: direct ? "direct" : "pull-request",
            reason: "repository",
            openPr: nil,
            buttons: buttons,
            ships: ships
        ))
    }

    static let previousFiles = [
        "Sources/Review/ReviewStore.swift",
        "Sources/Review/ReviewGuide.swift",
        "Sources/Review/LegacyGroups.swift",
        "Tests/ReviewProgressTests.swift",
        "docs/review.md",
    ]

    static let staleGuide = PrReviewGuide(
        number: 42,
        headRefOid: "head1",
        sections: [
            .init(title: "Store review progress", explanation: "Where marks live and how a push invalidates them.", files: ["Sources/Review/ReviewStore.swift"]),
            .init(title: "Group by the guide", explanation: "One grouping for steps, the tree and progress.", files: ["Sources/Review/ReviewGuide.swift", "Sources/Review/LegacyGroups.swift"]),
            .init(title: "Tests and docs", explanation: "Fixtures for the new rules.", files: ["Tests/ReviewProgressTests.swift", "docs/review.md"]),
        ],
        stale: true
    )

    static let threads = [
        PrReviewThread(id: "t1", isResolved: true, isOutdated: false, path: "Sources/Review/ReviewStore.swift", line: 4, rootAuthor: "reviewer", comments: [.init(login: "reviewer", body: "Should a mark survive a rebase that leaves the hunk alone?")]),
        PrReviewThread(id: "t2", isResolved: true, isOutdated: true, path: "Sources/Review/ReviewGuide.swift", line: 2, rootAuthor: "reviewer", comments: [.init(login: "reviewer", body: "Name the leftover group.")]),
    ]

    static let prPatch = """
    diff --git a/Sources/Review/ReviewStore.swift b/Sources/Review/ReviewStore.swift
    index 1111111..2222222 100644
    --- a/Sources/Review/ReviewStore.swift
    +++ b/Sources/Review/ReviewStore.swift
    @@ -1,4 +1,6 @@
     struct ReviewStore {
    -    var marks: Set<String>
    +    var marks: [String: String]
    +    /// A mark keeps the file's diff hash.
    +    func isCurrent(_ path: String, hash: String) -> Bool { marks[path] == hash }
     }
    diff --git a/Sources/Review/ReviewGuide.swift b/Sources/Review/ReviewGuide.swift
    index 3333333..4444444 100644
    --- a/Sources/Review/ReviewGuide.swift
    +++ b/Sources/Review/ReviewGuide.swift
    @@ -1,3 +1,4 @@
     struct ReviewGuide {
         var sections: [Section]
    +    var stale = false
     }
    diff --git a/Sources/Review/ReviewProgress.swift b/Sources/Review/ReviewProgress.swift
    new file mode 100644
    --- /dev/null
    +++ b/Sources/Review/ReviewProgress.swift
    @@ -0,0 +1,3 @@
    +enum ReviewProgress {
    +    static func done(_ reviewed: Int, of total: Int) -> Bool { reviewed == total }
    +}
    diff --git a/Tests/ReviewProgressTests.swift b/Tests/ReviewProgressTests.swift
    index 5555555..6666666 100644
    --- a/Tests/ReviewProgressTests.swift
    +++ b/Tests/ReviewProgressTests.swift
    @@ -1,2 +1,3 @@
     final class ReviewProgressTests {
    +    func testDone() {}
     }
    diff --git a/docs/review.md b/docs/review.md
    index 7777777..8888888 100644
    --- a/docs/review.md
    +++ b/docs/review.md
    @@ -1,1 +1,2 @@
     # Review
    +Marks follow each file's diff.
    """

    static let worktreePatch = prPatch

    static var worktreeResponse: OS1API.SessionDiffResponse {
        let files: [[String: Any]] = [
            ["path": "Sources/Review/ReviewStore.swift", "status": "modified", "additions": 3, "deletions": 1],
            ["path": "Sources/Review/ReviewGuide.swift", "status": "modified", "additions": 1, "deletions": 0],
            ["path": "Sources/Review/ReviewProgress.swift", "status": "added", "additions": 3, "deletions": 0],
            ["path": "Tests/ReviewProgressTests.swift", "status": "modified", "additions": 1, "deletions": 0],
            ["path": "docs/review.md", "status": "modified", "additions": 1, "deletions": 0],
        ]
        let json: [String: Any] = ["repos": [[
            "repo": "acme", "primary": true,
            "diff": ["branch": "review-progress", "baseRef": "main", "files": files,
                     "totalAdditions": 9, "totalDeletions": 1, "rawPatch": worktreePatch],
        ]]]
        let data = (try? JSONSerialization.data(withJSONObject: json)) ?? Data()
        return (try? JSONDecoder().decode(OS1API.SessionDiffResponse.self, from: data))
            ?? OS1API.SessionDiffResponse(repos: [])
    }
}
#endif
