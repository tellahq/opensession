import SwiftUI

#if os(macOS)
extension Notification.Name {
    /// Posted by the File > New Session menu command; the sessions list opens
    /// its new-session sheet in response.
    static let os1NewSession = Notification.Name("os1.newSession")
    /// File > New Session in This Workspace: a sibling of the open session,
    /// sharing its workspace, worktree and branch.
    static let os1NewSessionInWorkspace = Notification.Name("os1.newSessionInWorkspace")
    /// View > Command Palette. Toggles like the web command does.
    static let os1CommandPalette = Notification.Name("os1.commandPalette")
}
#endif

@main
struct OS1App: App {
    #if os(macOS)
    @AppStorage(AccountShortcuts.storageKey) private var rawShortcuts = AccountShortcuts.emptyRawValue
    #endif

    init() {
        // The shared cache is what carries repo icons across launches (see
        // `RepoImageCache`), and its stock disk budget is small enough that a
        // few sessions' worth of REST traffic evicts them — which showed up
        // as tiles, and the Settings button wearing one, drawing their
        // fallback on every cold start. Raising the ceiling keeps the
        // existing store and its entries; only lowering it evicts.
        URLCache.shared.memoryCapacity = 8 * 1024 * 1024
        URLCache.shared.diskCapacity = 64 * 1024 * 1024
    }

    var body: some Scene {
        #if os(macOS)
        let shortcuts = AccountShortcuts(rawValue: rawShortcuts)
        #endif
        WindowGroup {
            RootView()
        }
        #if os(macOS)
        .defaultSize(width: 920, height: 720)
        .commands {
            // New session composes in this window instead of opening another.
            CommandGroup(replacing: .newItem) {
                Button("New Session") {
                    NotificationCenter.default.post(name: .os1NewSession, object: nil)
                }
                .keyboardShortcut(shortcuts.keyboardShortcut(for: .newSession))
                // The sibling variant starts a second conversation on the
                // workspace you are already in, sharing its worktree and
                // branch. Never a dead key: with
                // nothing selected, or on a session too old to have a
                // workspace, the sessions list falls back to the composer.
                Button("New Session in This Workspace") {
                    NotificationCenter.default.post(
                        name: .os1NewSessionInWorkspace, object: nil
                    )
                }
                .keyboardShortcut(shortcuts.keyboardShortcut(for: .newSessionInWorkspace))
            }
            CommandGroup(after: .sidebar) {
                Button("Command Palette…") {
                    NotificationCenter.default.post(
                        name: .os1CommandPalette, object: nil
                    )
                }
                .keyboardShortcut(shortcuts.keyboardShortcut(for: .commandMenu))
            }
        }
        #endif

        #if os(macOS)
        // Real macOS Settings scene (App menu > Settings…, Cmd+,) hosting the
        // System Settings-style split view. The in-window settings sheet the
        // iOS app uses is not a Mac pattern.
        Settings {
            MacSettingsView()
                .os1AccentToggles()
        }
        .windowResizability(.contentMinSize)
        #endif
    }
}

/// Runs account lifecycle work without putting scene state in SwiftUI's view
/// graph. Platform notifications can suspend and resume the stores without
/// asking AttributeGraph to compare the sessions list and open transcript.
private struct RootSceneLifecycle: View {
    let config: ServerConfig

    var body: some View {
        Color.clear
            .frame(width: 0, height: 0)
            .task(id: hydrationID) {
                if AppLifecycle.isActive {
                    PresenceStore.shared.start()
                } else {
                    PresenceStore.shared.suspend()
                }
                while !Task.isCancelled {
                    if AppLifecycle.isActive { await hydrate() }
                    try? await Task.sleep(for: .seconds(30))
                }
            }
            .task {
                for await _ in NotificationCenter.default.notifications(
                    named: AppLifecycle.didBecomeActiveNotification
                ) {
                    PresenceStore.shared.start()
                    GitHubSignIn.shared.nudge()
                    // A grant can die while the app is in the background, and
                    // polls that fail quietly are exactly what this replaces.
                    AuthGate.shared.confirm()
                    await hydrate()
                }
            }
            .task {
                for await _ in NotificationCenter.default.notifications(
                    named: AppLifecycle.willResignActiveNotification
                ) {
                    PresenceStore.shared.suspend()
                    DraftsStore.shared.flushAll()
                }
            }
    }

    private var hydrationID: String {
        "\(config.activeId)|\(config.baseURLString)|\(config.userName)|\(config.githubLogin)|\(config.token.hashValue)"
    }

    private func hydrate() async {
        await NativePreferences.hydrate()
        await HideStore.shared.hydrate()
        await PinStore.shared.hydrate()
        await WorkspaceSnoozeStore.shared.hydrate()
        await LaneStore.shared.hydrate()
        await MentionStore.shared.hydrate()
        await ReadsStore.shared.hydrate()
        await DraftsStore.shared.hydrate()
    }
}

struct RootView: View {
    @AppStorage("os1.appearance") private var appearance = "system"
    @State private var config = ServerConfig.shared
    @State private var authGate = AuthGate.shared
    @State private var showedInitialSettings = false
    @State private var showSettings = false
    #if os(iOS)
    @AppStorage(LiveActivityCoordinator.preferenceKey) private var liveActivitiesEnabled = false
    #endif

    var body: some View {
        SessionsListView()
            .id(config.activeId)
            .tint(OS1VisualStyle.accentInk)
            .os1AccentToggles()
            .background(OS1VisualStyle.background.ignoresSafeArea())
            // An overlay, not a sheet: the server is refusing this session, so
            // everything underneath is answering 401 and there is nothing to
            // swipe back to. It clears itself when the sign-in lands.
            .overlay {
                if let reason = authGate.blocked {
                    ReconnectCover(reason: reason)
                        .transition(.opacity)
                }
            }
            .preferredColorScheme(preferredColorScheme)
            .sheet(isPresented: $showSettings) {
                #if os(macOS)
                // First-run connect flow only; day-to-day settings live in
                // the Settings scene (Cmd+,).
                ConnectionOnboardingSheet()
                #else
                SettingsView()
                #endif
            }
            .onAppear {
                if !config.isConfigured && !showedInitialSettings {
                    showedInitialSettings = true
                    showSettings = true
                }
            }
            .task {
                // Devices signed in before the app stored the GitHub login
                // (pre-07-23 builds) hold a valid token but an empty login —
                // backfill it from the server so the avatar can resolve.
                // A dev launch that names its viewer (`OS1_USER`) keeps that
                // name; the token's own identity would overwrite it here.
                let authContext = NativePreferences.context()
                if config.isConfigured, config.githubLogin.isEmpty,
                   ProcessInfo.processInfo.environment["OS1_USER"] == nil,
                   let status = try? await OS1API.authStatus(),
                   status.authenticated == true,
                   NativePreferences.context() == authContext {
                    if let login = status.login, !login.isEmpty {
                        config.githubLogin = login
                    }
                    if let name = status.name?.trimmingCharacters(in: .whitespacesAndNewlines),
                       !name.isEmpty {
                        config.userName = String(name.split(separator: " ").first!)
                    } else if let login = status.login, !login.isEmpty {
                        config.userName = login
                    }
                }
            }
            // Keep lifecycle state out of this root. Platform notifications
            // let the leaf run side effects without invalidating this tree.
            .background { RootSceneLifecycle(config: config) }
            #if os(iOS)
            .task(id: liveActivityTaskID) {
                if liveActivitiesEnabled {
                    LiveActivityCoordinator.shared.start()
                } else {
                    await LiveActivityCoordinator.shared.disable()
                }
            }
            #endif
            #if os(macOS)
            .frame(minWidth: 520, minHeight: 560)
            #endif
    }

    private var preferredColorScheme: ColorScheme? {
        switch appearance {
        case "light": .light
        case "dark": .dark
        default: nil
        }
    }

    private var connectionID: String {
        "\(config.activeId)|\(config.baseURLString)|\(config.userName)|\(config.githubLogin)|\(config.token.hashValue)"
    }

    #if os(iOS)
    private var liveActivityTaskID: String {
        "\(liveActivitiesEnabled)|\(connectionID)"
    }
    #endif
}
