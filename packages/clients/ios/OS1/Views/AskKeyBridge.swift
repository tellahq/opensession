import SwiftUI
#if os(macOS)
import AppKit
#endif

#if os(macOS)
extension Notification.Name {
    /// The "Answer the Question" command (⌘I by default). The menu and the
    /// command palette post it; the question card in the key window takes
    /// focus, which is how the keyboard gets from the composer to the card.
    static let os1AskFocus = Notification.Name("os1.askFocus")
}
#endif

extension View {
    /// Hardware keys for the question card from outside it.
    ///
    /// `onLetter` is a bare letter typed anywhere in the card's window that is
    /// not a text field; it returns whether the letter named an option, so an
    /// unclaimed key stays the system's. `onFocusCommand` is the "Answer the
    /// question" chord, which is allowed from a text field.
    ///
    /// SwiftUI's own `keyboardShortcut` cannot carry a bare letter safely on
    /// macOS: a key equivalent is matched before the field editor sees the
    /// key, so "a" would answer the question instead of typing into the
    /// composer. The Mac side is an `NSEvent` local monitor scoped to the
    /// card's own window (`AskKeyMonitorView`), which is how this app already
    /// reads keys out from under a focused field. On iOS the letters ride the
    /// option rows as key equivalents instead: UIKit gives text input
    /// priority over an unmodified key command, and the one scene is the one
    /// window.
    func askHardwareKeys(
        active: Bool,
        onLetter: @escaping (String) -> Bool,
        onFocusCommand: @escaping () -> Void
    ) -> some View {
        modifier(AskHardwareKeys(
            active: active, onLetter: onLetter, onFocusCommand: onFocusCommand
        ))
    }

    /// The bare key equivalent an option row answers to on iOS. A no-op on
    /// macOS, where the window monitor hears the letters instead.
    func askLetterKeyEquivalent(_ letter: String?) -> some View {
        modifier(AskLetterKeyEquivalent(letter: letter))
    }
}

private struct AskHardwareKeys: ViewModifier {
    let active: Bool
    let onLetter: (String) -> Bool
    let onFocusCommand: () -> Void

    func body(content: Content) -> some View {
        #if os(macOS)
        content.background {
            AskKeyMonitor(active: active, onLetter: onLetter, onFocusCommand: onFocusCommand)
                .frame(width: 0, height: 0)
        }
        #else
        content.background {
            // Listed in the iPad's ⌘ HUD under this title, which is what
            // makes it discoverable; the button itself never draws.
            Button("Answer the question", action: onFocusCommand)
                .keyboardShortcut("i", modifiers: .command)
                .disabled(!active)
                .opacity(0)
                .frame(width: 0, height: 0)
                .accessibilityHidden(true)
        }
        #endif
    }
}

private struct AskLetterKeyEquivalent: ViewModifier {
    let letter: String?

    func body(content: Content) -> some View {
        #if os(iOS)
        if let key = letter?.lowercased().first {
            content.keyboardShortcut(KeyEquivalent(key), modifiers: [])
        } else {
            content
        }
        #else
        content
        #endif
    }
}

#if os(macOS)
private struct AskKeyMonitor: NSViewRepresentable {
    let active: Bool
    let onLetter: (String) -> Bool
    let onFocusCommand: () -> Void

    func makeNSView(context: Context) -> AskKeyMonitorView {
        let view = AskKeyMonitorView()
        apply(to: view)
        return view
    }

    func updateNSView(_ view: AskKeyMonitorView, context: Context) {
        apply(to: view)
    }

    static func dismantleNSView(_ view: AskKeyMonitorView, coordinator: ()) {
        view.uninstall()
    }

    private func apply(to view: AskKeyMonitorView) {
        view.active = active
        view.onLetter = onLetter
        view.onFocusCommand = onFocusCommand
    }
}

/// A zero-sized view whose only job is to know which window the card is in.
/// The monitor it installs sees every key-down in the app first and keeps
/// only a bare letter aimed at this window while it is key and no text field
/// is editing; everything else passes through untouched. The focus command
/// is answered by the same test, so with two windows open only the one the
/// keyboard belongs to moves.
final class AskKeyMonitorView: NSView {
    var active = true
    var onLetter: (String) -> Bool = { _ in false }
    var onFocusCommand: () -> Void = {}

    private var monitor: Any?
    private var focusObserver: NSObjectProtocol?

    override var acceptsFirstResponder: Bool { false }

    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if window == nil {
            uninstall()
        } else {
            install()
        }
    }

    private func install() {
        if monitor == nil {
            monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
                MainActor.assumeIsolated {
                    self?.consume(event) == true ? nil : event
                }
            }
        }
        if focusObserver == nil {
            focusObserver = NotificationCenter.default.addObserver(
                forName: .os1AskFocus, object: nil, queue: .main
            ) { [weak self] _ in
                MainActor.assumeIsolated { self?.takeFocus() }
            }
        }
    }

    func uninstall() {
        if let monitor {
            NSEvent.removeMonitor(monitor)
            self.monitor = nil
        }
        if let focusObserver {
            NotificationCenter.default.removeObserver(focusObserver)
            self.focusObserver = nil
        }
    }

    private var scope: AskKeyScope? {
        guard let window else { return nil }
        return AskKeyScope(
            windowIsKey: window.isKeyWindow,
            appIsActive: NSApp.isActive,
            editingText: Self.isEditingText(window.firstResponder),
            answered: !active
        )
    }

    private func consume(_ event: NSEvent) -> Bool {
        guard let window, event.window === window, scope?.hearsLetters == true,
              let letter = AskLetterShortcuts.letter(
                  typed: event.charactersIgnoringModifiers,
                  modifiers: Self.modifiers(of: event),
                  isRepeat: event.isARepeat
              )
        else { return false }
        return onLetter(letter)
    }

    private func takeFocus() {
        guard scope?.takesFocusCommand == true else { return }
        // The composer's field editor holds first responder. Hand the
        // window's focus back before SwiftUI moves its own, or the letters
        // typed next still land in the field.
        window?.makeFirstResponder(nil)
        onFocusCommand()
    }

    /// SwiftUI text fields are backed by `NSTextField`, whose field editor
    /// (an `NSTextView`, so an `NSText`) is what actually holds first
    /// responder while editing; a `TextEditor` is an `NSTextView` outright.
    private static func isEditingText(_ responder: NSResponder?) -> Bool {
        responder is NSText || responder is NSTextField
    }

    private static func modifiers(of event: NSEvent) -> AccountShortcutModifiers {
        let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        var modifiers: AccountShortcutModifiers = []
        if flags.contains(.command) { modifiers.insert(.command) }
        if flags.contains(.control) { modifiers.insert(.control) }
        if flags.contains(.option) { modifiers.insert(.option) }
        if flags.contains(.shift) { modifiers.insert(.shift) }
        return modifiers
    }
}
#endif
