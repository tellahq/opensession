import SwiftUI

/// The session is blocked on an AskUserQuestion — render the first question's
/// options as tappable rows plus a free-text field. Answers are keyed by
/// question text, matching the server's `answer_question` frame.
///
/// Deliberately monochrome. The card used to be a tinted orange glass pane
/// with an ALL-CAPS header, which shouted louder than anything else in the
/// transcript for what is usually a routine fork in the work. It now reads as
/// a quiet inset list on the app's own neutral surface: one hairline border,
/// hairline-separated rows, and — for the free-text answer — the same
/// accent-filled send disc the composer wears, so answering here feels like
/// writing a message rather than filling in a form.
///
/// The letters are the keyboard's tap. Each option wears A, B, C, and a bare
/// letter typed anywhere in the card's window that is not a text field picks
/// that row and answers, exactly as a tap would. The composer is the one
/// place the letters cannot reach (they are typing there), so the "Answer the
/// question" command (⌘I) arms the card instead: it takes the keyboard back
/// from the composer and rings the card, and the letters answer from there.
/// Only the card in the key window hears any of it; see `AskKeyScope`.
///
/// The X in the corner dismisses without answering: it sends the protocol's
/// null answer, the asking run proceeds on its own judgment, and the server
/// answers with `ask_resolved` (even for a card it no longer holds), which
/// retires the card on every open client.
struct AskQuestionCard: View {
    let ask: AskQuestion
    let onAnswer: ([String: String]?) -> Void

    @State private var freeText = ""
    /// What was sent, so the card confirms it for the moment between the
    /// send and the server retiring the card, and never sends twice.
    @State private var submission = AskSubmission.idle
    @FocusState private var inputFocused: Bool
    /// The card itself holds keyboard focus, after the focus command. This is
    /// only what arms the card and draws the ring; the letters answer through
    /// the window bridge whether or not the card holds focus, as long as no
    /// text field is editing.
    @FocusState private var cardFocused: Bool

    private var question: AskQuestion.Question? { ask.questions.first }

    private var options: [AskQuestion.Option] { question?.options ?? [] }

    private var cardShape: RoundedRectangle {
        RoundedRectangle(cornerRadius: 20, style: .continuous)
    }

    private var trimmedFreeText: String {
        freeText.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let question {
                prompt(question)
                    .overlay(alignment: .topTrailing) { dismissButton }

                ForEach(Array(options.enumerated()), id: \.element.label) { index, option in
                    hairline
                    optionRow(option, at: index, in: question)
                }

                hairline
                freeTextRow(question)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        // The app's neutral raised surface: a shade under the page in light,
        // a shade over it in dark — the one direction each appearance leaves.
        .background(OS1VisualStyle.flapSurface, in: cardShape)
        .overlay(cardShape.stroke(OS1VisualStyle.border, lineWidth: 0.5))
        .focusRingShape(cardShape)
        .focusable()
        .focused($cardFocused)
        .onKeyPress(.escape) {
            guard cardFocused else { return .ignored }
            cardFocused = false
            return .handled
        }
        .askHardwareKeys(
            active: !submission.isInFlight,
            onLetter: pressLetter,
            onFocusCommand: focusCard
        )
        .animation(.snappy(duration: 0.2), value: submission)
        .animation(.snappy(duration: 0.2), value: trimmedFreeText.isEmpty)
        // Answering is the moment a stuck session starts moving again — worth
        // the success cue rather than a send's tap, and it covers both ways of
        // answering because both set `chosen`. A dismissal is not an answer.
        .haptic(trigger: chosen) { previous, chosen in
            previous == nil && chosen != nil ? .commit : nil
        }
    }

    private var chosen: String? { submission.chosen }

    // MARK: - Pieces

    /// Close without answering. The glyph stays small and dim so it never
    /// competes with the options; the hit target is the platform's minimum.
    private var dismissButton: some View {
        Button(action: dismiss) {
            Image(systemName: "xmark")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(OS1VisualStyle.textDim)
                .frame(width: Self.dismissTarget, height: Self.dismissTarget)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.top, 4)
        .padding(.trailing, 4)
        .disabled(submission.isInFlight)
        .opacity(submission.isInFlight ? 0.4 : 1)
        .help("Dismiss question")
        .accessibilityLabel("Dismiss question")
        .accessibilityHint("The agent continues without your answer")
    }

    #if os(macOS)
    private static let dismissTarget: CGFloat = 28
    #else
    private static let dismissTarget: CGFloat = 44
    #endif

    private func prompt(_ question: AskQuestion.Question) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            if let header = question.header, !header.isEmpty {
                // Sentence case, as written. Uppercasing a header the model
                // wrote ("Which app") turned a label into a shout.
                Text(header)
                    .font(.footnote)
                    .foregroundStyle(OS1VisualStyle.textDim)
            }
            Text(question.question)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(OS1VisualStyle.text)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.leading, 16)
        // Room for the dismiss button so a long question never runs under it.
        .padding(.trailing, Self.dismissTarget + 4)
        .padding(.top, 14)
        .padding(.bottom, 13)
    }

    private func optionRow(
        _ option: AskQuestion.Option,
        at index: Int,
        in question: AskQuestion.Question
    ) -> some View {
        let letter = AskLetterShortcuts.label(at: index)
        return Button {
            choose(option, in: question)
        } label: {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                if let letter {
                    keyCap(letter)
                }
                VStack(alignment: .leading, spacing: 3) {
                    Text(option.label)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(OS1VisualStyle.text)
                    if let description = option.description, !description.isEmpty {
                        Text(description)
                            .font(.footnote)
                            .foregroundStyle(OS1VisualStyle.textDim)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                Spacer(minLength: 0)
                // Nothing at rest — a chevron would promise navigation, and
                // tapping answers instead. The checkmark only marks the row
                // that was picked.
                Image(systemName: "checkmark")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(OS1VisualStyle.text)
                    .opacity(chosen == option.label ? 1 : 0)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 16)
            .padding(.vertical, 11)
        }
        .buttonStyle(AskOptionButtonStyle())
        .askLetterKeyEquivalent(letter)
        // The unpicked rows step back once a choice is in flight, so the card
        // reads as answered rather than still waiting.
        .opacity(!submission.isInFlight || chosen == option.label ? 1 : 0.4)
        .disabled(submission.isInFlight)
        .accessibilityHint(letter.map { "Press \($0) to pick" } ?? "")
    }

    /// The letter a row answers to, drawn like a key so it reads as one.
    private func keyCap(_ letter: String) -> some View {
        Text(verbatim: letter)
            .font(.caption2.weight(.semibold).monospaced())
            .foregroundStyle(OS1VisualStyle.textDim)
            .frame(width: 18, height: 18)
            .background(
                OS1VisualStyle.hover,
                in: RoundedRectangle(cornerRadius: 5, style: .continuous)
            )
            .accessibilityHidden(true)
    }

    private func freeTextRow(_ question: AskQuestion.Question) -> some View {
        HStack(alignment: .bottom, spacing: 6) {
            TextField("Answer in your own words", text: $freeText, axis: .vertical)
                .textFieldStyle(.plain)
                .font(.subheadline)
                .lineLimit(1...5)
                .focused($inputFocused)
                .frame(maxWidth: .infinity, minHeight: 32)
                .padding(.leading, 12)
                .onSubmit(sendFreeText)

            // Send only exists once there is something to send: an always-on
            // disabled button beside an empty field is noise, and the disc is
            // the composer's, so the gesture is already learned.
            if !trimmedFreeText.isEmpty {
                Button(action: sendFreeText) {
                    Image(systemName: "arrow.up")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(OS1VisualStyle.onAccent)
                        .frame(width: 28, height: 28)
                        .background(OS1VisualStyle.accent, in: Circle())
                }
                .buttonStyle(.plain)
                .contentShape(Circle())
                .accessibilityLabel("Send answer")
                .transition(.scale(scale: 0.6).combined(with: .opacity))
            }
        }
        .padding(4)
        .background(
            OS1VisualStyle.hover,
            in: RoundedRectangle(cornerRadius: 18, style: .continuous)
        )
        .padding(.horizontal, 12)
        .padding(.vertical, 12)
        .contentShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
        .onTapGesture { inputFocused = true }
        .disabled(submission.isInFlight)
    }

    private var hairline: some View {
        Rectangle()
            .fill(OS1VisualStyle.border)
            .frame(height: 0.5)
            .frame(maxWidth: .infinity)
    }

    // MARK: - Answering

    /// A tap, a letter, and Return all land here: pick the row and send.
    private func choose(_ option: AskQuestion.Option, in question: AskQuestion.Question) {
        guard submission.begin(.chosen(option.label)) else { return }
        cardFocused = false
        onAnswer([question.question: option.label])
    }

    /// A letter from the window. False when it names nothing on this
    /// question, so the keystroke stays the system's.
    private func pressLetter(_ letter: String) -> Bool {
        guard !submission.isInFlight, let question,
              let option = AskLetterShortcuts.option(in: question, letter: letter)
        else { return false }
        choose(option, in: question)
        return true
    }

    /// The "Answer the question" command: take the keyboard back from the
    /// composer. Focus the answer field for free-text questions, otherwise
    /// ring the card so a letter answers it.
    private func focusCard() {
        guard !submission.isInFlight else { return }
        if options.isEmpty {
            cardFocused = false
            inputFocused = true
        } else {
            inputFocused = false
            cardFocused = true
        }
    }

    private func sendFreeText() {
        guard let question, !submission.isInFlight else { return }
        let text = trimmedFreeText
        guard !text.isEmpty, submission.begin(.chosen(text)) else { return }
        inputFocused = false
        onAnswer([question.question: text])
    }

    /// The X: send the protocol's null answer. Never a guessed textual one,
    /// and never a local hide — the server's `ask_resolved` is what retires
    /// the card everywhere.
    private func dismiss() {
        guard submission.begin(.dismissed) else { return }
        cardFocused = false
        inputFocused = false
        onAnswer(nil)
    }
}

/// One card sends at most once: a pick, a free-text answer, or a dismissal,
/// whichever lands first. Everything after it is ignored until the server
/// retires the card.
enum AskSubmission: Equatable {
    case idle
    case chosen(String)
    case dismissed

    var isInFlight: Bool { self != .idle }

    var chosen: String? {
        if case .chosen(let label) = self { return label }
        return nil
    }

    /// Claim the card's one send. False when something was already sent.
    mutating func begin(_ next: AskSubmission) -> Bool {
        guard self == .idle, next != .idle else { return false }
        self = next
        return true
    }
}

private extension View {
    /// The system focus ring follows the card's corners. macOS is the platform
    /// that draws one around a focusable container; iOS has no focus-effect
    /// shape kind and draws its own keyboard focus halo.
    func focusRingShape(_ shape: RoundedRectangle) -> some View {
        #if os(macOS)
        contentShape(.focusEffect, shape)
        #else
        self
        #endif
    }
}

/// Row press feedback: the whole row lights, edge to edge, the way a grouped
/// list row does — a scale or an opacity dip on a full-width row reads as the
/// card itself flinching.
private struct AskOptionButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(configuration.isPressed ? OS1VisualStyle.hover : .clear)
            .contentShape(Rectangle())
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}
