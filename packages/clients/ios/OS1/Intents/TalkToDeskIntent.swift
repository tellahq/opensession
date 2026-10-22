import AppIntents

/// "Talk to Desk": one press, and you are in a live voice call with the Desk.
///
/// Meant for the iPhone's Action Button (Settings > Action Button > Shortcut >
/// Talk to Desk), next to `StartAgentIntent`. That one opens the composer with
/// dictation for an idea you want to read before it runs; this one is for
/// talking it through. Running it is the opt-in, so it does not need the Desk
/// voice preference to be on.
///
/// On iOS it runs in the BACKGROUND: the press leaves you where you were and
/// the call lives in the Dynamic Island and on the Lock Screen
/// (`DeskCallLiveActivity`). `AudioRecordingIntent` is what lets a background
/// app open the mic, and the system holds it to one rule: a Live Activity is
/// up for as long as the call is. When the call cannot start from the
/// background (the app is already open, the mic was never allowed, Live
/// Activities are off), the app comes forward on the Desk instead.
struct TalkToDeskIntent: AppIntent {
    static let title: LocalizedStringResource = "Talk to Desk"

    /// No Apple product names here ("iPhone", "Siri"…): App Store processing
    /// rejects a build whose intent metadata contains one (ITMS-90626).
    static let description = IntentDescription(
        "Starts a live voice call with your Desk that keeps running while you use other apps.",
        categoryName: "Sessions",
        searchKeywords: ["desk", "voice", "call", "talk", "assistant"]
    )

    #if os(iOS)
    static let supportedModes: IntentModes = [.background, .foreground(.dynamic)]
    #else
    static let supportedModes: IntentModes = .foreground
    #endif

    /// The Desk can do real work on your behalf; a locked phone in someone
    /// else's hand must not be able to talk to it.
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

    @MainActor
    func perform() async throws -> some IntentResult {
        if let start = DeskCallHooks.start {
            try await start(self)
        } else {
            DeskCallRequest.shared.ask()
        }
        return .result()
    }
}

#if os(iOS)
extension TalkToDeskIntent: AudioRecordingIntent {}

/// The Live Activity's mute button. It runs in the app, where the call is.
struct DeskCallMuteIntent: LiveActivityIntent {
    static let title: LocalizedStringResource = "Mute the Desk Call"
    static let isDiscoverable = false

    @MainActor
    func perform() async throws -> some IntentResult {
        DeskCallHooks.toggleMute?()
        return .result()
    }
}

/// The Live Activity's hang-up button.
struct DeskCallHangUpIntent: LiveActivityIntent {
    static let title: LocalizedStringResource = "End the Desk Call"
    static let isDiscoverable = false

    @MainActor
    func perform() async throws -> some IntentResult {
        DeskCallHooks.hangUp?()
        return .result()
    }
}
#endif

/// Where the app plugs the call into these intents. This file is also
/// compiled into the widget extension, which has no voice engine, so the
/// intents call through here and the app fills it in at launch
/// (`DeskCallActivityController.install()`). Left empty, "Talk to Desk" falls
/// back to opening the Desk in the app.
@MainActor
enum DeskCallHooks {
    static var start: (@MainActor (TalkToDeskIntent) async throws -> Void)?
    static var toggleMute: (@MainActor () -> Void)?
    static var hangUp: (@MainActor () -> Void)?
}

/// The hand-off between the intent and the Desk sheet, for calls that open
/// in the app. The intent can run before any view exists (cold launch), so
/// the request is parked here. The sessions list opens the Desk sheet when it
/// sees one, and the sheet takes it and shows the call, starting it unless
/// one is already running.
@MainActor
@Observable
final class DeskCallRequest {
    static let shared = DeskCallRequest()

    struct Request: Identifiable {
        let id = UUID()
    }

    private(set) var request: Request?

    func ask() {
        request = Request()
    }

    /// Read once and clear, so reopening the Desk later does not call again.
    func take() -> Request? {
        defer { request = nil }
        return request
    }
}
