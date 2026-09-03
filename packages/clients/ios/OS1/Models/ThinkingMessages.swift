import Foundation

/// How much provider reasoning stays in the visible transcript. The durable
/// transcript is never changed; this only filters the grouped display blocks.
enum ThinkingMessages: String {
    case none
    case latest
    case all

    static let standard = ThinkingMessages.latest
    static let storageKey = "os1.transcript.thinkingMessages"
    static let prefKey = "thinking-messages"

    init(_ rawValue: String?) {
        self = ThinkingMessages(rawValue: rawValue ?? "") ?? .standard
    }

    func visibleBlocks(_ blocks: [TranscriptBlock]) -> [TranscriptBlock] {
        guard self != .all else { return blocks }
        let latestId = self == .latest ? Self.latestReasoningId(in: blocks) : nil
        return Self.filter(blocks, latestId: latestId)
    }

    private static func latestReasoningId(in blocks: [TranscriptBlock]) -> String? {
        var latestId: String?
        for block in blocks {
            switch block {
            case .message(let entry):
                if entry.isReasoning == true { latestId = entry.id }
            case .work(let turn):
                for item in turn.items {
                    if case .message(let entry) = item, entry.isReasoning == true {
                        latestId = entry.id
                    }
                }
            case .reviewLoop(let loop):
                latestId = latestReasoningId(in: loop.blocks) ?? latestId
            case .tool, .footer, .walkthrough, .note:
                break
            }
        }
        return latestId
    }

    private static func filter(
        _ blocks: [TranscriptBlock],
        latestId: String?
    ) -> [TranscriptBlock] {
        blocks.compactMap { block in
            switch block {
            case .message(let entry) where entry.isReasoning == true:
                return entry.id == latestId ? block : nil
            case .work(var turn):
                turn.items.removeAll { item in
                    guard case .message(let entry) = item,
                          entry.isReasoning == true
                    else { return false }
                    return entry.id != latestId
                }
                guard let first = turn.items.first, let last = turn.items.last else {
                    return nil
                }
                turn.id = first.id
                turn.anchorId = last.id
                turn.hasNarration = turn.items.contains {
                    if case .message = $0 { return true }
                    return false
                }
                return .work(turn)
            case .reviewLoop(var loop):
                loop.blocks = filter(loop.blocks, latestId: latestId)
                return .reviewLoop(loop)
            case .message, .tool, .footer, .walkthrough, .note:
                return block
            }
        }
    }
}
