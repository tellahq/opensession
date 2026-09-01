import Foundation

private final class SafeImageRedirectDelegate: NSObject, URLSessionTaskDelegate {
    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        var redirected = request
        if let original = task.originalRequest?.url,
           let target = request.url,
           (original.scheme != target.scheme
            || original.host != target.host
            || original.port != target.port) {
            redirected.setValue(nil, forHTTPHeaderField: "Authorization")
        }
        completionHandler(redirected)
    }
}

/// Thin REST client for the Open Session HTTP API: reads, the occasional
/// mutation, and — through `deliverPrompt` — every message this app sends.
@MainActor
enum OS1API {
    private static let imageSession = URLSession(
        configuration: .default,
        delegate: SafeImageRedirectDelegate(),
        delegateQueue: nil
    )

    enum APIError: LocalizedError {
        case notConfigured
        case badURL
        case http(Int)
        case server(String)

        var errorDescription: String? {
            switch self {
            case .notConfigured: "Server URL or token not set — open Settings."
            case .badURL: "Invalid server URL."
            case .http(let code):
                code == 401
                    ? "Not signed in (401) — check your token in Settings."
                    : "Server returned HTTP \(code)."
            case .server(let message): message
            }
        }
    }

    /// The live sessions list — everything except archived.
    ///
    /// Archived sessions are the larger half of this instance's list and none
    /// of the first screen, so they travel on their own slice below. Asking
    /// for the live one is opt-in: a server that predates the parameter
    /// answers with the whole list, which still splits correctly downstream
    /// (`prepared` sorts archived rows out either way).
    static func sessions() async throws -> [Session] {
        try await get("/api/sessions?archived=exclude", revalidating: true)
    }

    /// Archived sessions, as summaries.
    ///
    /// Each row carries what the Archived screen renders — title, repo,
    /// activity, who — and is marked `slim`, so anything that opens one
    /// hydrates it first (`session(id:)`). Barely changes between polls, so
    /// it settles into a 304 while the live slice keeps churning.
    static func archivedSessions() async throws -> [Session] {
        try await get("/api/sessions?archived=only&slim=1", revalidating: true)
    }

    /// Closed sessions in one workspace group, for the native tab-history
    /// menus. The server also includes sessions filed under a second workspace
    /// record when both records own the same isolated worktree.
    static func archivedSessions(workspaceId: String) async throws -> [Session] {
        try await get(archivedSessionsPath(workspaceId: workspaceId), revalidating: true)
    }

    nonisolated static func archivedSessionsPath(workspaceId: String) -> String {
        var components = URLComponents()
        components.queryItems = [
            URLQueryItem(name: "archived", value: "only"),
            URLQueryItem(name: "slim", value: "1"),
            URLQueryItem(name: "workspace", value: workspaceId),
        ]
        return "/api/sessions?\(components.percentEncodedQuery ?? "")"
    }

    /// One session, whole. The list used to be the only source of a session
    /// object; this is what lets a client stop carrying every archived row
    /// and still open one.
    static func session(id: String) async throws -> Session {
        let encoded = id.addingPercentEncoding(
            withAllowedCharacters: .urlPathAllowed
        ) ?? id
        return try await get("/api/sessions/\(encoded)")
    }

    /// The fully resolved configuration the session's next turn would use.
    /// This is fetched only when Workspace Info opens: resolving it peeks at
    /// account availability and applies the live MCP and permission gates.
    static func effectiveConfig(sessionId: String) async throws -> SessionEffectiveConfig {
        try await get(effectiveConfigPath(
            sessionId: sessionId,
            user: ServerConfig.shared.userName
        ))
    }

    nonisolated static func effectiveConfigPath(sessionId: String, user: String) -> String {
        let session = sessionId.addingPercentEncoding(
            withAllowedCharacters: .urlPathAllowed
        ) ?? sessionId
        guard !user.isEmpty else { return "/api/sessions/\(session)/effective-config" }
        let allowed = CharacterSet.urlQueryAllowed.subtracting(
            CharacterSet(charactersIn: "&+")
        )
        let encodedUser = user.addingPercentEncoding(withAllowedCharacters: allowed) ?? user
        return "/api/sessions/\(session)/effective-config?user=\(encodedUser)"
    }

    /// One SHA named in transcript prose. The repo is a hint: the server
    /// searches it first, then returns the repository that actually owns the
    /// commit so cross-repo references still reach the right GitHub page.
    static func commit(sha: String, repo: String?) async throws -> CommitDetails? {
        let result: CommitDetails? = try await get(CommitDetails.lookupPath(sha: sha, repo: repo))
        return result
    }

    private struct SessionNotesResponse: Decodable, Sendable {
        let notes: [SessionNote]
    }

    private struct SessionNoteResponse: Decodable, Sendable {
        let note: SessionNote
    }

    static func sessionNotes(sessionId: String) async throws -> [SessionNote] {
        let encoded = sessionId.addingPercentEncoding(
            withAllowedCharacters: .urlPathAllowed
        ) ?? sessionId
        let response: SessionNotesResponse = try await get(
            "/api/sessions/\(encoded)/notes"
        )
        return response.notes
    }

    static func addSessionNote(
        sessionId: String,
        text: String,
        images: [String] = []
    ) async throws -> SessionNote {
        let encoded = sessionId.addingPercentEncoding(
            withAllowedCharacters: .urlPathAllowed
        ) ?? sessionId
        var body: [String: Any] = ["text": text, "user": ServerConfig.shared.userName]
        if !images.isEmpty { body["images"] = images }
        let response: SessionNoteResponse = try await post(
            "/api/sessions/\(encoded)/notes",
            body: body
        )
        return response.note
    }

    static func editSessionNote(
        sessionId: String,
        noteId: String,
        text: String
    ) async throws -> SessionNote {
        let session = sessionId.addingPercentEncoding(
            withAllowedCharacters: .urlPathAllowed
        ) ?? sessionId
        let note = noteId.addingPercentEncoding(
            withAllowedCharacters: .urlPathAllowed
        ) ?? noteId
        let response: SessionNoteResponse = try await patch(
            "/api/sessions/\(session)/notes/\(note)",
            body: ["text": text, "user": ServerConfig.shared.userName]
        )
        return response.note
    }

    static func deleteSessionNote(sessionId: String, noteId: String) async throws {
        let session = sessionId.addingPercentEncoding(
            withAllowedCharacters: .urlPathAllowed
        ) ?? sessionId
        let note = noteId.addingPercentEncoding(
            withAllowedCharacters: .urlPathAllowed
        ) ?? noteId
        let user = ServerConfig.shared.userName.addingPercentEncoding(
            withAllowedCharacters: .urlQueryAllowed
        ) ?? ServerConfig.shared.userName
        let _: SessionNoteResponse = try await mutate(
            "/api/sessions/\(session)/notes/\(note)?user=\(user)",
            method: "DELETE",
            body: [:]
        )
    }

    struct WorkspaceDraft: Decodable, Equatable, Sendable {
        let text: String
        let updatedAt: String
        let by: String?
        let autoName: Bool?

        static func workspaceName(for text: String) -> String {
            let first = text.split(whereSeparator: \.isNewline)
                .map { String($0).trimmingCharacters(in: .whitespacesAndNewlines) }
                .first { !$0.isEmpty }
            return String((first ?? "Draft").prefix(80))
        }
    }

    struct WorkspaceSummary: Decodable, Equatable, Sendable {
        let id: String
        let name: String
        let repo: String?
        let createdBy: String?
        let createdAt: String?
        let draft: WorkspaceDraft?
    }

    /// Canonical workspace names for collapsing sibling sessions into one row.
    static func workspaces() async throws -> [WorkspaceSummary] {
        struct WorkspacesResponse: Decodable, Sendable {
            let workspaces: [WorkspaceSummary]
        }
        let response: WorkspacesResponse = try await get("/api/workspaces")
        return response.workspaces
    }

    static func transcript(sessionId: String) async throws -> [TranscriptEntry] {
        try await get("/api/sessions/\(sessionId)/transcript")
    }

    struct TranscriptSearchMatch: Decodable, Equatable, Sendable {
        let id: String
        let snippet: String
    }

    private struct TranscriptSearchResponse: Decodable, Sendable {
        let matches: [TranscriptSearchMatch]
    }

    /// Search visible transcript text across sessions. The server ignores
    /// one-character queries too, but keeping them local avoids a round trip
    /// while someone is still starting to type.
    static func searchTranscripts(_ query: String) async throws -> [TranscriptSearchMatch] {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count >= 2 else { return [] }
        let response: TranscriptSearchResponse = try await get(
            transcriptSearchPath(query: trimmed)
        )
        return response.matches
    }

    nonisolated static func transcriptSearchPath(query: String) -> String {
        var components = URLComponents()
        components.queryItems = [URLQueryItem(name: "q", value: query)]
        return "/api/sessions/search?\(components.percentEncodedQuery ?? "")"
    }

    /// One sub-agent's transcript. `agentId` comes off the spawning Task
    /// call — its result's `agentId`, or the `ses_…` the result announces.
    static func subagent(
        sessionId: String,
        agentId: String
    ) async throws -> SubagentTranscript {
        let session = sessionId.addingPercentEncoding(
            withAllowedCharacters: .urlPathAllowed
        ) ?? sessionId
        let agent = agentId.addingPercentEncoding(
            withAllowedCharacters: .urlPathAllowed
        ) ?? agentId
        return try await get("/api/sessions/\(session)/subagent/\(agent)")
    }

    // ── Agents: the workflow runs a session fanned out ──────────────────────

    /// Every workflow run this session started, newest first. There is no
    /// cross-session route on purpose: a run belongs to the session that
    /// started it, and the server only ever indexes them that way.
    static func workflowRuns(sessionId: String) async throws -> [WorkflowRun] {
        let session = sessionId.addingPercentEncoding(
            withAllowedCharacters: .urlPathAllowed
        ) ?? sessionId
        let response: WorkflowRunsResponse = try await get(
            "/api/sessions/\(session)/workflows"
        )
        return response.runs
    }

    /// One workflow agent's own conversation, in the transcript shape the
    /// session view already renders. Readable while the agent is still
    /// working, because the server hands out the engine session as soon as it
    /// exists rather than when the agent finishes.
    static func workflowAgentTranscript(
        runId: String,
        seq: Int
    ) async throws -> WorkflowAgentTranscript {
        let run = runId.addingPercentEncoding(
            withAllowedCharacters: .urlPathAllowed
        ) ?? runId
        return try await get("/api/workflows/\(run)/agents/\(seq)/transcript")
    }

    /// Stop a live run. The server answers `{ ok: false }` when there was
    /// nothing live to stop, which the caller reports rather than swallows.
    @discardableResult
    static func cancelWorkflow(runId: String) async throws -> Bool {
        struct CancelResponse: Decodable, Sendable { let ok: Bool? }
        let run = runId.addingPercentEncoding(
            withAllowedCharacters: .urlPathAllowed
        ) ?? runId
        let response: CancelResponse = try await post(
            "/api/workflows/\(run)/cancel",
            body: [:]
        )
        return response.ok ?? false
    }

    // ── Reports: what the automations published ─────────────────────────────

    /// One row per automation that has ever published, newest report in hand.
    static func reportGroups() async throws -> [ReportGroup] {
        let response: ReportGroupsResponse = try await get("/api/reports")
        return response.groups
    }

    /// One automation's history, newest first.
    static func reports(automationId: String) async throws -> [ReportMeta] {
        let encoded = automationId.addingPercentEncoding(
            withAllowedCharacters: .urlPathAllowed
        ) ?? automationId
        let response: ReportHistoryResponse = try await get("/api/reports/\(encoded)")
        return response.reports
    }

    /// Where a report's rendered HTML is served. Framed rather than fetched:
    /// the document references its own durable evidence as `assets/<path>`
    /// relative to this URL, and only loading it from the route itself
    /// resolves them.
    static func reportURL(automationId: String, reportId: String) -> URL? {
        guard let base = ServerConfig.shared.baseURL else { return nil }
        let group = automationId.addingPercentEncoding(
            withAllowedCharacters: .urlPathAllowed
        ) ?? automationId
        let report = reportId.addingPercentEncoding(
            withAllowedCharacters: .urlPathAllowed
        ) ?? reportId
        return URL(string: "\(base.absoluteString)/api/reports/\(group)/\(report)/raw")
    }

    // ── Tasks: the shared list agents write to ──────────────────────────────

    /// Every task on this person's list, open ones first.
    ///
    /// Asks for all statuses rather than just the open ones, because the
    /// screen offers to show what is done and a second round trip to reveal
    /// it would be slower than the list is long.
    static func todos() async throws -> [TodoItem] {
        var components = URLComponents()
        components.queryItems = [
            URLQueryItem(name: "status", value: "all"),
            URLQueryItem(name: "user", value: ServerConfig.shared.userName),
        ]
        let response: TodoListResponse = try await get(
            "/api/todos?\(components.percentEncodedQuery ?? "")"
        )
        return response.todos
    }

    /// Add one task, owned by the signed-in person.
    @discardableResult
    static func addTodo(text: String) async throws -> TodoItem {
        let response: TodoResponse = try await post(
            "/api/todos",
            body: ["text": text, "user": ServerConfig.shared.userName]
        )
        return response.todo
    }

    /// Move one task between open, done and dropped.
    @discardableResult
    static func setTodoStatus(id: String, status: TodoStatus) async throws -> TodoItem {
        let encoded = id.addingPercentEncoding(
            withAllowedCharacters: .urlPathAllowed
        ) ?? id
        let response: TodoResponse = try await patch(
            "/api/todos/\(encoded)",
            body: ["status": status.rawValue, "user": ServerConfig.shared.userName]
        )
        return response.todo
    }

    // ── Feed ────────────────────────────────────────────────────────────────

    /// Recent pull requests across every repo, including ones merged outside
    /// Open Session.
    static func recentPrs() async throws -> [RecentPr] {
        let response: RecentPrsResponse = try await get("/api/recent-prs")
        return response.prs
    }

    /// Recent commits for repos that ship without pull requests, from the last
    /// `days`. The server clamps the window to what it read and says whether
    /// anything older is left, so the feed can stop offering to widen a window
    /// that has already reached the end of the history.
    static func recentCommits(days: Int) async throws -> RecentCommitPage {
        try await get("/api/recent-commits?days=\(days)")
    }

    /// File and folder `@` targets matching a query. Existing composers search
    /// every repo attached to their session; new-session composers search the
    /// repository they are about to use.
    static func fileMentions(
        query: String,
        sessionId: String? = nil,
        repo: String? = nil
    ) async throws -> [FileMention] {
        struct MentionsResponse: Decodable, Sendable { let files: [FileMention]? }
        var components = URLComponents()
        components.queryItems = [URLQueryItem(name: "q", value: query)]
        if let sessionId {
            components.queryItems?.append(URLQueryItem(name: "session", value: sessionId))
        } else if let repo {
            components.queryItems?.append(URLQueryItem(name: "repo", value: repo))
        }
        let response: MentionsResponse = try await get(
            "/api/files?\(components.percentEncodedQuery ?? "")"
        )
        return (response.files ?? []).filter { $0.kind == nil || $0.kind == "dir" }
    }

    /// People-independent rows for the inline `@` palette. Keeping this request
    /// separate means tools and recent sessions do not wait for repository
    /// search, matching the web composer.
    static func mentionSuggestions(
        query: String,
        sessionId: String? = nil
    ) async throws -> [FileMention] {
        struct SuggestionsResponse: Decodable, Sendable { let items: [FileMention]? }
        var components = URLComponents()
        components.queryItems = [
            URLQueryItem(name: "q", value: query),
            URLQueryItem(name: "user", value: ServerConfig.shared.userName),
        ]
        if let sessionId {
            components.queryItems?.append(URLQueryItem(name: "session", value: sessionId))
        }
        let response: SuggestionsResponse = try await get(
            "/api/mention-suggestions?\(components.percentEncodedQuery ?? "")"
        )
        return response.items ?? []
    }

    /// Promote an ask-mode session to code mode. The server cuts the worktree —
    /// which is why this is one-way, and why the row says so.
    @discardableResult
    static func promoteToCode(sessionId: String) async throws -> String? {
        struct PromoteResponse: Decodable, Sendable { let branch: String? }
        let response: PromoteResponse = try await post(
            "/api/sessions/\(sessionId)/promote",
            body: [:]
        )
        return response.branch
    }

    /// Hold a prompt until `at`, when the server sends it for you.
    static func schedulePrompt(sessionId: String, prompt: String, at: Date) async throws {
        struct ScheduledPrompt: Decodable, Sendable { let id: String? }
        let formatter = ISO8601DateFormatter()
        let _: ScheduledPrompt = try await post(
            "/api/sessions/\(sessionId)/scheduled-prompts",
            body: [
                "prompt": prompt,
                "at": formatter.string(from: at),
                "user": ServerConfig.shared.userName,
            ]
        )
    }

    /// A server-side media file (walkthrough stills and demo videos are staged
    /// as absolute paths). The route is path-scoped server-side; this only
    /// spells the URL, which the video player needs as a URL rather than data.
    static func mediaURL(path: String) -> URL? {
        guard let base = ServerConfig.shared.baseURL,
              var components = URLComponents(
                  url: base.appendingPathComponent("media"),
                  resolvingAgainstBaseURL: false
              )
        else { return nil }
        components.queryItems = [URLQueryItem(name: "path", value: path)]
        return components.url
    }

    /// Bytes of a staged media file, for the stills.
    static func media(path: String) async throws -> Data {
        guard let url = mediaURL(path: path) else { throw APIError.badURL }
        return try await responseData(for: ServerConfig.shared.authorizedRequest(url))
    }

    /// One file in a session's scratch assets folder — the artifacts an agent
    /// writes with `opensession-assets` (visualizations, reports, sample data).
    /// They live outside every worktree, so nothing here is a repo path.
    /// `Hashable` so a row can be pushed as a navigation destination.
    struct SessionAsset: Decodable, Sendable, Hashable, Identifiable {
        let path: String
        let size: Int
        let mtime: String
        let description: String?

        init(path: String, size: Int, mtime: String, description: String? = nil) {
            self.path = path
            self.size = size
            self.mtime = mtime
            self.description = description
        }

        var id: String { path }

        /// Last path component — what the file is called, without its folder.
        var name: String {
            path.split(separator: "/").last.map(String.init) ?? path
        }

        /// Lowercased extension, or "" — what the viewer picks a renderer by.
        var ext: String {
            let name = name
            guard let dot = name.lastIndex(of: "."), dot != name.startIndex
            else { return "" }
            return String(name[name.index(after: dot)...]).lowercased()
        }

        var modified: Date? { Session.parseISO(mtime) }
    }

    static func assets(sessionId: String) async throws -> [SessionAsset] {
        struct AssetsResponse: Decodable, Sendable { let files: [SessionAsset]? }
        let response: AssetsResponse = try await get("/api/sessions/\(sessionId)/assets")
        return response.files ?? []
    }

    /// Where one asset's bytes are served. The route carries the file's
    /// relative path in the URL PATH rather than a query parameter, which is
    /// what lets an HTML asset's relative references (./style.css, ./data.json)
    /// resolve against it — the same reason the web viewer frames this route.
    static func assetURL(sessionId: String, path: String) -> URL? {
        guard let base = ServerConfig.shared.baseURL else { return nil }
        // Per SEGMENT: `urlPathAllowed` leaves "/" alone, and the separators
        // are structure here, not part of any file's name.
        let encoded = path
            .split(separator: "/")
            .map { segment in
                String(segment).addingPercentEncoding(
                    withAllowedCharacters: .urlPathAllowed
                ) ?? String(segment)
            }
            .joined(separator: "/")
        return URL(
            string: "\(base.absoluteString)/api/sessions/\(sessionId)/assets/raw/\(encoded)"
        )
    }

    /// Bytes of one asset, for the kinds the app renders itself.
    static func assetData(sessionId: String, path: String) async throws -> Data {
        guard let url = assetURL(sessionId: sessionId, path: path) else {
            throw APIError.badURL
        }
        return try await responseData(for: ServerConfig.shared.authorizedRequest(url))
    }

    static func deleteAsset(sessionId: String, path: String) async throws {
        struct DeleteResponse: Decodable, Sendable { let ok: Bool }
        let _: DeleteResponse = try await post(
            "/api/sessions/\(sessionId)/assets/delete",
            body: ["path": path]
        )
    }

    /// Full content for an entry the WS delivered clamped.
    static func fullEntryContent(sessionId: String, entryId: String) async throws -> String {
        struct EntryResponse: Decodable { let content: String }
        let response: EntryResponse = try await get("/api/sessions/\(sessionId)/entry/\(entryId)")
        return response.content
    }

    /// Where a transcript image's bytes actually live.
    ///
    /// Most of them are SERVER-RELATIVE ("/media?path=…" for an uploaded or
    /// read file, "/api/…"), because the transcript is written for a web
    /// viewer that resolves those against its own origin for free. Here they
    /// have to be joined to the configured server: `URL(string:)` happily
    /// returns a scheme-less relative URL, `URLRequest` can't fetch one, and
    /// every such picture came out as the grey retry tile.
    nonisolated static func conversationMediaURL(source: String, base: URL?) -> URL? {
        if source.hasPrefix("/") {
            guard let base else { return nil }
            return URL(string: source, relativeTo: base)?.absoluteURL
        }
        return URL(string: source)
    }

    nonisolated static func conversationImageURL(source: String, base: URL?) -> URL? {
        conversationMediaURL(source: source, base: base)
    }

    /// Resolve an image from a bounded transcript entry. Large inline images
    /// arrive over the wire as `os-blob:<entry>/<index>` and are served as
    /// authenticated bytes by the transcript-image route.
    static func conversationImage(source: String, sessionId: String) async throws -> Data {
        if source.hasPrefix("os-blob:"),
           let slash = source.lastIndex(of: "/"),
           let index = Int(source[source.index(after: slash)...]) {
            let entryId = String(source[source.index(source.startIndex, offsetBy: 8)..<slash])
            return try await getData(
                "/api/sessions/\(sessionId)/transcript-image/\(entryId)/\(index)"
            )
        }

        let config = ServerConfig.shared
        let base = config.baseURL
        guard let url = conversationMediaURL(source: source, base: base) else {
            throw APIError.badURL
        }
        let sameOrigin = url.scheme == base?.scheme
            && url.host == base?.host
            && url.port == base?.port
        let request = sameOrigin
            ? config.authorizedRequest(url)
            : URLRequest(url: url)
        return try await responseData(for: request)
    }

    /// PR details for the primary branch or an explicit repo and branch target.
    /// The route answers a bare JSON `null` when that target has no PR, so
    /// probe the raw body before decoding.
    static func pr(
        sessionId: String,
        repo: String? = nil,
        branch: String? = nil
    ) async throws -> PrDetails? {
        var components = URLComponents()
        components.path = "/api/sessions/\(sessionId)/pr"
        components.queryItems = [
            repo.map { URLQueryItem(name: "repo", value: $0) },
            branch.map { URLQueryItem(name: "branch", value: $0) },
        ].compactMap { $0 }
        let data = try await getData(components.string ?? components.path)
        let body = String(decoding: data, as: UTF8.self)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if body.isEmpty || body == "null" { return nil }
        return try await decodeDetached(PrDetails.self, from: data)
    }

    /// The committed PR patch used by the native review canvas. The server
    /// returns `null` for a session target with no pull request.
    static func prDiff(sessionId: String) async throws -> PrDiff? {
        let data = try await getData("/api/sessions/\(sessionId)/pr-diff")
        let body = String(decoding: data, as: UTF8.self)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if body.isEmpty || body == "null" { return nil }
        return try await decodeDetached(PrDiff.self, from: data)
    }

    /// The generated review guide for the session's PR. `null` here is a real
    /// answer (no PR, or generation failed), and the canvas falls back to the
    /// plain diff rather than showing an error.
    static func prReviewGuide(sessionId: String) async throws -> PrReviewGuide? {
        let data = try await getData("/api/sessions/\(sessionId)/review-guide")
        let body = String(decoding: data, as: UTF8.self)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if body.isEmpty || body == "null" { return nil }
        return try await decodeDetached(PrReviewGuide.self, from: data)
    }

    /// The structural code-flow trees for the session's PR. Same `null`
    /// contract as the guide.
    static func prCodeFlow(sessionId: String) async throws -> PrCodeFlow? {
        let data = try await getData("/api/sessions/\(sessionId)/pr-code-flow")
        let body = String(decoding: data, as: UTF8.self)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if body.isEmpty || body == "null" { return nil }
        return try await decodeDetached(PrCodeFlow.self, from: data)
    }

    static func prViewedFiles(repo: String?, number: Int) async throws -> PrViewedFiles {
        var components = URLComponents()
        components.queryItems = [URLQueryItem(name: "number", value: String(number))]
        if let repo, !repo.isEmpty {
            components.queryItems?.append(URLQueryItem(name: "repo", value: repo))
        }
        return try await get("/api/pr-viewed-files?\(components.percentEncodedQuery ?? "")")
    }

    static func setPrFileViewed(prId: String, path: String, viewed: Bool) async throws {
        struct Response: Decodable, Sendable { let ok: Bool? }
        var body: [String: Any] = ["prId": prId, "path": path, "viewed": viewed]
        let user = ServerConfig.shared.userName
        if !user.isEmpty { body["user"] = user }
        let _: Response = try await post("/api/pr-viewed-files", body: body)
    }

    // MARK: - Pull request actions
    //
    // The three mutations the web PR panel offers, on the same routes. Each
    // needs a GitHub credential server-side: with web sign-in on that is the
    // signed-in person's own token, so a 403 here means "connect your GitHub
    // account", not a bug — the server says so in `error` and APIError.server
    // carries the sentence through to the panel.

    /// Submit a review on the session's PR. `event` is APPROVE,
    /// REQUEST_CHANGES or COMMENT; everything but APPROVE needs a summary
    /// (the server refuses an empty review).
    static func submitPrReview(
        sessionId: String,
        event: String,
        summary: String,
        comments: [PrInlineComment] = []
    ) async throws {
        struct ReviewResponse: Decodable { let ok: Bool? }
        var body: [String: Any] = ["event": event]
        let trimmed = summary.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty { body["summary"] = trimmed }
        if !comments.isEmpty {
            body["comments"] = comments.map {
                ["path": $0.path, "line": $0.line, "side": "RIGHT", "text": $0.text]
            }
        }
        let user = ServerConfig.shared.userName
        if !user.isEmpty { body["user"] = user }
        let _: ReviewResponse = try await post(
            "/api/sessions/\(sessionId)/pr-review",
            body: body
        )
    }

    /// Merge the session's PR. `method` is squash (the default), merge or
    /// rebase; the server refuses a merge a stack layer below still blocks.
    static func mergePr(sessionId: String, method: String = "squash") async throws {
        struct MergeResponse: Decodable { let ok: Bool? }
        let _: MergeResponse = try await post(
            "/api/sessions/\(sessionId)/pr-merge",
            body: ["method": method]
        )
    }

    /// Close the session's PR without merging it.
    static func closePr(sessionId: String) async throws {
        struct CloseResponse: Decodable { let ok: Bool? }
        let _: CloseResponse = try await post(
            "/api/sessions/\(sessionId)/pr-close",
            body: [:]
        )
    }

    /// What the agent can be asked to do with a pull request, from the
    /// workspace's Review section — the same four the web panel offers, and
    /// the same ones the `os-*` PR labels fire.
    enum PrAgentAction: String, CaseIterable, Identifiable, Sendable {
        case review, autofix, simplify, adversarial

        var id: String { rawValue }

        var label: String {
            switch self {
            case .review: "Review"
            case .autofix: "Auto-fix"
            case .simplify: "Simplify"
            case .adversarial: "Adversarial"
            }
        }

        /// One line for the menu row, in the same words as the web's hints.
        var hint: String {
            switch self {
            case .review: "Read the change and post findings on the PR."
            case .autofix: "Open a session that fixes every finding and failing check."
            case .simplify: "Cleanup pass: reuse, simpler shapes, dead code."
            case .adversarial: "Deeper two-pass adversarial review."
            }
        }

        var symbol: String {
            switch self {
            case .review: "text.magnifyingglass"
            case .autofix: "wrench.and.screwdriver"
            case .simplify: "scissors"
            case .adversarial: "shield.lefthalf.filled"
            }
        }
    }

    struct PrAgentRun: Decodable, Sendable {
        var ok: Bool?
        var message: String?
        var error: String?
        /// Auto-fix opens a live session in the workspace instead of a
        /// headless run — this is the session to open.
        var bksId: String?
        var openSession: Bool?
        var session: Session?
    }

    /// Ask the agent for one of its passes over the session's pull request.
    /// The server answers a refusal in words (no PR yet, a repo the agent
    /// doesn't know), so a failure is thrown with that sentence.
    static func triggerPrAction(
        sessionId: String,
        kind: PrAgentAction,
        repo: String? = nil
    ) async throws -> PrAgentRun {
        var body: [String: Any] = ["kind": kind.rawValue]
        let user = ServerConfig.shared.userName
        if !user.isEmpty { body["user"] = user }
        if let repo, !repo.isEmpty { body["repo"] = repo }
        let result: PrAgentRun = try await post(
            "/api/sessions/\(sessionId)/pr-action",
            body: body
        )
        if result.ok != true {
            throw APIError.server(result.error ?? result.message ?? "Couldn't start")
        }
        return result
    }

    /// Ask a teammate (or a review team's GitHub spec) to review this session,
    /// or clear the request with nil. Setting one mirrors onto GitHub's own
    /// reviewer list and buzzes the reviewer's devices.
    static func setSessionReviewer(sessionId: String, reviewer: String?) async throws {
        struct ReviewResponse: Decodable { let ok: Bool? }
        var body: [String: Any] = ["reviewer": reviewer ?? ""]
        let user = ServerConfig.shared.userName
        if !user.isEmpty { body["by"] = user }
        let _: ReviewResponse = try await put(
            "/api/sessions/\(sessionId)/review",
            body: body
        )
    }

    /// Sign off on the session's review request, or reopen it. Leaves the
    /// reviewer assignment (and GitHub's list) alone either way.
    static func setReviewAccepted(sessionId: String, accepted: Bool) async throws {
        struct ReviewResponse: Decodable { let ok: Bool? }
        var body: [String: Any] = ["accept": accepted]
        let user = ServerConfig.shared.userName
        if !user.isEmpty { body["by"] = user }
        let _: ReviewResponse = try await put(
            "/api/sessions/\(sessionId)/review",
            body: body
        )
    }

    struct GitStatus: Decodable, Sendable, Equatable {
        let branch: String?
        let hasUpstream: Bool
        let ahead: Int
        let behind: Int
        let behindBase: Int
        let baseBranch: String
        let uncommittedFiles: Int
    }

    struct DiffFile: Decodable, Sendable, Identifiable, Equatable {
        let path: String
        let oldPath: String?
        let status: String
        let additions: Int
        let deletions: Int
        let binary: Bool?

        var id: String { path }
    }

    struct SessionDiff: Decodable, Sendable, Equatable {
        let branch: String?
        let baseRef: String?
        let files: [DiffFile]
        let totalAdditions: Int
        let totalDeletions: Int
        let truncated: Bool?
        /// The whole worktree's unified patch, in one string — the route
        /// sends it alongside the file list, and the Changes view splits it
        /// per file (PatchSplitter) rather than asking per file. Optional
        /// because a server old enough to omit it must still decode.
        let rawPatch: String?
    }

    struct RepoDiff: Decodable, Sendable, Equatable {
        let repo: String
        let dir: String?
        let primary: Bool
        let diff: SessionDiff
    }

    struct SessionDiffResponse: Decodable, Sendable, Equatable {
        let repos: [RepoDiff]
    }

    struct WorkspaceOverview: Decodable, Sendable, Equatable {
        struct Message: Decodable, Sendable, Equatable {
            let content: String
            let sessionId: String
            let at: String
        }

        struct Media: Decodable, Sendable, Equatable, Identifiable {
            let kind: String
            let src: String
            let sessionId: String
            let sessionTitle: String?
            let at: String

            var id: String { "\(kind)|\(sessionId)|\(at)|\(src)" }
        }

        let prompt: Message?
        let lastMessage: Message?
        let media: [Media]

        init(prompt: Message?, lastMessage: Message?, media: [Media] = []) {
            self.prompt = prompt
            self.lastMessage = lastMessage
            self.media = media
        }

        private enum CodingKeys: String, CodingKey {
            case prompt, lastMessage, media
        }

        init(from decoder: Decoder) throws {
            let values = try decoder.container(keyedBy: CodingKeys.self)
            prompt = try values.decodeIfPresent(Message.self, forKey: .prompt)
            lastMessage = try values.decodeIfPresent(Message.self, forKey: .lastMessage)
            media = try values.decodeIfPresent([Media].self, forKey: .media) ?? []
        }
    }

    static func gitStatus(sessionId: String, repo: String) async throws -> GitStatus? {
        let encodedRepo = repo.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed)
            ?? repo
        let data = try await getData(
            "/api/sessions/\(sessionId)/git-status?repo=\(encodedRepo)"
        )
        let body = String(decoding: data, as: UTF8.self)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if body.isEmpty || body == "null" { return nil }
        return try await decodeDetached(GitStatus.self, from: data)
    }

    static func sessionDiff(sessionId: String) async throws -> SessionDiffResponse {
        try await get("/api/sessions/\(sessionId)/diff")
    }

    static func workspaceOverview(workspaceId: String) async throws -> WorkspaceOverview {
        try await get("/api/workspaces/\(workspaceId)/overview")
    }

    /// The services this session exposes, for the Portals list.
    ///
    /// Safe to ask for at any time: the server answers a sleeping sandbox
    /// from its cached, URL-less snapshot rather than waking it, so reading
    /// the list never starts compute.
    static func portals(sessionId: String) async throws -> PortalStatus {
        let encoded = sessionId.addingPercentEncoding(
            withAllowedCharacters: .urlPathAllowed
        ) ?? sessionId
        return try await get("/api/sessions/\(encoded)/preview")
    }

    /// Stop or restart one supervised portal, answering the session's whole
    /// portal status afterwards.
    ///
    /// Only `managed` services accept this. A restart is allowed to wake a
    /// sleeping Sandbox because a person asked for it by name; a stop never
    /// wakes one, and the server answers 409 rather than starting compute to
    /// end a process.
    static func portalAction(
        sessionId: String,
        name: String,
        action: PortalAction
    ) async throws -> PortalStatus {
        let session = sessionId.addingPercentEncoding(
            withAllowedCharacters: .urlPathAllowed
        ) ?? sessionId
        let portal = name.addingPercentEncoding(
            withAllowedCharacters: .urlPathAllowed
        ) ?? name
        return try await post(
            "/api/sessions/\(session)/portals/\(portal)/\(action.rawValue)",
            body: [:]
        )
    }

    /// What run environments this instance offers a NEW session. Read once
    /// when the composer opens; the per-session state above is a different
    /// question, asked of a session that already exists.
    static func sandboxStatus() async throws -> InstanceSandboxStatus {
        try await get("/api/sandbox/status")
    }

    /// Live per-session sandbox state. It is fetched only from Workspace
    /// details because asking every row can execute provider status checks.
    static func sandbox(sessionId: String) async throws -> SessionSandboxStatus {
        let encoded = sessionId.addingPercentEncoding(
            withAllowedCharacters: .urlPathAllowed
        ) ?? sessionId
        return try await get("/api/sessions/\(encoded)/sandbox")
    }

    /// Explicit sandbox lifecycle control. Recreate is destructive for files
    /// that only exist in the sandbox volume, so the server requires confirm.
    static func sandboxAction(
        sessionId: String,
        action: SessionSandboxAction
    ) async throws -> SessionSandboxStatus {
        let encoded = sessionId.addingPercentEncoding(
            withAllowedCharacters: .urlPathAllowed
        ) ?? sessionId
        let body: [String: Any] = action == .recreate ? ["confirm": true] : [:]
        return try await post("/api/sessions/\(encoded)/sandbox/\(action.rawValue)", body: body)
    }

    /// Archive (or unarchive) a session. Archiving an in-flight session also
    /// stops its run server-side.
    static func setArchived(sessionId: String, archived: Bool) async throws {
        struct ArchiveResponse: Decodable { let ok: Bool? }
        let _: ArchiveResponse = try await post(
            "/api/sessions/\(sessionId)/archive",
            body: ["archived": archived]
        )
    }

    static func renameWorkspace(workspaceId: String, name: String) async throws {
        struct RenameResponse: Decodable { let workspace: WorkspaceSummary? }
        let _: RenameResponse = try await patch(
            "/api/workspaces/\(workspaceId)",
            body: ["name": name]
        )
    }

    /// Build the parked-draft value sent to the workspace API. Blank text is
    /// absence, so an existing draft is patched with JSON null instead.
    static func workspaceDraftPayload(
        text: String,
        autoName: Bool? = nil
    ) -> [String: Any]? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        var draft: [String: Any] = [
            "text": trimmed,
            "updatedAt": ISO8601DateFormatter.draftStamp.string(from: Date()),
            "by": ServerConfig.shared.userName,
        ]
        if let autoName { draft["autoName"] = autoName }
        return draft
    }

    /// Park an unsent New Session prompt on a workspace. A fresh draft gets a
    /// fresh sessionless workspace; clearing a resumed draft removes its row.
    static func saveWorkspaceDraft(
        text: String,
        repo: String,
        workspaceId: String? = nil,
        autoName: Bool? = nil
    ) async throws -> WorkspaceSummary {
        struct WorkspaceResponse: Decodable { let workspace: WorkspaceSummary }
        let draft = workspaceDraftPayload(text: text, autoName: autoName)

        let response: WorkspaceResponse
        if let workspaceId, !workspaceId.isEmpty {
            let encoded = workspaceId.addingPercentEncoding(
                withAllowedCharacters: .urlPathAllowed
            ) ?? workspaceId
            response = try await patch(
                "/api/workspaces/\(encoded)", body: ["draft": draft ?? NSNull()]
            )
        } else {
            guard var newDraft = draft else { throw APIError.server("A draft needs text.") }
            newDraft["autoName"] = true
            var body: [String: Any] = [
                "name": WorkspaceDraft.workspaceName(for: text),
                "draft": newDraft,
                "user": ServerConfig.shared.userName,
            ]
            if !repo.isEmpty { body["repo"] = repo }
            response = try await post("/api/workspaces", body: body)
        }
        return response.workspace
    }

    static func deleteWorkspace(workspaceId: String) async throws {
        struct DeleteResponse: Decodable { let ok: Bool? }
        let encoded = workspaceId.addingPercentEncoding(
            withAllowedCharacters: .urlPathAllowed
        ) ?? workspaceId
        let _: DeleteResponse = try await mutate(
            "/api/workspaces/\(encoded)", method: "DELETE", body: [:]
        )
    }

    static func renameSession(sessionId: String, title: String) async throws {
        struct RenameResponse: Decodable { let ok: Bool? }
        let _: RenameResponse = try await put(
            "/api/sessions/\(sessionId)/title",
            body: ["title": title]
        )
    }

    struct AuthStatus: Decodable {
        /// The server requires sign-in at all. Absent on servers that predate
        /// it, which is why `AuthGate` treats "not true" as "don't judge".
        let required: Bool?
        let authenticated: Bool?
        /// Signed out because GitHub ended this person's grant, not because
        /// they never signed in, so `login` is still theirs.
        let reconnectRequired: Bool?
        let admin: Bool?
        let login: String?
        let name: String?
    }

    /// Signed-in identity for the current bearer token. Used to backfill
    /// `githubLogin` on devices whose token predates the app storing the
    /// login at sign-in time (the avatar needs it), and to confirm a 401
    /// before the app puts a reconnect in front of anyone (`AuthGate`).
    static func authStatus() async throws -> AuthStatus {
        try await get("/api/auth/status")
    }

    private struct LiveActivityResponse: Decodable, Sendable { let ok: Bool? }

    struct LiveActivityConnection: Equatable, Sendable {
        let baseURL: URL
        let token: String
        let user: String

        static func current() -> LiveActivityConnection? {
            let config = ServerConfig.shared
            guard let baseURL = config.baseURL, config.isConfigured else { return nil }
            return LiveActivityConnection(
                baseURL: baseURL,
                token: config.token,
                user: config.userName
            )
        }
    }

    static func registerLiveActivityDevice(
        deviceId: String,
        pushToStartToken: String,
        connection: LiveActivityConnection
    ) async throws {
        let _: LiveActivityResponse = try await liveActivityMutate(
            "/api/live-activities/device",
            method: "PUT",
            body: [
                "deviceId": deviceId,
                "pushToStartToken": pushToStartToken,
                "user": connection.user,
            ],
            connection: connection
        )
    }

    static func registerLiveActivity(
        deviceId: String,
        activityId: String,
        pushToken: String,
        connection: LiveActivityConnection
    ) async throws {
        let _: LiveActivityResponse = try await liveActivityMutate(
            "/api/live-activities/activity",
            method: "PUT",
            body: [
                "deviceId": deviceId,
                "activityId": activityId,
                "pushToken": pushToken,
                "user": connection.user,
            ],
            connection: connection
        )
    }

    static func unregisterLiveActivityDevice(
        deviceId: String,
        connection: LiveActivityConnection
    ) async throws {
        let encoded = deviceId.addingPercentEncoding(
            withAllowedCharacters: .urlPathAllowed
        ) ?? deviceId
        let _: LiveActivityResponse = try await liveActivityMutate(
            "/api/live-activities/device/\(encoded)",
            method: "DELETE",
            body: ["user": connection.user],
            connection: connection
        )
    }

    private static func liveActivityMutate<T: Decodable & Sendable>(
        _ path: String,
        method: String,
        body: [String: Any],
        connection: LiveActivityConnection
    ) async throws -> T {
        guard let url = URL(string: connection.baseURL.absoluteString + path) else {
            throw APIError.badURL
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("Bearer \(connection.token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, response) = try await URLSession.shared.data(for: request)
        if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            if let serverError = try? JSONDecoder().decode(ServerErrorBody.self, from: data),
               let message = serverError.error {
                throw APIError.server(message)
            }
            throw APIError.http(http.statusCode)
        }
        return try await decodeDetached(T.self, from: data)
    }

    /// Revoke the server-side web session before removing its keychain copy.
    static func logout() async throws {
        struct LogoutResponse: Decodable { let ok: Bool? }
        let _: LogoutResponse = try await post("/api/auth/logout", body: [:])
    }

    /// Unauthenticated liveness probe; also carries the server bootId.
    static func health() async throws -> Bool {
        struct Health: Decodable { let ok: Bool? }
        let health: Health = try await get("/api/health", authorized: false)
        return health.ok ?? true
    }

    // MARK: - Session creation

    private struct ServerErrorBody: Decodable { let error: String? }

    /// Every request's non-2xx tail reports its status here, so the one that
    /// means "this token is finished" is noticed in a single place rather than
    /// at each of the tails that could see it. The gate confirms before it acts
    /// (`AuthGate`), so a route answering 401 on its own account costs nothing
    /// more than one extra call to /api/auth/status.
    private static func noteStatus(_ status: Int) {
        guard status == 401 else { return }
        AuthGate.shared.noteUnauthorized()
    }

    struct RepoInfo: Codable, Identifiable, Hashable {
        let id: String
        let ghRepo: String?
        let label: String?
        let defaultBranch: String?
        let sharedCheckout: Bool?
        let isDefault: Bool?
        /// This repo's letter-tile color, assigned across the registered set
        /// so no two repos share one. Absent on servers older than the
        /// assignment, where the tile falls back to its own hash.
        let color: String?
        /// Whether that color was chosen for the repo rather than assigned.
        let colorChosen: Bool?
        /// What automatic would give it — the same as `color` unless one was
        /// chosen. The tile editor previews it on its Automatic row.
        let autoColor: String?
        /// Which of the editor's icon choices the art came from, when the
        /// server stored it ("github" / "upload").
        let iconSource: String?
        /// Whether the tile paints art rather than the letter.
        let hasIcon: Bool?
        /// Changes when that art does — hung off the icon URL so a replaced
        /// icon isn't served from the cache the old one is sitting in.
        let iconRev: Double?

        private enum CodingKeys: String, CodingKey {
            case id, ghRepo, label, defaultBranch, sharedCheckout, color
            case colorChosen, autoColor, iconSource, hasIcon, iconRev
            case isDefault = "default"
        }
    }

    /// Set a repo's tile color, or fetch/clear its icon. `color` and `icon`
    /// are three-state: absent leaves that half alone, `.some(nil)` clears it.
    @discardableResult
    static func setRepoAppearance(
        id: String,
        color: String?? = nil,
        icon: String?? = nil
    ) async throws -> RepoAppearance {
        var body: [String: Any] = [:]
        if let color { body["color"] = color ?? NSNull() }
        if let icon { body["icon"] = icon ?? NSNull() }
        return try await post("/api/repos/\(id)/appearance", body: body)
    }

    struct RepoAppearance: Decodable, Sendable {
        let color: String?
        let hasIcon: Bool
        let iconRev: Double?
        let iconSource: String?
    }

    /// The owner's GitHub avatar, proxied by our server so the editor can
    /// OFFER the picture rather than a button promising one. 404s when the
    /// repo has no GitHub remote — the choice then isn't shown.
    @MainActor
    static func repoGitHubAvatarURL(id: String) -> URL? {
        ServerConfig.shared.baseURL?
            .appendingPathComponent("api/repos/\(id)/github-avatar")
    }

    /// Give a repo art of its own. Raw PNG bytes, like the web editor: the
    /// client re-encodes whatever was picked, so the server's icon path only
    /// ever decodes PNG.
    static func uploadRepoIcon(id: String, png: Data) async throws -> RepoAppearance {
        let config = ServerConfig.shared
        guard let base = config.baseURL, config.isConfigured else {
            throw APIError.notConfigured
        }
        guard let url = URL(string: base.absoluteString + "/api/repos/\(id)/icon") else {
            throw APIError.badURL
        }
        var request = config.authorizedRequest(url)
        request.httpMethod = "POST"
        request.setValue("image/png", forHTTPHeaderField: "Content-Type")
        request.httpBody = png
        let (data, response) = try await URLSession.shared.data(for: request)
        if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            if let serverError = try? JSONDecoder().decode(ServerErrorBody.self, from: data),
               let message = serverError.error {
                throw APIError.server(message)
            }
            throw APIError.http(http.statusCode)
        }
        return try await decodeDetached(RepoAppearance.self, from: data)
    }

    /// Source bands this instance offers. Only the ids and titles are read:
    /// the app draws Plain's row itself, and the list exists so Settings can
    /// offer a switch per source instead of the one id this build knows.
    static func feeds() async throws -> [SidebarFeeds.Feed] {
        struct FeedsResponse: Decodable, Sendable { let feeds: [SidebarFeeds.Feed]? }
        let response: FeedsResponse = try await get("/api/feeds")
        return response.feeds ?? []
    }

    /// Repos a new session can target.
    static func repos() async throws -> [RepoInfo] {
        struct ReposResponse: Decodable { let repos: [RepoInfo] }
        let response: ReposResponse = try await get("/api/repos")
        // Recorded on the way through rather than at the call sites: every
        // tile in the app wants the assignment, and a tile is handed a repo
        // id, not a RepoInfo. The size of the set is remembered for the same
        // reason — the sessions list picks its default grouping from it, at a
        // point far too early to ask (see `RepoCount`).
        await RepoTilePalette.shared.remember(response.repos)
        // Same deal for the transcript's PR chips: the ids decide which
        // qualified mentions (`opensession#128`) link at all, and the GitHub
        // names are where a chip goes when the app can't show the PR itself.
        let transcriptRepos = Dictionary(
            response.repos.map { ($0.id, $0.ghRepo) },
            uniquingKeysWith: { first, _ in first }
        )
        PrLinks.register(repos: transcriptRepos)
        CommitLinks.register(repos: transcriptRepos)
        RepoCount.remember(response.repos.count)
        return response.repos
    }

    /// What the repo switcher needs before it offers the list. `switchable`
    /// is false for the session kinds that have no worktree of their own to
    /// repoint (Ask reads the main checkout, scratch has no repo at all);
    /// `hasWork` means the switch is confirmed first, because the current
    /// changes stay behind in the old worktree.
    struct RepoSwitchable: Decodable, Sendable {
        let switchable: Bool?
        let hasWork: Bool?
    }

    static func repoSwitchable(sessionId: String) async throws -> RepoSwitchable {
        try await get("/api/sessions/\(sessionId)/repo-switchable")
    }

    struct SwitchedRepo: Decodable, Sendable {
        let repo: String
        let branch: String
        let worktreeDir: String
    }

    /// Point a session at a different repo, for the wrong one picked at
    /// creation. Nothing is destroyed: the old worktree keeps its branch,
    /// commits and edits on disk, which is why a session that already has
    /// work has to pass `force`. The next prompt runs from the new worktree.
    @discardableResult
    static func switchPrimaryRepo(
        sessionId: String,
        repo: String,
        force: Bool
    ) async throws -> SwitchedRepo {
        try await post(
            "/api/sessions/\(sessionId)/switch-primary-repo",
            body: ["repo": repo, "force": force]
        )
    }

    /// The instance library: everything this instance can be extended with.
    /// Read-only, and small enough to fetch whole (the automation rows carry
    /// their prompts, which is most of the payload and the reason the phone
    /// asks for it at all).
    static func library() async throws -> [LibraryEntry] {
        struct LibraryResponse: Decodable { let entries: [LibraryEntry]? }
        let response: LibraryResponse = try await get("/api/library")
        return response.entries ?? []
    }

    /// One teammate from the server's identity roster (src/server/people.ts).
    /// `name` is the first name every people surface keys on — presence
    /// viewers, `startedBy`, @-mentions — and `github` is where the face
    /// comes from.
    struct Person: Decodable, Sendable {
        let name: String
        let fullName: String?
        let github: String?
        /// A picture they uploaded themselves (Settings > Personal > Account),
        /// as a server-relative `/media` URL. When set it outranks the GitHub
        /// face: it is the one they chose. Needs our bearer token like every
        /// other server path, so it loads through `authorizedRequest`.
        let image: String?
    }

    /// A configured review team: one name you can hand a review to, and the
    /// people it reaches (`reviewTeams` in the server's identity config).
    struct ReviewTeam: Decodable, Sendable, Identifiable {
        /// What it is called ("Super developers").
        let name: String
        /// Its GitHub spec (`org/team`) — what a review request is set to.
        let github: String
        /// The individual people the request covers.
        let members: [String]?

        var id: String { github }
    }

    struct Roster: Decodable, Sendable {
        let people: [Person]?
        let reviewTeams: [ReviewTeam]?
    }

    /// The team directory: who exists, which GitHub account each is, and the
    /// teams a review can be handed to.
    static func people() async throws -> Roster {
        try await get("/api/people")
    }

    /// What this instance calls itself and its agent (Settings → General on
    /// the web). Read-only here: the app shows the names, it doesn't set them.
    struct Identity: Decodable, Sendable {
        let personaName: String?
        let productName: String?
    }

    static func identity() async throws -> Identity {
        try await get("/api/settings/identity")
    }

    /// What's wired up on this instance, for Settings → Setup. Read-only
    /// snapshot; presence booleans only, never a credential value. Mirrors
    /// the web's `SetupStatus` (src/frontend/components/setup-shared.tsx) as
    /// a tolerant subset — every field optional, so a server that grows or
    /// drops one can't break an older build.
    struct SetupStatus: Codable, Sendable {
        struct Engine: Codable, Sendable {
            let ready: Bool?
            /// What stops this instance running a turn, in one sentence.
            let blocker: String?
            let fix: String?
            let defaultModel: String?
            let bridgeEnabled: Bool?
            let claudeAccounts: Int?
            let codexAccounts: Int?
        }

        /// Whether a repo commits the scripts that let a session provision and
        /// boot it unattended (docs/repo-lifecycle.md).
        struct Lifecycle: Codable, Sendable {
            let dir: String?
            let setup: Bool?
            let start: Bool?
            let previewCommand: Bool?
        }

        struct Repo: Codable, Sendable {
            let id: String
            let label: String?
            let path: String?
            let lifecycle: Lifecycle?
        }

        struct Team: Codable, Sendable {
            let count: Int?
            let names: [String]?
        }

        let publicBaseUrl: String?
        let repos: [Repo]?
        let team: Team?
        let engine: Engine?
        // The integration and sign-in halves are the settings models, not a
        // second lean copy: Settings -> Integrations manages what this
        // checklist reports, and two decodes of one payload drift.
        // Settable: the Integrations page writes a changed integration back
        // into the snapshot it is showing, so returning to the list does not
        // wait for a refetch to reflect a switch that already landed.
        var github: GithubSignInSettings?
        var integrations: [IntegrationSettings]?
    }

    static func setupStatus() async throws -> SetupStatus {
        try await get("/api/setup/status")
    }

    /// One repository the instance's GitHub credential can see, as the
    /// registration picker lists it (src/server/routes/setup-repos.ts).
    struct BrowsableRepo: Codable, Sendable, Hashable, Identifiable {
        let fullName: String
        let isPrivate: Bool?
        let description: String?
        let defaultBranch: String?
        /// Already registered here, so it is shown but can't be picked.
        let registered: Bool?

        var id: String { fullName }

        private enum CodingKeys: String, CodingKey {
            case fullName, description, defaultBranch, registered
            case isPrivate = "private"
        }
    }

    /// What `GET /api/setup/github/repos` answers.
    ///
    /// `source` names the credential the list was read with — `user` for the
    /// signed-in teammate's own connected account, `bot` for the instance's
    /// shared one. It is nil when this instance holds neither, which is the
    /// one case with nothing to pick from.
    struct RepoBrowse: Codable, Sendable {
        let source: String?
        let repos: [BrowsableRepo]?
    }

    static func browsableRepos() async throws -> RepoBrowse {
        try await getReportingServerError("/api/setup/github/repos")
    }

    /// Register a GitHub `owner/name` on this instance.
    ///
    /// The server CLONES the repo before it answers, so this call is slow in a
    /// way no other one here is — a minute or more on a large repo. It gets
    /// its own long timeout rather than the shared session's 60s, which would
    /// fail the request while the clone kept running and leave the phone
    /// reporting an error for a repo that did register.
    ///
    /// Returns nothing on purpose. The registered repo comes back in the
    /// reply, but the caller wants the whole list rather than one row, and
    /// decoding a body nobody reads would turn a successful clone into a
    /// visible error the moment that shape changed.
    static func registerRepo(fullName: String) async throws {
        let config = ServerConfig.shared
        guard let base = config.baseURL, config.isConfigured else {
            throw APIError.notConfigured
        }
        guard let url = URL(string: base.absoluteString + "/api/setup/repos") else {
            throw APIError.badURL
        }
        var request = config.authorizedRequest(url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 600
        request.httpBody = try JSONSerialization.data(
            withJSONObject: ["fullName": fullName]
        )
        let (data, response) = try await URLSession.shared.data(for: request)
        try throwServerError(data: data, response: response)
    }

    /// `get`, but surfacing the server's own error text.
    ///
    /// The shared `get` reports the status code alone, which turns setup's two
    /// most likely answers — "Workspace administrator access is required" and
    /// a GitHub outage — into "Server returned HTTP 403". Both are things the
    /// person holding the phone can act on, so both have to arrive as written.
    private static func getReportingServerError<T: Decodable & Sendable>(
        _ path: String
    ) async throws -> T {
        let config = ServerConfig.shared
        guard let base = config.baseURL, config.isConfigured else {
            throw APIError.notConfigured
        }
        guard let url = URL(string: base.absoluteString + path) else {
            throw APIError.badURL
        }
        let (data, response) = try await URLSession.shared.data(
            for: config.authorizedRequest(url)
        )
        try throwServerError(data: data, response: response)
        return try await decodeDetached(T.self, from: data)
    }

    private static func throwServerError(data: Data, response: URLResponse) throws {
        guard let http = response as? HTTPURLResponse,
              !(200..<300).contains(http.statusCode)
        else { return }
        if let body = try? JSONDecoder().decode(ServerErrorBody.self, from: data),
           let message = body.error {
            throw APIError.server(message)
        }
        throw APIError.http(http.statusCode)
    }

    /// Models (and presets) a session can run on, plus the interactive default
    /// and engine routing. A workspace replaces the global presets with its
    /// own catalog, so every surface editing a workspace session must scope
    /// this request.
    static func models(workspaceId: String? = nil) async throws -> ModelCatalog {
        try await get(modelsPath(workspaceId: workspaceId))
    }

    static func modelsPath(workspaceId: String?) -> String {
        guard let workspaceId, !workspaceId.isEmpty else { return "/api/models" }
        var components = URLComponents()
        components.path = "/api/models"
        components.queryItems = [URLQueryItem(name: "workspace", value: workspaceId)]
        return components.string ?? "/api/models"
    }

    struct ForkFrom: Equatable, Sendable {
        let sourceId: String
        let messageId: String?

        init(sourceId: String, messageId: String? = nil) {
            self.sourceId = sourceId
            self.messageId = messageId
        }

        var wireValue: [String: String] {
            var value = ["sourceId": sourceId]
            if let messageId { value["messageId"] = messageId }
            return value
        }
    }

    /// Create a session; returns the new session id. Code mode gets a
    /// server-suggested branch; the opening run starts immediately.
    static func createSession(
        prompt: String,
        repo: String,
        mode: String,
        checkoutMode: String = "default",
        model: String? = nil,
        effort: String? = nil,
        fastMode: Bool = false,
        images: [String] = [],
        files: [AttachedFile] = [],
        workspaceId: String? = nil,
        sandbox: String? = nil,
        forkFrom: ForkFrom? = nil,
        requestId: String? = nil
    ) async throws -> String {
        struct CreateResponse: Decodable { let id: String }
        var body = createSessionBody(
            prompt: prompt,
            repo: repo,
            mode: mode,
            checkoutMode: checkoutMode,
            model: model,
            effort: effort,
            fastMode: fastMode,
            images: images,
            files: files,
            workspaceId: workspaceId,
            sandbox: sandbox,
            forkFrom: forkFrom,
            user: ServerConfig.shared.userName,
            requestId: requestId
        )
        let config = ServerConfig.shared
        let scope = config.githubLogin.isEmpty ? config.userName : config.githubLogin
        let intents = SessionCreateIntent(
            key: "dev.tella.os1.create-intent.v1:\(config.baseURLString):\(scope)"
        )
        let stableRequestId = requestId ?? intents.requestId(for: body)
        body["requestId"] = stableRequestId
        let response: CreateResponse = try await post("/api/sessions", body: body)
        intents.complete(requestId: stableRequestId)
        return response.id
    }

    /// The native REST route accepts the same explicit no-repo sentinel as the
    /// web socket create. Keep this builder visible to focused contract tests:
    /// omitting `repo` means inherit-or-default and is not repo-less.
    static func createSessionBody(
        prompt: String,
        repo: String,
        mode: String,
        checkoutMode: String = "default",
        model: String? = nil,
        effort: String? = nil,
        fastMode: Bool = false,
        images: [String] = [],
        files: [AttachedFile] = [],
        workspaceId: String? = nil,
        sandbox: String? = nil,
        forkFrom: ForkFrom? = nil,
        user: String,
        requestId: String? = nil
    ) -> [String: Any] {
        var body: [String: Any] = [
            "prompt": prompt,
            "mode": mode,
            "checkoutMode": checkoutMode == "checkout" || checkoutMode == "worktree"
                ? checkoutMode
                : "default",
        ]
        if let requestId, !requestId.isEmpty { body["requestId"] = requestId }
        // Sent only when the composer actually offered the choice. Omitting it
        // lets the instance's own sandbox default decide, which is the right
        // behaviour when there was nothing to pick from — and the wrong one
        // the moment a chip on screen says where this session runs.
        if let sandbox, !sandbox.isEmpty { body["sandbox"] = sandbox }
        if !repo.isEmpty { body["repo"] = repo }
        // Join an existing workspace as a sibling session (a new tab) rather
        // than starting a standalone session: the server takes the workspace's
        // worktree/branch for code sessions, so the tabs share one checkout.
        if let workspaceId, !workspaceId.isEmpty { body["workspaceId"] = workspaceId }
        if let forkFrom { body["forkFrom"] = forkFrom.wireValue }
        if let model, !model.isEmpty { body["model"] = model }
        if let effort, !effort.isEmpty { body["effort"] = effort }
        if fastMode { body["fastMode"] = true }
        if !images.isEmpty { body["images"] = images }
        let stagedFiles = files.compactMap(\.wireValue)
        if !stagedFiles.isEmpty { body["files"] = stagedFiles }
        if !user.isEmpty { body["user"] = user }
        return body
    }

    /// Upload one composer file before it rides a prompt or session create.
    /// The route returns a server-confined path, so the JSON request carries no
    /// file bytes and can use the same path as the web composer.
    static func uploadComposerFile(_ file: AttachedFile) async throws -> AttachedFile {
        struct UploadResponse: Decodable, Sendable {
            let name: String
            let path: String
        }
        guard let data = file.data else {
            if file.isStaged { return file }
            throw APIError.server("The attachment is no longer available")
        }
        let encodedName = file.name.addingPercentEncoding(
            withAllowedCharacters: .alphanumerics
        ) ?? "file"
        let response: UploadResponse = try await upload(
            "/api/upload",
            data: data,
            contentType: file.mediaType,
            headers: ["x-file-name": encodedName]
        )
        return file.staged(name: response.name, path: response.path)
    }

    /// What the server did with a message — or why it couldn't.
    ///
    /// The distinction that matters to the outbox is retryable vs terminal:
    /// anything that smells like connectivity comes back `.unavailable` and is
    /// tried again, while a refusal is `.rejected` and waits for a human.
    enum PromptDelivery: Sendable {
        /// Accepted. `status` is where it landed: started/steered/queued/handled.
        case delivered(status: String, message: String)
        /// The server understood and refused — retrying won't help.
        case rejected(String)
        /// No such session (yet): a freshly created session may not be persisted.
        case missing(String)
        /// Couldn't reach the server, or it failed on its own. Retry.
        case unavailable(String)
    }

    /// Deliver one message. The reply is the acknowledgement the outbox waits
    /// for; `clientId` makes a retry idempotent, so a reply lost on the way
    /// back can never post the message twice.
    static func deliverPrompt(
        sessionId: String,
        content: String,
        images: [String] = [],
        user: String,
        busyMode: String,
        effort: String? = nil,
        fastMode: Bool? = nil,
        clientId: String
    ) async -> PromptDelivery {
        struct DeliverResponse: Decodable, Sendable {
            let status: String?
            let message: String?
            let error: String?
        }
        let config = ServerConfig.shared
        guard let base = config.baseURL, config.isConfigured else {
            return .unavailable(APIError.notConfigured.localizedDescription)
        }
        let escaped = sessionId.addingPercentEncoding(
            withAllowedCharacters: .urlPathAllowed
        ) ?? sessionId
        guard let url = URL(
            string: base.absoluteString + "/api/sessions/\(escaped)/prompt"
        ) else {
            return .rejected(APIError.badURL.localizedDescription)
        }

        let normalizedImages = images.compactMap(AttachedImage.serverDataURL)
        guard normalizedImages.count == images.count else {
            return .rejected("An attached image could not be prepared. Attach it again.")
        }
        var body: [String: Any] = ["content": content, "clientId": clientId]
        if busyMode == "queue" || busyMode == "steer" { body["busy"] = busyMode }
        if !user.isEmpty { body["user"] = user }
        if !normalizedImages.isEmpty { body["images"] = normalizedImages }
        if let effort, !effort.isEmpty { body["effort"] = effort }
        if let fastMode { body["fastMode"] = fastMode }

        var request = config.authorizedRequest(url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        // Shorter than URLSession's 60s default: a send that hasn't been
        // answered in 20s is better retried than left hanging, and the
        // clientId makes that safe.
        request.timeoutInterval = 20
        guard let payload = try? JSONSerialization.data(withJSONObject: body) else {
            return .rejected("Message couldn't be encoded.")
        }
        request.httpBody = payload

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            let decoded = try? await decodeDetached(DeliverResponse.self, from: data)
            guard let http = response as? HTTPURLResponse else {
                return .unavailable("No response from the server.")
            }
            if (200..<300).contains(http.statusCode) {
                return .delivered(
                    status: decoded?.status ?? "started",
                    message: decoded?.message ?? ""
                )
            }
            let message = decoded?.error ?? decoded?.message
                ?? APIError.http(http.statusCode).localizedDescription
            if http.statusCode == 404 { return .missing(message) }
            // 401 is "signed out", not "bad message" — a re-auth fixes it, so
            // hold the message rather than failing it.
            if http.statusCode == 401 || http.statusCode >= 500 {
                return .unavailable(message)
            }
            return .rejected(message)
        } catch {
            return .unavailable(await Reachability.describe(error))
        }
    }

    // MARK: - Desk

    struct DeskEnsure: Decodable, Sendable {
        let sessionId: String
        let clearedAt: String?
    }

    /// Get-or-create the user's standing Desk session (server: desk.ts).
    static func ensureDesk() async throws -> DeskEnsure {
        try await post("/api/desk/ensure", body: ["user": ServerConfig.shared.userName])
    }

    struct DeskVoiceSecret: Decodable, Sendable {
        let clientSecret: String
        let expiresAt: Double?
        let model: String
        let sessionId: String
    }

    /// Mint a short-lived Realtime client secret for a Desk voice call — the
    /// real OpenAI key stays on the server (desk-voice.ts).
    static func deskVoiceSecret() async throws -> DeskVoiceSecret {
        try await post("/api/desk/voice/secret", body: ["user": ServerConfig.shared.userName])
    }

    /// Run one Realtime tool call server-side, as the verified user, and hand
    /// back the JSON string the model gets as its function_call_output. The
    /// result under "result" has no fixed schema, so this path stays on raw
    /// JSONSerialization instead of a Decodable.
    static func deskVoiceTool(
        callId: String,
        name: String,
        args: [String: Any]
    ) async throws -> String {
        var body: [String: Any] = ["callId": callId, "name": name, "args": args]
        let user = ServerConfig.shared.userName
        if !user.isEmpty { body["user"] = user }
        let data = try await mutateData("/api/desk/voice/tool", method: "POST", body: body)
        if let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let result = object["result"],
           let out = try? JSONSerialization.data(
               withJSONObject: result,
               options: [.fragmentsAllowed]
           ),
           let text = String(data: out, encoding: .utf8) {
            return text
        }
        return String(decoding: data, as: UTF8.self)
    }

    /// Mirror finalized voice-call turns into the Desk transcript (and the
    /// next text turn's handoff note, server-side).
    static func deskVoiceTranscript(
        entries: [(id: String, role: String, text: String)]
    ) async throws {
        struct OkResponse: Decodable, Sendable { let ok: Bool? }
        var body: [String: Any] = [
            "entries": entries.map { ["id": $0.id, "role": $0.role, "text": $0.text] }
        ]
        let user = ServerConfig.shared.userName
        if !user.isEmpty { body["user"] = user }
        let _: OkResponse = try await post("/api/desk/voice/transcript", body: body)
    }

    /// One audio-free line about how a voice call went (counters only — no
    /// audio, no transcript). A call that fails does so on the user's device
    /// with nothing to inspect; this is what makes the next report of one
    /// answerable. Best effort by design: the caller ignores failures.
    static func deskVoiceDiag(_ report: [String: Any]) async throws {
        struct OkResponse: Decodable, Sendable { let ok: Bool? }
        var body = report
        let user = ServerConfig.shared.userName
        if !user.isEmpty { body["user"] = user }
        let _: OkResponse = try await post("/api/desk/voice/diag", body: body)
    }

    // MARK: - Plain (support)

    /// The Todo queue. The server caches it for 30s and caps it at 100
    /// threads — there is no cursor, so a busier inbox truncates silently.
    static func supportThreads() async throws -> [SupportThreadSummary] {
        struct ThreadsResponse: Decodable, Sendable {
            let threads: [SupportThreadSummary]?
        }
        let response: ThreadsResponse = try await get("/api/plain/threads")
        return response.threads ?? []
    }

    /// One thread's timeline. Uncached server-side, so this is what to refetch
    /// after sending — the queue's own cache lags by up to 30s.
    static func supportThread(id: String) async throws -> SupportThread {
        struct ThreadResponse: Decodable, Sendable { let thread: SupportThread }
        let encoded = id.addingPercentEncoding(
            withAllowedCharacters: .urlPathAllowed
        ) ?? id
        let response: ThreadResponse = try await get("/api/plain/threads/\(encoded)")
        return response.thread
    }

    /// Send a customer reply or post an internal note.
    ///
    /// Send the RAW text: the server adds the sign-off on a reply (skipping it
    /// when the author already signed) and the `**Name (via …):**` prefix on a
    /// note. Pre-signing here would produce two signatures.
    ///
    /// The answer says how it went out — `"user"` when the teammate's own
    /// Plain grant carried it, `"system"` when it fell back to the workspace
    /// bot. Worth showing: the customer sees a different sender.
    ///
    /// A reply emails a real person and there is no idempotency key, so this
    /// must never be auto-retried; a second attempt is a second email.
    @discardableResult
    static func sendSupportReply(
        threadId: String,
        text: String,
        isNote: Bool,
        attachmentIds: [String] = []
    ) async throws -> String? {
        struct ReplyResponse: Decodable, Sendable { let sentAs: String? }
        let encoded = threadId.addingPercentEncoding(
            withAllowedCharacters: .urlPathAllowed
        ) ?? threadId
        // Without a name the reply goes out unsigned and the note lands
        // unattributed. A signed-in server overrides this with the verified
        // identity anyway.
        let response: ReplyResponse = try await post(
            "/api/plain/threads/\(encoded)/reply",
            body: supportReplyBody(
                text: text,
                isNote: isNote,
                user: ServerConfig.shared.userName,
                attachmentIds: attachmentIds
            )
        )
        return response.sentAs
    }

    /// The reply route's JSON body. Split out of the send so the wire shape is
    /// pinned by a test: the ids of the already-uploaded files ride WITH the
    /// message, which is what makes a half-uploaded attachment impossible
    /// (the web does the same, in PlainThreadPanel.tsx).
    nonisolated static func supportReplyBody(
        text: String,
        isNote: Bool,
        user: String,
        attachmentIds: [String]
    ) -> [String: Any] {
        var body: [String: Any] = [
            "text": text,
            "kind": isNote ? "note" : "reply",
            "attachmentIds": attachmentIds,
        ]
        if !user.isEmpty { body["user"] = user }
        return body
    }

    /// Stage one file on the thread for the next reply or note, and hand back
    /// the id the send has to carry.
    ///
    /// The bytes go up raw, not as multipart: the route reads the whole body
    /// as the file and takes the name and the mode from headers. The name is
    /// percent-encoded because a header is ASCII and the server decodes it
    /// with `decodeURIComponent`.
    ///
    /// `isNote` is part of the upload, not just the send: the server remembers
    /// which mode each staged file was uploaded for and refuses a reply that
    /// carries a note's attachment (Plain uploads to a different message
    /// type). Switching the composer's mode therefore invalidates anything
    /// already uploaded — which is why this runs at send time and not when the
    /// file is picked.
    ///
    /// A file is capped at 25 MB here; the TOTAL a message may carry is the
    /// send's business (6 MB for a reply, 50 MB for a note).
    static func uploadSupportAttachment(
        threadId: String,
        fileName: String,
        mimeType: String,
        data: Data,
        isNote: Bool
    ) async throws -> String {
        struct UploadResponse: Decodable, Sendable { let attachmentId: String? }
        let target = supportAttachmentUpload(
            threadId: threadId,
            fileName: fileName,
            isNote: isNote
        )
        let response: UploadResponse = try await upload(
            target.path,
            data: data,
            contentType: mimeType,
            headers: target.headers
        )
        guard let attachmentId = response.attachmentId else {
            throw APIError.server("Plain didn't return an attachment")
        }
        return attachmentId
    }

    /// Where one staged file goes and what rides with it. Pure, so the part of
    /// this route that no compiler checks (the raw body, the name in a header,
    /// the mode in a header) is pinned by a test.
    nonisolated static func supportAttachmentUpload(
        threadId: String,
        fileName: String,
        isNote: Bool
    ) -> (path: String, headers: [String: String]) {
        let encoded = threadId.addingPercentEncoding(
            withAllowedCharacters: .urlPathAllowed
        ) ?? threadId
        // `.alphanumerics` rather than a URL set: every reserved character
        // then arrives as %XX, which is what the server's decode expects and
        // what keeps the header ASCII whatever the file is called.
        let encodedName = fileName.addingPercentEncoding(
            withAllowedCharacters: .alphanumerics
        ) ?? "attachment"
        return (
            "/api/plain/threads/\(encoded)/attachments",
            [
                "x-file-name": encodedName,
                "x-plain-kind": isNote ? "note" : "reply",
            ]
        )
    }

    /// Move a thread through the queue. Writes take the LOWERCASE status;
    /// reads hand back Plain's uppercase one.
    static func setSupportStatus(
        threadId: String,
        status: String,
        durationSeconds: Int? = nil
    ) async throws {
        struct StatusResponse: Decodable, Sendable { let ok: Bool? }
        let encoded = threadId.addingPercentEncoding(
            withAllowedCharacters: .urlPathAllowed
        ) ?? threadId
        var body: [String: Any] = ["status": status]
        if let durationSeconds { body["durationSeconds"] = durationSeconds }
        let user = ServerConfig.shared.userName
        if !user.isEmpty { body["user"] = user }
        let _: StatusResponse = try await post(
            "/api/plain/threads/\(encoded)/status",
            body: body
        )
    }

    /// An attachment's bytes, through the server's proxy.
    ///
    /// Never build a Plain URL: its signed links expire in about three
    /// minutes, which is why the thread payload carries only the id and the
    /// proxy re-mints one per request. It also needs our bearer token, so this
    /// can't be handed to `AsyncImage` — the same reason the assets viewer
    /// fetches its own bytes.
    static func supportAttachment(id: String) async throws -> Data {
        let encoded = id.addingPercentEncoding(
            withAllowedCharacters: .urlPathAllowed
        ) ?? id
        return try await getData("/api/plain/attachments/\(encoded)")
    }

    private static func post<T: Decodable & Sendable>(
        _ path: String,
        body: [String: Any]
    ) async throws -> T {
        try await mutate(path, method: "POST", body: body)
    }

    private static func put<T: Decodable & Sendable>(
        _ path: String,
        body: [String: Any]
    ) async throws -> T {
        try await mutate(path, method: "PUT", body: body)
    }

    private static func patch<T: Decodable & Sendable>(
        _ path: String,
        body: [String: Any]
    ) async throws -> T {
        try await mutate(path, method: "PATCH", body: body)
    }

    private static func mutate<T: Decodable & Sendable>(
        _ path: String,
        method: String,
        body: [String: Any]
    ) async throws -> T {
        let config = ServerConfig.shared
        guard let base = config.baseURL else { throw APIError.notConfigured }
        guard config.isConfigured else { throw APIError.notConfigured }
        guard let url = URL(string: base.absoluteString + path) else { throw APIError.badURL }

        var request = config.authorizedRequest(url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, response) = try await URLSession.shared.data(for: request)
        if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            noteStatus(http.statusCode)
            if let serverError = try? JSONDecoder().decode(ServerErrorBody.self, from: data),
               let message = serverError.error {
                throw APIError.server(message)
            }
            throw APIError.http(http.statusCode)
        }
        return try await decodeDetached(T.self, from: data)
    }

    /// `mutate` with a file for a body instead of JSON — the Plain attachment
    /// route takes the raw bytes and reads the file's name and type from
    /// headers. Same error contract, so a server message ("Attachment is too
    /// large (25 MB max)") reaches the caller as written.
    private static func upload<T: Decodable & Sendable>(
        _ path: String,
        data: Data,
        contentType: String,
        headers: [String: String]
    ) async throws -> T {
        let config = ServerConfig.shared
        guard let base = config.baseURL else { throw APIError.notConfigured }
        guard config.isConfigured else { throw APIError.notConfigured }
        guard let url = URL(string: base.absoluteString + path) else { throw APIError.badURL }

        var request = config.authorizedRequest(url)
        request.httpMethod = "POST"
        request.setValue(contentType, forHTTPHeaderField: "Content-Type")
        for (field, value) in headers { request.setValue(value, forHTTPHeaderField: field) }
        request.httpBody = data
        let (body, response) = try await URLSession.shared.data(for: request)
        if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            noteStatus(http.statusCode)
            if let serverError = try? JSONDecoder().decode(ServerErrorBody.self, from: body),
               let message = serverError.error {
                throw APIError.server(message)
            }
            throw APIError.http(http.statusCode)
        }
        return try await decodeDetached(T.self, from: body)
    }

    /// `mutate` without a Decodable — for responses with no fixed schema
    /// (the Desk voice tool relay). Same error contract.
    private static func mutateData(
        _ path: String,
        method: String,
        body: [String: Any]
    ) async throws -> Data {
        let config = ServerConfig.shared
        guard let base = config.baseURL else { throw APIError.notConfigured }
        guard config.isConfigured else { throw APIError.notConfigured }
        guard let url = URL(string: base.absoluteString + path) else { throw APIError.badURL }

        var request = config.authorizedRequest(url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, response) = try await URLSession.shared.data(for: request)
        if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            noteStatus(http.statusCode)
            if let serverError = try? JSONDecoder().decode(ServerErrorBody.self, from: data),
               let message = serverError.error {
                throw APIError.server(message)
            }
            throw APIError.http(http.statusCode)
        }
        return data
    }

    /// `revalidating` asks the server whether the body changed instead of for
    /// the body: the last ETag rides with the request, and a 304 is answered
    /// from `RevalidationCache` without a transfer or a decode. Worth it only
    /// where the same path is read again and again and the answer is usually
    /// the same, which is the polled lists and nothing else so far.
    private static func get<T: Decodable & Sendable>(
        _ path: String,
        authorized: Bool = true,
        revalidating: Bool = false
    ) async throws -> T {
        let config = ServerConfig.shared
        guard let base = config.baseURL else { throw APIError.notConfigured }
        if authorized && !config.isConfigured { throw APIError.notConfigured }
        guard let url = URL(string: base.absoluteString + path) else { throw APIError.badURL }

        var request = authorized ? config.authorizedRequest(url) : URLRequest(url: url)
        let cache = RevalidationCache.shared
        // Server and token, and deliberately not the display name: the token
        // is what decides which account a body was answered for, while the
        // name arrives later (`ServerConfig` backfills it from /api/auth/
        // status), and keying on it threw the first response of every launch
        // away for a change that was never a change of account.
        let connection = "\(base.absoluteString)|\(config.token)"
        var conditional = false
        if revalidating, let etag = cache.validator(for: path, connection: connection) {
            request.setValue(etag, forHTTPHeaderField: "If-None-Match")
            // Ours is the validator this request is asking on, so URLSession's
            // own cache must neither answer it nor add a second one.
            request.cachePolicy = .reloadIgnoringLocalCacheData
            conditional = true
        }

        let (data, response) = try await URLSession.shared.data(for: request)
        let http = response as? HTTPURLResponse
        if conditional, http?.statusCode == 304 {
            if let cached = cache.value(T.self, for: path) { return cached }
            // The body went away under us. Ask again without the validator
            // rather than report a 304 to a caller that has nothing either;
            // the entry is gone now, so the second attempt cannot loop.
            cache.forget(path)
            return try await get(path, authorized: authorized, revalidating: revalidating)
        }
        if let http, !(200..<300).contains(http.statusCode) {
            noteStatus(http.statusCode)
            throw APIError.http(http.statusCode)
        }
        let decoded = try await decodeDetached(T.self, from: data)
        if revalidating {
            if let etag = http?.value(forHTTPHeaderField: "ETag") {
                cache.store(decoded, etag: etag, for: path, connection: connection)
            } else {
                // A server that answers this path without one must not be
                // asked conditionally on a validator it never gave.
                cache.forget(path)
            }
        }
        return decoded
    }

    /// Decode off the main actor. OS1API is @MainActor, and decoding inline
    /// parked multi-megabyte payloads on the main thread — the sessions list
    /// is thousands of rows every 5s poll, a visible periodic hitch while
    /// typing (long transcripts weren't small either). Taking archived
    /// sessions off that poll roughly halved it; it is still the biggest
    /// thing this app decodes.
    private static func decodeDetached<T: Decodable & Sendable>(
        _ type: T.Type,
        from data: Data
    ) async throws -> T {
        try await Task.detached(priority: .userInitiated) {
            try JSONDecoder().decode(T.self, from: data)
        }.value
    }

    private static func getData(_ path: String) async throws -> Data {
        let config = ServerConfig.shared
        guard let base = config.baseURL else { throw APIError.notConfigured }
        guard config.isConfigured else { throw APIError.notConfigured }
        guard let url = URL(string: base.absoluteString + path) else { throw APIError.badURL }
        return try await responseData(for: config.authorizedRequest(url))
    }

    private static func responseData(for request: URLRequest) async throws -> Data {
        let (data, response) = try await imageSession.data(for: request)
        if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            noteStatus(http.statusCode)
            throw APIError.http(http.statusCode)
        }
        return data
    }
}
