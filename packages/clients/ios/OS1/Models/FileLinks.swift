import Foundation

/// File paths inside a transcript, turned into links that open that file's
/// diff.
///
/// A turn's footer already names the files it touched, but the sentence above
/// it — "moved the guard into `src/server/pr.ts`" — is dead text, and the file
/// it names is the thing you want to look at while reading. The rewrite itself
/// lives in `PathLinks`; this is the set of paths it points at and where a tap
/// lands: a push of the Changes panel focused on that file.
///
/// This reaches the surfaces that render markdown — a turn's answer and its
/// narration. A user bubble and a notice body (a recap) are deliberately
/// plain `Text`, so a path written there stays text; that is a property of
/// those rows, not of this.
///
/// Only paths the session ITSELF touched are linked, registered per session
/// from the transcript's own tool calls.
@MainActor
enum FileLinks {
    /// Private scheme, so a link can never escape to a browser by accident.
    static let scheme = "os1file"

    private static let links = PathLinks(scheme: scheme)

    static func register(paths next: Set<String>, for sessionId: String) {
        links.register(paths: next, for: sessionId)
    }

    /// The file a transcript link points at, or nil for a normal URL.
    static func path(from url: URL) -> String? {
        links.path(from: url)
    }

    /// The files this session touched: what a ```tree row may open.
    static func paths(for sessionId: String?) -> Set<String> {
        links.paths(for: sessionId)
    }

    /// Markdown with every registered path rewritten as a link.
    static func linkify(_ markdown: String, sessionId: String?) -> String {
        links.linkify(markdown, sessionId: sessionId)
    }
}
