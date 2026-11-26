#if os(macOS)
import SwiftUI

/// The Mac settings surface, hosted by the standard `Settings` scene
/// (App menu → Settings…, Cmd+,): a System Settings-style split view.
/// Every pane reuses the same native settings views as iOS — only the
/// container is Mac-specific.
struct MacSettingsView: View {
    /// Declared in sidebar order. Labels are sentence case, matching the web
    /// nav and the panes' own navigation titles.
    enum Pane: String, CaseIterable, Identifiable {
        case connection
        case keychain
        case preferences
        case notifications
        case shortcuts
        case appearance
        case providers
        case connections
        case memory
        case automations
        case goals
        case actions
        case security
        case runners
        case prewarming
        case papercuts
        case auditLog

        var id: String { rawValue }

        var title: String {
            switch self {
            case .connection: "Connection"
            case .preferences: "Preferences"
            case .keychain: "Keychain"
            case .notifications: "Notifications"
            case .shortcuts: "Keyboard shortcuts"
            case .appearance: "Appearance"
            case .providers: "Providers"
            case .connections: "Connections"
            case .memory: "Memory"
            case .automations: "Automations"
            case .goals: "Goals"
            case .actions: "Actions"
            case .security: "Security"
            case .runners: "Runners"
            case .prewarming: "Prewarming"
            case .papercuts: "Papercuts"
            case .auditLog: "Audit log"
            }
        }

        var icon: String {
            switch self {
            case .connection: "server.rack"
            case .preferences: "slider.horizontal.3"
            case .keychain: "key"
            case .notifications: "bell.badge"
            case .shortcuts: "keyboard"
            case .appearance: "circle.lefthalf.filled"
            case .providers: "square.grid.2x2"
            case .connections: "point.3.connected.trianglepath.dotted"
            case .memory: "brain"
            case .automations: "clock.arrow.circlepath"
            case .goals: "target"
            case .actions: "bolt"
            case .security: "checkmark.shield"
            case .runners: "desktopcomputer"
            case .prewarming: "flame"
            case .papercuts: "bandage"
            case .auditLog: "list.bullet.rectangle"
            }
        }
    }

    @State private var selection: Pane? = {
        #if DEBUG
        // Screenshot hook, like the iPhone's `OS1_OPEN_SETTINGS`.
        switch ProcessInfo.processInfo.environment["OS1_OPEN_SETTINGS"] {
        case "notifications": return .notifications
        case "keychain": return .keychain
        case "memory": return .memory
        case "providers": return .providers
        default: break
        }
        #endif
        return .preferences
    }()
    @State private var automationId: String?
    @State private var authenticationMessage: String?
    @State private var config = ServerConfig.shared
    @AppStorage("os1.appearance") private var appearance = "system"

    var body: some View {
        NavigationSplitView {
            List(selection: $selection) {
                // Groups mirror the web nav (src/frontend/components/Settings.tsx):
                // this app's own connection, then what one person owns, then
                // what the whole instance does. "Connection" has no web
                // counterpart — the browser is already on the server it talks to.
                Section("This app") {
                    paneRow(.connection)
                }
                Section("Personal") {
                    paneRow(.keychain)
                    paneRow(.preferences)
                    paneRow(.notifications)
                    paneRow(.shortcuts)
                    paneRow(.appearance)
                }
                Section("Workspace") {
                    paneRow(.providers)
                    paneRow(.connections)
                    paneRow(.memory)
                }
                Section("Automation") {
                    paneRow(.automations)
                    paneRow(.goals)
                    paneRow(.actions)
                    paneRow(.security)
                }
                Section("Infrastructure") {
                    paneRow(.runners)
                    paneRow(.prewarming)
                }
                Section("Activity") {
                    paneRow(.papercuts)
                    paneRow(.auditLog)
                }
            }
            .listStyle(.sidebar)
            .navigationSplitViewColumnWidth(min: 200, ideal: 215, max: 260)
        } detail: {
            // Each pane gets its own stack so NavigationLink pushes inside a
            // pane (automation details, goal details, …) stay in-window; the
            // id reset drops any pushed detail when the pane changes.
            NavigationStack {
                paneView
                    .formStyle(.grouped)
            }
            .id("\(selection?.rawValue ?? "preferences"):\(automationId ?? "")")
        }
        .frame(minWidth: 840, idealWidth: 920, minHeight: 560, idealHeight: 660)
        .macSettingsWindowChrome()
        .preferredColorScheme(preferredColorScheme)
        .onReceive(NotificationCenter.default.publisher(for: .settingsAuthenticationExpired)) { _ in
            config.token = ""
            authenticationMessage = "Your session expired. Sign in again to continue."
            selection = .connection
        }
        .onChange(of: config.token) { _, token in
            if !token.isEmpty { authenticationMessage = nil }
        }
        .onChange(of: selection) { _, pane in
            if pane != .automations { automationId = nil }
        }
        .onAppear { openPendingAutomation() }
        .onReceive(NotificationCenter.default.publisher(for: .os1OpenAutomationSettings)) { note in
            guard let id = note.object as? String else { return }
            automationId = id
            selection = .automations
        }
    }

    private func paneRow(_ pane: Pane) -> some View {
        Label(pane.title, systemImage: pane.icon)
            .tag(pane)
    }

    @ViewBuilder
    private var paneView: some View {
        switch selection ?? .preferences {
        case .connection: MacConnectionSettingsView(authenticationMessage: authenticationMessage)
        case .preferences: PreferencesSettingsView()
        case .keychain: KeychainSettingsView()
        case .notifications: NotificationsSettingsView()
        case .shortcuts: MacKeyboardShortcutsSettingsView()
        case .appearance: AppearanceSettingsView()
        case .providers: ProvidersSettingsView()
        case .connections: ConnectionsSettingsView()
        case .memory: MemorySettingsView()
        case .automations: AutomationSettingsView(initialAutomationId: automationId)
        case .goals: GoalSettingsView()
        case .actions: ActionSettingsView()
        case .security: SecuritySettingsView()
        case .runners: RunnersSettingsView()
        case .prewarming: PrewarmingSettingsView()
        case .papercuts: PapercutsSettingsView()
        case .auditLog: AuditLogSettingsView()
        }
    }

    private func openPendingAutomation() {
        guard let id = AutomationLinks.takePendingSettingsId() else { return }
        automationId = id
        selection = .automations
    }

    private var preferredColorScheme: ColorScheme? {
        switch appearance {
        case "light": .light
        case "dark": .dark
        default: nil
        }
    }
}

/// Server address, GitHub sign-in, and identity — the Mac counterpart of the
/// iOS connection form, shaped as a grouped settings pane.
struct MacConnectionSettingsView: View {
    var authenticationMessage: String?

    @Environment(\.openURL) private var openURL

    @State private var config = ServerConfig.shared
    @State private var serverURL = ServerConfig.shared.baseURLString
    @State private var userName = ServerConfig.shared.userName
    @State private var token = ServerConfig.shared.token
    @State private var checkResult: String?
    @State private var copiedCode = false
    @State private var testing = false

    private var signIn: GitHubSignIn { .shared }

    private var signedInLogin: String? {
        let login = config.githubLogin
        return login.isEmpty || token.isEmpty ? nil : login
    }

    private var dirty: Bool {
        serverURL.trimmingCharacters(in: .whitespacesAndNewlines) != config.baseURLString
            || userName.trimmingCharacters(in: .whitespacesAndNewlines) != config.userName
            || token.trimmingCharacters(in: .whitespacesAndNewlines) != config.token
    }

    var body: some View {
        Form {
            Section("Organizations") {
                NavigationLink {
                    OrganizationsSettingsView()
                } label: {
                    LabeledContent("Active", value: config.activeAccount.displayLabel)
                }
            }

            Section("Server") {
                TextField(
                    "Address",
                    text: $serverURL,
                    prompt: Text(verbatim: "https://sessions.example.com")
                )
                .autocorrectionDisabled()
            }

            Section {
                if let flow = signIn.flow {
                    deviceFlow(flow)
                } else if let signedInLogin {
                    HStack {
                        Label("Signed in as @\(signedInLogin)", systemImage: "checkmark.seal")
                        Spacer()
                        Button("Sign Out", role: .destructive) { signOut() }
                    }
                } else {
                    LabeledContent("GitHub") {
                        Button(signIn.starting ? "Starting…" : "Sign In with GitHub…") {
                            startSignIn()
                        }
                        .disabled(signIn.starting)
                    }
                }
                if let signInError = signIn.error {
                    Text(signInError)
                        .font(.callout)
                        .foregroundStyle(.red)
                }
                SecureField(
                    "Token",
                    text: $token,
                    prompt: Text("Bearer token (or paste one manually)")
                )
            } header: {
                Text("Authentication")
            } footer: {
                Text("Sign in with GitHub, or paste a session token. The token is stored in the keychain.")
            }

            if !signIn.diagnostics.isEmpty {
                Section("Sign-in Log") {
                    ForEach(
                        Array(signIn.diagnostics.suffix(15).reversed().enumerated()),
                        id: \.offset
                    ) { _, line in
                        Text(line)
                            .font(.caption2.monospaced())
                            .foregroundStyle(.secondary)
                    }
                }
            }

            Section("Identity") {
                TextField(
                    "Name",
                    text: $userName,
                    prompt: Text("Name shown on your prompts")
                )
                .autocorrectionDisabled()
            }

            Section {
                HStack {
                    Button(testing ? "Testing…" : "Test Connection") {
                        Task { await testConnection() }
                    }
                    .disabled(testing)
                    Spacer()
                    Button("Save") { save() }
                        .buttonStyle(.borderedProminent)
                        .disabled(!dirty)
                }
                if let statusMessage = checkResult ?? authenticationMessage {
                    Text(statusMessage)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .navigationTitle("Connection")
        .onAppear { signIn.nudge() }
        .onChange(of: config.activeId) { _, _ in
            serverURL = config.baseURLString
            userName = config.userName
            token = config.token
            checkResult = nil
        }
        .onChange(of: signIn.flow?.deviceCode) { _, deviceCode in
            copiedCode = false
            // Flow finished: adopt the token it landed in ServerConfig.
            if deviceCode == nil, config.token != token {
                token = config.token
                userName = config.userName
                checkResult = nil
            }
        }
    }

    @ViewBuilder
    private func deviceFlow(_ flow: GitHubAuth.DeviceFlowStart) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Enter this code on GitHub:")
                .foregroundStyle(.secondary)
            Button {
                copyToPasteboard(flow.userCode)
                copiedCode = true
            } label: {
                Text(flow.userCode)
                    .font(.system(.title2, design: .monospaced).bold())
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.plain)
            Text(copiedCode ? "Copied. Paste it on GitHub." : "Click the code to copy it.")
                .font(.callout)
                .foregroundStyle(.tertiary)
                .frame(maxWidth: .infinity, alignment: .center)
            HStack(spacing: 10) {
                if let url = URL(string: flow.verificationUri) {
                    Button("Copy Code and Open GitHub") {
                        copyToPasteboard(flow.userCode)
                        copiedCode = true
                        openURL(url)
                    }
                }
                Spacer()
                ProgressView()
                    .controlSize(.small)
                Text("Waiting for approval…")
                    .foregroundStyle(.secondary)
                Button("Cancel", role: .cancel) { signIn.cancel() }
            }
            if let at = signIn.lastPollAt {
                Text("Checked \(at.formatted(date: .omitted, time: .standard)) · \(signIn.lastPollNote ?? "")")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(.vertical, 2)
    }

    private func startSignIn() {
        config.baseURLString = serverURL.trimmingCharacters(in: .whitespacesAndNewlines)
        signIn.start()
    }

    private func signOut() {
        Task {
            try? await OS1API.logout()
            config.token = ""
            token = ""
        }
    }

    private func save() {
        config.baseURLString = serverURL.trimmingCharacters(in: .whitespacesAndNewlines)
        config.userName = userName.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedToken = token.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmedToken != config.token { config.githubLogin = "" }
        config.token = trimmedToken
    }

    private func testConnection() async {
        testing = true
        defer { testing = false }
        save()
        do {
            _ = try await OS1API.health()
            _ = try await OS1API.sessions()
            checkResult = "Connected — auth OK."
        } catch {
            checkResult = await Reachability.describe(error)
        }
    }
}

/// First-run sheet on the Mac: just the connection pane with a Done button.
/// Day-to-day settings live in the Settings scene (Cmd+,).
struct ConnectionOnboardingSheet: View {
    @Environment(\.dismiss) private var dismiss
    @State private var config = ServerConfig.shared

    var body: some View {
        NavigationStack {
            MacConnectionSettingsView(authenticationMessage: nil)
                .formStyle(.grouped)
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done") { dismiss() }
                            .disabled(!config.isConfigured)
                    }
                }
        }
        .frame(minWidth: 620, minHeight: 560)
    }
}
#endif
