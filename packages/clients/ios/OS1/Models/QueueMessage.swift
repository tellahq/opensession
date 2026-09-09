import Foundation

/// How a queue chip should present a message that isn't necessarily something
/// the person typed.
///
/// The prompt queue carries agent-to-agent deliveries too — worker reports,
/// workflow nudges, GitHub review feedback, a teammate's answer routed back in —
/// and each is marked with an HTML-comment sentinel and/or an `[attribution]`
/// prefix. The transcript's markdown renderer swallows those; a plain-text
/// chip shows them raw, so a queued worker report used to read as a literal
/// `<!--os:worker-report-->` line. Mirrors the web's
/// `src/frontend/lib/humanReply.ts`, trimmed to what a two-line chip needs.
struct QueueMessagePresentation: Equatable {
    /// Short "who or what this is" tag; nil for an ordinary typed message.
    let label: String?
    /// The message with its delivery sentinels (and the routing prefix that
    /// comes with them) removed. A typed message is passed through untouched.
    let body: String
    /// GitHub deliveries are informational — there's nothing to steer,
    /// edit, or reorder about them, so the chip only offers a dismiss.
    let isGitHub: Bool
    /// A review handoff is automated work waiting behind the current turn.
    let isReviewHandoff: Bool
    /// A peer session's agent-authored coordination message, not human prose.
    let isSessionMessage: Bool
    /// The paste riding beside the text, named: "Pasted text +60 lines" for
    /// one, "2 pasted texts" for several, nil for none. Mirrors the web's
    /// queue row, so a queued paste reads as attached rather than lost.
    let pastedLabel: String?

    init(content: String, user: String?, pastedTexts: [String] = []) {
        pastedLabel = Self.pastedTextLabel(pastedTexts)
        isGitHub = user == "GitHub" || user == "GitHub (automation)"
        isReviewHandoff = isGitHub && Self.reviewHandoffSentinel.match(content) != nil
        let agentPrefixed = Self.agentAttribution.match(content)
        let routingStripped = agentPrefixed?.rest
            ?? Self.attributionPrefix.match(content)?.rest
            ?? content
        let legacyWorkerFailure = Self.legacyWorkerFailure.match(content)
        isSessionMessage = Self.agentActor.match(user ?? "") != nil
            || agentPrefixed != nil
            || Self.sessionNoticeSentinel.match(routingStripped) != nil

        // Every marker starts the message, so a couple of prefix tests settle
        // the ordinary case without touching a regex. This runs for each
        // visible chip on every composer keystroke.
        if !isGitHub, !isSessionMessage, legacyWorkerFailure == nil,
           !Self.mayCarryMarker(content) {
            label = nil
            body = content
            return
        }

        // A teammate's answer to a human-in-the-loop ask. Checked first: it
        // carries its own attribution prefix, which the generic strip below
        // would eat along with the name the chip wants to credit.
        if let match = Self.humanReply.match(content) {
            label = match.groups.first ?? "Teammate"
            body = Self.humanReplyHeader.stripPrefix(from: content)
            return
        }

        if let worker = Self.workerAttribution.match(content) {
            label = "Worker report"
            body = Self.stripLeadingSentinels(worker.rest)
            return
        }

        if let legacyWorkerFailure {
            label = "Worker report"
            body = legacyWorkerFailure.rest
            return
        }

        // The routing prefix a named teammate's message carries. Stripped only
        // when a sentinel or machine actor proves this is a delivery rather
        // than something typed. An ordinary prompt may open with "[WIP] …".
        let unprefixed = routingStripped
        if Self.workerSentinel.match(unprefixed) != nil {
            label = "Worker report"
        } else if Self.workflowSentinel.match(unprefixed) != nil {
            label = "Workflow"
        } else if isSessionMessage {
            label = "Message from another session"
        } else if isReviewHandoff {
            label = nil
            let clean = Self.stripLeadingSentinels(content)
            if let number = Self.reviewPRNumber.match(clean)?.groups.first {
                body = "PR #\(number) review feedback · Runs after this turn"
            } else {
                body = "PR review feedback · Runs after this turn"
            }
            return
        } else if isGitHub {
            label = "GitHub"
            body = Self.stripLeadingSentinels(content)
            return
        } else {
            label = nil
            body = content
            return
        }
        body = Self.stripLeadingSentinels(unprefixed)
    }

    /// What the queue row says about a message's pastes. One paste is named
    /// by its size; several are counted, since a row has no room to size each.
    static func pastedTextLabel(_ pastedTexts: [String]) -> String? {
        switch pastedTexts.count {
        case 0: nil
        case 1: "Pasted text \(lineLabel(pastedTexts[0]))"
        default: "\(pastedTexts.count) pasted texts"
        }
    }

    /// "+N lines", the way the transcript's paste card and the web's chip
    /// count them (`pastedTextLineLabel`): line breaks plus one, so an empty
    /// paste is still one line and a trailing newline still counts.
    static func lineLabel(_ text: String) -> String {
        // A Swift Character is a grapheme cluster, so "\r\n" is ONE newline
        // here just as it is one separator in the web's regex.
        let lines = text.split(omittingEmptySubsequences: false, whereSeparator: \.isNewline).count
        return "+\(lines) \(lines == 1 ? "line" : "lines")"
    }

    private static func mayCarryMarker(_ content: String) -> Bool {
        let head = content.drop(while: \.isWhitespace)
        return head.hasPrefix("[") || head.hasPrefix("<!--")
            || head.hasPrefix("💬") || head.hasPrefix(":speech_balloon:")
    }

    private static func stripLeadingSentinels(_ text: String) -> String {
        // Notices stack: a worker whose whole job was a workflow reports back
        // with the workflow nudge as its body, so both sentinels are present.
        var out = text
        while let match = leadingSentinel.match(out) { out = match.rest }
        return out.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    // MARK: - Patterns (kept in sync with src/frontend/lib/humanReply.ts)

    private static let humanReplyHead =
        "(?:\\[[^\\]]+\\]\\s*)?(?:💬|:speech_balloon:)\\s*\\*{0,2}\\s*(.+?)"
        + "\\s*\\*{0,2}\\s+(?:answered|replied)\\b"
    private static let humanReply = Pattern("^" + humanReplyHead)
    private static let humanReplyHeader = Pattern("^" + humanReplyHead + "[^\\n]*\\n+")
    /// Deliberately strict (single line, brace-free, ≤40 chars) so an ordinary
    /// prompt opening with "[WIP] …" isn't mistaken for an attribution.
    private static let attributionPrefix = Pattern("^\\[([^\\]\\n{}]{1,40})\\]\\s+")
    private static let workerAttribution = Pattern("^\\[worker\\s+([^\\]\\s]+)\\]\\s*")
    private static let agentAttribution =
        Pattern("^\\[agent\\s+((?:os|bks)-[a-z0-9-]+)\\]\\s*")
    private static let agentActor = Pattern("^agent\\s+(?:os|bks)-[a-z0-9-]+$")
    private static let workerSentinel =
        Pattern("^<!--os:worker-report(?::[^\\s>]+)?-->\\s*")
    private static let legacyWorkerFailure = Pattern(
        "^Server notice:\\s+(?=worker task `(?:os|bks)-[a-z0-9-]+` ended in error without reporting back\\.)"
    )
    private static let workflowSentinel =
        Pattern("^<!--os:workflow-notice(?::[^\\s>]+)?-->\\s*")
    private static let sessionNoticeSentinel = Pattern("^<!--os:session-notice-->\\s*")
    private static let reviewHandoffSentinel = Pattern("^<!--os:review-handoff-->\\s*")
    private static let reviewPRNumber = Pattern("\\bPR #(\\d+)")
    private static let leadingSentinel =
        Pattern("^\\s*<!--os:[a-z-]+(?::[^\\s>]+)?-->\\s*")

    /// Thin NSRegularExpression wrapper: the matched groups plus what follows
    /// the match, which is all any caller here wants.
    private struct Pattern {
        struct Match {
            let groups: [String]
            let rest: String
        }

        private let regex: NSRegularExpression

        init(_ pattern: String) {
            regex = try! NSRegularExpression(pattern: pattern)
        }

        func match(_ text: String) -> Match? {
            let range = NSRange(text.startIndex..., in: text)
            guard let found = regex.firstMatch(in: text, range: range),
                  let whole = Range(found.range, in: text)
            else { return nil }
            let groups = (1..<found.numberOfRanges).compactMap { index -> String? in
                guard let range = Range(found.range(at: index), in: text) else {
                    return nil
                }
                return String(text[range])
            }
            return Match(groups: groups, rest: String(text[whole.upperBound...]))
        }

        /// The text with a leading match removed (unchanged when it doesn't match).
        func stripPrefix(from text: String) -> String {
            (match(text)?.rest ?? text)
                .trimmingCharacters(in: .whitespacesAndNewlines)
        }
    }
}
