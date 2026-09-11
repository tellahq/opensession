import Foundation

/// ```ansi and ```terminal fences render their SGR colours and styles; a
/// shell or text fence does the same when it carries a real escape byte
/// (docs/blocks.md, "Terminal output"). The parsing is `TerminalScrollback`,
/// the same state machine the Terminal panel runs on PTY output, so a fence
/// and a live shell colour a word the same way.
enum AnsiBlock {
    static let langs: Set<String> = ["ansi", "terminal"]
    /// Fences that render as terminal output only when they carry an escape.
    static let escapeClaimLangs: Set<String> = ["bash", "sh", "shell", "zsh", "console", "text", "log"]

    private static let escape = "\u{1B}"

    /// Whether a fence of `lang` should render as terminal output.
    static func claims(lang: String, source: String) -> Bool {
        if langs.contains(lang) { return true }
        return escapeClaimLangs.contains(lang) && source.contains(escape + "[")
    }

    /// The text to parse. An explicit ansi/terminal fence written by a model
    /// usually spells the escape rather than emitting the byte (`\x1b[31m`,
    /// `\e[31m`, `\033[31m`, `[31m`), so those spellings are decoded
    /// when the fence carries no real escape at all. A shell fence is left
    /// alone: it only claimed because it has the real byte.
    static func terminalSource(lang: String, source: String) -> String {
        guard langs.contains(lang), !source.contains(escape) else { return source }
        var out = source
        for spelling in ["\\x1b[", "\\x1B[", "\\u001b[", "\\u001B[", "\\033[", "\\e["] {
            out = out.replacingOccurrences(of: spelling, with: escape + "[")
        }
        return out
    }

    /// The fence as styled lines, and the text with every escape gone (what
    /// copy reads).
    static func lines(lang: String, source: String) -> (lines: [TerminalLine], plain: String) {
        var scrollback = TerminalScrollback()
        scrollback.feed(terminalSource(lang: lang, source: source))
        return (scrollback.lines, scrollback.plainText)
    }
}
