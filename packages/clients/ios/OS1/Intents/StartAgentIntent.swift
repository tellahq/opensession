import AppIntents

/// "Start an Agent" — one press, and the composer is open with the mic
/// listening.
///
/// This exists for the iPhone's Action Button (Settings > Action Button >
/// Shortcut > Start an Agent): hold it, speak the idea, send. It deliberately
/// OPENS the app (`openAppWhenRun = true`) rather than collecting the idea in
/// the system's plain text dialog and firing a session off in the background —
/// dictation mishears, and an idea usually wants a glance at which repo and
/// model it's about to run on. Our composer already has all of that; the
/// Action Button just gets you there in one press instead of app → list → +.
struct StartAgentIntent: AppIntent {
    static let title: LocalizedStringResource = "Start an Agent"

    static let description = IntentDescription(
        "Opens the composer with the mic already listening, so you can speak an idea and start a session on it.",
        categoryName: "Sessions",
        searchKeywords: ["session", "agent", "idea", "dictate", "voice", "prompt"]
    )

    /// The point: the app comes forward and the composer is the first thing
    /// you see.
    static let openAppWhenRun = true

    @MainActor
    func perform() async throws -> some IntentResult {
        QuickCapture.shared.ask(dictate: true)
        return .result()
    }
}

/// The hand-off between the intent and the sessions list. The intent can run
/// before any view exists (cold launch), so the request is PARKED here rather
/// than posted — the list picks it up whenever it appears.
@MainActor
@Observable
final class QuickCapture {
    static let shared = QuickCapture()

    struct Request: Identifiable {
        let id = UUID()
        var dictate: Bool
    }

    private(set) var request: Request?

    func ask(dictate: Bool) {
        request = Request(dictate: dictate)
    }

    /// Read once and clear: reopening the sheet on every later appearance
    /// would trap you in the composer.
    func take() -> Request? {
        defer { request = nil }
        return request
    }
}

/// Makes the intent show up without any setup: in Spotlight, in the Action
/// Button's shortcut picker, and as a Siri phrase.
struct AgentShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: StartAgentIntent(),
            phrases: [
                "Start an agent in \(.applicationName)",
                "New \(.applicationName) session",
                "New idea in \(.applicationName)",
            ],
            shortTitle: "Start an Agent",
            systemImageName: "mic"
        )
        AppShortcut(
            intent: TalkToDeskIntent(),
            phrases: [
                "Talk to Desk in \(.applicationName)",
                "Call my \(.applicationName) Desk",
            ],
            shortTitle: "Talk to Desk",
            systemImageName: "waveform"
        )
    }
}
