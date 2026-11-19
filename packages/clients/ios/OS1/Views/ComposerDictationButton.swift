import SwiftUI

/// The composer's mic, seated immediately left of send: tap to dictate, tap
/// again to stop. What it produces is plain text in the draft — the person
/// still reads it and still presses send.
///
/// Distinct from the Desk's voice call, which is a live conversation with a
/// model and lives behind the Desk header's own control. This is on every
/// session's composer because dictation needs nothing from the server.
///
/// Its own view struct so `SessionInputBar` never reads dictation state: a
/// property read there re-evaluates the whole bar, and this one changes
/// mid-utterance. The `Dictation` object is OWNED by the bar and passed in —
/// held as `@State` here it would be destroyed the moment a long dictation
/// wrapped the composer to two rows and swapped which layout branch renders
/// the button.
struct ComposerDictationButton: View {
    let dictation: Dictation
    @Binding var draft: String
    /// Toolbar items keep the system style so iOS can fold them into the
    /// surrounding Liquid Glass group. Composer buttons stay visually bare.
    var usesSystemButtonStyle = false

    @ScaledMetric(relativeTo: .body) private var glyph: CGFloat = 18

    var body: some View {
        Group {
            if usesSystemButtonStyle {
                dictationButton
            } else {
                dictationButton.buttonStyle(.plain)
            }
        }
        .accessibilityLabel(dictation.active ? "Stop dictating" : "Dictate a message")
        .alert(
            "Can't dictate",
            isPresented: Binding(
                get: { dictationProblem != nil },
                set: { if !$0 { dictation.clearError() } }
            )
        ) {
            Button("OK", role: .cancel) { dictation.clearError() }
        } message: {
            Text(dictationProblem ?? "")
        }
    }

    private var dictationButton: some View {
        Button {
            // The mic is the one control here you keep talking to after you
            // let go of it, so it says when it opened and when it closed —
            // the release deliberately lighter than the arm, so the pair reads
            // as one gesture rather than two taps. Played on the tap, not on
            // `dictation.active`: authorisation and engine start-up sit
            // between the two, and feedback that arrives after a permission
            // sheet isn't feedback for the tap any more.
            if dictation.active {
                Haptics.play(.released)
                dictation.stop()
            } else {
                Haptics.play(.armed)
                let base = draft
                Task { await dictation.start(base: base) { draft = $0 } }
            }
        } label: {
            Image(systemName: dictation.active ? "waveform" : "mic")
                #if os(iOS)
                // Matches the "+": full ink at phone size.
                .font(.system(size: glyph + 3, weight: .regular))
                .foregroundStyle(
                    dictation.active ? OS1VisualStyle.accentInk : OS1VisualStyle.text
                )
                #else
                .font(.system(size: glyph, weight: .medium))
                .foregroundStyle(
                    dictation.active ? OS1VisualStyle.accentInk : OS1VisualStyle.textDim
                )
                #endif
                .symbolEffect(.variableColor.iterative, isActive: dictation.active)
                #if os(iOS)
                .frame(width: 44, height: 44)
                #else
                .frame(width: 27, height: 27)
                #endif
                .contentShape(Circle())
        }
    }

    /// A refusal or failure worth interrupting for. Permission prompts only
    /// appear once, so a silent no-op mic would just look broken.
    private var dictationProblem: String? {
        switch dictation.state {
        case .denied(let message), .failed(let message): message
        default: nil
        }
    }
}
