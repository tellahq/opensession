import XCTest
@testable import OS1

final class SessionTests: XCTestCase {
    private func session(_ json: String) throws -> Session {
        try JSONDecoder().decode(Session.self, from: Data(json.utf8))
    }

    func testMissingRepoUsesServerDefault() throws {
        let session = try JSONDecoder().decode(
            Session.self,
            from: Data(#"{"id":"bks-1"}"#.utf8)
        )

        XCTAssertNil(session.repo)
        XCTAssertEqual(session.effectiveRepo, "opensession")
    }

    func testExplicitRepoIsPreserved() throws {
        let session = try JSONDecoder().decode(
            Session.self,
            from: Data(#"{"id":"bks-1","repo":"backstage"}"#.utf8)
        )

        XCTAssertEqual(session.effectiveRepo, "backstage")
    }

    func testLastRunErrorDecodesMessageAndTimestamp() throws {
        let failed = try session(#"{"id":"os-failed","lastRunError":{"message":"Provider credits exhausted.","at":"2026-08-28T10:00:00Z"}}"#)

        XCTAssertEqual(failed.lastRunError?.message, "Provider credits exhausted.")
        XCTAssertEqual(failed.lastRunError?.at, "2026-08-28T10:00:00Z")
    }

    func testSafetyProjectionDecodesTolerantlyAndOverridesRunningLane() throws {
        let paused = try session(#"{"id":"os-paused","isRunning":true,"safety":{"status":"paused_for_safety","explanation":"This session was paused safely.","automaticReconciliationRunning":false,"pausedAt":"2026-08-26T12:00:00Z","operation":"finishing the current turn","repairAvailable":false}}"#)

        XCTAssertEqual(paused.safety?.status, "paused_for_safety")
        XCTAssertEqual(paused.safety?.explanation, "This session was paused safely.")
        XCTAssertEqual(paused.status, .needsInput)
        XCTAssertEqual(paused.lane, .needsInput)

        let partial = try session(#"{"id":"os-partial","safety":{"status":"paused_for_safety"}}"#)
        XCTAssertEqual(partial.safety?.status, "paused_for_safety")
        XCTAssertNil(partial.safety?.explanation)
    }

    func testSessionAliasesAreDecodedForTranscriptLinks() throws {
        let session = try self.session(
            #"{"id":"os-current","aliasIds":["bks-original"]}"#
        )

        XCTAssertEqual(session.aliasIds, ["bks-original"])
    }

    @MainActor
    func testRepoLessMarkerWinsOverNormalizedDefaultRepo() throws {
        let session = try session(
            #"{"id":"os-1","repo":"opensession","repoLess":true,"mode":"ask"}"#
        )

        XCTAssertTrue(session.repoLess == true)
        XCTAssertEqual(session.effectiveRepo, Session.noRepoID)
        XCTAssertEqual(RepoTile.label(for: session.effectiveRepo), "No repo")
    }

    @MainActor
    func testRepoLessAskCreationSendsExplicitServerSentinel() {
        let body = OS1API.createSessionBody(
            prompt: "Summarize the latest support themes",
            repo: Session.noRepoID,
            mode: "ask",
            user: "Alice"
        )

        XCTAssertEqual(body["prompt"] as? String, "Summarize the latest support themes")
        XCTAssertEqual(body["mode"] as? String, "ask")
        XCTAssertEqual(body["repo"] as? String, "none")
        XCTAssertEqual(body["user"] as? String, "Alice")
        XCTAssertNil(body["repoLess"])
    }

    @MainActor
    func testSessionCreationSendsValidatedCheckoutMode() {
        for mode in ["default", "checkout", "worktree"] {
            let body = OS1API.createSessionBody(
                prompt: "Build it",
                repo: "opensession",
                mode: "code",
                checkoutMode: mode,
                user: "Alice"
            )
            XCTAssertEqual(body["checkoutMode"] as? String, mode)
        }

        let malformed = OS1API.createSessionBody(
            prompt: "Build it",
            repo: "opensession",
            mode: "code",
            checkoutMode: "future",
            user: "Alice"
        )
        XCTAssertEqual(malformed["checkoutMode"] as? String, "default")
    }

    @MainActor
    func testRepoLessAskPinsCreationToTheHost() {
        let body = OS1API.createSessionBody(
            prompt: "Check the incident queue",
            repo: Session.noRepoID,
            mode: "ask",
            sandbox: SandboxOffering.createValue(SandboxOffering.host),
            user: "Alice"
        )

        XCTAssertEqual(body["sandbox"] as? String, "local")
    }

    @MainActor
    func testSessionCreationCarriesOnlyStagedFiles() {
        let staged = AttachedFile(
            name: "incident.pdf",
            mediaType: "application/pdf",
            path: "/uploads/incident.pdf"
        )
        let local = AttachedFile(name: "still-uploading.log", data: Data("log".utf8))
        let body = OS1API.createSessionBody(
            prompt: "Review these",
            repo: "opensession",
            mode: "code",
            files: [staged, local],
            user: "Alice"
        )

        let files = body["files"] as? [[String: String]]
        XCTAssertEqual(files?.count, 1)
        XCTAssertEqual(files?.first?["name"], "incident.pdf")
        XCTAssertEqual(files?.first?["type"], "application/pdf")
        XCTAssertEqual(files?.first?["path"], "/uploads/incident.pdf")
    }

    @MainActor
    func testAskDefaultsToNoRepoUnlessCreationIsRepoScoped() {
        XCTAssertEqual(
            NewSessionView.repoAfterSelectingMode(
                "ask",
                current: "opensession",
                isRepoScoped: false,
                fallback: "opensession"
            ),
            Session.noRepoID
        )
        XCTAssertEqual(
            NewSessionView.repoAfterSelectingMode(
                "ask",
                current: "tella-fusion",
                isRepoScoped: true,
                fallback: "opensession"
            ),
            "tella-fusion"
        )
        XCTAssertEqual(
            NewSessionView.repoAfterSelectingMode(
                "code",
                current: Session.noRepoID,
                isRepoScoped: false,
                fallback: "opensession"
            ),
            "opensession"
        )
    }

    func testPullRequestContextStatePrioritizesBlockersBeforeMerge() throws {
        let conflicts = try session(
            #"{"id":"one","prNumber":42,"prState":"OPEN","prMergeable":"CONFLICTING","prChecks":{"failed":1,"pending":2}}"#
        )
        let failing = try session(
            #"{"id":"two","prNumber":42,"prState":"OPEN","prChecks":{"failed":1,"pending":2}}"#
        )
        let running = try session(
            #"{"id":"three","prNumber":42,"prState":"OPEN","prChecks":{"failed":0,"pending":2}}"#
        )

        XCTAssertEqual(conflicts.pullRequestContextState, .conflicts)
        XCTAssertEqual(failing.pullRequestContextState, .failing)
        XCTAssertEqual(running.pullRequestContextState, .running(2))
        XCTAssertEqual(running.pullRequestContextState?.label, "2 checks running")
    }

    func testPullRequestContextStateHandlesReviewAndTerminalStates() throws {
        let draft = try session(
            #"{"id":"one","prNumber":42,"prState":"OPEN","prIsDraft":true,"prReviewDecision":"CHANGES_REQUESTED"}"#
        )
        let feedback = try session(
            #"{"id":"two","prNumber":42,"prState":"OPEN","prReviewDecision":"CHANGES_REQUESTED"}"#
        )
        let ready = try session(#"{"id":"three","prNumber":42,"prState":"OPEN"}"#)
        let merged = try session(#"{"id":"four","prNumber":42,"prState":"MERGED"}"#)

        XCTAssertEqual(draft.pullRequestContextState, .draft)
        XCTAssertEqual(feedback.pullRequestContextState, .changesRequested)
        XCTAssertEqual(ready.pullRequestContextState, .ready)
        XCTAssertEqual(merged.pullRequestContextState, .merged)
    }

    func testRepositoryOrderUsesFrequencyThenName() throws {
        let sessions = try JSONDecoder().decode(
            [Session].self,
            from: Data(
                #"[{"id":"1","repo":"zebra"},{"id":"2","repo":"alpha"},{"id":"3","repo":"zebra"},{"id":"4","repo":"beta"},{"id":"5","repo":"alpha"}]"#.utf8
            )
        )

        XCTAssertEqual(
            SessionsListViewModel.repositoryOrder(in: sessions),
            ["alpha", "zebra", "beta"]
        )
    }

    func testRepositoryOrderHonorsPreferenceAndAppendsNewRepos() throws {
        let sessions = try JSONDecoder().decode(
            [Session].self,
            from: Data(
                #"[{"id":"1","repo":"alpha"},{"id":"2","repo":"beta"},{"id":"3","repo":"gamma"}]"#.utf8
            )
        )

        XCTAssertEqual(
            SessionsListViewModel.repositoryOrder(
                in: sessions,
                preferredOrderJSON: #"["gamma","missing","alpha","gamma"]"#
            ),
            ["gamma", "alpha", "beta"]
        )
    }

    func testTabSessionsUseWorkspaceAndNaturalOrder() throws {
        let sessions = try JSONDecoder().decode(
            [Session].self,
            from: Data(
                #"[{"id":"second","workspaceId":"ws-1","createdAt":"2026-07-02T00:00:00Z"},{"id":"other","workspaceId":"ws-2","createdAt":"2026-07-01T00:00:00Z"},{"id":"first","workspaceId":"ws-1","createdAt":"2026-07-01T00:00:00Z"},{"id":"worker","workspaceId":"ws-1","parentSessionId":"first","createdAt":"2026-07-03T00:00:00Z"},{"id":"archived","workspaceId":"ws-1","archived":true}]"#.utf8
            )
        )

        XCTAssertEqual(
            SessionsListViewModel.tabSessions(in: sessions, containing: sessions[0]).map(\.id),
            ["first", "second"]
        )
        XCTAssertEqual(
            SessionsListViewModel.tabSessions(in: sessions, containing: sessions[3]).map(\.id),
            ["worker"]
        )
    }

    func testWorkerMenuUsesDirectLiveChildrenAcrossWorkspaces() throws {
        let sessions = try JSONDecoder().decode(
            [Session].self,
            from: Data(
                #"[{"id":"parent","workspaceId":"ws-1"},{"id":"later","workspaceId":"ws-worker","parentSessionId":"parent","createdAt":"2026-07-03T00:00:00Z"},{"id":"nested","parentSessionId":"later"},{"id":"archived","parentSessionId":"parent","archived":true},{"id":"earlier","parentSessionId":"parent","createdAt":"2026-07-02T00:00:00Z"}]"#.utf8
            )
        )

        XCTAssertEqual(
            SessionsListViewModel.workerSessions(in: sessions, parentId: "parent").map(\.id),
            ["earlier", "later"]
        )
    }

    func testClosingATabLandsOnItsNeighbour() throws {
        let sessions = try JSONDecoder().decode(
            [Session].self,
            from: Data(#"[{"id":"one"},{"id":"two"},{"id":"three"}]"#.utf8)
        )

        // Closing a tab hands the strip to the one on its right …
        XCTAssertEqual(
            SessionsListViewModel.tabAfterClosing(sessions[0], in: sessions)?.id,
            "two"
        )
        XCTAssertEqual(
            SessionsListViewModel.tabAfterClosing(sessions[1], in: sessions)?.id,
            "three"
        )
        // … except the rightmost, which falls back to its left neighbour.
        XCTAssertEqual(
            SessionsListViewModel.tabAfterClosing(sessions[2], in: sessions)?.id,
            "two"
        )
        // The workspace's last session leaves nothing to show.
        XCTAssertNil(
            SessionsListViewModel.tabAfterClosing(sessions[0], in: [sessions[0]])
        )
        // A tab that already left the strip doesn't hand it to a phantom.
        XCTAssertEqual(
            SessionsListViewModel.tabAfterClosing(sessions[2], in: Array(sessions.prefix(2)))?.id,
            "one"
        )
    }

    func testTabSessionsFallBackToIsolatedWorktree() throws {
        let sessions = try JSONDecoder().decode(
            [Session].self,
            from: Data(
                #"[{"id":"one","worktreeDir":"/home/ubuntu/worktrees/feature"},{"id":"two","worktreeDir":"/home/ubuntu/worktrees/feature"},{"id":"main","worktreeDir":"/home/ubuntu/projects/tella-backstage"}]"#.utf8
            )
        )

        XCTAssertEqual(
            SessionsListViewModel.tabSessions(in: sessions, containing: sessions[0]).map(\.id),
            ["one", "two"]
        )
        XCTAssertEqual(
            SessionsListViewModel.tabSessions(in: sessions, containing: sessions[2]).map(\.id),
            ["main"]
        )
    }

    func testWorktreeFallbackIncludesWorkspaceAssignedSibling() throws {
        let sessions = try JSONDecoder().decode(
            [Session].self,
            from: Data(
                #"[{"id":"readonly","worktreeDir":"/home/ubuntu/worktrees/feature"},{"id":"filed","workspaceId":"ws-1","worktreeDir":"/home/ubuntu/worktrees/feature"}]"#.utf8
            )
        )

        XCTAssertEqual(
            SessionsListViewModel.tabSessions(in: sessions, containing: sessions[0]).map(\.id),
            ["filed", "readonly"]
        )
        XCTAssertEqual(
            SessionsListViewModel.tabSessions(in: sessions, containing: sessions[1]).map(\.id),
            ["filed", "readonly"]
        )
    }

    func testSidebarCollapsesWorkspaceSessionsIntoOneRow() throws {
        let sessions = try JSONDecoder().decode(
            [Session].self,
            from: Data(
                #"[{"id":"first","workspaceId":"ws-1","branch":"feature","createdAt":"2026-07-01T00:00:00Z","lastActivity":"2026-07-01T00:01:00Z","ran":true},{"id":"second","workspaceId":"ws-1","branch":"feature","createdAt":"2026-07-02T00:00:00Z","lastActivity":"2026-07-02T00:01:00Z"},{"id":"other","workspaceId":"ws-2","branch":"other"}]"#.utf8
            )
        )

        let workspaces = SessionsListViewModel.sidebarWorkspaces(
            in: sessions,
            workspaceNames: ["ws-1": "Feature workspace"]
        )

        XCTAssertEqual(workspaces.count, 2)
        XCTAssertEqual(workspaces[0].title, "Feature workspace")
        XCTAssertEqual(workspaces[0].sessions.map(\.id), ["first", "second"])
        XCTAssertEqual(workspaces[0].mainSession.id, "first")
    }

    /// Every row carries its workspace's name, so a cold launch titles its
    /// rows after their workspaces rather than after whichever tab happens to
    /// be first — before the separate names request has landed.
    func testWorkspaceRowUsesTheNameTheSessionCarries() throws {
        let sessions = try JSONDecoder().decode(
            [Session].self,
            from: Data(
                #"[{"id":"first","workspaceId":"ws-1","title":"Resolve merge conflicts on main","workspaceName":"Implement the shadow tokens"},{"id":"second","workspaceId":"ws-1","title":"New session"}]"#.utf8
            )
        )

        let workspaces = SessionsListViewModel.sidebarWorkspaces(in: sessions)

        XCTAssertEqual(workspaces.count, 1)
        XCTAssertEqual(workspaces[0].title, "Implement the shadow tokens")
    }

    /// A row with no name from either source — an older server, or a session
    /// whose workspace is gone — degrades to the session's own title, never to
    /// its branch: the whole sidebar reading as machine slugs is how that
    /// failure once surfaced.
    func testWorkspaceRowFallsBackToTheSessionTitleNotTheBranch() throws {
        let sessions = try JSONDecoder().decode(
            [Session].self,
            from: Data(
                #"[{"id":"first","workspaceId":"ws-1","branch":"feature/some-slug","title":"Add the yin yang spinner","worktreeDir":"/home/ubuntu/worktrees/spinner"}]"#.utf8
            )
        )

        let workspaces = SessionsListViewModel.sidebarWorkspaces(in: sessions)

        XCTAssertEqual(workspaces.count, 1)
        XCTAssertEqual(workspaces[0].title, "Add the yin yang spinner")
    }

    /// The other half of that rule: a legacy workspace-less row has no name to
    /// miss, so the branch remains its best identity — as on the web.
    func testWorktreeRowStillTitlesItselfByItsBranch() throws {
        let sessions = try JSONDecoder().decode(
            [Session].self,
            from: Data(
                #"[{"id":"legacy","branch":"feature/some-slug","title":"Add the yin yang spinner","worktreeDir":"/home/ubuntu/worktrees/spinner"}]"#.utf8
            )
        )

        let workspaces = SessionsListViewModel.sidebarWorkspaces(in: sessions)

        XCTAssertEqual(workspaces.count, 1)
        XCTAssertEqual(workspaces[0].title, "feature/some-slug")
    }

    func testSidebarDoesNotMergeDistinctWorkspacesSharingAPath() throws {
        let sessions = try JSONDecoder().decode(
            [Session].self,
            from: Data(
                #"[{"id":"first","workspaceId":"ws-1","worktreeDir":"/home/ubuntu/worktrees/shared","branch":"feature"},{"id":"second","workspaceId":"ws-2","worktreeDir":"/home/ubuntu/worktrees/shared","branch":"feature"},{"id":"main-one","workspaceId":"ws-3","worktreeDir":"/home/ubuntu/projects/tella-backstage"},{"id":"main-two","workspaceId":"ws-4","worktreeDir":"/home/ubuntu/projects/tella-backstage"}]"#.utf8
            )
        )

        let workspaces = SessionsListViewModel.sidebarWorkspaces(in: sessions)

        XCTAssertEqual(workspaces.count, 4)
        XCTAssertEqual(workspaces.map(\.sessions).map { $0.map(\.id) }, [
            ["first"], ["second"], ["main-one"], ["main-two"]
        ])
    }

    func testSidebarAdoptsWorkspacelessSiblingUsingTheSameWorktree() throws {
        let sessions = try JSONDecoder().decode(
            [Session].self,
            from: Data(
                #"[{"id":"filed","workspaceId":"ws-1","worktreeDir":"/home/ubuntu/worktrees/shared","branch":"feature"},{"id":"legacy","worktreeDir":"/home/ubuntu/worktrees/shared","branch":"feature"}]"#.utf8
            )
        )

        let workspaces = SessionsListViewModel.sidebarWorkspaces(in: sessions)

        XCTAssertEqual(workspaces.count, 1)
        XCTAssertEqual(workspaces[0].sessions.map(\.id), ["filed", "legacy"])
    }

    func testInboxBandsRankByActivityWithNeedsActionAndLiveRowsLifted() throws {
        let sessions = try JSONDecoder().decode(
            [Session].self,
            from: Data(
                #"[{"id":"blocked","waitingForInput":true,"lastActivity":"2026-07-01T09:00:00Z"},{"id":"today-early","lastActivity":"2026-08-04T02:00:00Z"},{"id":"today-late","lastActivity":"2026-08-04T08:00:00Z"},{"id":"running-old","isRunning":true,"lastActivity":"2026-07-20T09:00:00Z"},{"id":"yesterday","lastActivity":"2026-08-03T23:00:00Z"},{"id":"earlier","lastActivity":"2026-08-01T10:00:00Z"},{"id":"merged-today","prState":"MERGED","lastActivity":"2026-08-04T07:00:00Z"}]"#.utf8
            )
        )
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!

        let bands = SessionsListViewModel.inboxBands(
            SessionsListViewModel.sidebarWorkspaces(in: sessions),
            now: try XCTUnwrap(Session.parseISO("2026-08-04T12:00:00Z")),
            calendar: calendar
        )

        XCTAssertEqual(bands.map(\.band), [.needsAction, .recent, .yesterday, .earlier])
        XCTAssertEqual(bands.map { $0.workspaces.map(\.mainSession.id) }, [
            ["blocked"],
            // Merged work stays in its activity band instead of moving to Done.
            // A live row is recent whatever its day, but ranks by activity.
            ["today-late", "merged-today", "today-early", "running-old"],
            ["yesterday"],
            ["earlier"],
        ])
    }

    func testSidebarManualRenameWinsOverFallbackBranch() throws {
        let sessions = try JSONDecoder().decode(
            [Session].self,
            from: Data(
                #"[{"id":"first","worktreeDir":"/home/ubuntu/worktrees/feature","branch":"feature"},{"id":"renamed","worktreeDir":"/home/ubuntu/worktrees/feature","branch":"feature","title":"Customer escalation","titleOverridden":true}]"#.utf8
            )
        )

        let workspaces = SessionsListViewModel.sidebarWorkspaces(in: sessions)

        XCTAssertEqual(workspaces.first?.title, "Customer escalation")
    }

    func testOptimisticSessionStaysMarkedAfterReceivingRealId() {
        let session = Session.optimistic(
            id: "bks-real",
            title: "New session",
            repo: "backstage",
            mode: "code",
            model: nil,
            effort: nil,
            fastMode: false,
            startedBy: "Alice"
        )

        XCTAssertTrue(session.isOptimisticPlaceholder == true)
    }

    func testTabSessionsPinStartedHumanSessionFirst() throws {
        let sessions = try JSONDecoder().decode(
            [Session].self,
            from: Data(
                #"[{"id":"automation","workspaceId":"ws-1","automation":"Review","createdAt":"2026-07-01T00:00:00Z","lastActivity":"2026-07-01T00:01:00Z","ran":true},{"id":"main","workspaceId":"ws-1","createdAt":"2026-07-02T00:00:00Z","lastActivity":"2026-07-02T00:01:00Z","ran":true},{"id":"shell","workspaceId":"ws-1","createdAt":"2026-07-03T00:00:00Z","lastActivity":"2026-07-03T00:00:00Z"}]"#.utf8
            )
        )

        XCTAssertEqual(
            SessionsListViewModel.tabSessions(in: sessions, containing: sessions[1]).map(\.id),
            ["main", "automation", "shell"]
        )
    }

    func testTabSessionsUseLatestPolledWorkspaceMembership() throws {
        let stale = try JSONDecoder().decode(
            Session.self,
            from: Data(#"{"id":"current"}"#.utf8)
        )
        let sessions = try JSONDecoder().decode(
            [Session].self,
            from: Data(
                #"[{"id":"current","workspaceId":"ws-1","createdAt":"2026-07-01T00:00:00Z"},{"id":"sibling","workspaceId":"ws-1","createdAt":"2026-07-02T00:00:00Z"}]"#.utf8
            )
        )

        XCTAssertEqual(
            SessionsListViewModel.tabSessions(in: sessions, containing: stale).map(\.id),
            ["current", "sibling"]
        )
    }

    /// `automation` arrives as `true` or as the automation's NAME, and older
    /// rows carry it only in `startedBy`. All three mark the row as a machine's
    /// run, which is what the list's robot and its lane routing key on.
    func testAutomationFlagAcceptsBothWireShapes() throws {
        XCTAssertTrue(try session(#"{"id":"one","automation":true}"#).isAutomation)
        XCTAssertTrue(try session(#"{"id":"two","automation":"triage"}"#).isAutomation)
        XCTAssertTrue(
            try session(#"{"id":"three","startedBy":"Plain triage (automation)"}"#).isAutomation
        )
        XCTAssertFalse(try session(#"{"id":"four","automation":false}"#).isAutomation)
        XCTAssertFalse(try session(#"{"id":"five","automation":""}"#).isAutomation)
        XCTAssertFalse(try session(#"{"id":"six","startedBy":"Kent"}"#).isAutomation)
        XCTAssertFalse(try session(#"{"id":"seven"}"#).isAutomation)
    }

    func testAgentStartedAcceptsExplicitAndLegacyOrigins() throws {
        XCTAssertTrue(try session(#"{"id":"report","agentStarted":true}"#).wasAgentStarted)
        XCTAssertTrue(
            try session(#"{"id":"legacy-report","branch":"report-fix-ios"}"#).wasAgentStarted
        )
        XCTAssertTrue(
            try session(#"{"id":"child","parentSessionId":"parent"}"#).wasAgentStarted
        )
        XCTAssertFalse(try session(#"{"id":"manual"}"#).wasAgentStarted)
    }

    func testTranscriptOwnerFallsBackToCreatedBy() throws {
        XCTAssertEqual(
            try session(#"{"id":"one","createdBy":"Michiel"}"#).transcriptOwner,
            "Michiel"
        )
        XCTAssertEqual(
            try session(#"{"id":"two","startedBy":"Kent","createdBy":"Michiel"}"#).transcriptOwner,
            "Kent"
        )
        XCTAssertNil(
            try session(#"{"id":"three","startedBy":"Plain (automation)","createdBy":"Michiel"}"#)
                .transcriptOwner
        )
    }

    /// The list is a SUMMARY: it carries `ran` and not the engine session ids,
    /// which were 9% of its bytes and which nothing here ever compared. A row
    /// without the flag never ran, which is also the right answer for the
    /// optimistic row this client mints for a just-created session.
    func testMissingRanFlagCountsAsNeverRun() throws {
        let shell = try JSONDecoder().decode(
            Session.self,
            from: Data(
                #"{"id":"shell","createdAt":"2026-07-01T00:00:00Z","lastActivity":"2026-07-01T00:00:00Z"}"#.utf8
            )
        )
        XCTAssertTrue(shell.neverRan)

        let started = try JSONDecoder().decode(
            Session.self,
            from: Data(
                #"{"id":"started","ran":true,"createdAt":"2026-07-01T00:00:00Z","lastActivity":"2026-07-01T00:00:00Z"}"#.utf8
            )
        )
        XCTAssertFalse(started.neverRan)
    }

    /// Usage rides on the session row. Older servers send none of it, and a
    /// server that adds a counter must not break the ones already shipped, so
    /// every field decodes independently and defaults to zero.
    func testUsageDecodesFromTheSessionRow() throws {
        let full = try session(
            #"{"id":"one","usage":{"costUsd":1.234,"inputTokens":900,"outputTokens":2500,"cacheReadTokens":45300,"cacheCreationTokens":1200,"contextTokens":128400,"contextWindow":200000,"turns":7,"updatedAt":"2026-08-13T10:00:00Z"}}"#
        )
        XCTAssertEqual(full.usage?.costUsd ?? 0, 1.234, accuracy: 0.0001)
        XCTAssertEqual(full.usage?.turns, 7)
        XCTAssertEqual(full.usage?.contextWindow, 200_000)

        XCTAssertNil(try session(#"{"id":"two"}"#).usage)
        let partial = try session(#"{"id":"three","usage":{"turns":2}}"#)
        XCTAssertEqual(partial.usage?.turns, 2)
        XCTAssertEqual(partial.usage?.costUsd, 0)
        XCTAssertEqual(partial.usage?.contextWindow, 0)
    }

    /// The numbers are formatted to match the web's UsageMeter exactly: the
    /// same conversation read on a phone and in a browser has to agree. Pinned
    /// to en_US because grouping and decimal marks follow the reader's locale
    /// (as the web's `Intl.NumberFormat` does) and this build box is not
    /// guaranteed to be American.
    func testUsageLabelsMatchTheWebFormatting() {
        let en = Locale(identifier: "en_US")
        XCTAssertEqual(SessionUsage.costLabel(0, locale: en), "$0.00")
        XCTAssertEqual(SessionUsage.costLabel(-1, locale: en), "$0.00")
        XCTAssertEqual(SessionUsage.costLabel(0.004, locale: en), "<$0.01")
        XCTAssertEqual(SessionUsage.costLabel(1.239, locale: en), "$1.24")
        XCTAssertEqual(SessionUsage.costLabel(99.999, locale: en), "$100.00")
        XCTAssertEqual(SessionUsage.costLabel(1234.6, locale: en), "$1,235")

        XCTAssertEqual(SessionUsage.tokenLabel(0, locale: en), "0")
        XCTAssertEqual(SessionUsage.tokenLabel(999, locale: en), "999")
        XCTAssertEqual(SessionUsage.tokenLabel(45_300, locale: en), "45.3K")
        XCTAssertEqual(SessionUsage.tokenLabel(200_000, locale: en), "200K")
    }

    func testUsageContextAndCacheReadouts() {
        let en = Locale(identifier: "en_US")
        let usage = SessionUsage(
            costUsd: 1.5,
            inputTokens: 900,
            cacheReadTokens: 45_300,
            cacheCreationTokens: 1_200,
            contextTokens: 128_400,
            contextWindow: 200_000,
            turns: 1
        )
        XCTAssertEqual(usage.contextLabel(locale: en), "128.4K / 200K (64%)")
        XCTAssertFalse(usage.contextIsTight)
        XCTAssertEqual(usage.cacheHitPercent, 96)
        XCTAssertEqual(usage.cacheReadLabel(locale: en), "45.3K (96%)")
        XCTAssertEqual(usage.turnsLabel, "1 turn")

        // No window reported: a percentage of an unknown ceiling means
        // nothing, so the readout is withheld rather than guessed.
        XCTAssertNil(SessionUsage(contextTokens: 1_000).contextLabel(locale: en))
        XCTAssertEqual(SessionUsage().cacheHitPercent, 0)
        XCTAssertEqual(SessionUsage().turnsLabel, "0 turns")
        XCTAssertTrue(
            SessionUsage(contextTokens: 190_000, contextWindow: 200_000).contextIsTight
        )
    }
}
