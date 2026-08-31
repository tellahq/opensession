import AppIntents
import SwiftUI

// Native personal settings use the same server preference keys as the web app
// where a preference follows a person between devices. Device alerts stay local.

struct NotificationsSettingsView: View {
    @AppStorage("os1.notifications.pushAlerts") private var pushAlerts = false
    @AppStorage("os1.notifications.completionSound") private var completionSound = "default"
    @AppStorage("os1.notifications.whenToNotify") private var whenToNotify = "background"
    @AppStorage("os1.notifications.needsInput") private var needsInputAlerts = true
    @AppStorage("os1.notifications.runComplete") private var runCompleteAlerts = true
    #if os(iOS)
    @AppStorage("os1.notifications.unreadBadge") private var unreadBadge = false
    @AppStorage(LiveActivityCoordinator.preferenceKey) private var liveActivities = false
    #endif

    var body: some View {
        Form {
            Section {
                Toggle("Push alerts on this device", isOn: $pushAlerts)
                #if os(iOS)
                Toggle("Badge unread sessions", isOn: $unreadBadge)
                #endif
                Picker("Completion sound", selection: $completionSound) {
                    Text("Default").tag("default")
                    Text("None").tag("none")
                }
                Picker("When to notify", selection: $whenToNotify) {
                    Text("Always").tag("always")
                    Text("When \(AppBrand.productName) is in the background").tag("background")
                    Text("Never").tag("never")
                }
            } header: {
                Text("Alerts")
            } footer: {
                Text("These notification preferences apply only to this native \(AppBrand.productName) app and device.")
            }

            Section("Events") {
                Toggle("Session needs input", isOn: $needsInputAlerts)
                Toggle("Session run completes", isOn: $runCompleteAlerts)
            }

            #if os(iOS)
            Section {
                Toggle("Show session activity", isOn: $liveActivities)
            } header: {
                Text("Live Activities")
            } footer: {
                Text(liveActivityFooter)
            }
            #endif
        }
        .navigationTitle("Notifications")
        .onChange(of: pushAlerts) { _, enabled in
            Task {
                if enabled, !(await NativeNotifications.requestAuthorization()) {
                    pushAlerts = false
                } else {
                    NativeNotifications.refreshBadge()
                }
            }
        }
        #if os(iOS)
        .onChange(of: unreadBadge) { _, enabled in
            Task {
                if enabled, !(await NativeNotifications.requestBadgeAuthorization()) {
                    unreadBadge = false
                } else {
                    NativeNotifications.refreshBadge()
                }
            }
        }
        .onChange(of: liveActivities) { _, enabled in
            Task {
                if enabled {
                    LiveActivityCoordinator.shared.start()
                } else {
                    await LiveActivityCoordinator.shared.disable()
                }
            }
        }
        #endif
    }

    #if os(iOS)
    private var liveActivityFooter: String {
        LiveActivityCoordinator.shared.areActivitiesAvailable
            ? "Shows running and unread sessions on the Lock Screen and Dynamic Island. Session titles follow your Lock Screen privacy settings."
            : "Live Activities are disabled for \(AppBrand.appName) in iPhone Settings."
    }
    #endif
}

/// Everything about how you work with a session: the message box, what a
/// follow-up does mid-run, how much of a turn the transcript shows, voice, and
/// the standing prompt. Appearance next door is only what this device looks
/// like. The `os1.*` AppStorage keys stay under their original names — they
/// are the offline cache, not a user-facing label.
///
/// Nearly all of it is server-side per-user prefs, so it matches the web
/// (Settings → Preferences). Haptics is the device-local exception.
struct PreferencesSettingsView: View {
    @AppStorage("os1.composer.defaultRepo") private var nativeDefaultRepo = ""
    @AppStorage(NativePreferences.sessionCheckoutsStorageKey) private var nativeSessionCheckouts = ""
    @AppStorage("os1.composer.defaultModel") private var nativeDefaultModel = ""
    @AppStorage("os1.composer.defaultEngine") private var nativeDefaultEngine = ""
    @AppStorage("os1.composer.sendKey") private var nativeSendKey = "enter"
    @AppStorage("os1.composer.busySend") private var nativeBusySend = "queue"
    @AppStorage("os1.composer.busySendMod") private var nativeBusySendMod = "steer"
    @AppStorage("os1.appearance.turnActivity") private var nativeTurnWork = "running"
    @AppStorage("os1.appearance.toolCalls") private var nativeToolCalls = "folded"
    @AppStorage("os1.composer.replySuggestions") private var nativeReplySuggestions = true
    @AppStorage("os1.composer.nextChatButton") private var nativeNextChatButton = true
    @AppStorage("os1.transcript.liveTyping") private var nativeLiveTyping = false
    @AppStorage("os1.desk.voice") private var deskVoice = "off"
    /// The one control on this screen that stays on the device — see the type
    /// note above. It is deliberately not in `seededPrefs`/`commit()`: those
    /// are the server round-trip, and this value never makes that trip.
    @AppStorage(Haptics.preferenceKey) private var haptics = true

    @State private var repos: [OS1API.RepoInfo]
    @State private var models: [SettingsModelOption]
    @State private var engines: [ModelEngineOption]
    @State private var defaultRepo: String
    @State private var sessionCheckouts: String
    @State private var defaultModel: String
    @State private var defaultEngine: String
    @State private var sendKey: String
    @State private var busySend: String
    @State private var busySendMod: String
    @State private var turnWork: String
    @State private var toolCalls: String
    @State private var replySuggestions: Bool
    @State private var nextChatButton: Bool
    @State private var liveTyping: Bool
    @State private var loading = true
    @State private var saving = false
    @State private var resaveNeeded = false
    @State private var error: String?
    @State private var savedPrefs: [String: String] = [:]
    @State private var prefsLoaded = false
    /// What the controls were seeded with. A control still sitting on its seed
    /// when the fetch lands adopts the server's value; one the reader has
    /// already moved keeps their choice, and `commit()` pushes it.
    @State private var seededPrefs: [String: String]

    /// Opens on the values this device already holds — the same `os1.*`
    /// mirrors the composer reads, kept current by `NativePreferences` — so
    /// the screen is the settings rather than a spinner in front of them. The
    /// fetch still runs; it corrects rather than reveals. Writing back is
    /// unaffected: `commit()` waits for `prefsLoaded`, so nothing is saved
    /// against a baseline the server has not confirmed.
    init() {
        let defaults = UserDefaults.standard
        let activity = TurnActivity(
            work: defaults.string(forKey: "os1.appearance.turnActivity"),
            tools: defaults.string(forKey: "os1.appearance.toolCalls")
        )
        let seeded: [String: String] = [
            "default-repo": NativePreferences.normalizedDefaultRepository(
                defaults.string(forKey: "os1.composer.defaultRepo")
            ) ?? "",
            "session-checkouts": NativePreferences.validatedSessionCheckouts(
                defaults.string(forKey: NativePreferences.sessionCheckoutsStorageKey)
            ) ?? "",
            "default-model": defaults.string(forKey: "os1.composer.defaultModel") ?? "",
            "default-engine": defaults.string(forKey: "os1.composer.defaultEngine") ?? "",
            "send-key": defaults.string(forKey: "os1.composer.sendKey") ?? "enter",
            "busy-send": defaults.string(forKey: "os1.composer.busySend") ?? "queue",
            "busy-send-mod": defaults.string(forKey: "os1.composer.busySendMod") ?? "steer",
            "turn-activity": activity.work.rawValue,
            "tool-calls": activity.tools.rawValue,
            "reply-suggestions": (defaults.object(forKey: "os1.composer.replySuggestions") as? Bool ?? true) ? "on" : "off",
            "next-chat-button": (defaults.object(forKey: "os1.composer.nextChatButton") as? Bool ?? true) ? "on" : "off",
            "live-typing": (defaults.object(forKey: "os1.transcript.liveTyping") as? Bool ?? false) ? "on" : "off",
        ]
        _seededPrefs = State(initialValue: seeded)
        _defaultRepo = State(initialValue: seeded["default-repo"] ?? "")
        _sessionCheckouts = State(initialValue: seeded["session-checkouts"] ?? "")
        _defaultModel = State(initialValue: seeded["default-model"] ?? "")
        _defaultEngine = State(initialValue: seeded["default-engine"] ?? "")
        _sendKey = State(initialValue: seeded["send-key"] ?? "enter")
        _busySend = State(initialValue: seeded["busy-send"] ?? "queue")
        _busySendMod = State(initialValue: seeded["busy-send-mod"] ?? "steer")
        _turnWork = State(initialValue: seeded["turn-activity"] ?? "running")
        _toolCalls = State(initialValue: seeded["tool-calls"] ?? "folded")
        _replySuggestions = State(initialValue: seeded["reply-suggestions"] != "off")
        _nextChatButton = State(initialValue: seeded["next-chat-button"] != "off")
        _liveTyping = State(initialValue: seeded["live-typing"] == "on")
        let cachedCatalog = SettingsCache.value("model-catalog", as: ModelCatalogSettings.self)
        _repos = State(initialValue: SettingsCache.value("repos") ?? [])
        _models = State(initialValue: cachedCatalog?.models ?? [])
        _engines = State(initialValue: cachedCatalog?.engines ?? [])
    }

    private var selectableModels: [SettingsModelOption] {
        models.filter { $0.id?.isEmpty == false }
    }

    /// Nothing to choose on a single-engine instance, and the same empty list
    /// comes back from a server too old to answer — both hide the row.
    private var selectableEngines: [ModelEngineOption] {
        engines.filter(\.isAvailable)
    }

    var body: some View {
        Form {
            if let error {
                Section {
                    Text(error)
                        .foregroundStyle(.red)
                    Button("Try again") { Task { await load() } }
                }
            }

            Section {
                if repos.isEmpty, loading {
                    HStack(spacing: 8) {
                        ProgressView()
                        Text("Loading repositories…").foregroundStyle(.secondary)
                    }
                } else {
                    Picker("Default repository", selection: $defaultRepo) {
                        Text("No preference").tag("")
                        ForEach(repos) { repo in
                            Text(repo.label ?? repo.id).tag(repo.id)
                        }
                    }
                    ForEach(repos) { repo in
                        Picker(
                            "\(repo.label ?? repo.id) workspace",
                            selection: sessionCheckoutBinding(for: repo.id)
                        ) {
                            Text("Default").tag("default")
                            Text("Local checkout").tag("checkout")
                            Text("Separate worktree").tag("worktree")
                        }
                    }
                }
                // The catalogs are the only things here with no complete local
                // mirror to open on, so a first visit waits for these rows and
                // the rest of the screen does not.
                if selectableModels.isEmpty, loading {
                    HStack(spacing: 8) {
                        ProgressView()
                        Text("Loading models…").foregroundStyle(.secondary)
                    }
                } else {
                    Picker("Default model", selection: $defaultModel) {
                        Text("No preference").tag("")
                        ForEach(selectableModels, id: \.id) { model in
                            Text(model.label ?? model.id ?? "Model").tag(model.id ?? "")
                        }
                    }
                }
                if selectableEngines.count > 1 {
                    Picker("Default engine", selection: $defaultEngine) {
                        Text("No preference").tag("")
                        ForEach(selectableEngines, id: \.id) { engine in
                            Text(engine.label).tag(engine.id)
                        }
                    }
                }
            } header: {
                Text("New sessions")
            } footer: {
                Text(
                    selectableEngines.count > 1
                        ? "New sessions use this repository, model, engine, and code workspace when available. Default uses each repository's setting."
                        : "New sessions use this repository, model, and code workspace when available. Default uses each repository's setting."
                )
            }

            Section {
                #if os(macOS)
                Picker("Send messages with", selection: $sendKey) {
                    Text("Enter").tag("enter")
                    Text("Command/Control-Enter").tag("mod-enter")
                }
                #else
                LabeledContent("Send messages with", value: "Return")
                #endif
                Picker("Send button while busy", selection: $busySend) {
                    Text("Queue for later").tag("queue")
                    Text("Steer the current run").tag("steer")
                }
                #if os(macOS)
                if sendKey == "enter" {
                    Picker("Command/Control-Enter while busy", selection: $busySendMod) {
                        Text("Queue for later").tag("queue")
                        Text("Steer the current run").tag("steer")
                    }
                }
                #endif
            } header: {
                Text("Sending")
            } footer: {
                // The setting is only the default: the other verb is
                // always one gesture away, and this is the only place
                // that says so.
                #if os(macOS)
                Text("Queue waits for the agent to finish. Steer adds your message to the running turn. Hold Send to use the other option once.")
                #else
                Text("Queue waits for the agent to finish. Steer adds your message to the running turn. Touch and hold Send to use the other option once.")
                #endif
            }

            Section {
                Toggle("Quick replies", isOn: $replySuggestions)
                Toggle("Next button", isOn: $nextChatButton)
            } footer: {
                Text("Quick replies fill the draft. Next opens the next chat.")
            }

            #if os(iOS)
            // Directly under Sending, because sending is what it mostly
            // answers — and its own section rather than a row in there,
            // because that section's footer is about where a message goes,
            // which has nothing to do with what the tap feels like.
            Section {
                Toggle("Haptic feedback", isOn: $haptics)
            } header: {
                Text("Haptics")
            } footer: {
                Text("Play haptics when you send a message, answer a question, or stop a run.")
            }
            #endif

            Section {
                Picker("Steps", selection: $turnWork) {
                    Text("Closed").tag("folded")
                    Text("With updates").tag("running")
                    Text("Open").tag("open")
                }
                Picker("Tool calls", selection: $toolCalls) {
                    Text("Closed").tag("folded")
                    Text("Open").tag("open")
                }
                Toggle("Live typing", isOn: $liveTyping)
            } header: {
                Text("Transcript")
            } footer: {
                Text("By default, steps stay open while a turn runs, then close. Closed tool calls stay one tap away. Live typing types the reply out as the model writes it. Off, each part appears when it is finished.")
            }

            Section {
                Toggle("Desk voice", isOn: Binding(
                    get: { deskVoice == "on" },
                    set: { enabled in
                        deskVoice = enabled ? "on" : "off"
                        pushDeskVoice(enabled)
                    }
                ))
            } footer: {
                Text("Talk to your Desk with a live voice call. Uses the server's OpenAI key.")
            }
            PersonalOutputStyleSection()
            PersonalPromptSection()
        }
        .navigationTitle("Preferences")
        #if os(iOS)
        // Switching it on plays the send cue once, so the control demonstrates
        // what it does instead of describing it — and proves the engine works
        // on this device before you go looking for the tap in a composer.
        .onChange(of: haptics) { _, on in
            if on { Haptics.play(.send) }
        }
        #endif
        .task { await load() }
        .onChange(of: defaultRepo) { _, _ in commit() }
        .onChange(of: sessionCheckouts) { _, _ in commit() }
        .onChange(of: defaultModel) { _, _ in commit() }
        .onChange(of: defaultEngine) { _, _ in commit() }
        .onChange(of: sendKey) { _, _ in commit() }
        .onChange(of: busySend) { _, _ in commit() }
        .onChange(of: busySendMod) { _, _ in commit() }
        .onChange(of: turnWork) { _, _ in commit() }
        .onChange(of: toolCalls) { _, _ in commit() }
        .onChange(of: replySuggestions) { _, _ in commit() }
        .onChange(of: nextChatButton) { _, _ in commit() }
        .onChange(of: liveTyping) { _, _ in commit() }
        .onDisappear { commit() }
    }

    /// Fire-and-forget: the toggle already reflects locally via `@AppStorage`,
    /// this just lets other devices pick it up.
    private func pushDeskVoice(_ enabled: Bool) {
        let user = NativePreferences.context().user
        Task {
            _ = try? await SettingsAPI.updateUiPrefs(
                user: user,
                prefs: ["desk-voice": enabled ? "on" : "off"]
            )
        }
    }

    /// Every control writes through on change — there is no Save button, so
    /// leaving the screen is only a backstop for a request still in flight.
    /// A change made mid-save queues behind it rather than racing it.
    private func commit() {
        guard prefsLoaded, !loading, currentPrefs != savedPrefs else { return }
        guard !saving else { resaveNeeded = true; return }
        Task { await save() }
    }

    private func load() async {
        loading = true
        error = nil
        prefsLoaded = false
        do {
            let requestContext = NativePreferences.context()
            let prefs = try await SettingsAPI.uiPrefs(user: requestContext.user)
            guard NativePreferences.context() == requestContext else { loading = false; return }
            let remoteActivity = TurnActivity.mergingRemote(
                work: prefs["turn-activity"],
                tools: prefs["tool-calls"],
                local: TurnActivity(work: nativeTurnWork, tools: nativeToolCalls)
            )
            let server: [String: String] = [
                "default-repo": NativePreferences.normalizedDefaultRepository(
                    prefs["default-repo"]
                ) ?? "",
                "session-checkouts": NativePreferences.validatedSessionCheckouts(
                    prefs["session-checkouts"]
                ) ?? "",
                "default-model": prefs["default-model"] ?? nativeDefaultModel,
                "default-engine": prefs["default-engine"] ?? nativeDefaultEngine,
                "send-key": prefs["send-key"] == "mod-enter" ? "mod-enter" : "enter",
                "busy-send": prefs["busy-send"] == "steer" ? "steer" : "queue",
                "busy-send-mod": prefs["busy-send-mod"] == "queue" ? "queue" : "steer",
                // Unset (or an unknown value from a newer client) keeps
                // whatever this device last saw rather than snapping the
                // picker to a default the account never chose.
                "turn-activity": remoteActivity.work.rawValue,
                "tool-calls": remoteActivity.tools.rawValue,
                "reply-suggestions": (
                    NativePreferences.replySuggestionsEnabled(prefs["reply-suggestions"])
                        ?? replySuggestions
                ) ? "on" : "off",
                "next-chat-button": (
                    NativePreferences.nextChatButtonEnabled(prefs["next-chat-button"])
                        ?? nextChatButton
                ) ? "on" : "off",
                "live-typing": (
                    NativePreferences.liveTypingEnabled(prefs["live-typing"]) ?? liveTyping
                ) ? "on" : "off",
            ]
            // The screen was already usable while this was in flight, so a
            // control the reader moved in the meantime keeps their choice —
            // only the ones still sitting on their seed adopt the server's.
            // The `commit()` below then pushes whatever they changed.
            if defaultRepo == seededPrefs["default-repo"] { defaultRepo = server["default-repo"] ?? defaultRepo }
            if sessionCheckouts == seededPrefs["session-checkouts"] {
                sessionCheckouts = server["session-checkouts"] ?? sessionCheckouts
            }
            if defaultModel == seededPrefs["default-model"] { defaultModel = server["default-model"] ?? defaultModel }
            if defaultEngine == seededPrefs["default-engine"] { defaultEngine = server["default-engine"] ?? defaultEngine }
            if sendKey == seededPrefs["send-key"] { sendKey = server["send-key"] ?? sendKey }
            if busySend == seededPrefs["busy-send"] { busySend = server["busy-send"] ?? busySend }
            if busySendMod == seededPrefs["busy-send-mod"] { busySendMod = server["busy-send-mod"] ?? busySendMod }
            if turnWork == seededPrefs["turn-activity"] { turnWork = server["turn-activity"] ?? turnWork }
            if toolCalls == seededPrefs["tool-calls"] { toolCalls = server["tool-calls"] ?? toolCalls }
            if (replySuggestions ? "on" : "off") == seededPrefs["reply-suggestions"] {
                replySuggestions = server["reply-suggestions"] != "off"
            }
            if (nextChatButton ? "on" : "off") == seededPrefs["next-chat-button"] {
                nextChatButton = server["next-chat-button"] != "off"
            }
            if (liveTyping ? "on" : "off") == seededPrefs["live-typing"] {
                liveTyping = server["live-typing"] == "on"
            }
            seededPrefs = server
            nativeDefaultRepo = defaultRepo
            nativeSessionCheckouts = sessionCheckouts
            #if os(macOS)
            nativeSendKey = sendKey
            #endif
            nativeBusySend = busySend
            nativeBusySendMod = busySendMod
            nativeTurnWork = turnWork
            nativeToolCalls = toolCalls
            nativeReplySuggestions = replySuggestions
            nativeNextChatButton = nextChatButton
            nativeLiveTyping = liveTyping
            savedPrefs = server
            if let legacyValue = prefs["turn-activity"],
               TurnActivity.legacy[legacyValue] != nil {
                let expected: [String: String?] = [
                    "turn-activity": legacyValue,
                    "tool-calls": prefs["tool-calls"],
                ]
                if let migrated = try? await SettingsAPI.updateUiPrefs(
                    user: requestContext.user,
                    prefs: [
                        "turn-activity": remoteActivity.work.rawValue,
                        "tool-calls": remoteActivity.tools.rawValue,
                    ],
                    expected: expected
                ) {
                    let reconciled = TurnActivity.mergingRemote(
                        work: migrated["turn-activity"],
                        tools: migrated["tool-calls"],
                        local: remoteActivity
                    )
                    if turnWork == remoteActivity.work.rawValue {
                        turnWork = reconciled.work.rawValue
                    }
                    if toolCalls == remoteActivity.tools.rawValue {
                        toolCalls = reconciled.tools.rawValue
                    }
                    nativeTurnWork = turnWork
                    nativeToolCalls = toolCalls
                    savedPrefs["turn-activity"] = reconciled.work.rawValue
                    savedPrefs["tool-calls"] = reconciled.tools.rawValue
                }
            }
            prefsLoaded = true
        } catch {
            self.error = error.localizedDescription
        }
        do {
            let fetched = try await OS1API.repos()
            repos = fetched
            SettingsCache.save("repos", fetched)
            // A removed repository id is no longer a usable preference. Show
            // and persist the same safe no-preference value as the web client.
            if !defaultRepo.isEmpty, !fetched.contains(where: { $0.id == defaultRepo }) {
                defaultRepo = ""
            }
        } catch {
            if repos.isEmpty, self.error == nil { self.error = error.localizedDescription }
        }
        do {
            let catalog = try await SettingsAPI.modelCatalog()
            models = catalog.models ?? []
            engines = catalog.engines ?? []
            SettingsCache.save("model-catalog", catalog)
        } catch {
            if self.error == nil { self.error = error.localizedDescription }
        }
        loading = false
        commit()
    }

    private func save() async {
        saving = true
        error = nil
        do {
            let current = currentPrefs
            var patch: [String: String?] = [:]
            for (key, value) in current where savedPrefs[key] != value {
                patch[key] = value
            }
            guard !patch.isEmpty else { saving = false; resaveNeeded = false; return }
            let requestContext = NativePreferences.context()
            let response = try await SettingsAPI.updateUiPrefs(user: requestContext.user, prefs: patch)
            var confirmed = savedPrefs
            for (key, value) in current where patch.keys.contains(key) { confirmed[key] = value }
            confirmed.merge(response) { _, server in server }
            confirmed["session-checkouts"] = NativePreferences.validatedSessionCheckouts(
                confirmed["session-checkouts"]
            ) ?? ""
            guard NativePreferences.apply(confirmed, for: requestContext) else {
                self.error = "Connection changed before preferences finished saving."
                saving = false
                return
            }
            defaultRepo = NativePreferences.normalizedDefaultRepository(
                confirmed["default-repo"]
            ) ?? defaultRepo
            if !defaultRepo.isEmpty, !repos.contains(where: { $0.id == defaultRepo }) {
                defaultRepo = ""
            }
            sessionCheckouts = NativePreferences.validatedSessionCheckouts(
                confirmed["session-checkouts"]
            ) ?? ""
            defaultModel = confirmed["default-model"] ?? defaultModel
            defaultEngine = confirmed["default-engine"] ?? defaultEngine
            sendKey = confirmed["send-key"] == "mod-enter" ? "mod-enter" : "enter"
            busySend = confirmed["busy-send"] == "steer" ? "steer" : "queue"
            busySendMod = confirmed["busy-send-mod"] == "queue" ? "queue" : "steer"
            turnWork = TurnActivity.Work(rawValue: confirmed["turn-activity"] ?? "")?.rawValue ?? turnWork
            toolCalls = TurnActivity.Tools(rawValue: confirmed["tool-calls"] ?? "")?.rawValue ?? toolCalls
            replySuggestions = NativePreferences.replySuggestionsEnabled(
                confirmed["reply-suggestions"]
            ) ?? replySuggestions
            nextChatButton = NativePreferences.nextChatButtonEnabled(
                confirmed["next-chat-button"]
            ) ?? nextChatButton
            liveTyping = NativePreferences.liveTypingEnabled(
                confirmed["live-typing"]
            ) ?? liveTyping
            nativeDefaultRepo = defaultRepo
            nativeSessionCheckouts = sessionCheckouts
            nativeDefaultModel = defaultModel
            nativeDefaultEngine = defaultEngine
            #if os(macOS)
            nativeSendKey = sendKey
            #endif
            nativeBusySend = busySend
            nativeBusySendMod = busySendMod
            nativeTurnWork = turnWork
            nativeToolCalls = toolCalls
            nativeReplySuggestions = replySuggestions
            nativeNextChatButton = nextChatButton
            nativeLiveTyping = liveTyping
            savedPrefs = confirmed
        } catch {
            self.error = error.localizedDescription
        }
        saving = false
        if resaveNeeded {
            resaveNeeded = false
            commit()
        }
    }

    private func sessionCheckoutBinding(for repository: String) -> Binding<String> {
        Binding(
            get: {
                NativePreferences.sessionCheckoutMode(
                    for: repository,
                    in: sessionCheckouts
                )
            },
            set: { mode in
                sessionCheckouts = NativePreferences.settingSessionCheckout(
                    mode,
                    for: repository,
                    in: sessionCheckouts
                )
            }
        )
    }

    private var currentPrefs: [String: String] {
        [
            "default-repo": defaultRepo,
            "session-checkouts": sessionCheckouts,
            "default-model": defaultModel,
            "default-engine": defaultEngine,
            "send-key": sendKey,
            "busy-send": busySend,
            "busy-send-mod": busySendMod,
            "turn-activity": turnWork,
            "tool-calls": toolCalls,
            "reply-suggestions": replySuggestions ? "on" : "off",
            "next-chat-button": nextChatButton ? "on" : "off",
            "live-typing": liveTyping ? "on" : "off",
        ]
    }

}

/// How the app looks, and how the session list is arranged — the native half
/// of the web's Appearance panel.
///
/// Two kinds of setting share the screen, as they do on the web: the theme is
/// this device's (a display habit, not cloud state), and repo order is the
/// account's — the very same `repo-order` ui-pref the web sidebar writes when
/// its repo bands are dragged, which this app has always READ
/// (`NativePreferences`) and until now could not set. How much of a session
/// you see, and every other choice about how you WORK, still lives in
/// Preferences. The footer under each group says which is which.
struct AppearanceSettingsView: View {
    @AppStorage("os1.appearance") private var appearance = "system"
    @AppStorage("os1.list.lastUsed") private var lastUsed = "off"
    @AppStorage("os1.sidebar.repoOrder") private var repoOrderJSON = "[]"
    @AppStorage(SidebarFeeds.storageKey) private var hiddenFeeds = "[]"
    @AppStorage(SidebarTools.storageKey) private var hiddenTools = SidebarTools.defaultHiddenJSON
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    @State private var repos: [OS1API.RepoInfo] = SettingsCache.value("repos") ?? []
    @State private var feeds: [SidebarFeeds.Feed] = SettingsCache.value("feeds") ?? []

    private static let themes: [(value: String, label: String)] = [
        ("system", "System"),
        ("light", "Light"),
        ("dark", "Dark"),
    ]

    var body: some View {
        Form {
            Section {
                // Three swatches across is the pattern both platforms' own
                // settings use for this exact choice. At accessibility text
                // sizes the labels under them stop fitting, so that size class
                // falls back to the plain picker rather than shrinking type.
                if dynamicTypeSize.isAccessibilitySize {
                    Picker("Theme", selection: $appearance) {
                        ForEach(Self.themes, id: \.value) { theme in
                            Text(theme.label).tag(theme.value)
                        }
                    }
                } else {
                    HStack(alignment: .top, spacing: 14) {
                        ForEach(Self.themes, id: \.value) { theme in
                            ThemeOptionCard(
                                option: theme.value,
                                label: theme.label,
                                selected: appearance == theme.value
                            ) {
                                appearance = theme.value
                            }
                        }
                    }
                    .padding(.vertical, 6)
                    // A phone row is narrower than this, so the cap only bites
                    // in the Mac settings window, where an uncapped swatch
                    // grows to a third of a 900pt pane and stops reading as a
                    // control.
                    .frame(maxWidth: 430)
                    .frame(maxWidth: .infinity)
                    .listRowBackground(Color.clear)
                    .accessibilityElement(children: .contain)
                    .accessibilityLabel("Theme")
                }
            } header: {
                Text("Theme")
            } footer: {
                // Kept from the old screen on purpose: the swatch ring is the
                // only other cue, and it is not one VoiceOver reads aloud.
                Text(themeFooter)
            }

            Section {
                // One control for the app's whole primary colour: every accent
                // surface reads `OS1VisualStyle.accent`, which reads the
                // selection here, so the app repaints as the ring moves.
                LazyVGrid(
                    columns: [GridItem(.adaptive(minimum: 46), spacing: 14)],
                    spacing: 14
                ) {
                    ForEach(AccentTheme.allCases) { theme in
                        AccentOptionSwatch(
                            theme: theme,
                            selected: AccentStore.shared.theme == theme
                        ) {
                            AccentStore.shared.theme = theme
                        }
                    }
                }
                .padding(.vertical, 10)
                .frame(maxWidth: 430)
                .frame(maxWidth: .infinity)
                // Keep the Form row surface so the swatches read as one picker.
                .accessibilityElement(children: .contain)
                .accessibilityLabel("Accent colour")
            } header: {
                Text("Accent")
            }

            Section {
                NavigationLink {
                    RepoOrderSettingsView()
                } label: {
                    LabeledContent {
                        RepoOrderPreview(order: previewOrder)
                    } label: {
                        Text("Repo order")
                    }
                }
                Picker("Show last used time", selection: $lastUsed) {
                    Text("Off").tag("off")
                    Text("Always").tag("always")
                }
            } header: {
                Text("Session list")
            } footer: {
                Text(
                    "Repo order is your account's — the web sidebar follows it too. The last-used time is this device's, and a running session always shows its own clock."
                )
            }

            // Only the tools this app can open, unlike Sources below: the tool
            // ids are a fixed list the web owns, so one it does not draw is
            // never stranded here, and a switch for a screen the phone does
            // not have would be a preference with nothing behind it.
            if hasPlainSupport {
                Section {
                    Picker("Support tickets", selection: supportLocationBinding) {
                        ForEach(SupportLocation.allCases) { location in
                            Text(location.label).tag(location)
                        }
                    }
                } header: {
                    Text("Support tickets")
                } footer: {
                    Text("Choose where the Support queue lives. This setting follows your account across the web and native apps.")
                }
            }

            Section {
                ForEach(SidebarTools.surfaced) { tool in
                    Toggle(isOn: Binding(
                        get: { !SidebarTools.isHidden(tool.id, in: hiddenTools) },
                        set: { SidebarTools.setVisible(tool.id, $0) }
                    )) {
                        Text(tool.title)
                    }
                }
            } header: {
                Text("Tools")
            } footer: {
                Text(
                    "Where you go that is not a session. The setting is your account's, so the web sidebar follows it too."
                )
            }

            // The way back from a long press on the row, and on the Mac the
            // only way back at all.
            //
            // One switch per source the SERVER describes, not per source this
            // build draws: the hidden list is the account's and the browser
            // writes it too, so a feed hidden there needs a way back that does
            // not depend on this client having a row for it. That is the whole
            // reason it is not gated to the platform whose sidebar draws these
            // rows today — a Mac that hid a feed in a browser would otherwise
            // have to go back to that browser to undo it, which is the
            // one-way hiding this section exists to prevent.
            if !otherSources.isEmpty {
                Section {
                    ForEach(otherSources) { source in
                        Toggle(isOn: Binding(
                            get: { !SidebarFeeds.isHidden(source.id, in: hiddenFeeds) },
                            set: { SidebarFeeds.setVisible(source.id, $0) }
                        )) {
                            SourceToggleLabel(source: source)
                        }
                    }
                } header: {
                    Text("Sources")
                } footer: {
                    Text(
                        "Hidden sources stop refreshing until you show them again. The setting is your account's, so the web sidebar follows it too."
                    )
                }
            }
        }
        .navigationTitle("Appearance")
        .task { await loadRepos() }
        .task { await loadFeeds() }
    }

    private var sources: [SidebarFeeds.Source] {
        SidebarFeeds.sources(known: feeds, hidden: hiddenFeeds)
    }

    private var hasPlainSupport: Bool {
        sources.contains { $0.id == SidebarFeeds.plain }
    }

    private var otherSources: [SidebarFeeds.Source] {
        sources.filter { $0.id != SidebarFeeds.plain }
    }

    private var supportLocationBinding: Binding<SupportLocation> {
        Binding(
            get: {
                SupportLocation.current(hiddenTools: hiddenTools, hiddenFeeds: hiddenFeeds)
            },
            set: SupportLocation.set
        )
    }

    /// Cached like the repo list: the switches have to be right on the screen
    /// that restores a source, and a cold fetch is a beat too late. A failed
    /// fetch leaves the cached set, and the hidden ids alone still draw rows.
    private func loadFeeds() async {
        guard let fetched = try? await OS1API.feeds() else { return }
        feeds = fetched
        SettingsCache.save("feeds", fetched)
    }

    private var themeFooter: String {
        switch appearance {
        case "light": "Always light, on this device."
        case "dark": "Always dark, on this device."
        default: "Matches your system setting, on this device."
        }
    }

    private var previewOrder: [String] {
        RepoOrderSettingsView.ordered(ids: repos.map(\.id), preferredJSON: repoOrderJSON)
    }

    /// Only to fill the row's preview tiles — the editor behind it fetches for
    /// itself, and a cached list is enough to open on.
    private func loadRepos() async {
        guard let fetched = try? await OS1API.repos() else { return }
        repos = fetched
        SettingsCache.save("repos", fetched)
    }
}

/// One source's name, and a word about it when the only thing that knows the
/// id is the hidden list itself. Saying so is what keeps the row honest: the
/// switch still works, and the person can see why it has no better name.
private struct SourceToggleLabel: View {
    let source: SidebarFeeds.Source

    var body: some View {
        if source.unknown {
            VStack(alignment: .leading, spacing: 2) {
                Text(source.title)
                Text("This server no longer offers this source.")
                    .font(.footnote)
                    .foregroundStyle(OS1VisualStyle.textDim)
            }
        } else {
            Text(source.title)
        }
    }
}

/// The first few repo tiles, in order, on the row that opens the editor — the
/// setting's value said in the same language the list itself speaks.
private struct RepoOrderPreview: View {
    let order: [String]

    var body: some View {
        if order.isEmpty {
            Text("None")
        } else {
            HStack(spacing: 4) {
                ForEach(order.prefix(4), id: \.self) { repo in
                    RepoTile(name: repo, size: 18)
                }
                if order.count > 4 {
                    Text("+\(order.count - 4)")
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.secondary)
                }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(
                order.map(RepoTile.label(for:)).joined(separator: ", ")
            )
        }
    }
}

/// One theme swatch: a miniature of the app in that tone, its name under it,
/// and a ring when it is the one in use.
/// One accent choice: the colour as it resolves in the CURRENT appearance,
/// with the selected one ringed. Showing the resolved value rather than both
/// halves of the pair is the honest preview — it is exactly the fill the send
/// disc will wear a moment later — and it keeps the checkmark, which is drawn
/// in the same derived `onAccent` the disc's glyph uses, legible on every
/// swatch including `mono`.
private struct AccentOptionSwatch: View {
    let theme: AccentTheme
    let selected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Circle()
                .fill(theme.gradient)
                .frame(width: 34, height: 34)
                .overlay {
                    // Mono's light fill is black and its dark fill white, so on
                    // one appearance or the other it sits flush against the
                    // row — a hairline keeps every swatch a disc.
                    Circle().strokeBorder(OS1VisualStyle.border, lineWidth: 0.5)
                }
                .overlay {
                    if selected {
                        Image(systemName: "checkmark")
                            .font(.system(size: 15, weight: .bold))
                            .foregroundStyle(theme.onAccent)
                    }
                }
                .padding(3)
                .overlay {
                    Circle().strokeBorder(
                        selected ? AnyShapeStyle(theme.gradient) : AnyShapeStyle(.clear),
                        lineWidth: 2
                    )
                }
                .animation(.easeOut(duration: 0.15), value: selected)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(theme.title)
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
    }
}

private struct ThemeOptionCard: View {
    let option: String
    let label: String
    let selected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: 8) {
                ZStack {
                    ThemeMock(dark: option == "dark")
                    // System is the light mock with the dark one clipped over
                    // its right half — the web swatch's own trick.
                    if option == "system" {
                        ThemeMock(dark: true)
                            .mask {
                                HStack(spacing: 0) {
                                    Color.clear
                                    Color.black
                                }
                            }
                    }
                }
                .aspectRatio(16.0 / 10.0, contentMode: .fit)
                .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: 9, style: .continuous)
                        .strokeBorder(
                            selected ? OS1VisualStyle.accent : OS1VisualStyle.border,
                            lineWidth: selected ? 2 : 1
                        )
                }
                Text(label)
                    .font(.footnote.weight(selected ? .semibold : .regular))
                    .foregroundStyle(selected ? OS1VisualStyle.text : OS1VisualStyle.textDim)
            }
            .animation(.easeOut(duration: 0.15), value: selected)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
    }
}

/// The miniature app inside a theme swatch.
///
/// Fixed greys rather than the app's tokens, deliberately: each card has to go
/// on showing ITS tone whichever theme is currently in use. The proportions are
/// fractions of the card, matching the web's `ThemeMock`
/// (src/frontend/components/settings/AppearancePanel.tsx), so the two products
/// draw the same illustration.
private struct ThemeMock: View {
    let dark: Bool

    private var page: Color { dark ? Color(white: 0.337) : Color(white: 0.914) }
    private var panel: Color { dark ? Color(white: 0.243) : .white }
    private var line: Color { dark ? Color(white: 0.769) : Color(white: 0.835) }
    private var pill: Color { dark ? Color(white: 0.541) : Color(white: 0.796) }

    var body: some View {
        GeometryReader { proxy in
            let w = proxy.size.width
            let h = proxy.size.height
            let leadingInset = w * 0.14
            let trailingInset = w * 0.09
            let panelPad = w * 0.068
            let inner = w - leadingInset - trailingInset - panelPad * 2
            VStack(spacing: 0) {
                VStack(spacing: h * 0.05) {
                    bar(w * 0.56, h * 0.06, pill)
                    bar(w * 0.42, h * 0.06, pill.opacity(0.65))
                }
                .padding(.top, h * 0.15)
                .padding(.bottom, h * 0.09)

                VStack(alignment: .leading, spacing: h * 0.08) {
                    bar(inner * 0.68, h * 0.06, line)
                    bar(inner * 0.84, h * 0.06, line)
                    bar(inner * 0.56, h * 0.06, line)
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, panelPad)
                .padding(.top, h * 0.11)
                .frame(maxWidth: .infinity, alignment: .leading)
                .frame(height: h * 0.56)
                .background {
                    UnevenRoundedRectangle(
                        topLeadingRadius: h * 0.07,
                        topTrailingRadius: h * 0.07,
                        style: .continuous
                    )
                    .fill(panel)
                }
                .padding(.leading, leadingInset)
                .padding(.trailing, trailingInset)
            }
            .frame(width: w, height: h, alignment: .top)
            .background(page)
        }
    }

    private func bar(_ width: CGFloat, _ height: CGFloat, _ color: Color) -> some View {
        RoundedRectangle(cornerRadius: height / 2, style: .continuous)
            .fill(color)
            .frame(width: width, height: height)
    }
}

/// The order the session list's repo bands sit in.
///
/// This is the account's `repo-order` ui-pref, the one the web sidebar writes
/// when its bands are dragged; the app has always honored it on the way in
/// (`NativePreferences.apply`) and had nowhere to set it. A drop saves
/// straight away — there is no Save button, like every other settings screen
/// here — and the reply is applied through `NativePreferences` so the local
/// `os1.sidebar.repoOrder` mirror gets the server's normalized value rather
/// than a second guess at it.
struct RepoOrderSettingsView: View {
    @AppStorage("os1.sidebar.repoOrder") private var repoOrderJSON = "[]"

    @State private var order: [String] = []
    @State private var repos: [OS1API.RepoInfo] = SettingsCache.value("repos") ?? []
    @State private var error: String?

    /// The stored order first — dropping repos this server no longer has — and
    /// then everything it has not heard of, alphabetically. Same rule as the
    /// list's own `SessionsListViewModel.repositoryOrder`, over the registered
    /// set rather than whichever repos happen to have sessions.
    static func ordered(ids: [String], preferredJSON: String) -> [String] {
        let preferred = (try? JSONDecoder().decode(
            [String].self,
            from: Data(preferredJSON.utf8)
        )) ?? []
        let known = Set(ids)
        var seen = Set<String>()
        let head = preferred.filter { known.contains($0) && seen.insert($0).inserted }
        let tail = ids
            .filter { seen.insert($0).inserted }
            .sorted { $0.localizedStandardCompare($1) == .orderedAscending }
        return head + tail
    }

    var body: some View {
        List {
            if let error {
                Section { Text(error).foregroundStyle(.red) }
            }
            Section {
                if order.isEmpty {
                    Text("No repositories registered.")
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(order, id: \.self) { repo in
                        HStack(spacing: 11) {
                            RepoTile(name: repo, size: 24)
                            Text(RepoTile.label(for: repo))
                        }
                    }
                    .onMove(perform: move)
                }
            } footer: {
                Text(
                    "Drag to set the order repo bands appear in. Saved to your account, so every device — and the web sidebar — follows it."
                )
            }
        }
        .insetGroupedListCompat()
        #if os(iOS)
        // Always in edit mode: the screen exists to be reordered, so its rows
        // wear their grip from the start instead of hiding it behind Edit.
        // Nothing here deletes, so the grip is all edit mode adds.
        .environment(\.editMode, .constant(.active))
        #endif
        .navigationTitle("Repo order")
        .task { await load() }
    }

    private func move(from source: IndexSet, to destination: Int) {
        order.move(fromOffsets: source, toOffset: destination)
        save()
    }

    private func load() async {
        order = Self.ordered(ids: repos.map(\.id), preferredJSON: repoOrderJSON)
        do {
            let fetched = try await OS1API.repos()
            repos = fetched
            SettingsCache.save("repos", fetched)
            order = Self.ordered(ids: fetched.map(\.id), preferredJSON: repoOrderJSON)
            error = nil
        } catch {
            if repos.isEmpty { self.error = error.localizedDescription }
        }
    }

    private func save() {
        guard let data = try? JSONEncoder().encode(order),
              let json = String(data: data, encoding: .utf8)
        else { return }
        // The list reads the mirror, not this screen, so move it now — the
        // request only confirms it.
        repoOrderJSON = json
        let requestContext = NativePreferences.context()
        Task {
            do {
                let response = try await SettingsAPI.updateUiPrefs(
                    user: requestContext.user,
                    prefs: ["repo-order": json]
                )
                var confirmed = response
                if confirmed["repo-order"] == nil { confirmed["repo-order"] = json }
                _ = NativePreferences.apply(confirmed, for: requestContext)
                error = nil
            } catch {
                self.error = error.localizedDescription
            }
        }
    }
}

/// How sessions report their work. This is server-backed so the same choice
/// applies when the person starts a session from another client.
struct PersonalOutputStyleSection: View {
    @State private var style: String
    @State private var savedStyle: String
    @State private var loading: Bool
    @State private var saving = false
    @State private var error: String?

    private let user = ServerConfig.shared.userName

    init() {
        let cached: String? = SettingsCache.value("personal-output-style")
        let initial = cached == "concise" ? "concise" : "default"
        _style = State(initialValue: initial)
        _savedStyle = State(initialValue: initial)
        _loading = State(initialValue: cached == nil)
    }

    var body: some View {
        Section {
            Picker("Output style", selection: $style) {
                Text("Default").tag("default")
                Text("Concise").tag("concise")
            }
            .disabled(loading || saving)
            if let error {
                Text(error).foregroundStyle(.red)
            }
        } footer: {
            Text("Concise leads with the result and skips preamble and narration without reducing the work.")
        }
        .task { await load() }
        .onChange(of: style) { _, next in save(next) }
    }

    private func save(_ next: String) {
        guard !loading, next != savedStyle else { return }
        let previous = savedStyle
        savedStyle = next
        saving = true
        SettingsCache.save("personal-output-style", next)
        Task {
            do {
                let result = try await SettingsAPI.setPersonalOutputStyle(
                    user: user,
                    outputStyle: next
                )
                style = result
                savedStyle = result
                SettingsCache.save("personal-output-style", result)
                error = nil
            } catch {
                style = previous
                savedStyle = previous
                SettingsCache.save("personal-output-style", previous)
                self.error = error.localizedDescription
            }
            saving = false
        }
    }

    private func load() async {
        let startingStyle = style
        do {
            let result = try await SettingsAPI.personalOutputStyle(user: user)
            if style == startingStyle, savedStyle == startingStyle {
                style = result
                savedStyle = result
                SettingsCache.save("personal-output-style", result)
            }
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
        loading = false
    }
}

/// The standing prompt, shown inside Preferences. There is no Save button: it
/// commits when the box loses focus and again when the screen goes away, so
/// leaving keeps your edit, matching the web.
struct PersonalPromptSection: View {
    @State private var prompt: String
    @State private var savedPrompt: String
    @State private var loading: Bool
    @State private var error: String?
    @FocusState private var editing: Bool

    private let user = ServerConfig.shared.userName

    /// Opens on the last prompt this device fetched, so the box holds text
    /// immediately instead of a spinner. `savedPrompt` starts at the same
    /// value, so a screen that is only looked at never sends anything.
    init() {
        let cached: String? = SettingsCache.value("personal-prompt")
        _prompt = State(initialValue: cached ?? "")
        _savedPrompt = State(initialValue: cached ?? "")
        _loading = State(initialValue: cached == nil)
    }

    var body: some View {
        Section {
            if loading {
                ProgressView()
            } else if let error {
                Text(error).foregroundStyle(.red)
                Button("Try again") { Task { await load() } }
            } else {
                TextEditor(text: $prompt)
                    .frame(minHeight: 140)
                    .focused($editing)
            }
        } header: {
            Text("Personal prompt")
        } footer: {
            Text("Add standing instructions to every session you start. Leave this empty to turn them off.")
        }
        .task { await load() }
        .onChange(of: editing) { _, focused in if !focused { commit() } }
        .onDisappear { commit() }
    }

    /// Fire-and-forget — by the time this runs the view may already be gone,
    /// so there is nothing to report a result to. `savedPrompt` moves first so
    /// a blur followed by a disappear doesn't send the same body twice.
    private func commit() {
        guard !loading, prompt != savedPrompt else { return }
        let pending = prompt
        savedPrompt = pending
        SettingsCache.save("personal-prompt", pending)
        Task { _ = try? await SettingsAPI.setPersonalPrompt(user: user, prompt: pending) }
    }

    private func load() async {
        error = nil
        do {
            let result = try await SettingsAPI.personalPrompt(user: user)
            // An edit made while this was in flight wins — the cached text it
            // was typed over is what `savedPrompt` still holds, so `commit()`
            // sends it when the box loses focus.
            if prompt == savedPrompt { prompt = result }
            savedPrompt = result
            SettingsCache.save("personal-prompt", result)
        } catch {
            self.error = error.localizedDescription
        }
        loading = false
    }
}

/// Where "Start an Agent" is explained and handed over to the system.
///
/// It needs no setup — an `AppShortcutsProvider` registers it the moment the
/// app is installed (see `AgentShortcuts`), and the widgets ship with it — but
/// nothing in the app ever SAYS that, and the steps that are a person's to
/// take (placing a widget, binding the Action Button, which only iOS Settings
/// can do) happen outside Open Session entirely. So this page is mostly signposting:
/// what the shortcut does, where its widgets live, a `ShortcutsLink` into the
/// Shortcuts app, and the paths Apple gives no deep link for.
struct ShortcutsSettingsView: View {
    var body: some View {
        Form {
            Section {
                shortcut(
                    icon: "mic",
                    title: "Start an Agent",
                    detail: """
                    Opens the composer with the mic listening, so you can speak \
                    the idea and still change repo, mode or model before sending.
                    """
                )
            } footer: {
                // No section header: the navigation title above already says
                // "Shortcuts", and repeating it just pushed the first row down.
                Text("Installed with the app. Ask Siri for it by name, or find it under \(AppBrand.appName) in Shortcuts.")
            }

            #if os(iOS)
            Section {
                shortcut(
                    icon: "square.grid.2x2",
                    title: "Home Screen and Lock Screen",
                    detail: """
                    Add the \(AppBrand.appName) widget and the whole tile \
                    becomes the same press.
                    """
                )
                shortcut(
                    icon: "switch.2",
                    title: "Control Centre",
                    detail: """
                    Swipe down, +, Add a Control, then \(AppBrand.appName). \
                    The Action Button's picker lists it under Controls too.
                    """
                )
            } header: {
                Text("Widgets")
            } footer: {
                Text("The widgets run the same shortcut, so they open the composer with the mic listening. They show no session data and work offline.")
            }
            #endif

            Section {
                #if os(iOS)
                // The system's own button into the Shortcuts app, opened on
                // this app's shortcuts. macOS has no such view, so it gets an
                // ordinary button on the Shortcuts app's URL scheme.
                ShortcutsLink()
                    .shortcutsLinkStyle(.automaticOutline)
                    .frame(maxWidth: .infinity, alignment: .center)
                    .listRowBackground(Color.clear)
                #else
                Button("Open Shortcuts") {
                    if let url = URL(string: "shortcuts://") {
                        NSWorkspace.shared.open(url)
                    }
                }
                #endif
            } footer: {
                #if os(iOS)
                Text("To put it on the Action Button: iPhone Settings → Action Button → swipe to Shortcut → Choose a Shortcut → \(AppBrand.appName) → Start an Agent.")
                #else
                Text("Run it from Spotlight, or say it to Siri.")
                #endif
            }
        }
        .navigationTitle("Shortcuts")
        #if os(iOS)
        .scrollContentBackground(.hidden)
        .background(OS1VisualStyle.background)
        #else
        .formStyle(.grouped)
        #endif
    }

    private func shortcut(icon: String, title: String, detail: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: icon)
                .font(.system(size: 15, weight: .medium))
                .foregroundStyle(OS1VisualStyle.accentInk)
                .frame(width: 26, height: 26)
                .background(OS1VisualStyle.hover, in: Circle())
                // Optically centred on the title's cap height rather than the
                // text block, which the multi-line detail below would drag down.
                .padding(.top, 1)
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                Text(detail)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
    }
}

/// Settings → Personal → Account: every per-user sign-in in one place.
///
/// The web has had this page since per-user grants landed; the native app
/// shipped without it, so a phone could see which tools the workspace was
/// wired into but not connect its own account to any of them. Same two halves
/// as the web (src/frontend/components/MyAccounts.tsx): OAuth-capable MCP
/// servers, and the per-user GitHub auth that opens PRs under your own name.
///
/// A row states what the tool is authenticated as and nothing more — the
/// sentence about what connecting changes is identical on every unconnected
/// row, so it lives once in the section footer.
struct MyAccountsSettingsView: View {
    @State private var connections: ConnectionsResponse? = SettingsCache.value("connections")
    @State private var oauth: [String: MCPOauthStatus] = [:]
    @State private var github: GitHubConnectionStatus? = SettingsCache.value("github-connection")
    @State private var loading = true
    @State private var error: String?
    @State private var busyServer: String?
    @State private var disconnecting: String?
    @State private var githubFlow: GitHubDeviceFlow?
    @State private var githubTask: Task<Void, Never>?
    @State private var pollTask: Task<Void, Never>?
    #if os(iOS)
    @State private var consent: SafariLink?
    #endif
    @Environment(\.openURL) private var openURL

    var body: some View {
        List {
            if loading, connections == nil {
                HStack { Spacer(); ProgressView("Loading…"); Spacer() }
            }
            if let error {
                VStack(alignment: .leading, spacing: 8) {
                    Text(error).foregroundStyle(.red)
                    Button("Retry") { Task { await load() } }
                }
            }

            Section {
                if oauthServers.isEmpty, !loading {
                    Text("No OAuth-capable MCP servers yet.").foregroundStyle(.secondary)
                }
                ForEach(oauthServers, id: \.id) { server in
                    accountRow(server)
                }
            } header: {
                Text("MCP accounts · tools as yourself")
            } footer: {
                Text("Connect one and your sessions use your own account for that tool. Anything you leave unconnected keeps running on the workspace credential.")
            }

            Section {
                githubRows
            } header: {
                Text("GitHub · PRs as yourself")
            } footer: {
                Text("Interactive sessions of a connected teammate open PRs as their own GitHub account. Everyone else, and every automation, keeps the bot.")
            }
        }
        .insetGroupedListCompat()
        .navigationTitle("Account")
        .task { await load() }
        .refreshable { await load() }
        .onDisappear { pollTask?.cancel(); githubTask?.cancel() }
        #if os(iOS)
        // The provider's consent page opens over the app: coming back is a
        // swipe, and the poll below flips the row the moment the grant lands.
        .sheet(item: $consent) { link in SafariSheet(url: link.url) }
        #endif
        .sheet(isPresented: Binding(
            get: { githubFlow != nil },
            set: { if !$0 { cancelGitHubConnect() } }
        )) {
            if let githubFlow {
                GitHubConnectionFlowView(flow: githubFlow, onCancel: cancelGitHubConnect)
            }
        }
    }

    // MARK: - Rows

    private func accountRow(_ server: MCPConnection) -> some View {
        let name = server.name ?? ""
        let status = oauth[name]
        let mine = isMine(status)
        return HStack(spacing: 12) {
            BrandTile(name: name, size: 30)
            VStack(alignment: .leading, spacing: 2) {
                Text(Brand.displayName(name))
                Text(statusText(status, mine: mine))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
            if busyServer == name {
                ProgressView()
            } else if mine {
                Button("Disconnect") { disconnecting = name }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .confirmationDialog(
                        "Disconnect \(Brand.displayName(name))?",
                        isPresented: Binding(
                            get: { disconnecting == name },
                            set: { if !$0, disconnecting == name { disconnecting = nil } }
                        ),
                        titleVisibility: .visible
                    ) {
                        Button("Disconnect", role: .destructive) { Task { await disconnect(name) } }
                        Button("Cancel", role: .cancel) { disconnecting = nil }
                    } message: {
                        Text("Your sessions go back to the workspace credential for \(Brand.displayName(name)).")
                    }
            } else {
                Button("Connect") { Task { await connect(name) } }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
            }
        }
        .padding(.vertical, 2)
    }

    @ViewBuilder private var githubRows: some View {
        if github?.enabled == true {
            if let account = myGitHubAccount {
                HStack(spacing: 12) {
                    BrandTile(name: "github", size: 30)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("@\(account.login ?? "")")
                        // A grant GitHub has since revoked is not a working
                        // connection, and saying "Connected as you" for one
                        // hides the only thing that fixes it.
                        if account.needsReconnect == true {
                            Text("Reconnect needed").font(.footnote).foregroundStyle(.red)
                        } else {
                            Text("Connected as you").font(.footnote).foregroundStyle(.secondary)
                        }
                    }
                    Spacer(minLength: 8)
                    Button("Disconnect") { Task { await disconnectGitHub(account) } }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                }
                .padding(.vertical, 2)
            } else {
                Button { Task { await connectGitHub() } } label: {
                    Label("Connect GitHub account", systemImage: "person.badge.key")
                }
            }
        } else {
			Text("Personal GitHub sign-in is off for this workspace. Sessions open PRs as the bot.")
                .foregroundStyle(.secondary)
        }
    }

    // MARK: - Identity

    /// Who "you" are to the server — BOTH names, because a grant is stored
    /// under whichever one made it: the server keys MCP grants by display name
    /// ("Michiel") while GitHub accounts are the login ("happylinks"). Matching
    /// only the login left every one of this account's own grants reading as
    /// "Using the workspace key". Prefix-matched like the web's `isMe`, since a
    /// grant may carry a first name against a full one.
    private var myNames: [String] {
        [ServerConfig.shared.githubLogin, ServerConfig.shared.userName]
            .map { $0.trimmingCharacters(in: .whitespaces).lowercased() }
            .filter { !$0.isEmpty }
    }

    private func isMine(_ status: MCPOauthStatus?) -> Bool {
        guard let users = status?.users else { return false }
        let names = myNames
        guard !names.isEmpty else { return false }
        return users.contains { user in
            let other = user.lowercased()
            return names.contains { $0 == other || other.hasPrefix($0) || $0.hasPrefix(other) }
        }
    }

    private var myGitHubAccount: GitHubConnectedAccount? {
        // The login only: a GitHub account row IS a login, so a loose match
        // here would claim a teammate's account.
        let login = ServerConfig.shared.githubLogin.lowercased()
        guard !login.isEmpty else { return nil }
        return (github?.accounts ?? []).first { ($0.login ?? "").lowercased() == login }
    }

    private func statusText(_ status: MCPOauthStatus?, mine: Bool) -> String {
        if mine { return "Connected as you" }
        if status?.shared != nil { return "Using the workspace account" }
        if status?.capable == true { return "Using the workspace key" }
        return "Not connected"
    }

    /// The servers this page is about: anything that can hold a per-user grant,
    /// or already holds one.
    private var oauthServers: [MCPConnection] {
        (connections?.mcpServers ?? []).filter { server in
            guard let name = server.name, !name.isEmpty else { return false }
            let status = oauth[name]
            return server.status == "needs-auth"
                || status?.capable == true
                || status?.shared != nil
                || !(status?.users ?? []).isEmpty
        }
    }

    // MARK: - Loading and actions

    private func load() async {
        loading = true
        error = nil
        do {
            async let connectionsCall = SettingsAPI.connections()
            async let githubCall = SettingsAPI.githubConnection()
            let (loaded, gh) = try await (connectionsCall, githubCall)
            connections = loaded
            github = gh
            SettingsCache.save("connections", loaded)
            SettingsCache.save("github-connection", gh)
            await loadOauth()
        } catch {
            self.error = error.localizedDescription
        }
        loading = false
    }

    /// One status call per server. They are independent, and a server that
    /// cannot answer should leave the others' rows alone rather than fail the
    /// page — hence the per-name catch.
    private func loadOauth() async {
        let names = (connections?.mcpServers ?? []).compactMap { $0.name }.filter { !$0.isEmpty }
        var next: [String: MCPOauthStatus] = [:]
        for name in names {
            if let status = try? await SettingsAPI.mcpOauth(name: name) { next[name] = status }
        }
        oauth = next
    }

    private func connect(_ name: String) async {
        busyServer = name
        defer { busyServer = nil }
        do {
            let started = try await SettingsAPI.startMcpOauth(name: name)
            guard let raw = started.url, let url = URL(string: raw) else {
                error = "The server did not return a consent URL."
                return
            }
            #if os(iOS)
            if SafariLink.isWeb(url) { consent = SafariLink(url: url) } else { openURL(url) }
            #else
            openURL(url)
            #endif
            pollForGrant(name)
        } catch {
            self.error = error.localizedDescription
        }
    }

    /// The grant lands on the SERVER when the provider redirects back, so the
    /// app learns about it by asking — two minutes of polling covers a consent
    /// screen with a login in it, and pulling to refresh covers the rest.
    private func pollForGrant(_ name: String) {
        pollTask?.cancel()
        pollTask = Task {
            for _ in 0..<24 {
                try? await Task.sleep(for: .seconds(5))
                if Task.isCancelled { return }
                guard let status = try? await SettingsAPI.mcpOauth(name: name) else { continue }
                oauth[name] = status
                if isMine(status) {
                    #if os(iOS)
                    consent = nil
                    #endif
                    return
                }
            }
        }
    }

    private func disconnect(_ name: String) async {
        disconnecting = nil
        busyServer = name
        defer { busyServer = nil }
        do {
            _ = try await SettingsAPI.disconnectMcpOauth(name: name)
            if let status = try? await SettingsAPI.mcpOauth(name: name) { oauth[name] = status }
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func disconnectGitHub(_ account: GitHubConnectedAccount) async {
        guard let login = account.login else { return }
        do {
            _ = try await SettingsAPI.disconnectGitHub(login: login)
            github = try await SettingsAPI.githubConnection()
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func connectGitHub() async {
        do {
            let started = try await SettingsAPI.startGitHubDeviceFlow()
            githubFlow = started
            githubTask?.cancel()
            githubTask = Task {
                var interval = max(started.interval ?? 5, 1)
                while !Task.isCancelled, let code = started.deviceCode {
                    try? await Task.sleep(for: .seconds(interval))
                    if Task.isCancelled { return }
                    do {
                        let result = try await SettingsAPI.pollGitHubDeviceFlow(deviceCode: code)
                        if result.status == "ok" {
                            githubFlow = nil
                            github = try? await SettingsAPI.githubConnection()
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

    private func cancelGitHubConnect() {
        githubTask?.cancel()
        githubTask = nil
        githubFlow = nil
    }
}
