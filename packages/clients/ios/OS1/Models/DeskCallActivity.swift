import Foundation

/// What a Desk voice call is doing, as the Live Activity shows it. The widget
/// extension does not compile `DeskVoiceEngine`, so this is its own small
/// vocabulary rather than `DeskVoiceState`.
enum DeskCallPhase: String, Codable, Hashable, Sendable {
    case connecting
    case listening
    case thinking
    case speaking
    case working
    case failed

    var label: String {
        switch self {
        case .connecting: "Connecting…"
        case .listening: "Listening"
        case .thinking: "Thinking…"
        case .speaking: "Speaking"
        case .working: "Working…"
        case .failed: "Call ended"
        }
    }
}

/// The URL the call's Live Activity opens when tapped: the app comes forward
/// on the full-screen call. It rides the app's own `os1-native` scheme.
enum DeskCallLink {
    static let url = URL(string: "os1-native://desk-call")!

    static func matches(_ url: URL) -> Bool {
        url.scheme?.lowercased() == "os1-native" && url.host?.lowercased() == "desk-call"
    }
}

#if os(iOS)
import ActivityKit

/// A running Desk voice call, in the Dynamic Island and on the Lock Screen.
/// Started and updated locally by the app (`DeskCallActivityController`),
/// never by push.
struct DeskCallAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable, Sendable {
        var phase: DeskCallPhase
        var muted: Bool
    }

    let title: String
    let startedAt: Date
}
#endif
