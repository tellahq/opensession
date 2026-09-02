import SwiftUI

// Native settings panels intentionally use only SettingsAPI. They can be hosted by
// any settings navigation container without depending on the legacy web settings view.

/// Settings → Providers. Which model a session starts on, which engine
/// carries it, the subscription accounts runs draw from and how close each one
/// is to its limit, and any provider someone brought a key for.
///
/// One page, as on the web (ProvidersPanel.tsx). The account meters were their
/// own page for a while, on the grounds that they move hourly while a default
/// model is set once. They are back here because the answer to "this pool is
/// spent" is on this page too: connect another account, or start runs on a
/// different model.
struct ProvidersSettingsView: View {
    @State private var reload = 0

    var body: some View {
        List {
            ModelDefaultsSections(reload: reload)
            ProviderAccountSections(reload: reload)
            ModelProvidersSections(reload: reload)
        }
        .insetGroupedListCompat()
        .navigationTitle("Providers")
        .refreshable { reload += 1 }
    }
}

/// The model a new session starts on, and whether a spent account falls back
/// to another one.
struct ModelDefaultsSections: View {
    /// Bumped by the enclosing pane's pull-to-refresh; re-runs `task`.
    var reload: Int
    @State private var catalog: ModelCatalogSettings?
    @State private var selectedModel: String
    @State private var autoFallback: Bool
    @State private var loading = true
    @State private var error: String?

    /// Seeded from the last answer this device saw, so re-entering Models shows
    /// the controls straight away and the fetch behind it only corrects them.
    /// Both are derived from the catalog rather than cached separately — one
    /// payload, one source of truth.
    init(reload: Int) {
        self.reload = reload
        let cached: ModelCatalogSettings? = SettingsCache.value("model-catalog")
        _catalog = State(initialValue: cached)
        _selectedModel = State(initialValue: cached?.default ?? "")
        _autoFallback = State(initialValue: cached?.autoFallback ?? false)
    }

    var body: some View {
        // The spinner is only for having nothing to show at all: with a cached
        // catalog the controls stay up and a failed refresh adds its row above
        // them rather than replacing them.
        Section("Workspace defaults") {
            if loading, catalog == nil {
                settingsLoadingRow
            } else if let error, catalog == nil {
                settingsErrorRow(error) { Task { await load() } }
            } else {
                if let error { settingsErrorRow(error) { Task { await load() } } }
                Picker("Default model", selection: $selectedModel) {
                    Text("None").tag("")
                    ForEach(validModels, id: \.id) { model in
                        Text(model.label ?? model.id ?? "Model").tag(model.id ?? "")
                    }
                }
                Toggle("Auto-fallback", isOn: $autoFallback)
            }
        }
        .task(id: reload) { await load() }
        .onChange(of: selectedModel) { _, value in
            guard !loading else { return }
            Task { await saveDefault(value) }
        }
        .onChange(of: autoFallback) { _, value in
            guard !loading else { return }
            Task { await saveFallback(value) }
        }
    }

    private var validModels: [SettingsModelOption] { (catalog?.models ?? []).filter { $0.id?.isEmpty == false } }

    private func load() async {
        loading = true; error = nil
        do {
            let fetched = try await SettingsAPI.modelCatalog()
            catalog = fetched
            selectedModel = fetched.default ?? ""
            autoFallback = fetched.autoFallback ?? false
            SettingsCache.save("model-catalog", fetched)
        } catch { self.error = error.localizedDescription }
        loading = false
    }
    private func saveDefault(_ value: String) async { do { _ = try await SettingsAPI.setDefaultModel(value.isEmpty ? nil : value) } catch { self.error = error.localizedDescription } }
    private func saveFallback(_ value: Bool) async { do { _ = try await SettingsAPI.setModelAutoFallback(value) } catch { self.error = error.localizedDescription } }
}

struct ModelProvidersSections: View {
    /// Bumped by the enclosing pane's pull-to-refresh; re-runs `task`.
    var reload: Int
    /// `nil` until this device has an answer — from the cache on entry, or from
    /// the fetch. An empty list is a real answer ("no providers"), so emptiness
    /// can't stand in for it.
    @State private var providers: [ModelProvider]?
    @State private var loading = true
    @State private var error: String?
    /// Outcome of the last save or discovery, shown above the rows because the
    /// sheet that triggered it is gone by the time the answer lands.
    @State private var notice: String?
    /// Id of the provider a discovery poll is running for.
    @State private var discovering: String?
    @State private var editor: ModelProvider?
    @State private var deleting: ModelProvider?
    @State private var openedFromEnvironment = false

    init(reload: Int) {
        self.reload = reload
        _providers = State(initialValue: SettingsCache.value("model-providers"))
    }

    var body: some View {
        Section {
            if loading, providers == nil { settingsLoadingRow }
            if let error { settingsErrorRow(error) { Task { await load() } } }
            if let notice {
                Text(notice).font(.caption).foregroundStyle(.secondary)
            }
            if let providers {
                if providers.isEmpty {
                    Text("No providers yet. Add one to use models beyond the Anthropic and OpenAI subscriptions.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                ForEach(providers.filter { $0.id?.isEmpty == false }, id: \.id) { provider in
                    Button { editor = provider } label: {
                        ModelProviderRow(provider: provider, discovering: discovering == provider.id)
                    }
                    .foregroundStyle(.primary)
                    .swipeActions(edge: .leading) {
                        if provider.baseURL?.isEmpty == false {
                            Button { Task { notice = await discover(provider) } } label: {
                                Label("Discover models", systemImage: "magnifyingglass")
                            }
                            .tint(.accentColor)
                        }
                    }
                    .contextMenu {
                        if provider.baseURL?.isEmpty == false {
                            Button { Task { notice = await discover(provider) } } label: {
                                Label("Discover models", systemImage: "magnifyingglass")
                            }
                        }
                        Button(role: .destructive) { deleting = provider } label: {
                            Label("Delete provider", systemImage: "trash")
                        }
                    }
                }
                Button { editor = ModelProvider(id: "") } label: { Label("Add provider", systemImage: "plus") }
            }
        } header: {
            Text("Your own providers")
        } footer: {
            Text("Any provider pi supports with your API key, or any OpenAI-compatible gateway with its base URL. Keys are stored on the server and only shown masked. Discover models reads the gateway's model list into the picker.")
        }
        .task(id: reload) { await load(); openFromEnvironment() }
        .sheet(item: $editor) { provider in
            ModelProviderEditor(
                provider: provider,
                onSave: save,
                onDiscover: { await discover(provider) },
                onDelete: { deleting = provider }
            )
        }
        .alert("Delete provider?", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }), presenting: deleting) { provider in
            Button("Delete", role: .destructive) { Task { await delete(provider) } }; Button("Cancel", role: .cancel) {}
        } message: { provider in Text("Remove \(provider.displayName)?") }
    }

    private func load() async { loading = true; error = nil; do { let fetched = try await SettingsAPI.modelProviders().providers ?? []; providers = fetched; SettingsCache.save("model-providers", fetched) } catch { self.error = error.localizedDescription }; loading = false }

    /// Returns the failure to show inside the sheet, or nil once saved. The
    /// discovery outcome of a save lands in `notice` because the sheet closes.
    private func save(_ draft: ModelProviderDraft) async -> String? {
        do {
            let response = try await SettingsAPI.upsertModelProvider(
                id: draft.cleanId,
                apiKey: draft.apiKeyValue,
                baseURL: draft.trimmedBaseURL,
                models: draft.modelIds,
                api: draft.apiValue,
                name: draft.trimmedName,
                discoverModels: draft.discoverModels
            )
            if let failure = response.discoveryError {
                notice = "Provider \(draft.cleanId) saved. \(failure)"
            } else if let discovery = response.discovery {
                notice = "Provider \(draft.cleanId) saved, \(discovery.models?.count ?? 0) models discovered"
            } else {
                notice = nil
            }
            editor = nil
            await load()
            return nil
        } catch {
            return error.localizedDescription
        }
    }

    /// Poll the gateway's model list. Returns a one-line outcome either way,
    /// so the caller can show it wherever it started from.
    private func discover(_ provider: ModelProvider) async -> String {
        guard let id = provider.id, !id.isEmpty else { return "Save the provider before discovering models." }
        discovering = id
        defer { discovering = nil }
        do {
            let result = try await SettingsAPI.discoverModelProviderModels(id: id)
            await load()
            return "\(result.models?.count ?? 0) models listed, \(result.added ?? 0) added to the picker"
        } catch {
            return error.localizedDescription
        }
    }

    private func delete(_ provider: ModelProvider) async { guard let id = provider.id, !id.isEmpty else { return }; do { _ = try await SettingsAPI.deleteModelProvider(id: id); providers?.removeAll { $0.id == id }; if let providers { SettingsCache.save("model-providers", providers) } } catch { self.error = error.localizedDescription }; deleting = nil }

    /// Node-only hook: a scripted run cannot tap its way into a sheet, so
    /// `OS1_OPEN_PROVIDER=<id>` (or `new`) opens the editor once the list is in.
    private func openFromEnvironment() {
        #if DEBUG
        guard !openedFromEnvironment, editor == nil,
              let target = ProcessInfo.processInfo.environment["OS1_OPEN_PROVIDER"], !target.isEmpty
        else { return }
        openedFromEnvironment = true
        editor = target == "new" ? ModelProvider(id: "") : providers?.first { $0.id == target }
        #endif
    }
}

/// One provider in the list: display name (id beside it when they differ),
/// then the key, endpoint and catalog state on a second line.
private struct ModelProviderRow: View {
    let provider: ModelProvider
    let discovering: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                Text(provider.displayName)
                if provider.name?.isEmpty == false, let id = provider.id {
                    Text(id).font(.caption).foregroundStyle(.secondary)
                }
                if discovering { ProgressView().controlSize(.small) }
            }
            Text(provider.summary)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(2)
        }
    }
}

/// What the provider editor collects, and the rules the Save button follows.
/// Kept as a plain value so the rules are testable without a view.
struct ModelProviderDraft: Equatable {
    var id = ""
    var apiKey = ""
    var baseURL = ""
    var name = ""
    var modelText = ""
    /// Declare `api: openai-completions` so an id pi does not know can run.
    var customGateway = false
    /// Poll `GET {baseURL}/models` on save.
    var discoverModels = false
    /// Editing an existing provider: a blank key keeps the stored one.
    var isEditing = false

    init(provider: ModelProvider) {
        id = provider.id ?? ""
        baseURL = provider.baseURL ?? ""
        name = provider.name ?? ""
        modelText = (provider.models ?? []).joined(separator: ", ")
        customGateway = provider.isCustomGateway
        discoverModels = provider.discoverModels == true
        isEditing = !(provider.id ?? "").isEmpty
    }

    var cleanId: String { id.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }
    /// The server's PROVIDER_ID_RE: lowercase letters, digits and dashes.
    var idValid: Bool { cleanId.range(of: "^[a-z0-9-]+$", options: .regularExpression) != nil }
    var cleanKey: String { apiKey.filter { !$0.isWhitespace } }
    /// `nil` keeps the stored key; the form never clears one.
    var apiKeyValue: String? { cleanKey.isEmpty ? nil : cleanKey }
    var trimmedBaseURL: String { baseURL.trimmingCharacters(in: .whitespacesAndNewlines) }
    var trimmedName: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }
    /// `""` clears the protocol, making the id a plain pi slug again.
    var apiValue: String { customGateway ? "openai-completions" : "" }
    var modelIds: [String] {
        modelText.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    }
    /// A custom protocol or discovery without an endpoint can never run, and
    /// the server refuses to store it.
    var needsBaseURL: Bool { (customGateway || discoverModels) && trimmedBaseURL.isEmpty }
    var canSave: Bool { idValid && !needsBaseURL && (isEditing || !cleanKey.isEmpty) }
}

struct ConnectionsSettingsView: View {
    @State private var response: ConnectionsResponse? = SettingsCache.value("connections")
    @State private var github: GitHubConnectionStatus? = SettingsCache.value("github-connection")
    @State private var router: PlainRouterConfig? = SettingsCache.value("plain-router")
    @State private var loading = true
    @State private var error: String?
    @State private var addSheet = false
    @State private var editing: MCPConnection?
    @State private var removing: MCPConnection?
    @State private var disconnecting: GitHubConnectedAccount?
    @State private var routerSheet = false
    @State private var githubFlow: GitHubDeviceFlow?
    @State private var githubConnectTask: Task<Void, Never>?

    var body: some View {
        List {
            if loading, response == nil { settingsLoadingRow }
            if let error { settingsErrorRow(error) { Task { await load() } } }
            if response != nil {
                Section("Agents") {
                    let agents = response?.agents ?? [:]
                    if agents.isEmpty { Text("No agent health data.").foregroundStyle(.secondary) }
                    ForEach(agents.keys.sorted(), id: \.self) { name in
                        let health = agents[name]
                        ConnectionRow(
                            name: name,
                            status: health?.status,
                            subtitle: health?.activeSessions.flatMap { $0 > 0 ? "\($0) active \($0 == 1 ? "session" : "sessions")" : nil } ?? health?.detail
                        )
                    }
                }
                Section("MCP connections") {
                    let connections = (response?.mcpServers ?? []).filter { $0.name?.isEmpty == false }
                    if connections.isEmpty { Text("No MCP connections.").foregroundStyle(.secondary) }
                    ForEach(connections, id: \.id) { connection in
                        ConnectionRow(
                            name: connection.name ?? "Connection",
                            status: connection.status,
                            subtitle: connectionSubtitle(connection),
                            detail: allowedUsersDetail(connection)
                        ) {
                            // The destructive action lives behind the row's menu
                            // rather than as a bare red button per row: a list of
                            // "Remove"s reads as the point of the screen, and one
                            // mis-tap silently drops a connection for everyone.
                            Menu {
                                Button { editing = connection } label: { Label("Allowed users", systemImage: "person.2") }
                                Button(role: .destructive) { removing = connection } label: { Label("Remove connection", systemImage: "trash") }
                            } label: {
                                Image(systemName: "ellipsis")
                                    .font(.system(size: 15, weight: .semibold))
                                    .foregroundStyle(.secondary)
                                    .frame(width: 30, height: 30)
                                    .contentShape(Rectangle())
                            }
                            .menuStyle(.button)
                            .buttonStyle(.borderless)
                            .accessibilityLabel("\(Brand.displayName(connection.name ?? "connection")) options")
                            // Anchored to the row's own control, so the confirm
                            // reads as a continuation of the menu it came from
                            // instead of a dialog floating over the whole list.
                            .confirmationDialog(
                                "Remove \(Brand.displayName(connection.name ?? "connection"))?",
                                isPresented: Binding(
                                    get: { removing?.id == connection.id },
                                    set: { if !$0, removing?.id == connection.id { removing = nil } }
                                ),
                                titleVisibility: .visible
                            ) {
                                Button("Remove connection", role: .destructive) { Task { await remove(connection) } }
                                Button("Cancel", role: .cancel) { removing = nil }
                            } message: {
                                Text("Every session loses access to \(Brand.displayName(connection.name ?? "this server"))'s tools. You can add it back later.")
                            }
                        }
                        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                            Button(role: .destructive) { removing = connection } label: { Label("Remove", systemImage: "trash") }
                            Button { editing = connection } label: { Label("Users", systemImage: "person.2") }.tint(.blue)
                        }
                    }
                    Button { addSheet = true } label: { Label("Add MCP connection", systemImage: "plus") }
                }
                Section("GitHub") {
                    Text(github?.enabled == true ? "GitHub connection enabled" : "GitHub connection not enabled").foregroundStyle(.secondary)
                    // The whole roster, not only this account: `accounts` holds
                    // just the person signed in here, so on its own the screen
                    // couldn't say whether anyone else had connected — or, for
                    // the one row it did show, that the grant behind it had
                    // been revoked.
                    ForEach(teamRoster, id: \.id) { member in
                        let manageable = manageableAccount(member)
                        ConnectionRow(
                            name: "github",
                            title: member.name?.isEmpty == false ? member.name! : "@\(member.github ?? "")",
                            status: githubStatus(member),
                            subtitle: member.name?.isEmpty == false ? "@\(member.github ?? "")" : nil,
                            detail: connectedSince(connectedAccount(member.github))
                        ) {
                            // Only your own grant is yours to revoke, so every
                            // other row carries no control at all.
                            if let manageable {
                                Menu {
                                    Button(role: .destructive) { disconnecting = manageable } label: { Label("Disconnect account", systemImage: "person.badge.minus") }
                                } label: {
                                    Image(systemName: "ellipsis")
                                        .font(.system(size: 15, weight: .semibold))
                                        .foregroundStyle(.secondary)
                                        .frame(width: 30, height: 30)
                                        .contentShape(Rectangle())
                                }
                                .menuStyle(.button)
                                .buttonStyle(.borderless)
                                .accessibilityLabel("@\(manageable.login ?? "") options")
                                .confirmationDialog(
                                    "Disconnect @\(manageable.login ?? "")?",
                                    isPresented: Binding(
                                        get: { disconnecting?.id == manageable.id },
                                        set: { if !$0, disconnecting?.id == manageable.id { disconnecting = nil } }
                                    ),
                                    titleVisibility: .visible
                                ) {
                                    Button("Disconnect account", role: .destructive) { Task { await disconnect(manageable) } }
                                    Button("Cancel", role: .cancel) { disconnecting = nil }
                                } message: {
                                    Text("Sessions fall back to the shared GitHub credential. You can reconnect any time.")
                                }
                            }
                        }
                        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                            if let manageable {
                                Button(role: .destructive) { disconnecting = manageable } label: { Label("Disconnect", systemImage: "person.badge.minus") }
                            }
                        }
                    }
                    if github?.enabled == true, let connectAction = githubConnectAction {
                        Button { Task { await connectGitHub() } } label: {
                            Label(connectAction, systemImage: "person.badge.key")
                        }
                    }
                }
                Section("Plain router") {
                    Text(router?.basicModel ?? "No basic model selected").foregroundStyle(.secondary)
                    Button("Edit routing") { routerSheet = true }
                }
            }
        }
        .navigationTitle("Connections")
        .toolbar { Button("Refresh") { Task { await load(refresh: true) } } }
        .task { await load() }.refreshable { await load(refresh: true) }
        .sheet(isPresented: $addSheet) { MCPConnectionEditor { await add($0) } }
        .sheet(item: $editing) { connection in AllowedUsersEditor(connection: connection) { await update(connection, users: $0) } }
        .sheet(isPresented: $routerSheet) { PlainRouterEditor(config: router) { prompt, model in await saveRouter(prompt: prompt, model: model) } }
        .sheet(isPresented: Binding(
            get: { githubFlow != nil },
            set: { if !$0 { cancelGitHubConnect() } }
        )) {
            if let githubFlow {
                GitHubConnectionFlowView(flow: githubFlow, onCancel: cancelGitHubConnect)
            }
        }
    }
    // MARK: - GitHub roster

    /// Every configured teammate, plus any connected account the workspace's
    /// identity list doesn't name — without that fallback an instance with no
    /// configured team would list nobody, including whoever is signed in here.
    private var teamRoster: [GitHubTeamConnection] {
        let team = (github?.team ?? []).filter { $0.github?.isEmpty == false }
        let named = Set(team.compactMap { $0.github?.lowercased() })
        let extras: [GitHubTeamConnection] = (github?.accounts ?? []).compactMap { account in
            guard let login = account.login, !login.isEmpty,
                !named.contains(login.lowercased())
            else { return nil }
            return GitHubTeamConnection(
                name: account.name,
                github: login,
                connected: true,
                needsReconnect: account.needsReconnect,
                canManage: true
            )
        }
        return team + extras
    }

    private func connectedAccount(_ login: String?) -> GitHubConnectedAccount? {
        guard let login, !login.isEmpty else { return nil }
        return (github?.accounts ?? []).first { ($0.login ?? "").lowercased() == login.lowercased() }
    }

    /// The account a Disconnect on this row would act on, or nil when the row
    /// holds nothing or belongs to someone else.
    private func manageableAccount(_ member: GitHubTeamConnection) -> GitHubConnectedAccount? {
        guard member.connected == true, member.canManage == true else { return nil }
        return connectedAccount(member.github)
            ?? GitHubConnectedAccount(
                login: member.github,
                name: member.name,
                connectedAt: nil,
                scopes: nil,
                needsReconnect: member.needsReconnect
            )
    }

    /// Three states, not two. A revoked grant is neither connected nor
    /// unconnected, and reads as healthy unless the row says otherwise.
    private func githubStatus(_ member: GitHubTeamConnection) -> String {
        if member.needsReconnect == true { return "reconnect needed" }
        return member.connected == true ? "connected" : "not connected"
    }

    private func connectedSince(_ account: GitHubConnectedAccount?) -> String? {
        guard let date = Session.parseISO(account?.connectedAt) else { return nil }
        return "since \(date.formatted(date: .abbreviated, time: .omitted))"
    }

    /// Which row is you. `canManage` is the server's own answer, computed from
    /// your GitHub login; the name compare is the fallback for an account whose
    /// login the server doesn't know yet, matched loosely in both directions
    /// because one person arrives as "Michiel", "Michiel Westerbeek" and
    /// "happylinks". The account screen had to learn the same thing, having read every
    /// one of this account's own grants as somebody else's.
    private var myTeamRow: GitHubTeamConnection? {
        if let mine = teamRoster.first(where: { $0.canManage == true }) { return mine }
        let name = ServerConfig.shared.userName
        let login = ServerConfig.shared.githubLogin
        return teamRoster.first { member in
            [member.github, member.name]
                .compactMap { $0 }
                .filter { !$0.isEmpty }
                .contains { MessageAttribution.isViewer($0, viewerName: name, viewerLogin: login) }
        }
    }

    /// The button under the roster, when there is anything left to do: your
    /// row already saying "Connected" makes a Connect button below it read as
    /// though it hadn't worked.
    private var githubConnectAction: String? {
        guard let mine = myTeamRow else { return "Connect GitHub account" }
        if mine.needsReconnect == true { return "Reconnect GitHub account" }
        return mine.connected == true ? nil : "Connect GitHub account"
    }

    private func load(refresh: Bool = false) async {
        loading = true; error = nil
        do {
            async let c = SettingsAPI.connections(refresh: refresh); async let g = SettingsAPI.githubConnection(); async let r = SettingsAPI.plainRouter()
            let result = try await (c, g, r)
            response = result.0; github = result.1; router = result.2
            SettingsCache.save("connections", result.0)
            SettingsCache.save("github-connection", result.1)
            SettingsCache.save("plain-router", result.2)
        } catch { self.error = error.localizedDescription }
        loading = false
    }
    private func add(_ body: [String: Any]) async { do { _ = try await SettingsAPI.addConnection(body); addSheet = false; await load() } catch { self.error = error.localizedDescription } }
    private func update(_ connection: MCPConnection, users: [String]) async { guard let name = connection.name else { return }; do { _ = try await SettingsAPI.updateConnection(name: name, allowedUsers: users); editing = nil; await load() } catch { self.error = error.localizedDescription } }
    private func remove(_ connection: MCPConnection) async { guard let name = connection.name else { return }; do { _ = try await SettingsAPI.removeConnection(name: name); await load() } catch { self.error = error.localizedDescription }; removing = nil }
    private func disconnect(_ account: GitHubConnectedAccount) async { guard let login = account.login else { return }; do { _ = try await SettingsAPI.disconnectGitHub(login: login); await load() } catch { self.error = error.localizedDescription } }
    private func saveRouter(prompt: String, model: String) async { do { router = try await SettingsAPI.updatePlainRouter(prompt: prompt, basicModel: model); routerSheet = false } catch { self.error = error.localizedDescription } }
    private func connectGitHub() async {
        do {
            let started = try await SettingsAPI.startGitHubDeviceFlow()
            githubFlow = started
            githubConnectTask?.cancel()
            githubConnectTask = Task {
                var interval = max(started.interval ?? 5, 1)
                while !Task.isCancelled, let code = started.deviceCode {
                    try? await Task.sleep(for: .seconds(interval))
                    guard !Task.isCancelled else { return }
                    do {
                        let result = try await SettingsAPI.pollGitHubDeviceFlow(deviceCode: code)
                        if result.status == "ok" {
                            githubFlow = nil
                            await load()
                            return
                        }
                        if result.status == "slow_down" { interval += 5 }
                        if result.status == "error" {
                            error = result.error ?? "GitHub connection failed."
                            githubFlow = nil
                            return
                        }
                    } catch {
                        self.error = error.localizedDescription
                        githubFlow = nil
                        return
                    }
                }
            }
        } catch {
            self.error = error.localizedDescription
        }
    }
    private func cancelGitHubConnect() { githubConnectTask?.cancel(); githubConnectTask = nil; githubFlow = nil }

    /// Where the server lives. The transport is dropped when the target already
    /// says it (an https URL) and kept when it doesn't (a stdio command).
    private func connectionSubtitle(_ connection: MCPConnection) -> String? {
        guard let target = connection.target, !target.isEmpty else { return connection.transport }
        if let url = URL(string: target), let host = url.host, url.scheme?.hasPrefix("http") == true {
            return host + (url.path == "/" ? "" : url.path)
        }
        return [connection.transport, target].compactMap { $0 }.joined(separator: " · ")
    }

    private func allowedUsersDetail(_ connection: MCPConnection) -> String? {
        guard let users = connection.allowedUsers, !users.isEmpty else { return nil }
        return users.count == 1 ? "1 allowed user" : "\(users.count) allowed users"
    }
}

/// One service in Connections: its real logo and capitalized name, a health dot,
/// and whatever actions the section wants behind a trailing control.
private struct ConnectionRow<Trailing: View>: View {
    let name: String
    var title: String?
    let status: String?
    /// The endpoint — the one part long enough to truncate.
    let subtitle: String?
    /// Short, always-legible facts (e.g. "3 allowed users") kept out of the
    /// truncating endpoint so a long URL can't eat them.
    var detail: String?
    @ViewBuilder let trailing: Trailing

    init(
        name: String,
        title: String? = nil,
        status: String?,
        subtitle: String?,
        detail: String? = nil,
        @ViewBuilder trailing: () -> Trailing
    ) {
        self.name = name
        self.title = title
        self.status = status
        self.subtitle = subtitle
        self.detail = detail
        self.trailing = trailing()
    }

    var body: some View {
        HStack(spacing: 12) {
            BrandTile(name: name)
            VStack(alignment: .leading, spacing: 2) {
                Text(title ?? Brand.displayName(name))
                if status != nil || subtitle != nil || detail != nil {
                    HStack(spacing: 5) {
                        if let status, !status.isEmpty {
                            Circle().fill(ConnectionRow.statusColor(status)).frame(width: 6, height: 6)
                            Text(status.prefix(1).uppercased() + status.dropFirst()).fixedSize()
                        }
                        if let subtitle, !subtitle.isEmpty {
                            if status?.isEmpty == false { Text("·") }
                            Text(subtitle).lineLimit(1).truncationMode(.middle)
                        }
                        if let detail, !detail.isEmpty {
                            if status?.isEmpty == false || subtitle?.isEmpty == false { Text("·").fixedSize() }
                            Text(detail).fixedSize()
                        }
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 4)
            trailing
        }
        .padding(.vertical, 2)
    }

    private static func statusColor(_ status: String) -> Color {
        switch status.lowercased() {
        case "operational", "connected", "ready", "ok", "healthy", "running": .green
        case "error", "failed", "disconnected", "unauthorized", "stopped", "down",
            "reconnect needed": .red
        // Nothing is wrong with an account nobody has connected, so it gets
        // the quiet dot rather than the amber one that means "look at me".
        case "not connected": .secondary
        default: .orange
        }
    }
}

extension ConnectionRow where Trailing == EmptyView {
    init(name: String, title: String? = nil, status: String?, subtitle: String?, detail: String? = nil) {
        self.init(name: name, title: title, status: status, subtitle: subtitle, detail: detail) { EmptyView() }
    }
}

struct MemorySettingsView: View {
    @State private var scopes: [MemoryScope]? = SettingsCache.value("memory")
    @State private var loading = true
    @State private var error: String?
    @State private var editor: MemoryEditTarget?

    var body: some View {
        List {
            if loading, scopes == nil { settingsLoadingRow }
            if let error { settingsErrorRow(error) { Task { await load() } } }
            if let scopes {
                if scopes.isEmpty { ContentUnavailableView("No memory entries", systemImage: "brain") }
                ForEach(scopes.filter { $0.scope?.key?.isEmpty == false }, id: \.id) { scope in
                    Section(scope.scope?.label ?? scope.scope?.kind ?? "Memory") {
                        let entries = (scope.entries ?? []).filter { $0.id?.isEmpty == false }
                        if entries.isEmpty { Text("No entries.").foregroundStyle(.secondary) }
                        ForEach(entries, id: \.id) { entry in
                            Button { editor = MemoryEditTarget(scope: scope.scope!, entry: entry) } label: {
                                VStack(alignment: .leading) { Text(entry.text ?? ""); Text([entry.by, entry.at].compactMap { $0 }.joined(separator: " · ")).font(.caption).foregroundStyle(.secondary) }
                            }.foregroundStyle(.primary)
                        }
                        Button { editor = MemoryEditTarget(scope: scope.scope!, entry: nil) } label: { Label("Add entry", systemImage: "plus") }
                    }
                }
            }
        }
        .navigationTitle("Memory")
        .task { await load() }.refreshable { await load() }
        .sheet(item: $editor) { target in MemoryEditor(target: target, onSave: save, onDelete: delete) }
    }
    private func load() async { loading = true; error = nil; do { let fetched = try await SettingsAPI.memory().scopes ?? []; scopes = fetched; SettingsCache.save("memory", fetched) } catch { self.error = error.localizedDescription }; loading = false }
    private func save(_ target: MemoryEditTarget, text: String) async { guard let key = target.scope.key else { return }; do { if let id = target.entry?.id { _ = try await SettingsAPI.updateMemory(scopeKey: key, id: id, text: text) } else { _ = try await SettingsAPI.addMemory(scopeKey: key, text: text, by: ServerConfig.shared.userName) }; editor = nil; await load() } catch { self.error = error.localizedDescription } }
    private func delete(_ target: MemoryEditTarget) async { guard let key = target.scope.key, let id = target.entry?.id else { return }; do { _ = try await SettingsAPI.deleteMemory(scopeKey: key, id: id); editor = nil; await load() } catch { self.error = error.localizedDescription } }
}

/// Settings → Prewarming. Dependency templates and preview containers are the
/// same idea — work done per repo ahead of time so a session starts fast — and
/// were two panes of the same shape, so they share one screen as the web does.
struct PrewarmingSettingsView: View {
    @State private var reload = 0

    var body: some View {
        List {
            WarmDepsSections(reload: reload)
            PreviewPoolSections(reload: reload)
        }
        .insetGroupedListCompat()
        .navigationTitle("Acceleration")
        .refreshable { reload += 1 }
    }
}

struct WarmDepsSections: View {
    /// Bumped by the enclosing pane's pull-to-refresh; re-runs `task`.
    var reload: Int
    @State private var repos: [WarmTemplate]? = SettingsCache.value("warm-templates")
    @State private var loading = true
    @State private var error: String?
    var body: some View {
        Group {
            // Always-rendered section, so the task it carries survives the
            // loading row swapping out — see ModelAccountsSections.
            Section("Dependency templates") {
                Text("A template worktree per repo with dependencies installed, adopted into new session worktrees instead of installing cold.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if loading, repos == nil { settingsLoadingRow }
                if let error { settingsErrorRow(error) { Task { await load() } } }
                if let repos, repos.isEmpty {
                    Text("No repositories configured.").foregroundStyle(.secondary)
                }
            }
            .task(id: reload) { await load() }
            if let repos {
                ForEach(repos.filter { $0.repoId?.isEmpty == false }, id: \.id) { repo in
                    Section(repo.repoId ?? "Repository") {
                        Toggle("Enabled", isOn: binding(repo, keyPath: \.enabled, default: false) { enabled in await update(repo, ["enabled": enabled]) })
                        Stepper("Refresh interval: \(repo.intervalHours ?? 24) hours", value: binding(repo, keyPath: \.intervalHours, default: 24) { interval in await update(repo, ["intervalHours": interval]) }, in: 1...168)
                        LabeledContent("Status", value: repo.refreshing == true ? "Refreshing" : (repo.state?.ok == false ? "Failed" : "Ready"))
                        Button("Refresh now") { Task { await refresh(repo) } }
                    }
                }
            }
        }
    }
    private func binding<T>(_ repo: WarmTemplate, keyPath: KeyPath<WarmTemplate, T?>, default defaultValue: T, save: @escaping (T) async -> Void) -> Binding<T> where T: Equatable { Binding(get: { repo[keyPath: keyPath] ?? defaultValue }, set: { value in Task { await save(value) } }) }
    private func load() async { loading = true; error = nil; do { apply(try await SettingsAPI.warmTemplates().repos ?? []) } catch { self.error = error.localizedDescription }; loading = false }
    private func update(_ repo: WarmTemplate, _ patch: [String: Any]) async { guard let id = repo.repoId else { return }; do { apply(try await SettingsAPI.updateWarmTemplate(repoId: id, patch: patch).repos ?? []) } catch { self.error = error.localizedDescription } }
    private func refresh(_ repo: WarmTemplate) async { guard let id = repo.repoId else { return }; do { apply(try await SettingsAPI.refreshWarmTemplate(repoId: id).repos ?? []) } catch { self.error = error.localizedDescription } }
    private func apply(_ fetched: [WarmTemplate]) { repos = fetched; SettingsCache.save("warm-templates", fetched) }
}

struct PreviewPoolSections: View {
    /// Bumped by the enclosing pane's pull-to-refresh; re-runs `task`.
    var reload: Int
    @State private var repos: [PreviewPool]? = SettingsCache.value("preview-pool")
    @State private var loading = true
    @State private var error: String?
    var body: some View {
        Group {
            // Always-rendered section, so the task it carries survives the
            // loading row swapping out — see ModelAccountsSections.
            Section("Preview containers") {
                Text("Dev-server containers kept pre-booted so the Preview button claims one in seconds instead of paying a cold boot.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if loading, repos == nil { settingsLoadingRow }
                if let error { settingsErrorRow(error) { Task { await load() } } }
                if let repos, repos.isEmpty {
                    Text("No repositories configured.").foregroundStyle(.secondary)
                }
            }
            .task(id: reload) { await load() }
            if let repos {
                ForEach(repos.filter { $0.repoId?.isEmpty == false }, id: \.id) { pool in
                    Section(pool.repoId ?? "Repository") {
                        Toggle("Enabled", isOn: Binding(get: { pool.config?.enabled ?? false }, set: { value in Task { await update(pool, ["enabled": value]) } }))
                        Picker("Backend", selection: Binding(get: { pool.config?.backend ?? "docker" }, set: { value in Task { await update(pool, ["backend": value]) } })) { Text("Docker").tag("docker"); Text("Daytona").tag("daytona"); Text("MicroVM").tag("microvm") }
                        Stepper("Running: \(pool.config?.running ?? 0)", value: Binding(get: { pool.config?.running ?? 0 }, set: { value in Task { await update(pool, ["running": value]) } }), in: 0...20)
                        Stepper("Paused: \(pool.config?.paused ?? 0)", value: Binding(get: { pool.config?.paused ?? 0 }, set: { value in Task { await update(pool, ["paused": value]) } }), in: 0...20)
                        Button(pool.goldenBuilding == true ? "Building…" : "Rebuild golden image") { Task { await refresh(pool) } }.disabled(pool.goldenBuilding == true)
                        ForEach((pool.containers ?? []).filter { $0.name?.isEmpty == false }, id: \.id) { container in Text("\(container.name ?? "Container") · \(container.state ?? "unknown")").font(.caption).foregroundStyle(.secondary) }
                    }
                }
            }
        }
    }
    private func load() async { loading = true; error = nil; do { apply(try await SettingsAPI.previewPool().repos ?? []) } catch { self.error = error.localizedDescription }; loading = false }
    private func update(_ pool: PreviewPool, _ patch: [String: Any]) async { guard let id = pool.repoId else { return }; do { apply(try await SettingsAPI.updatePreviewPool(repoId: id, patch: patch).repos ?? []) } catch { self.error = error.localizedDescription } }
    private func refresh(_ pool: PreviewPool) async { guard let id = pool.repoId else { return }; do { apply(try await SettingsAPI.refreshPreviewPool(repoId: id).repos ?? []) } catch { self.error = error.localizedDescription } }
    private func apply(_ fetched: [PreviewPool]) { repos = fetched; SettingsCache.save("preview-pool", fetched) }
}

struct PapercutsSettingsView: View {
    @State private var response: PapercutsResponse? = SettingsCache.value("papercuts")
    @State private var loading = true
    @State private var error: String?
    var body: some View {
        List {
            if loading, response == nil { settingsLoadingRow }; if let error { settingsErrorRow(error) { Task { await load() } } }
            if response != nil {
                Section("Repositories") {
                    let repos = (response?.repos ?? []).filter { $0.repoId?.isEmpty == false }
                    if repos.isEmpty { Text("No repository configuration.").foregroundStyle(.secondary) }
                    ForEach(repos, id: \.id) { repo in Toggle(repo.repoId ?? "Repository", isOn: Binding(get: { repo.enabled ?? false }, set: { enabled in Task { await set(repo, enabled: enabled) } })) }
                }
                Section("Recent entries") {
                    let entries = response?.entries ?? []
                    if entries.isEmpty { Text("No recent papercuts.").foregroundStyle(.secondary) }
                    ForEach(entries, id: \.id) { entry in VStack(alignment: .leading) { Text(entry.message ?? ""); Text([entry.repo, entry.ts].compactMap { $0 }.joined(separator: " · ")).font(.caption).foregroundStyle(.secondary) } }
                }
            }
        }.navigationTitle("Papercuts").task { await load() }.refreshable { await load() }
    }
    private func load() async { loading = true; error = nil; do { let fetched = try await SettingsAPI.papercuts(days: 14, limit: 100); response = fetched; SettingsCache.save("papercuts", fetched) } catch { self.error = error.localizedDescription }; loading = false }
    private func set(_ repo: PapercutsRepoConfig, enabled: Bool) async { guard let id = repo.repoId else { return }; do { response = try await SettingsAPI.setPapercuts(repo: id, enabled: enabled) } catch { self.error = error.localizedDescription } }
}

struct AuditLogSettingsView: View {
    @State private var page: AuditPage?
    @State private var selectedDate = ""
    @State private var selectedType = ""
    @State private var search = ""
    @State private var includeTools = false
    @State private var loading = true
    @State private var error: String?
    @State private var offset = 0
    var body: some View {
        List {
            Section("Filters") {
                Picker("Date", selection: $selectedDate) {
                    if selectedDate.isEmpty { Text("Loading dates…").tag("") }
                    ForEach(page?.dates ?? [], id: \.self) { Text($0).tag($0) }
                }
                Picker("Type", selection: $selectedType) { Text("All types").tag(""); ForEach(page?.types ?? [], id: \.self) { Text($0).tag($0) } }
                TextField("Search audit log", text: $search)
                Toggle("Include tool events", isOn: $includeTools)
                Button("Apply filters") { Task { offset = 0; await load() } }
            }
            if loading { settingsLoadingRow }; if let error { settingsErrorRow(error) { Task { await load() } } }
            if !loading, error == nil {
                Section("Events") {
                    let events = page?.events ?? []
                    if events.isEmpty { Text("No matching audit events.").foregroundStyle(.secondary) }
                    ForEach(events.filter { $0.id?.isEmpty == false }, id: \.id) { event in VStack(alignment: .leading) { Text(event.displayType).font(.headline); Text(event.displayMessage).font(.subheadline); Text([event.displayTime, event.user].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")).font(.caption).foregroundStyle(.secondary) } }
                    if events.count < (page?.total ?? 0) { Button("Load more") { Task { offset = events.count; await load(append: true) } } }
                }
            }
        }.navigationTitle("Audit Log").task { await load() }.refreshable { offset = 0; await load() }
    }
    private func load(append: Bool = false) async {
        loading = true
        error = nil
        do {
            let result = try await SettingsAPI.audit(
                date: selectedDate.isEmpty ? nil : selectedDate,
                query: search.isEmpty ? nil : search,
                type: selectedType.isEmpty ? nil : selectedType,
                includeAll: includeTools,
                offset: offset,
                limit: 100
            )
            if selectedDate.isEmpty, let newest = result.dates?.first {
                page = result
                selectedDate = newest
                loading = false
                await load()
                return
            }
            if append, let old = page {
                page = AuditPage(
                    dates: result.dates ?? old.dates,
                    events: (old.events ?? []) + (result.events ?? []),
                    total: result.total,
                    types: result.types ?? old.types
                )
            } else {
                page = result
            }
        } catch {
            self.error = error.localizedDescription
        }
        loading = false
    }
}

enum AccountKind: String, Identifiable { case claude = "Claude", codex = "Codex"; var id: String { rawValue } }
struct AccountRemoval: Identifiable { let id: String; let name: String; let kind: AccountKind }
private struct MemoryEditTarget: Identifiable { let scope: MemoryScopeInfo; let entry: MemoryEntry?; var id: String { "\(scope.key ?? "")-\(entry?.id ?? "new")" } }

struct AccountEditor: View {
    let kind: AccountKind; let onSave: (String, String, String?) async -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""; @State private var credential = ""; @State private var shared = true; @State private var saving = false
    var body: some View { NavigationStack { Form { TextField("Account name", text: $name); SecureField("Credential", text: $credential); Toggle("Shared pool account", isOn: $shared); if !shared { Text("Personal accounts are assigned to the current person.").font(.footnote).foregroundStyle(.secondary) } } .navigationTitle("Add \(kind.rawValue)").toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }; ToolbarItem(placement: .confirmationAction) { Button("Add") { saving = true; Task { await onSave(name, credential, shared ? nil : ServerConfig.shared.userName); saving = false } }.disabled(name.isEmpty || credential.isEmpty || saving) } } } }
}

struct CodexDeviceLoginView: View {
    let onAdded: () async -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @State private var name = ""
    @State private var shared = true
    @State private var login: CodexDeviceLogin?
    @State private var error: String?
    @State private var starting = false

    var body: some View {
        NavigationStack {
            Form {
                if let login {
                    Section("ChatGPT sign-in") {
                        if login.state == "starting" {
                            ProgressView("Starting sign-in…")
                        } else if login.state == "awaiting_code" {
                            Text("Open ChatGPT and enter this one-time code:")
                            Button { copyToPasteboard(login.code ?? "") } label: {
                                Text(login.code ?? "—").font(.title.monospaced().bold())
                            }
                            if let raw = login.url, let url = URL(string: raw) {
                                Button("Copy code and open ChatGPT") {
                                    copyToPasteboard(login.code ?? "")
                                    openURL(url)
                                }
                            }
                            ProgressView("Waiting for approval…")
                        } else if login.state == "error" {
                            Text(login.error ?? "ChatGPT sign-in failed.").foregroundStyle(.red)
                        }
                    }
                } else {
                    Section {
                        TextField("Account name", text: $name)
                            .autocorrectionDisabled()
                            .noAutocapitalizationCompat()
                        Toggle("Shared pool account", isOn: $shared)
                    } header: {
                        Text("Account")
                    } footer: {
                        Text("A device code lets you sign in without opening a shell on the server.")
                    }
                    Button(starting ? "Starting…" : "Start ChatGPT sign-in") {
                        Task { await start() }
                    }
                    .disabled(starting || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
                if let error { Text(error).foregroundStyle(.red) }
            }
            .navigationTitle("Add Codex Account")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { Task { await cancel() } }
                }
            }
            .task(id: login?.id) { await poll() }
        }
        .onDisappear { Task { await cancelPendingLogin() } }
        #if os(macOS)
        .frame(minWidth: 440, minHeight: 360)
        #endif
    }

    private func start() async {
        starting = true
        error = nil
        do {
            login = try await SettingsAPI.startCodexDeviceLogin(
                name: name.trimmingCharacters(in: .whitespacesAndNewlines),
                owner: shared ? nil : ServerConfig.shared.userName
            )
        } catch {
            self.error = error.localizedDescription
        }
        starting = false
    }

    private func poll() async {
        guard let id = login?.id else { return }
        while !Task.isCancelled {
            guard login?.state == "starting" || login?.state == "awaiting_code" else { return }
            try? await Task.sleep(for: .seconds(2))
            guard !Task.isCancelled else { return }
            do {
                let next = try await SettingsAPI.codexDeviceLogin(id: id)
                login = next
                if next.state == "done" {
                    await onAdded()
                    dismiss()
                    return
                }
            } catch {
                self.error = error.localizedDescription
                return
            }
        }
    }

    private func cancel() async {
        await cancelPendingLogin()
        dismiss()
    }

    private func cancelPendingLogin() async {
        guard let id = login?.id,
              let state = login?.state,
              state == "starting" || state == "awaiting_code"
        else { return }
        login?.state = "cancelled"
        _ = try? await SettingsAPI.cancelCodexDeviceLogin(id: id)
    }
}

/// Add or edit a provider: a pi slug with a key, or any OpenAI-compatible
/// gateway with a base URL. Catalog rows and the catalog file are read-only
/// here (they live in model-providers.json); discovery can be run in place.
private struct ModelProviderEditor: View {
    let provider: ModelProvider
    /// Returns the failure to show, or nil once saved (the sheet then closes).
    let onSave: (ModelProviderDraft) async -> String?
    /// Returns a one-line outcome, success or failure.
    let onDiscover: () async -> String
    let onDelete: () -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var draft: ModelProviderDraft
    @State private var saving = false
    @State private var discovering = false
    @State private var discoveryStatus: String?
    @State private var error: String?

    init(
        provider: ModelProvider,
        onSave: @escaping (ModelProviderDraft) async -> String?,
        onDiscover: @escaping () async -> String,
        onDelete: @escaping () -> Void
    ) {
        self.provider = provider
        self.onSave = onSave
        self.onDiscover = onDiscover
        self.onDelete = onDelete
        _draft = State(initialValue: ModelProviderDraft(provider: provider))
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Provider ID", text: $draft.id)
                        .noAutocapitalizationCompat().autocorrectionDisabled()
                    SecureField(draft.isEditing ? "API key (leave blank to keep)" : "API key", text: $draft.apiKey)
                    TextField("Base URL", text: $draft.baseURL)
                        .urlFieldCompat()
                    TextField("Display name (optional)", text: $draft.name)
                } footer: {
                    Text("Use pi's slug for a known provider (xai, openrouter, groq), or any id with a base URL for an OpenAI-compatible gateway.")
                }

                Section {
                    Toggle("OpenAI-compatible gateway", isOn: $draft.customGateway)
                    Toggle("Discover models on save", isOn: $draft.discoverModels)
                } header: {
                    Text("Gateway")
                } footer: {
                    if draft.needsBaseURL {
                        Text("A base URL is required for these options.").foregroundStyle(.red)
                    } else {
                        Text("Turn on the gateway option for an id pi does not know. Discovery reads the gateway's /v1/models list into the picker without removing pinned ids.")
                    }
                }

                Section {
                    TextField("Model IDs, comma separated", text: $draft.modelText)
                        .noAutocapitalizationCompat().autocorrectionDisabled()
                } header: {
                    Text("Models")
                } footer: {
                    Text("Registered in the picker as pi/<provider>/<model>. List the provider's own model ids, e.g. grok-4 for xai.")
                }

                if draft.isEditing {
                    Section("Catalog") {
                        LabeledContent("API", value: provider.apiDisplayName)
                        LabeledContent("Catalog rows", value: "\(provider.catalogModels ?? 0)")
                        if let file = provider.catalogFile, !file.isEmpty {
                            LabeledContent("Catalog file", value: file)
                        }
                        LabeledContent("Last discovery", value: lastDiscovery)
                        Button {
                            discovering = true
                            Task {
                                discoveryStatus = await onDiscover()
                                discovering = false
                            }
                        } label: {
                            HStack {
                                Label("Discover models now", systemImage: "magnifyingglass")
                                if discovering { Spacer(); ProgressView().controlSize(.small) }
                            }
                        }
                        .disabled(discovering || (provider.baseURL ?? "").isEmpty)
                        if let discoveryStatus {
                            Text(discoveryStatus).font(.footnote).foregroundStyle(.secondary)
                        }
                    }

                    Section {
                        Button("Delete provider", role: .destructive) { onDelete(); dismiss() }
                    }
                }

                if let error {
                    Section { Text(error).foregroundStyle(.red) }
                }
            }
            .navigationTitle(draft.isEditing ? "Edit Provider" : "Add Provider")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(saving ? "Saving…" : "Save") {
                        saving = true
                        Task {
                            error = await onSave(draft)
                            saving = false
                        }
                    }
                    .disabled(!draft.canSave || saving)
                }
            }
        }
        #if os(macOS)
        .frame(minWidth: 480, minHeight: 560)
        #endif
    }

    private var lastDiscovery: String {
        guard let date = Session.parseISO(provider.discoveredAt) else { return "Never" }
        return date.formatted(.relative(presentation: .named))
    }
}

private struct MCPConnectionEditor: View {
    let onSave: ([String: Any]) async -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""; @State private var transport = "http"; @State private var target = ""; @State private var command = ""
    var body: some View { NavigationStack { Form { TextField("Name", text: $name); Picker("Transport", selection: $transport) { Text("HTTP").tag("http"); Text("stdio").tag("stdio") }; if transport == "http" { TextField("Server URL", text: $target).urlFieldCompat() } else { TextField("Command", text: $command); TextField("Arguments (space separated)", text: $target) } } .navigationTitle("Add MCP").toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }; ToolbarItem(placement: .confirmationAction) { Button("Add") { var body: [String: Any] = ["name": name, "transport": transport]; if transport == "http" { body["url"] = target } else { body["command"] = command; body["args"] = target.split(separator: " ").map(String.init) }; Task { await onSave(body) } }.disabled(name.isEmpty || (transport == "http" ? target.isEmpty : command.isEmpty)) } } } }
}

private struct AllowedUsersEditor: View {
    let connection: MCPConnection; let onSave: ([String]) async -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var users = ""
    var body: some View { NavigationStack { Form { TextField("Allowed users, comma separated", text: $users); Text("Leave blank to make this connection available to everyone.").font(.footnote).foregroundStyle(.secondary) }.navigationTitle("Allowed Users").onAppear { users = (connection.allowedUsers ?? []).joined(separator: ", ") }.toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }; ToolbarItem(placement: .confirmationAction) { Button("Save") { Task { await onSave(users.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }) } } } } } }
}

private struct PlainRouterEditor: View {
    let config: PlainRouterConfig?; let onSave: (String, String) async -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var prompt = ""; @State private var model = ""
    var body: some View { NavigationStack { Form { TextField("Basic model", text: $model); TextEditor(text: $prompt).frame(minHeight: 180); Button("Reset to server defaults") { prompt = config?.defaultPrompt ?? ""; model = config?.defaultBasicModel ?? "" } } .navigationTitle("Plain Router").onAppear { prompt = config?.prompt ?? ""; model = config?.basicModel ?? "" }.toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }; ToolbarItem(placement: .confirmationAction) { Button("Save") { Task { await onSave(prompt, model) } } } } } }
}

/// Internal rather than file-private: the account screen (Settings → Personal) runs
/// the same device flow, and two copies of a code-entry screen would drift.
struct GitHubConnectionFlowView: View {
    let flow: GitHubDeviceFlow
    let onCancel: () -> Void
    @Environment(\.openURL) private var openURL

    var body: some View {
        NavigationStack {
            VStack(spacing: 20) {
                Image(systemName: "person.badge.key")
                    .font(.system(size: 42))
                    .foregroundStyle(.tint)
                Text("Connect GitHub")
                    .font(.title2.bold())
                Text("Enter this code on GitHub")
                    .foregroundStyle(.secondary)
                Button {
                    copyToPasteboard(flow.userCode ?? "")
                } label: {
                    Text(flow.userCode ?? "—")
                        .font(.title.monospaced().bold())
                }
                if let raw = flow.verificationUri, let url = URL(string: raw) {
                    Button("Copy code and open GitHub") {
                        copyToPasteboard(flow.userCode ?? "")
                        openURL(url)
                    }
                    .buttonStyle(.borderedProminent)
                }
                ProgressView("Waiting for approval…")
                Spacer()
            }
            .padding(28)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: onCancel)
                }
            }
        }
        #if os(macOS)
        .frame(minWidth: 420, minHeight: 360)
        #endif
    }
}

private struct MemoryEditor: View {
    let target: MemoryEditTarget; let onSave: (MemoryEditTarget, String) async -> Void; let onDelete: (MemoryEditTarget) async -> Void
    @Environment(\.dismiss) private var dismiss; @State private var text = ""
    var body: some View { NavigationStack { Form { TextEditor(text: $text).frame(minHeight: 150); if target.entry != nil { Button("Delete entry", role: .destructive) { Task { await onDelete(target) } } } } .navigationTitle(target.entry == nil ? "Add Memory" : "Edit Memory").onAppear { text = target.entry?.text ?? "" }.toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }; ToolbarItem(placement: .confirmationAction) { Button("Save") { Task { await onSave(target, text) } }.disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) } } } }
}

/// Shared settings vocabulary: every native settings page shows the same
/// spinner and the same retryable error row, so they live once here.
var settingsLoadingRow: some View { HStack { Spacer(); ProgressView("Loading…"); Spacer() } }
func settingsErrorRow(_ message: String, retry: @escaping () -> Void) -> some View { VStack(alignment: .leading, spacing: 8) { Text(message).foregroundStyle(.red); Button("Retry", action: retry) } }
