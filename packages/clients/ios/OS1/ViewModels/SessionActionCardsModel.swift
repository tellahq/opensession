import Foundation
import Observation

/// The cards a session shows above its composer when the agent needs a person
/// (a credential to register, a keychain ask to answer, a force merge to
/// confirm) and the session's supervised script runs, plus what the reader
/// did to its You should know notes.
///
/// One per `SessionViewModel`, which routes only its own session's frames
/// here, so a frame for another session can never reach these cards. Its own
/// `@Observable` object so the cards re-render on their own: reading this
/// state in `SessionView.body` would re-evaluate the whole transcript.
///
/// The socket frames carry no viewer identity (and the keychain one carries
/// nothing at all), so a frame only says "look again": every pending card is
/// re-read over REST, which answers with this viewer's permissions. The same
/// reads run on open and after every reconnect, because a broadcast reaches
/// only the viewers connected when it went out.
@Observable
@MainActor
final class SessionActionCardsModel {
    let sessionId: String

    /// A register_credential request. Every viewer sees it; only the verified
    /// driver gets `canAnswer`.
    private(set) var registration: PendingCredentialRegistration?
    /// Keychain asks for credentials this viewer owns. The server returns
    /// them to the verified owner only, so everyone else gets none.
    private(set) var keychainAsks: [SessionKeychainAsk] = []
    /// A force merge waiting on the driver. Anyone may cancel it; only the
    /// verified driver gets `canConfirm`.
    private(set) var forceMerge: PendingForceMerge?
    /// Every run the server knows for this session, newest first.
    private(set) var scriptRuns: [ScriptRun] = []
    /// What the card shows: running runs, and ended ones for 15 minutes.
    private(set) var visibleScriptRuns: [ScriptRun] = []
    /// True while any card is on screen. Stored, and written only when it
    /// flips, so the transcript can place its tail without observing the
    /// cards themselves.
    private(set) var hasCards = false
    /// Changes when a card that needs an answer appears, so the transcript
    /// can bring it into view.
    private(set) var attentionKey = ""

    /// You should know lines remembered from this device in this session.
    private(set) var knownYouShouldKnow: Set<String> = []
    /// Turned off from a note here. Hides every note's Turn off button.
    private(set) var youShouldKnowOff = false

    @ObservationIgnored private let client: SessionActionsClient
    @ObservationIgnored private let now: () -> Date
    @ObservationIgnored private let user: () -> String
    @ObservationIgnored private var active = false
    // A load token per card: bumped by every load and every local resolution,
    // so a slow response can never overwrite something newer.
    @ObservationIgnored private var registrationLoad = 0
    @ObservationIgnored private var asksLoad = 0
    @ObservationIgnored private var forceMergeLoad = 0
    @ObservationIgnored private var scriptsRevision = 0
    /// Requests already settled. A read that started before the settlement
    /// can still answer with the request; it must not bring the card back.
    @ObservationIgnored private var resolvedRegistrations: Set<String> = []
    @ObservationIgnored private var resolvedForceMerges: Set<String> = []
    @ObservationIgnored private var expiryTask: Task<Void, Never>?

    init(
        sessionId: String,
        client: SessionActionsClient = .live,
        now: @escaping () -> Date = Date.init,
        user: @escaping () -> String = { ServerConfig.shared.userName }
    ) {
        self.sessionId = sessionId
        self.client = client
        self.now = now
        self.user = user
    }

    // MARK: - Lifecycle

    /// The session is on screen and its socket just completed a handshake
    /// (first open, reconnect, or server restart): re-read everything.
    func rehydrate() {
        #if DEBUG
        if holdsFixture { return }
        #endif
        active = true
        reloadRegistration()
        reloadKeychainAsks()
        reloadForceMerge()
        reloadScriptRuns()
    }

    /// The session left the screen. Cards clear, as on the web, and any read
    /// still in flight is dropped when it lands.
    func deactivate() {
        #if DEBUG
        if holdsFixture { return }
        #endif
        active = false
        registrationLoad += 1
        asksLoad += 1
        forceMergeLoad += 1
        scriptsRevision += 1
        expiryTask?.cancel()
        expiryTask = nil
        registration = nil
        keychainAsks = []
        forceMerge = nil
        scriptRuns = []
        refreshDerived()
    }

    // MARK: - Frames (already filtered to this session)

    func registrationFrame(pending: Bool) {
        guard active else { return }
        if pending {
            reloadRegistration()
        } else {
            registrationLoad += 1
            registration = nil
            refreshDerived()
        }
    }

    func registrationResolved(requestId: String) {
        resolvedRegistrations.insert(requestId)
        guard registration?.request.id == requestId else { return }
        registrationLoad += 1
        registration = nil
        refreshDerived()
    }

    func keychainAsksChanged() {
        guard active else { return }
        reloadKeychainAsks()
    }

    func forceMergeFrame(pending: Bool) {
        guard active else { return }
        if pending {
            reloadForceMerge()
        } else {
            forceMergeLoad += 1
            forceMerge = nil
            refreshDerived()
        }
    }

    func forceMergeResolved(requestId: String) {
        resolvedForceMerges.insert(requestId)
        guard forceMerge?.request.id == requestId else { return }
        forceMergeLoad += 1
        forceMerge = nil
        refreshDerived()
    }

    func scriptRunsFrame(_ runs: [ScriptRun]) {
        guard active else { return }
        // A frame is newer than any list read still in flight.
        scriptsRevision += 1
        scriptRuns = runs
        refreshDerived()
    }

    // MARK: - Reads

    private func reloadRegistration() {
        registrationLoad += 1
        let token = registrationLoad
        Task { [weak self] in
            guard let self else { return }
            // `nil` is an answer (nothing pending), unlike a failed read.
            let loaded: PendingCredentialRegistration?
            do { loaded = try await self.client.registration(self.sessionId) } catch { return }
            guard token == self.registrationLoad, self.active else { return }
            self.registration =
                loaded.flatMap { self.resolvedRegistrations.contains($0.request.id) ? nil : $0 }
            self.refreshDerived()
        }
    }

    func reloadKeychainAsks() {
        asksLoad += 1
        let token = asksLoad
        Task { [weak self] in
            guard let self else { return }
            guard let loaded = try? await self.client.keychainAsks(self.sessionId),
                  token == self.asksLoad, self.active
            else { return }
            self.keychainAsks = loaded
            self.refreshDerived()
        }
    }

    private func reloadForceMerge() {
        forceMergeLoad += 1
        let token = forceMergeLoad
        Task { [weak self] in
            guard let self else { return }
            // `nil` is an answer (nothing pending), unlike a failed read.
            let loaded: PendingForceMerge?
            do { loaded = try await self.client.forceMerge(self.sessionId) } catch { return }
            guard token == self.forceMergeLoad, self.active else { return }
            self.forceMerge =
                loaded.flatMap { self.resolvedForceMerges.contains($0.request.id) ? nil : $0 }
            self.refreshDerived()
        }
    }

    private func reloadScriptRuns() {
        scriptsRevision += 1
        let revision = scriptsRevision
        Task { [weak self] in
            guard let self else { return }
            guard let loaded = try? await self.client.scriptRuns(self.sessionId),
                  revision == self.scriptsRevision, self.active
            else { return }
            self.scriptRuns = loaded
            self.refreshDerived()
        }
    }

    // MARK: - Answers

    /// Save the driver's secret. The secret is only ever in this call's
    /// request body: never on the socket, never in the transcript or the
    /// draft, so the model cannot see it.
    func registerCredential(_ request: CredentialRegistrationRequest, secret: String) async throws {
        try await client.registerCredential(sessionId, request.id, secret)
        registrationResolved(requestId: request.id)
    }

    func declineCredential(_ request: CredentialRegistrationRequest) async throws {
        try await client.declineCredential(sessionId, request.id)
        registrationResolved(requestId: request.id)
    }

    func answer(_ ask: SessionKeychainAsk, decision: SessionKeychainAsk.Decision) async throws {
        try await client.answerKeychainAsk(ask.id, decision)
        // Gone at once here; the re-read confirms what the server holds.
        asksLoad += 1
        keychainAsks.removeAll { $0.id == ask.id }
        refreshDerived()
        if active { reloadKeychainAsks() }
    }

    /// Confirm as the driver. Throws with the reason when the merge did not
    /// happen (the branch moved, GitHub refused); the card is settled either
    /// way, and the transcript records the outcome.
    func confirmForceMerge(_ request: ForceMergeRequest) async throws {
        let outcome = try await client.confirmForceMerge(sessionId, request.id)
        forceMergeResolved(requestId: request.id)
        if let message = outcome?.failureMessage { throw OS1API.APIError.server(message) }
    }

    func cancelForceMerge(_ request: ForceMergeRequest) async throws {
        try await client.cancelForceMerge(sessionId, request.id)
        forceMergeResolved(requestId: request.id)
    }

    func stopScript(_ run: ScriptRun) async throws {
        try await client.stopScript(sessionId, run.id)
    }

    func scriptOutput(_ run: ScriptRun) async throws -> String {
        #if DEBUG
        if holdsFixture { return Self.fixtureOutput }
        #endif
        return try await client.scriptOutput(sessionId, run.id)
    }

    // MARK: - You should know

    /// "I knew this": later checks skip the topic. Quiet when it rides along
    /// with Ask about this, which counts as having seen the note too.
    func rememberYouShouldKnow(_ note: YouShouldKnowNote) async throws {
        guard !knownYouShouldKnow.contains(note.line) else { return }
        knownYouShouldKnow.insert(note.line)
        do {
            try await client.rememberYouShouldKnow(user(), note.line)
        } catch {
            knownYouShouldKnow.remove(note.line)
            throw error
        }
    }

    func turnOffYouShouldKnow() async throws {
        let enabled = try await client.setYouShouldKnow(user(), false)
        youShouldKnowOff = !enabled
    }

    #if DEBUG
    // MARK: - Screenshot fixtures

    /// Launch-env-only states for the native capture harness, with
    /// placeholder people, hosts and repos. Held against reloads so the live
    /// server cannot clear them mid-capture; answering one changes nothing
    /// on any server, because no server holds these ids.
    @ObservationIgnored private var holdsFixture = false

    func installScreenshotFixture(_ variant: String) {
        holdsFixture = true
        active = true
        let driver = variant != "viewer"
        if variant == "approve" || variant == "viewer" {
            registration = PendingCredentialRegistration(
                request: CredentialRegistrationRequest(
                    id: "fixture-registration",
                    service: "Acme Billing",
                    host: "api.example.test",
                    description: "Read-only token for the invoice export.",
                    allowedMethods: ["GET"],
                    allowedPathPrefixes: ["/v1/invoices"],
                    owner: "alex"
                ),
                canAnswer: driver
            )
        }
        if variant == "approve" {
            keychainAsks = [SessionKeychainAsk(
                id: "fixture-ask",
                requestedBy: "sam",
                purpose: "Reconcile last month's invoices against the export.",
                requestedMode: "standing",
                credentials: [.init(service: "Acme Billing", host: "api.example.test")]
            )]
        }
        if variant == "merge" || variant == "viewer" {
            forceMerge = PendingForceMerge(
                request: ForceMergeRequest(
                    id: "fixture-merge",
                    ghRepo: "acme/app",
                    number: 42,
                    title: "Fix flaky upload retry test",
                    base: "main",
                    head: "fix-upload-retry",
                    headSha: "3f9c2e1a7b",
                    method: "squash",
                    reason: "The failing check is a known flaky runner; the fix is verified locally.",
                    bypass: [
                        .init(kind: "check", name: "e2e", state: "failing", required: true),
                        .init(kind: "review", detail: "1 approving review required"),
                    ],
                    driver: "alex"
                ),
                canConfirm: driver
            )
        }
        if variant == "merge" {
            let at = now()
            scriptRuns = [
                ScriptRun(
                    id: "fixture-run-done", sessionId: sessionId, title: "Rebuild search index",
                    command: "bun scripts/reindex.ts", state: "exited",
                    startedAt: at.addingTimeInterval(-420), endedAt: at.addingTimeInterval(-300),
                    exitCode: 0
                ),
                ScriptRun(
                    id: "fixture-run", sessionId: sessionId, title: "Backfill invoice totals",
                    command: "bun scripts/backfill-invoices.ts --since 2026-09-01",
                    state: "running", startedAt: at.addingTimeInterval(-185),
                    deadline: at.addingTimeInterval(3415),
                    credentials: [.init(grantId: "fixture-grant", service: "Acme Billing",
                                        calls: 120, denied: 0)]
                ),
            ]
        }
        refreshDerived()
    }

    private static let fixtureOutput = [
        "Fetched page 1 of 6 (200 invoices)",
        "Fetched page 2 of 6 (200 invoices)",
        "Updated 400 totals",
        "Fetched page 3 of 6 (200 invoices)",
    ].joined(separator: "\n")
    #endif

    // MARK: - Derived

    private func refreshDerived() {
        let at = now()
        let visible = ScriptRun.visible(scriptRuns, at: at)
        if visible != visibleScriptRuns { visibleScriptRuns = visible }
        let cards = registration != nil || !keychainAsks.isEmpty || forceMerge != nil
            || !visible.isEmpty
        if cards != hasCards { hasCards = cards }
        let key = ([registration?.request.id, forceMerge?.request.id].compactMap { $0 }
            + keychainAsks.map(\.id)).joined(separator: ",")
        if key != attentionKey { attentionKey = key }
        scheduleExpiry(after: at)
    }

    /// Ended runs leave the card after their window, without waiting for
    /// another frame.
    private func scheduleExpiry(after at: Date) {
        expiryTask?.cancel()
        expiryTask = nil
        guard active, let next = ScriptRun.nextExpiry(scriptRuns, after: at) else { return }
        let delay = max(1, next.timeIntervalSince(at))
        expiryTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled else { return }
            self?.refreshDerived()
        }
    }
}
