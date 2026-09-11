import Foundation

/// Letter shortcuts for the live question card (`AskQuestionCard`).
///
/// The web card labels its options A, B, C and answers to those letters from
/// anywhere on the page that is not a text field. This is the native reading
/// of the same idea, kept pure on purpose: the keystroke-to-option mapping
/// and the "does this card hear this key" decision are unit-testable without
/// a window, and the two platforms' bridges cannot disagree about which
/// option "B" is.
enum AskLetterShortcuts {
    private static let letters = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZ")

    /// The label the card draws on an option: A for the first, B the second.
    /// Nil past Z, where a row still answers to touch but has no key.
    static func label(at index: Int) -> String? {
        guard letters.indices.contains(index) else { return nil }
        return String(letters[index])
    }

    /// The option letter a keystroke spells, or nil when it is anything else:
    /// a chord, a held key, or a key that is not one ASCII letter. Shift
    /// passes, since "A" and "a" name the same option.
    static func letter(
        typed characters: String?,
        modifiers: AccountShortcutModifiers,
        isRepeat: Bool
    ) -> String? {
        guard !isRepeat, modifiers.subtracting(.shift).isEmpty,
              let characters, characters.count == 1
        else { return nil }
        let upper = characters.uppercased()
        guard upper.count == 1, let letter = upper.first, letters.contains(letter) else {
            return nil
        }
        return String(letter)
    }

    /// The row a letter names, counted the way the card labels them.
    static func index(of letter: String) -> Int? {
        guard letter.count == 1, let character = letter.uppercased().first else { return nil }
        return letters.firstIndex(of: character)
    }

    /// The option a letter names on one question, or nil past the last
    /// option and on a free-text question.
    static func option(
        in question: AskQuestion.Question,
        letter: String
    ) -> AskQuestion.Option? {
        guard let index = index(of: letter), let options = question.options,
              options.indices.contains(index)
        else { return nil }
        return options[index]
    }
}

/// Whether one card hears one keystroke. A second window or a Desk sheet can
/// show its own live question, and the keyboard belongs to exactly one of
/// them; the platform bridge reads these off the card's window and the pure
/// rule decides.
struct AskKeyScope: Equatable, Sendable {
    /// The card's window is the key window.
    var windowIsKey: Bool
    /// The app is frontmost. A local event monitor only sees the app's own
    /// events, but a stale key window while another app is active must not
    /// answer either.
    var appIsActive: Bool
    /// A text field holds the keyboard: the composer, the card's own free
    /// text row, or a search field. Letters there are text.
    var editingText: Bool
    /// The card already sent its answer and is waiting to be retired.
    var answered: Bool

    /// A bare letter picks an option.
    var hearsLetters: Bool {
        windowIsKey && appIsActive && !editingText && !answered
    }

    /// The "Answer the question" command reaches the card. It is allowed
    /// from a text field: the composer is the one place the letters cannot
    /// reach, and this is the way over from it.
    var takesFocusCommand: Bool {
        windowIsKey && appIsActive && !answered
    }
}
