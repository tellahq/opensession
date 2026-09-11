import Foundation

/// The machinery behind the transcript's path links.
///
/// `FileLinks` and `AssetLinks` are the same idea pointed at two different
/// sets of paths: prose names something the turn touched, and naming it should
/// be enough to open it. Both rewrite those names into ordinary markdown links
/// on a private scheme, which the session intercepts through `openURL`; only
/// the scheme and where a tap lands differ, so the matching lives here once.
///
/// Paths are registered per session from that session's OWN tool calls. That
/// is what keeps a link honest in both directions: it always lands on
/// something that exists, and prose that merely looks like a path ("about 3/4
/// of the way") is never touched, because it was never registered.
@MainActor
final class PathLinks {
    /// Private scheme, so a link can never escape to a browser by accident.
    let scheme: String

    /// Every exact path remains linkable. Only shorthand suffixes are bounded:
    /// one deeply nested 2,000-file session can otherwise create tens of
    /// thousands of regex alternatives for every markdown render.
    private let maxShortAliases: Int
    /// Repo paths may come from the composer's `@path` mention syntax. Scratch
    /// asset names have no such syntax, so `@report.html` must stay unknown.
    private let acceptsMentionPrefix: Bool
    /// What a matched path draws as, or nil for an ordinary link. A scratch
    /// file is an artifact the turn made — one object, worth a chip. A repo
    /// path is a name in a sentence, and a paragraph listing four files would
    /// come out as four buttons, so those stay text.
    private let chipKind: TranscriptChip.Kind?

    init(
        scheme: String,
        maxShortAliases: Int = 600,
        acceptsMentionPrefix: Bool = true,
        chipKind: TranscriptChip.Kind? = nil
    ) {
        self.scheme = scheme
        self.maxShortAliases = maxShortAliases
        self.acceptsMentionPrefix = acceptsMentionPrefix
        self.chipKind = chipKind
    }

    /// session id → the paths that session may link, and the pattern matching
    /// them. Keyed by session because the transcript of one session must not
    /// link a path only another one touched: the link would open a panel with
    /// nothing to show.
    private struct Registry {
        var paths: Set<String>
        /// What may be WRITTEN → the full path it means. A turn touches
        /// `packages/core/webapp/src/frontend/UI__ContextMenu.res` and then
        /// writes `UI__ContextMenu.res`, which is how anyone refers to a file
        /// in a sentence — so every trailing segment run of a registered path
        /// is a way to say it, as long as it says only one of them.
        var targets: [String: String]
        var pattern: NSRegularExpression?
    }

    private var registries: [String: Registry] = [:]

    func register(paths next: Set<String>, for sessionId: String) {
        guard registries[sessionId]?.paths != next else { return }
        let allTargets = Self.buildTargets(next)
        let exactPaths = next.filter { allTargets[$0] != nil }
        let shortAliases = allTargets.keys
            .filter { !next.contains($0) }
            .sorted { $0.count == $1.count ? $0 < $1 : $0.count > $1.count }
            .prefix(maxShortAliases)
        let selected = Set(exactPaths).union(shortAliases)
        let targets = allTargets.filter { selected.contains($0.key) }
        registries[sessionId] = Registry(
            paths: next,
            targets: targets,
            pattern: buildPattern(Set(targets.keys))
        )
        TranscriptLinks.shared.invalidate()
    }

    /// The path a transcript link points at, or nil for a normal URL.
    func path(from url: URL) -> String? {
        guard url.scheme == scheme else { return nil }
        // os1file:src/a.ts — the path lands in `path` or `host` depending on
        // how the URL was spelled, so accept either.
        let candidate = url.host.map { host in
            host + url.path
        } ?? url.path
        let path = candidate.hasPrefix("/") ? String(candidate.dropFirst()) : candidate
        return path.isEmpty ? nil : path
    }

    /// Return an exact registered path. Media URLs use this to prove that an
    /// absolute file under the assets root is one of this session's files.
    func registeredPath(_ path: String, for sessionId: String) -> String? {
        registries[sessionId]?.paths.contains(path) == true ? path : nil
    }

    /// Every path registered for a session. A ```tree block reads it to
    /// decide which of its rows can open the Changes panel.
    func paths(for sessionId: String?) -> Set<String> {
        sessionId.flatMap { registries[$0]?.paths } ?? []
    }

    /// Markdown with every registered path rewritten as a link. Returns the
    /// input unchanged when there is nothing to do, which is most text.
    func linkify(_ markdown: String, sessionId: String?) -> String {
        guard let sessionId,
              let registry = registries[sessionId],
              let pattern = registry.pattern,
              !markdown.isEmpty
        else { return markdown }
        return MarkdownProse.rewrite(markdown) { line in
            linkifyLine(line, pattern: pattern, targets: registry.targets)
        }
    }

    // MARK: - Internals

    /// Every trailing segment run of every path, minus the ambiguous ones.
    ///
    /// Two touched files called `index.ts` make `index.ts` mean neither, and
    /// a link that guesses which is worse than no link — so an ambiguous way
    /// of writing a path is dropped, and the longer forms that separate them
    /// (`server/index.ts`) survive.
    private static func buildTargets(_ paths: Set<String>) -> [String: String] {
        var targets: [String: String] = [:]
        var ambiguous: Set<String> = []
        for path in paths where !path.isEmpty {
            let segments = path.split(separator: "/").map(String.init)
            guard !segments.isEmpty else { continue }
            for start in segments.indices {
                let candidate = segments[start...].joined(separator: "/")
                if let existing = targets[candidate], existing != path {
                    ambiguous.insert(candidate)
                } else {
                    targets[candidate] = path
                }
            }
        }
        for candidate in ambiguous { targets.removeValue(forKey: candidate) }
        return targets
    }

    /// Skip alternatives first, so at any position an existing link wins over
    /// a path inside it — the same order (and the same reason) as
    /// `MarkdownAutolink`.
    private func buildPattern(_ paths: Set<String>) -> NSRegularExpression? {
        // Longest first: `src/a/b.ts` must win over a registered `src/a`,
        // which would otherwise match its prefix and split the path in two.
        let alternatives = paths
            .filter { !$0.isEmpty }
            .sorted { $0.count == $1.count ? $0 < $1 : $0.count > $1.count }
            .map { NSRegularExpression.escapedPattern(for: $0) }
        guard !alternatives.isEmpty else { return nil }
        let group = "(?:" + alternatives.joined(separator: "|") + ")"
        let mention = acceptsMentionPrefix ? "@?" : ""
        return try? NSRegularExpression(
            pattern:
                "(!?\\[[^\\]]*\\]\\([^)]*\\)"      // [label](destination)
                + "|<[^>\\s]+>)"                   // <https://…>
                + "|`(\(mention)\(group))`"        // `path`, optionally `@path`
                // A trailing "/" means the text continues into a LONGER path
                // than the one that matched — a registered directory must not
                // link the first half of the file under it. A trailing "." is
                // allowed: that is a sentence ending, not a deeper path.
                + "|(?<![\\w./~@-])(\(mention)\(group))(?![\\w/-])",
            options: []
        )
    }

    private func linkifyLine(
        _ line: String,
        pattern: NSRegularExpression,
        targets: [String: String]
    ) -> String {
        let ns = line as NSString
        let matches = pattern.matches(
            in: line,
            range: NSRange(location: 0, length: ns.length)
        )
        guard !matches.isEmpty else { return line }

        var result = ""
        var cursor = 0
        for match in matches {
            // Group 1 matched: an existing link, copied verbatim.
            let coded = match.range(at: 2)
            let bare = match.range(at: 3)
            let target = coded.location != NSNotFound ? coded : bare
            guard target.location != NSNotFound else { continue }

            let whole = match.range
            result += ns.substring(with: NSRange(
                location: cursor,
                length: whole.location - cursor
            ))
            let text = ns.substring(with: target)
            let written = acceptsMentionPrefix && text.hasPrefix("@")
                ? String(text.dropFirst())
                : text
            // The link goes to the full path, whatever shorthand named it.
            guard let path = targets[written],
                  let destination = destination(for: path) else {
                result += ns.substring(with: whole)
                cursor = whole.location + whole.length
                continue
            }
            // The label is the bare text even when the path was written in
            // backticks, because the renderer resolves a code span INSIDE a
            // link by keeping the link's tap and the code span's styling
            // (Markdown+InlineConvertible: InlineCode overrides .font and
            // .foregroundColor, .link survives) — a link that is tappable and
            // looks exactly like the un-tappable code around it. Dropping the
            // code voice is the smaller loss: the reader learns that a grey
            // chip is code and a coloured path is a file they can open.
            result += link(text: text, path: path, destination: destination)
            cursor = whole.location + whole.length
        }
        result += ns.substring(from: cursor)
        return result
    }

    /// The markdown one match becomes: a chip for the schemes that draw one,
    /// an ordinary link for the rest. `text` is what the prose wrote, which is
    /// the shorthand the reader chose; `path` is the whole of it, and is what
    /// the chip says out loud.
    private func link(text: String, path: String, destination: String) -> String {
        guard let chipKind else { return "[\(text)](\(destination))" }
        return TranscriptChip(
            kind: chipKind,
            tone: .accent,
            title: text,
            accessibilityLabel: "Open \(path)",
            destination: destination
        ).markdown
    }

    /// Percent-encode everything a markdown destination can't carry — a space
    /// ends the destination, and a parenthesis closes it.
    private func destination(for path: String) -> String? {
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "/._-~")
        guard let encoded = path.addingPercentEncoding(withAllowedCharacters: allowed)
        else { return nil }
        return "\(scheme):\(encoded)"
    }
}
