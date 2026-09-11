import Foundation
import Observation
import SwiftUI

/// The session's side of a ```choices block. A chip inside a markdown body
/// is several layers below the composer, so the block reaches the session
/// through this object in the environment: `send` puts the chip's text on
/// the composer's own path (isolated from the draft, queued while a run is
/// busy), `fill` drops it into the composer instead, and `openEntryIds` says
/// whose chips are still current (no later user message, see
/// `ChoicesBlock.openEntryIds`). Observable, so a block re-reads only when
/// that set changes rather than on every transcript body.
///
/// Where there is no session to send into (the Mac's read-only surfaces, a
/// sub-agent transcript) the environment carries nil and the chips render
/// quiet: a chip that does nothing must not invite a tap.
@MainActor
@Observable
final class QuickReplyRelay {
    private(set) var openEntryIds: Set<String> = []
    @ObservationIgnored var send: (String) -> Void = { _ in }
    @ObservationIgnored var fill: (String) -> Void = { _ in }

    func update(entries: [TranscriptEntry]) {
        let next = ChoicesBlock.openEntryIds(entries)
        if next != openEntryIds { openEntryIds = next }
    }

    func isOpen(entryId: String?) -> Bool {
        guard let entryId else { return false }
        return openEntryIds.contains(entryId)
    }
}

extension EnvironmentValues {
    /// The relay for the transcript on screen, or nil where chips are quiet.
    @Entry var quickReplyRelay: QuickReplyRelay?
    /// The transcript entry a markdown body belongs to, so a block inside it
    /// can ask whether its quick replies are still current.
    @Entry var transcriptEntryId: String?
}
