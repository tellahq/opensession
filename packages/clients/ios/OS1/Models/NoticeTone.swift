import SwiftUI

/// How loudly an operational line reads: a grey aside, an amber heads-up, or
/// a red failure. One enum for both surfaces that show one — the transcript's
/// notice row and the composer's floating chip — so "run failed" never lands
/// in the same colour as "switched to code mode".
///
/// Durable transcript entries arrive pre-classified (`EntryNotice.tone`, which
/// the server derives in `packages/core/protocol/src/notices.ts`). The live `notice`
/// WebSocket frame is a bare string with no tone, so `derived(fromText:)`
/// mirrors that file's patterns here. Keep the two lists in step: a phrase
/// added there should be added here, and anything unrecognised stays `info` —
/// a miss costs a grey line where an amber one belonged, never a false alarm.
enum NoticeTone: String, Equatable {
    case info, warn, error

    /// Classify a durable entry. `isError` is the server saying so outright;
    /// everything else goes through the same text rules as a live notice.
    static func derived(from entry: TranscriptEntry) -> NoticeTone {
        if entry.isError == true { return .error }
        return derived(fromText: entry.text)
    }

    /// Classify a bare notice string — the live composer chip's only input.
    static func derived(fromText text: String) -> NoticeTone {
        let text = text.lowercased()

        // The anchored phrasings the server classifies by. These come first:
        // they are the exact wording of a known call site, so they beat the
        // loose scan below ("couldn't reach the sandbox" is a warn, even
        // though a bare "could not" reads as a failure).
        for phrase in errorPrefixes where text.hasPrefix(phrase) { return .error }
        if text.contains("no host fallback") { return .error }
        for phrase in warnPrefixes where text.hasPrefix(phrase) { return .warn }

        // Fallback for wording neither side has pinned down yet.
        for marker in ["failed", "failure", "error", "denied", "crashed", "could not"]
        where text.contains(marker) {
            return .error
        }
        for marker in [
            "warning", "interrupted", "timed out", "timeout", "stopped",
            "cancelled", "canceled", "restart", "compacted", "retry",
        ] where text.contains(marker) {
            return .warn
        }
        return .info
    }

    /// The run is over and it did not do what was asked — a human has to act.
    private static let errorPrefixes = [
        "run failed:", "run stopped:", "stopped after", "turn stopped after",
        "frontend rebuild failed",
    ]

    /// Something went sideways, but the work continued.
    private static let warnPrefixes = [
        "sandbox unavailable", "couldn't", "this session's worktree",
        "app update paused", "ci failed on pr #",
    ]

    /// How long a notice earns on the composer before it fades on its own.
    /// An error stays: it is the one kind whose whole point is that somebody
    /// has to read it. A tap dismisses any of them.
    var autoDismissAfter: Duration? {
        switch self {
        case .info: .seconds(5)
        case .warn: .seconds(10)
        case .error: nil
        }
    }

    var color: Color {
        switch self {
        case .info: OS1VisualStyle.textDim
        case .warn: OS1VisualStyle.yellow
        case .error: OS1VisualStyle.red
        }
    }

    var symbol: String? {
        switch self {
        case .info: nil
        case .warn: "exclamationmark.triangle"
        case .error: "exclamationmark.octagon"
        }
    }

    var background: Color {
        switch self {
        case .info: OS1VisualStyle.panel.opacity(0.6)
        case .warn: OS1VisualStyle.yellow.opacity(0.12)
        case .error: OS1VisualStyle.red.opacity(0.12)
        }
    }
}
