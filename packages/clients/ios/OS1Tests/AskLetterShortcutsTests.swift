import XCTest
@testable import OS1

final class AskLetterShortcutsTests: XCTestCase {
    private let question = AskQuestion.Question(
        question: "Pick",
        header: nil,
        options: [
            AskQuestion.Option(label: "One", description: nil),
            AskQuestion.Option(label: "Two", description: nil),
        ],
        multiSelect: nil
    )

    // MARK: - Letters

    func testLabelsArePositionalAndStopAtZ() {
        XCTAssertEqual(AskLetterShortcuts.label(at: 0), "A")
        XCTAssertEqual(AskLetterShortcuts.label(at: 2), "C")
        XCTAssertEqual(AskLetterShortcuts.label(at: 25), "Z")
        XCTAssertNil(AskLetterShortcuts.label(at: 26))
        XCTAssertNil(AskLetterShortcuts.label(at: -1))
    }

    func testBareLetterNamesAnOptionInEitherCase() {
        XCTAssertEqual(AskLetterShortcuts.letter(typed: "b", modifiers: [], isRepeat: false), "B")
        XCTAssertEqual(AskLetterShortcuts.letter(typed: "B", modifiers: [.shift], isRepeat: false), "B")
    }

    func testChordsAndHeldKeysAreNotAnswers() {
        for modifiers: AccountShortcutModifiers in [.command, .control, .option, [.command, .shift]] {
            XCTAssertNil(AskLetterShortcuts.letter(typed: "b", modifiers: modifiers, isRepeat: false))
        }
        XCTAssertNil(AskLetterShortcuts.letter(typed: "b", modifiers: [], isRepeat: true))
    }

    func testOnlySingleAsciiLettersCount() {
        for key in ["1", "\r", " ", "é", "ß", "ab", ""] {
            XCTAssertNil(AskLetterShortcuts.letter(typed: key, modifiers: [], isRepeat: false), key)
        }
        XCTAssertNil(AskLetterShortcuts.letter(typed: nil, modifiers: [], isRepeat: false))
    }

    func testLettersMapToOptionsTheWayTheCardLabelsThem() {
        XCTAssertEqual(AskLetterShortcuts.option(in: question, letter: "A")?.label, "One")
        XCTAssertEqual(AskLetterShortcuts.option(in: question, letter: "b")?.label, "Two")
    }

    func testLetterPastTheLastOptionOrOnFreeTextIsNothing() {
        XCTAssertNil(AskLetterShortcuts.option(in: question, letter: "C"))
        let freeText = AskQuestion.Question(
            question: "Why?", header: nil, options: nil, multiSelect: nil
        )
        XCTAssertNil(AskLetterShortcuts.option(in: freeText, letter: "A"))
    }

    // MARK: - Which card hears the key

    func testOnlyTheKeyWindowsCardHearsLetters() {
        let front = AskKeyScope(windowIsKey: true, appIsActive: true, editingText: false, answered: false)
        XCTAssertTrue(front.hearsLetters)

        var other = front
        other.windowIsKey = false
        XCTAssertFalse(other.hearsLetters, "a second window or tab keeps its keys")

        var background = front
        background.appIsActive = false
        XCTAssertFalse(background.hearsLetters)
    }

    func testTextFieldsKeepTheirLettersButNotTheFocusCommand() {
        let composer = AskKeyScope(windowIsKey: true, appIsActive: true, editingText: true, answered: false)
        XCTAssertFalse(composer.hearsLetters)
        XCTAssertTrue(composer.takesFocusCommand, "the command is the way over from the composer")
    }

    func testAnAnsweredCardIsDeaf() {
        let done = AskKeyScope(windowIsKey: true, appIsActive: true, editingText: false, answered: true)
        XCTAssertFalse(done.hearsLetters)
        XCTAssertFalse(done.takesFocusCommand)
    }

    // MARK: - Focus command

    func testFocusCommandHasANativeDefaultChord() {
        let shortcuts = AccountShortcuts(rawValue: "{}")
        XCTAssertEqual(shortcuts.primaryBinding(for: .askFocus)?.rawValue, "mod+i")
        XCTAssertEqual(AccountShortcutCommand.askFocus.rawValue, "ask-focus")
    }
}
