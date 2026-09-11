import Foundation
import SwiftUI

/// Account shortcut ids the native Mac app implements today.
enum AccountShortcutCommand: String, CaseIterable, Identifiable {
    case commandMenu = "command-menu"
    case newSession = "session-new"
    case newSessionInWorkspace = "session-new-sibling"
    /// The web registry's `ask-focus`: the letters answer a question from
    /// anywhere but a text field, and this is the way over from the composer.
    case askFocus = "ask-focus"

    var id: String { rawValue }

    var title: String {
        switch self {
        case .commandMenu: "Command menu"
        case .newSession: "New session"
        case .newSessionInWorkspace: "New session in this workspace"
        case .askFocus: "Answer the question"
        }
    }

    var detail: String {
        switch self {
        case .commandMenu: "Search sessions and commands"
        case .newSession: "Start a session in any repository"
        case .newSessionInWorkspace: "Start another session in the open workspace"
        case .askFocus: "Jump to the question the assistant is waiting on"
        }
    }

    /// Native defaults stay native. The shared preference contains overrides,
    /// so a Mac keeps Command-N until the account customizes this command.
    var defaultChord: AccountShortcutChord {
        switch self {
        case .commandMenu: AccountShortcutChord(rawValue: "mod+k")!
        case .newSession: AccountShortcutChord(rawValue: "mod+n")!
        case .newSessionInWorkspace: AccountShortcutChord(rawValue: "mod+alt+n")!
        case .askFocus: AccountShortcutChord(rawValue: "mod+i")!
        }
    }
}

struct AccountShortcutModifiers: OptionSet, Equatable, Hashable, Sendable {
    let rawValue: Int

    static let command = Self(rawValue: 1 << 0)
    static let control = Self(rawValue: 1 << 1)
    static let option = Self(rawValue: 1 << 2)
    static let shift = Self(rawValue: 1 << 3)
}

/// One canonical Apple chord, using the web registry's portable spelling.
struct AccountShortcutChord: Equatable, Hashable, Sendable {
    let rawValue: String
    let key: String
    let modifiers: AccountShortcutModifiers

    init?(rawValue: String) {
        let aliases: [String: String] = [
            "meta": "mod", "cmd": "mod", "control": "ctrl",
            "option": "alt", "opt": "alt",
        ]
        let tokens = rawValue
            .lowercased()
            .split(separator: "+")
            .map { String($0).trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        guard !tokens.isEmpty else { return nil }

        var modifierNames = Set<String>()
        var key: String?
        for token in tokens {
            let token = aliases[token] ?? token
            if ["mod", "ctrl", "alt", "shift"].contains(token) {
                modifierNames.insert(token)
            } else {
                guard key == nil else { return nil }
                key = token
            }
        }
        guard let key, !key.isEmpty else { return nil }

        var modifiers: AccountShortcutModifiers = []
        if modifierNames.contains("mod") { modifiers.insert(.command) }
        if modifierNames.contains("ctrl") { modifiers.insert(.control) }
        if modifierNames.contains("alt") { modifiers.insert(.option) }
        if modifierNames.contains("shift") { modifiers.insert(.shift) }
        var canonical: [String] = []
        if modifiers.contains(.command) { canonical.append("mod") }
        if modifiers.contains(.control) { canonical.append("ctrl") }
        if modifiers.contains(.option) { canonical.append("alt") }
        if modifiers.contains(.shift) { canonical.append("shift") }
        canonical.append(key)

        self.rawValue = canonical.joined(separator: "+")
        self.key = key
        self.modifiers = modifiers
    }

    init?(key: String, modifiers: AccountShortcutModifiers) {
        var parts: [String] = []
        if modifiers.contains(.command) { parts.append("mod") }
        if modifiers.contains(.control) { parts.append("ctrl") }
        if modifiers.contains(.option) { parts.append("alt") }
        if modifiers.contains(.shift) { parts.append("shift") }
        parts.append(key)
        self.init(rawValue: parts.joined(separator: "+"))
    }

    var glyphs: [String] {
        var result: [String] = []
        if modifiers.contains(.command) { result.append("⌘") }
        if modifiers.contains(.control) { result.append("⌃") }
        if modifiers.contains(.option) { result.append("⌥") }
        if modifiers.contains(.shift) { result.append("⇧") }
        result.append(Self.keyGlyphs[key] ?? key.uppercased())
        return result
    }

    var label: String { glyphs.joined() }

    var isBindable: Bool {
        let bindingModifiers: AccountShortcutModifiers = [.command, .control, .option]
        return !modifiers.intersection(bindingModifiers).isEmpty || Self.isFunctionKey(key)
    }

    func isUsable(on command: AccountShortcutCommand) -> Bool {
        guard isBindable, keyEquivalent != nil else { return false }
        return !Self.reservedMacChords.contains(rawValue) || self == command.defaultChord
    }

    func matches(key: String, modifiers: AccountShortcutModifiers) -> Bool {
        guard let candidate = AccountShortcutChord(key: key, modifiers: modifiers) else { return false }
        return candidate == self
    }

    var keyboardShortcut: KeyboardShortcut? {
        guard isBindable, let equivalent = keyEquivalent else { return nil }
        var eventModifiers: EventModifiers = []
        if modifiers.contains(.command) { eventModifiers.insert(.command) }
        if modifiers.contains(.control) { eventModifiers.insert(.control) }
        if modifiers.contains(.option) { eventModifiers.insert(.option) }
        if modifiers.contains(.shift) { eventModifiers.insert(.shift) }
        return KeyboardShortcut(equivalent, modifiers: eventModifiers)
    }

    private var keyEquivalent: KeyEquivalent? {
        switch key {
        case "arrowup": return .upArrow
        case "arrowdown": return .downArrow
        case "arrowleft": return .leftArrow
        case "arrowright": return .rightArrow
        case "enter": return .return
        case "escape": return .escape
        case "backspace": return .delete
        case "tab": return .tab
        case "space": return .space
        case "delete": return Self.keyEquivalent(0xF728)
        case "home": return Self.keyEquivalent(0xF729)
        case "end": return Self.keyEquivalent(0xF72B)
        case "pageup": return Self.keyEquivalent(0xF72C)
        case "pagedown": return Self.keyEquivalent(0xF72D)
        default:
            if Self.isFunctionKey(key), let number = Int(key.dropFirst()) {
                return Self.keyEquivalent(0xF703 + number)
            }
            guard key.count == 1, let character = key.first else { return nil }
            return KeyEquivalent(character)
        }
    }

    private static func keyEquivalent(_ value: Int) -> KeyEquivalent? {
        guard let scalar = UnicodeScalar(value) else { return nil }
        return KeyEquivalent(Character(String(scalar)))
    }

    private static func isFunctionKey(_ key: String) -> Bool {
        guard key.first == "f", let number = Int(key.dropFirst()) else { return false }
        return (1...24).contains(number)
    }

    private static let keyGlyphs: [String: String] = [
        "arrowup": "↑", "arrowdown": "↓", "arrowleft": "←", "arrowright": "→",
        "enter": "↵", "escape": "Esc", "backspace": "⌫", "delete": "⌦",
        "tab": "⇥", "space": "Space", "pageup": "PgUp", "pagedown": "PgDn",
        "home": "Home", "end": "End",
    ]

    private static let reservedMacChords: Set<String> = [
        "mod+q", "mod+h", "mod+alt+h", "mod+m", "mod+w", "mod+,",
        "mod+c", "mod+v", "mod+x", "mod+a", "mod+z", "mod+shift+z",
    ]
}

/// Validated account overrides. Unknown command ids remain intact so this
/// client cannot erase bindings written by a newer web or native client.
struct AccountShortcuts: Equatable, Sendable {
    static let storageKey = "os1.shortcuts"
    static let emptyRawValue = "{}"

    private(set) var overrides: [String: [AccountShortcutChord]]

    init(rawValue: String?) {
        guard let rawValue,
              let data = rawValue.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data),
              let decoded = object as? [String: Any]
        else {
            overrides = [:]
            return
        }

        overrides = decoded.reduce(into: [:]) { result, entry in
            guard let values = entry.value as? [Any] else { return }
            var seen = Set<AccountShortcutChord>()
            result[entry.key] = values.compactMap { value -> AccountShortcutChord? in
                guard let raw = value as? String else { return nil }
                guard let chord = AccountShortcutChord(rawValue: raw), seen.insert(chord).inserted else {
                    return nil
                }
                return chord
            }
        }
    }

    var rawValue: String {
        let strings = overrides.mapValues { $0.map(\.rawValue) }
        guard let data = try? JSONEncoder.sorted.encode(strings) else { return Self.emptyRawValue }
        return String(decoding: data, as: UTF8.self)
    }

    static func validatedRawValue(_ rawValue: String?) -> String {
        AccountShortcuts(rawValue: rawValue).rawValue
    }

    func bindings(for command: AccountShortcutCommand) -> [AccountShortcutChord] {
        if let custom = overrides[command.rawValue] { return custom }
        return [command.defaultChord]
    }

    func primaryBinding(for command: AccountShortcutCommand) -> AccountShortcutChord? {
        bindings(for: command).first { $0.isUsable(on: command) }
    }

    func keyboardShortcut(for command: AccountShortcutCommand) -> KeyboardShortcut? {
        primaryBinding(for: command)?.keyboardShortcut
    }

    func isCustomized(_ command: AccountShortcutCommand) -> Bool {
        overrides[command.rawValue] != nil
    }

    func matches(
        _ command: AccountShortcutCommand,
        key: String,
        modifiers: AccountShortcutModifiers
    ) -> Bool {
        bindings(for: command).contains { $0.matches(key: key, modifiers: modifiers) }
    }

    mutating func setPrimaryBinding(
        _ chord: AccountShortcutChord,
        for command: AccountShortcutCommand
    ) {
        let rest = (overrides[command.rawValue] ?? []).filter { $0 != chord }
        overrides[command.rawValue] = [chord] + rest
    }

    mutating func removeBindings(for command: AccountShortcutCommand) {
        overrides[command.rawValue] = []
    }

    mutating func reset(_ command: AccountShortcutCommand) {
        overrides.removeValue(forKey: command.rawValue)
    }

    mutating func resetSupportedCommands() {
        for command in AccountShortcutCommand.allCases { reset(command) }
    }
}

private extension JSONEncoder {
    static var sorted: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return encoder
    }
}
