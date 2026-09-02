import SwiftUI

struct SettingsView: View {
    var automationId: String? = nil
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL

    @State private var config = ServerConfig.shared
    @State private var showingConnection = !ServerConfig.shared.isConfigured
    @State private var serverURL = ServerConfig.shared.baseURLString
    @State private var userName = ServerConfig.shared.userName
    @State private var token = ServerConfig.shared.token
    @State private var checkResult: String?
    @State private var copiedCode = false
    @State private var confirmingSignOut = false
    @State private var isAdmin = true
    /// Node-only hook: `OS1_OPEN_SETTINGS=providers` pushes the Providers
    /// page, which a scripted run cannot otherwise reach inside the sheet.
    @State private var openProviders = false

    private var signIn: GitHubSignIn { .shared }

    private var signedInLogin: String? {
        let login = config.githubLogin
        return login.isEmpty || token.isEmpty ? nil : login
    }

    var body: some View {
        NavigationStack {
            Group {
                if showingConnection || !config.isConfigured {
                    connectionForm
                } else if let automationId {
                    AutomationSettingsView(initialAutomationId: automationId)
                } else {
                    settingsHome
                }
            }
            .navigationTitle(
                showingConnection || !config.isConfigured
                    ? "Connection"
                    : automationId == nil ? "Settings" : "Automations"
            )
            .inlineTitleBarCompat()
            #if os(macOS)
            .frame(minWidth: 620, minHeight: 640)
            #endif
            .toolbar { toolbar }
            .onAppear { signIn.nudge() }
            .navigationDestination(isPresented: $openProviders) { ProvidersSettingsView() }
            .task {
                #if DEBUG
                if ProcessInfo.processInfo.environment["OS1_OPEN_SETTINGS"] == "providers" {
                    openProviders = true
                }
                #endif
                if let status = try? await OS1API.authStatus() {
                    isAdmin = status.admin != false
                }
            }
            .onChange(of: config.activeId) { _, _ in
                serverURL = config.baseURLString
                userName = config.userName
                token = config.token
                showingConnection = !config.isConfigured
                checkResult = nil
            }
            .onChange(of: signIn.flow?.deviceCode) { _, deviceCode in
                copiedCode = false
                if deviceCode == nil, config.token != token {
                    token = config.token
                    userName = config.userName
                    checkResult = nil
                    if config.isConfigured { showingConnection = false }
                }
            }
            .onReceive(NotificationCenter.default.publisher(for: .settingsAuthenticationExpired)) { _ in
                config.token = ""
                token = ""
                SettingsCache.clear()
                checkResult = "Your session expired. Sign in again to continue."
                showingConnection = true
            }
        }
    }

    private var settingsHome: some View {
        List {
            Section("This app") {
                settingsLink("Organizations", icon: "building.2.crop.circle") {
                    OrganizationsSettingsView()
                }
                Button {
                    signIn.cancel()
                    config.addAccount()
                    serverURL = config.baseURLString
                    userName = config.userName
                    token = config.token
                    showingConnection = true
                } label: {
                    Label("Add organization", systemImage: "plus.circle")
                }
            }

            // Groups mirror the web nav (src/frontend/components/Settings.tsx):
            // what one person owns first, then what the whole instance does.
            Section("Personal") {
                settingsLink("Account", icon: "person.crop.circle") {
                    MyAccountsSettingsView()
                }
                settingsLink("Keychain", icon: "key") {
                    KeychainSettingsView()
                }
                settingsLink("Preferences", icon: "slider.horizontal.3") {
                    PreferencesSettingsView()
                }
                settingsLink("Notifications", icon: "bell") {
                    NotificationsSettingsView()
                }
                settingsLink("Shortcuts", icon: "sparkles") {
                    ShortcutsSettingsView()
                }
                settingsLink("Appearance", icon: "circle.lefthalf.filled") {
                    AppearanceSettingsView()
                }
            }

            // Same order as the web's Workspace group: what an instance is set
            // up with, then what a session runs on, then what it can reach.
            // Identity is part of General. Members and Integrations stay as
            // dedicated destinations because they each carry their own lists.
            Section("Workspace") {
                if isAdmin {
                    settingsLink("General", icon: "building.2") {
                        GeneralSettingsView()
                    }
                }
                settingsLink("Setup", icon: "checklist") {
                    SetupSettingsView()
                }
                settingsLink("Repositories", icon: "shippingbox") {
                    RepositoriesSettingsView()
                }
                settingsLink("Members", icon: "person.2") {
                    MembersSettingsView()
                }
                settingsLink("Providers", icon: "square.grid.2x2") {
                    ProvidersSettingsView()
                }
                // Not "cube": Repositories two rows up is a shipping box, and
                // at 15pt the two solids are the same grey lozenge. The
                // transparent one also says the thing a sandbox is — a box you
                // can see into.
                settingsLink("Sandboxes", icon: "cube.transparent") {
                    SandboxesSettingsView()
                }
                settingsLink("Runners", icon: "desktopcomputer") {
                    RunnersSettingsView()
                }
                settingsLink("Integrations", icon: "puzzlepiece.extension") {
                    IntegrationsSettingsView()
                }
                settingsLink("Connections", icon: "point.3.connected.trianglepath.dotted") {
                    ConnectionsSettingsView()
                }
                settingsLink("Memory", icon: "brain") {
                    MemorySettingsView()
                }
            }

            Section("Automation") {
                settingsLink("Automations", icon: "clock.arrow.circlepath") {
                    AutomationSettingsView()
                }
                settingsLink("Goals", icon: "target") {
                    GoalSettingsView()
                }
                settingsLink("Actions", icon: "bolt") {
                    ActionSettingsView()
                }
                settingsLink("Security", icon: "checkmark.shield") {
                    SecuritySettingsView()
                }
            }

            // The machinery prepared ahead of a run, and what agents left
            // running behind one.
            Section("Infrastructure") {
                settingsLink("Acceleration", icon: "flame") {
                    PrewarmingSettingsView()
                }
                settingsLink("Deploys", icon: "square.stack.3d.up") {
                    DeploysSettingsView()
                }
            }

            Section("Activity") {
                settingsLink("Papercuts", icon: "bandage") {
                    PapercutsSettingsView()
                }
                settingsLink("Audit log", icon: "list.bullet.rectangle") {
                    AuditLogSettingsView()
                }
            }

            // Last card, as in the web settings sheet: who your sessions act
            // as, and the way out.
            Section("Account") {
                // Tappable, not a label: the two things people come here to
                // change — which GitHub account they are signed in as, and the
                // name their prompts carry — both live in the connection form,
                // and an inert identity row reads as "this can't be changed".
                Button {
                    showingConnection = true
                } label: {
                    HStack(spacing: 12) {
                        UserAvatar(size: 34)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(config.userName)
                                .font(.body.weight(.medium))
                                .foregroundStyle(OS1VisualStyle.text)
                            Text(accountSubtitle)
                                .font(.footnote)
                                .foregroundStyle(Color.secondary)
                        }
                        Spacer(minLength: 12)
                        Image(systemName: "chevron.forward")
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(Color.secondary.opacity(0.55))
                    }
                }
                .padding(.vertical, 2)
                .accessibilityElement(children: .combine)
                .accessibilityLabel("Account, \(config.userName), \(accountSubtitle)")
                .accessibilityHint("Change your name or GitHub account")

                // The connection form used to hang off a toolbar button in the
                // top-left corner, which read as navigation rather than as a
                // setting. It is one: a row, next to the identity it belongs to.
                Button {
                    showingConnection = true
                } label: {
                    HStack {
                        Label {
                            Text("Server")
                                .foregroundStyle(OS1VisualStyle.text)
                        } icon: {
                            Image(systemName: "server.rack")
                                .symbolRenderingMode(.monochrome)
                                .font(.system(size: 15, weight: .semibold))
                                .foregroundStyle(OS1VisualStyle.iconTint)
                                .frame(width: 28, height: 28)
                        }
                        Spacer(minLength: 12)
                        // Explicit colours, not `.secondary`: inside a button
                        // the hierarchical styles resolve against the tint,
                        // and the value would read as a teal link rather than
                        // as the detail text every other settings app uses.
                        Text(serverHost)
                            .font(.subheadline)
                            .foregroundStyle(Color.secondary)
                            .lineLimit(1)
                            .truncationMode(.head)
                        // A plain button gets no disclosure of its own, and
                        // without one the row doesn't look like it goes
                        // anywhere — the rest of this list does.
                        Image(systemName: "chevron.forward")
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(Color.secondary.opacity(0.55))
                    }
                }

                Button(role: .destructive) {
                    confirmingSignOut = true
                } label: {
                    Label("Sign out", systemImage: "rectangle.portrait.and.arrow.right")
                }
                // On the button, not the list: the popover form of a
                // confirmation dialog points at whatever it is attached to.
                .confirmationDialog(
                    "Sign out?",
                    isPresented: $confirmingSignOut,
                    titleVisibility: .visible
                ) {
                    Button("Sign out", role: .destructive) { signOut() }
                    Button("Cancel", role: .cancel) {}
                } message: {
                    Text("This device forgets its token. Your sessions keep running on the server.")
                }
            }
        }
        .insetGroupedListCompat()
    }

    /// How the current identity was decided — the same two modes the web
    /// account card distinguishes.
    private var accountSubtitle: String {
        if let signedInLogin {
            return "Signed in with GitHub · @\(signedInLogin)"
        }
        return "Signed in with a session token"
    }

    /// The connection screen's header. It follows the field below it as it is
    /// typed, so the name you are setting is visible as the thing it names.
    private var connectionTitle: String {
        let name = userName.trimmingCharacters(in: .whitespaces)
        // The untouched default is a stand-in, and set at 20pt beside an
        // avatar it reads as the person's name — so the verified login wins
        // over it here, unlike everywhere the name is SENT.
        if !name.isEmpty, name != ServerConfig.placeholderUserName { return name }
        if let signedInLogin { return "@\(signedInLogin)" }
        return name.isEmpty ? "Not signed in" : name
    }

    /// Same two identity modes as `accountSubtitle`, plus the state that card
    /// never has to describe: a device that isn't connected to anything yet.
    private var connectionSubtitle: String {
        if let signedInLogin {
            // No point printing the login twice when it IS the title.
            return connectionTitle == "@\(signedInLogin)"
                ? "Signed in with GitHub"
                : "Signed in with GitHub · @\(signedInLogin)"
        }
        if !token.trimmingCharacters(in: .whitespaces).isEmpty {
            return "Signed in with a session token"
        }
        return "Sign in below to connect this device"
    }

    /// The host alone: the row is narrow, and the scheme is the least
    /// interesting part of "which server am I talking to".
    private var serverHost: String {
        let raw = config.baseURLString.trimmingCharacters(in: .whitespacesAndNewlines)
        if let host = URL(string: raw)?.host, !host.isEmpty { return host }
        return raw.isEmpty ? "Not set" : raw
    }

    private func settingsLink<Destination: View>(
        _ title: String,
        icon: String,
        @ViewBuilder destination: () -> Destination
    ) -> some View {
        NavigationLink {
            destination()
        } label: {
            Label {
                Text(title)
                    .foregroundStyle(OS1VisualStyle.text)
            } icon: {
                // Without the tile the glyph carries the row on its own, so it
                // trades size for weight — smaller than the title beside it,
                // heavier than it — which lets the icon column stay neutral
                // (see `iconTint`) and still read as a column rather than as
                // dimmer text.
                Image(systemName: icon)
                    .symbolRenderingMode(.monochrome)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(OS1VisualStyle.iconTint)
                    .frame(width: 28, height: 28)
            }
        }
    }

    private var connectionForm: some View {
        Form {
            // The identity the rest of the screen is about, stated once at the
            // top. Without it this was five equal blocks of plumbing with
            // nothing to anchor them; with it, every card below reads as a
            // setting ON this account. Same avatar + name + subtitle as the
            // Account row that leads here, so the tap lands somewhere
            // recognisable.
            Section {
                HStack(spacing: 14) {
                    UserAvatar(size: 44)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(connectionTitle)
                            .font(.title3.weight(.semibold))
                            .foregroundStyle(OS1VisualStyle.text)
                        Text(connectionSubtitle)
                            .font(.footnote)
                            .foregroundStyle(Color.secondary)
                    }
                    Spacer(minLength: 0)
                }
                .padding(.vertical, 8)
                .accessibilityElement(children: .combine)
                .accessibilityLabel("\(connectionTitle), \(connectionSubtitle)")
            }

            Section("Server") {
                TextField("https://sessions.example.com", text: $serverURL)
                    .urlFieldCompat()
                    .autocorrectionDisabled()
            }

            Section {
                if let flow = signIn.flow {
                    signInFlow(flow)
                } else if signedInLogin != nil {
                    // Who you are is the header's job now, so this card is
                    // only the two things you can do about it. Signing in
                    // again replaces the token outright, so switching
                    // accounts needs no sign-out first — asking for one is
                    // what made "change my account" feel like a dead end.
                    Button {
                        startSignIn()
                    } label: {
                        Label(
                            signIn.starting ? "Starting…" : "Switch GitHub account",
                            systemImage: "arrow.trianglehead.2.clockwise.rotate.90"
                        )
                    }
                    .disabled(signIn.starting)
                    Button(role: .destructive) { signOut() } label: {
                        Label("Sign out", systemImage: "rectangle.portrait.and.arrow.right")
                    }
                } else {
                    Button {
                        startSignIn()
                    } label: {
                        Label(
                            signIn.starting ? "Starting…" : "Sign in with GitHub",
                            systemImage: "person.badge.key"
                        )
                    }
                    .disabled(signIn.starting)
                }
                if let signInError = signIn.error {
                    Text(signInError)
                        .font(.footnote)
                        .foregroundStyle(.red)
                }
            } header: {
                Text("Authentication")
            } footer: {
                Text("Signing in with GitHub is the usual way in. The token it returns is stored in the keychain.")
            }

            // Above the fallback and diagnostic cards, because this field is
            // what the header says — the name on your prompts, next to the
            // place it appears.
            Section {
                TextField("Name shown on your prompts", text: $userName)
                    .autocorrectionDisabled()
            } header: {
                Text("Identity")
            } footer: {
                Text("What teammates see on the prompts you send from this device.")
            }

            // Its own card rather than a field under the sign-in buttons:
            // pasting a token is the fallback path, and sharing a card with
            // the primary one made both read as equal halves of one step.
            Section {
                SecureField("Paste a session token", text: $token)
                    .autocorrectionDisabled()
                    .noAutocapitalizationCompat()
            } header: {
                Text("Session token")
            } footer: {
                Text("For a server without GitHub sign-in, or to move a token you already have onto this device.")
            }

            if !signIn.diagnostics.isEmpty {
                Section("Sign-in log") {
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

            Section {
                Button("Test connection") {
                    Task { await testConnection() }
                }
                if let checkResult {
                    Text(checkResult)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
        }
        // These fields are copies, taken when the sheet was built. On a first
        // run that is BEFORE the server has answered with the verified
        // identity, so the name field sat on the "ios" placeholder while the
        // header above it named the account — and saving wrote the
        // placeholder back over the real name.
        .onAppear {
            serverURL = config.baseURLString
            userName = config.userName
            token = config.token
        }
        // …and the answer can land while the form is already open, so adopt
        // it — but only into a field still holding what it was given, never
        // over something being typed.
        .onChange(of: config.userName) { previous, current in
            if userName == previous { userName = current }
        }
        // The grouped backdrop is left ON here, unlike most screens in the
        // app: it is what separates the cards from the page. Painted over
        // with `background` — `.systemBackground` — every card became white
        // on white in light appearance, and five sections collapsed into one
        // undifferentiated wall held together by hairlines.
        #if os(macOS)
        .formStyle(.grouped)
        #endif
    }

    @ViewBuilder
    private func signInFlow(_ flow: GitHubAuth.DeviceFlowStart) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Enter this code on GitHub:")
                .font(.footnote)
                .foregroundStyle(.secondary)
            // A well, not bare text on the card: the code is the one thing
            // on this screen that has to be carried somewhere else, and a
            // recessed surface is what makes it read as an artifact to copy
            // rather than as a heading.
            Button {
                copyToPasteboard(flow.userCode)
                copiedCode = true
            } label: {
                Text(flow.userCode)
                    .font(.system(.title, design: .monospaced).bold())
                    .foregroundStyle(OS1VisualStyle.text)
                    .kerning(2)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
                    .background(
                        RoundedRectangle(cornerRadius: 12, style: .continuous)
                            .fill(OS1VisualStyle.markdownInlineCode)
                    )
            }
            Text(copiedCode ? "Copied. Paste it on GitHub." : "Tap the code to copy it.")
                .font(.caption2)
                .foregroundStyle(.tertiary)
                .frame(maxWidth: .infinity)
            if let url = URL(string: flow.verificationUri) {
                Button("Copy code and open GitHub") {
                    copyToPasteboard(flow.userCode)
                    copiedCode = true
                    openURL(url)
                }
            }
            HStack(spacing: 8) {
                ProgressView()
                Text("Waiting for approval…")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                Spacer()
                Button("Cancel", role: .cancel) { signIn.cancel() }
            }
            if let at = signIn.lastPollAt {
                Text("Checked \(at.formatted(date: .omitted, time: .standard)) · \(signIn.lastPollNote ?? "")")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(.vertical, 4)
        .buttonStyle(.borderless)
    }

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        if showingConnection || !config.isConfigured {
            ToolbarItem(placement: .confirmationAction) {
                Button("Save") {
                    save()
                    if config.isConfigured { showingConnection = false }
                }
            }
            ToolbarItem(placement: .cancellationAction) {
                Button(config.isConfigured ? "Back" : "Cancel") {
                    if config.isConfigured {
                        showingConnection = false
                    } else {
                        dismiss()
                    }
                }
            }
        } else {
            ToolbarItem(placement: .confirmationAction) {
                #if os(iOS)
                    // A glyph, not the word: the sheet's only exit reads faster
                    // as a checkmark, and the accent tint is what marks it as
                    // the confirming action.
                    Button {
                        dismiss()
                    } label: {
                        Label("Done", systemImage: "checkmark")
                            .labelStyle(.iconOnly)
                            .font(.body.weight(.semibold))
                    }
                    .tint(OS1VisualStyle.accentInk)
                #else
                    Button("Done") { dismiss() }
                #endif
            }
        }
    }

    private func startSignIn() {
        config.baseURLString = serverURL.trimmingCharacters(in: .whitespacesAndNewlines)
        signIn.start()
    }

    private func signOut() {
        Task {
            #if os(iOS)
            await LiveActivityCoordinator.shared.disable()
            #endif
            try? await OS1API.logout()
            config.token = ""
            token = ""
            // Nothing cached outlives the account it was fetched for.
            SettingsCache.clear()
            showingConnection = true
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
