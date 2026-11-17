import Foundation

/// Pull requests named in agent output, turned into chips you can tap.
///
/// A turn that opens a PR says so — "opened opensession#128", or pastes the
/// GitHub URL — and on the web that sentence carries a chip tinted by the PR's
/// live state, which opens the review in place. Natively the URL was an
/// external link that threw you into Safari, and `owner/repo#123` was plain
/// text. Both become one thing here: a markdown link on a private scheme,
/// intercepted through `openURL` like every other transcript chip.
///
/// The rules are the web's (src/frontend/lib/markdown.ts), because a reference
/// must mean the same thing in both clients:
///
/// - A mention only links when its repo is one this instance actually serves.
///   `vercel/next.js#1234` stays text rather than pointing a third party's
///   number at one of our repos.
/// - A QUALIFIED mention (`opensession#128`) always links. A BARE `#123` does
///   not, unless its number is long enough to be a PR rather than prose (short
///   `#numbers` are usually a step, a hex colour or a ranking) or the sessions
///   list already knows a PR by that number in the repo being read.
/// - The word `PR` in front of a short number is the other cue that says PR,
///   which is what lets `PR #92` link in a repo numbered under a thousand.
///
/// Conservative in the same way as the other rewrites: code — fenced,
/// indented, or a span — is left alone, and a URL already inside a link keeps
/// its own destination unless that destination is itself a PR we can open.
///
/// One chip per PR per message, as on the web: a reply that names the same PR
/// a dozen times would otherwise bury its prose under a dozen filled, tinted
/// pills. The first mention is the chip; every later one is an ordinary link
/// on the same private scheme, so it still opens the review in place. Which
/// PRs a message has already drawn is a `Ledger`, and the message boundary is
/// whoever owns it (`MarkdownBody`), not a line or a paragraph.
@MainActor
enum PrLinks {
    /// Private scheme, so a chip can never escape to a browser by accident.
    /// Where a tap lands is the transcript's decision (SessionView): this
    /// session's own PR opens its review panel, anything else falls back to
    /// the PR on github.com.
    static let scheme = "os1pr"

    /// A pull request a chip points at: a repo id this instance serves plus
    /// the PR number in it.
    struct Reference: Equatable {
        let repo: String
        let number: Int
    }

    /// The PRs a message has already drawn as a chip. A reference type so
    /// the per-line rewrite can fill it in as it goes; one per message.
    final class Ledger {
        private(set) var drawn: Set<String>

        init(drawn: Set<String> = []) {
            self.drawn = drawn
        }

        /// Replays a remembered rewrite: the PRs it drew are now drawn.
        func adopt(_ drawn: Set<String>) {
            self.drawn = drawn
        }

        /// Whether this is the first time the message names `reference`,
        /// recording it either way.
        fileprivate func claim(_ reference: Reference) -> Bool {
            drawn.insert(Index.key(reference.repo, reference.number)).inserted
        }
    }

    // MARK: - What the app knows

    /// repo id → `owner/name` on GitHub. The ids decide which qualified
    /// mentions can link at all; the GitHub name is what the fallback tap
    /// opens, so a repo without one still chips but only opens in-app.
    private static var repos: [String: String?] = [:]

    /// Everything the polled sessions list can say about the PRs in it.
    /// Built off the main actor with the rest of the list preparation — it
    /// walks thousands of rows, which is not something to do in a 5s poll on
    /// the main thread.
    struct Index: Equatable {
        /// `repo\0number` → what the chip's dot shows.
        var states: [String: PrDetails.Summary] = [:]
        /// session id → the repo a bare `#5528` in ITS transcript means.
        var repos: [String: String] = [:]

        nonisolated static func key(_ repo: String, _ number: Int) -> String {
            "\(repo)\u{0}\(number)"
        }

        /// The same fields the web hands `setKnownPrStates` — the sessions
        /// list carries a PR's state, draft flag and check rollup, so a chip
        /// for a PR some session in the list owns is live without fetching
        /// anything. A PR no session owns has no state here and draws no dot.
        nonisolated static func build(_ sessions: [Session]) -> Index {
            var index = Index()
            for session in sessions {
                guard let repo = session.repo, !repo.isEmpty else { continue }
                index.repos[session.id] = repo
                guard let number = session.prNumber,
                      let summary = summary(of: session) else { continue }
                // First writer wins: the newest session for a PR is the one
                // whose row the list sorts first, and a stale duplicate must
                // not overwrite it.
                let key = Self.key(repo, number)
                if index.states[key] == nil { index.states[key] = summary }
            }
            return index
        }

        /// The list's PR fields ranked exactly as `PrDetails.summary` ranks a
        /// fetched PR, so a chip and the PR panel never disagree.
        nonisolated private static func summary(of session: Session) -> PrDetails.Summary? {
            switch session.prState ?? "" {
            case "MERGED": return .merged
            case "CLOSED": return .closed
            default: break
            }
            if session.prIsDraft == true { return .draft }
            if (session.prChecks?.failed ?? 0) > 0 { return .failing }
            if (session.prChecks?.pending ?? 0) > 0 { return .pending }
            // No state at all means the list knows of no PR here; a row that
            // has one always carries at least its `prState`.
            guard session.prState != nil else { return nil }
            return .passing
        }
    }

    private static var index = Index()

    static func register(index next: Index) {
        guard next != index else { return }
        index = next
        TranscriptLinks.shared.invalidate()
    }

    /// Until this lands a mention has no repo it is allowed to point at, so a
    /// transcript drawn before it — a cold deep link — carries no PR chips at
    /// all rather than merely unstyled ones.
    static func register(repos next: [String: String?]) {
        guard next != repos else { return }
        repos = next
        TranscriptLinks.shared.invalidate()
    }

    /// The PR a transcript chip points at, or nil for a normal URL.
    static func reference(from url: URL) -> Reference? {
        guard url.scheme == scheme else { return nil }
        // os1pr:opensession/128 — the repo lands in `path` or `host`
        // depending on how the URL was spelled, so accept either.
        let candidate = url.host.map { $0 + url.path } ?? url.path
        let trimmed = candidate.hasPrefix("/") ? String(candidate.dropFirst()) : candidate
        let parts = trimmed.split(separator: "/")
        guard parts.count == 2, let number = Int(parts[1]) else { return nil }
        let repo = String(parts[0]).removingPercentEncoding ?? String(parts[0])
        return Reference(repo: repo, number: number)
    }

    /// Where a chip goes when this app can't show the PR itself.
    static func githubURL(for reference: Reference) -> URL? {
        guard let ghRepo = repos[reference.repo] ?? nil, !ghRepo.isEmpty else { return nil }
        return URL(string: "https://github.com/\(ghRepo)/pull/\(reference.number)")
    }

    /// Whether this reference is the PR of the session being read — the one
    /// case the app can open in place, since the review panel is built around
    /// a session's own view model.
    static func isOwnPr(_ reference: Reference, of session: Session) -> Bool {
        session.repo == reference.repo && session.prNumber == reference.number
    }

    // MARK: - Rewriting

    /// A bare mention has nothing but its digits to argue it is a PR at all.
    /// Measured on the web over 120k transcript entries: 4+ digits are
    /// overwhelmingly PRs, 1-3 digit runs are mostly step indices, hex colours
    /// and rankings. Repos numbered under a thousand link on a cue instead.
    private static let bareMinimumDigits = 4
    private static let numberMaxDigits = 5

    /// The mention as the web spells it. The `PR` cue must be followed by a
    /// space or the `#` itself, so a repo whose id merely starts with those
    /// letters (`prisma#12`) is read as the qualifier it is. The qualifier is
    /// part of the match so it can be vetted rather than left dangling in
    /// front of a chip — which also means a word glued to the `#` can never be
    /// mistaken for a bare mention.
    private static let mentionSource =
        "([Pp][Rr]s?(?:[ \\t]+|(?=#)))?"
        + "((?:[A-Za-z0-9][\\w.-]*/)?[A-Za-z0-9][\\w.-]*)?"
        + "#(\\d{1,\(numberMaxDigits)})(?!\\w)"

    /// A PR page on github.com, without a query or fragment — the same shape
    /// the web's `githubPrTarget` accepts.
    private static let prUrlSource =
        "https?://(?:www\\.)?github\\.com/([\\w.-]+)/([\\w.-]+)/pull/(\\d{1,\(numberMaxDigits)})/?"

    /// Skip alternatives come first, so at any position an existing link or a
    /// code span wins over what is inside it. The leading guard on the mention
    /// is a lookbehind rather than a consumed character: `&#8212;` entities and
    /// a `#` glued to a word or a path stay plain text.
    private static let pattern = try! NSRegularExpression(
        pattern:
            "(`[^`]*`"                        // inline code
            + "|!?\\[[^\\]]*\\]\\([^)]*\\)"   // [label](destination)
            + "|<[^>\\s]+>)"                  // <https://…>
            + "|(\(prUrlSource))(?![\\w/])"
            + "|(?<![\\w#&/])\(mentionSource)",
        options: []
    )

    /// An explicit link whose destination is a PR: `[PR #5528](https://…)` is
    /// everyday agent output, and it should open the review here rather than
    /// leave the app. Only the destination changes — the label the agent chose
    /// is what it wrote, and an image (`![…](…)`) is never a link to retarget.
    private static let linkDestination = try! NSRegularExpression(
        pattern: "(?<!!)(\\[[^\\]]*\\]\\()(\(prUrlSource))(\\))",
        options: []
    )

    /// Markdown with every PR reference rewritten as a chip. Returns the input
    /// unchanged when there is nothing to do, which is most text.
    ///
    /// `sessionId` is whose transcript this is: a bare `#5528` means the PR of
    /// that session's repo, exactly as the web's `renderMarkdown(src, { repo })`
    /// resolves one against the surface it renders on.
    ///
    /// `ledger` carries what the message has already drawn across the pieces
    /// it is rendered in (prose, table cells, a callout). Without one, the
    /// text is a whole message of its own.
    ///
    /// `ownPrs` are the PRs the conversation is about (`Index.key`). A
    /// mention of one stays the text it was written as, and a link to one
    /// keeps only its label: a chip there would open what the reader is
    /// already looking at. The web does the same (`renderMarkdown`'s
    /// `ownPrs`).
    static func linkify(
        _ markdown: String,
        sessionId: String?,
        ledger: Ledger = Ledger(),
        ownPrs: Set<String> = []
    ) -> String {
        guard markdown.contains("#") || markdown.contains("/pull/") else { return markdown }
        let contextRepo = sessionId.flatMap { index.repos[$0] }
        return MarkdownProse.rewrite(markdown) { line in
            guard line.contains("#") || line.contains("/pull/") else { return line }
            return rewriteMentions(
                in: retargetLinks(in: line, ownPrs: ownPrs),
                repo: contextRepo,
                ledger: ledger,
                ownPrs: ownPrs
            )
        }
    }

    private static func retargetLinks(in line: String, ownPrs: Set<String>) -> String {
        guard line.contains("/pull/") else { return line }
        let ns = line as NSString
        var result = ""
        var cursor = 0
        for match in linkDestination.matches(
            in: line,
            range: NSRange(location: 0, length: ns.length)
        ) {
            guard let reference = reference(
                owner: ns.substring(with: match.range(at: 3)),
                name: ns.substring(with: match.range(at: 4)),
                number: ns.substring(with: match.range(at: 5))
            ) else { continue }
            result += ns.substring(with: NSRange(
                location: cursor,
                length: match.range.location - cursor
            ))
            if ownPrs.contains(Index.key(reference.repo, reference.number)) {
                // `[label](` minus its brackets: the label alone, as prose.
                let opener = ns.substring(with: match.range(at: 1))
                result += String(opener.dropFirst().dropLast(2))
            } else {
                result += ns.substring(with: match.range(at: 1))
                result += destination(for: reference)
                result += ns.substring(with: match.range(at: 6))
            }
            cursor = match.range.location + match.range.length
        }
        guard cursor > 0 else { return line }
        result += ns.substring(from: cursor)
        return result
    }

    private static func rewriteMentions(
        in line: String,
        repo contextRepo: String?,
        ledger: Ledger,
        ownPrs: Set<String>
    ) -> String {
        let ns = line as NSString
        var result = ""
        var cursor = 0
        for match in pattern.matches(
            in: line,
            range: NSRange(location: 0, length: ns.length)
        ) {
            // Group 1 matched: an existing link or code span, copied verbatim.
            guard match.range(at: 1).location == NSNotFound else { continue }
            guard let chip = chip(
                for: match,
                in: ns,
                repo: contextRepo,
                ledger: ledger,
                ownPrs: ownPrs
            ) else { continue }
            result += ns.substring(with: NSRange(
                location: cursor,
                length: match.range.location - cursor
            ))
            result += chip
            cursor = match.range.location + match.range.length
        }
        guard cursor > 0 else { return line }
        result += ns.substring(from: cursor)
        return result
    }

    /// The markdown a single match becomes, or nil to leave it as it was
    /// written — nowhere to point, or nothing but short digits to go on.
    private static func chip(
        for match: NSTextCheckingResult,
        in ns: NSString,
        repo contextRepo: String?,
        ledger: Ledger,
        ownPrs: Set<String>
    ) -> String? {
        if match.range(at: 2).location != NSNotFound {
            guard let reference = reference(
                owner: ns.substring(with: match.range(at: 3)),
                name: ns.substring(with: match.range(at: 4)),
                number: ns.substring(with: match.range(at: 5))
            ) else { return nil }
            if ownPrs.contains(Index.key(reference.repo, reference.number)) {
                return "PR #\(reference.number)"
            }
            // A pasted URL is labelled like a mention: the address is 50
            // characters of noise, and the chip already says it is a PR.
            return link(label: "PR #\(reference.number)", to: reference, ledger: ledger)
        }
        let cue = match.range(at: 6).location == NSNotFound
            ? ""
            : ns.substring(with: match.range(at: 6))
        let qualifier = match.range(at: 7).location == NSNotFound
            ? nil
            : ns.substring(with: match.range(at: 7))
        let digits = ns.substring(with: match.range(at: 8))
        guard let number = Int(digits), let repo = repoId(for: qualifier, context: contextRepo)
        else { return nil }
        let reference = Reference(repo: repo, number: number)
        if ownPrs.contains(Index.key(reference.repo, reference.number)) { return nil }
        // A short number with nothing but its digits to go on is prose.
        if cue.isEmpty, qualifier == nil, !bareMentionLinks(reference, digits: digits) {
            return nil
        }
        // The cue stays prose: it reads as `PR` + a chip labelled `#92`, so a
        // chip that already says PR doesn't also spell the word out.
        let written = ns.substring(with: match.range).dropFirst(cue.count)
        return cue + link(label: String(written), to: reference, ledger: ledger)
    }

    /// The repo a mention points at, or nil when it can't be placed.
    private static func repoId(for qualifier: String?, context: String?) -> String? {
        guard let qualifier else { return context }
        // `owner/repo` and a bare `repo` both identify the repo by their last
        // segment: ids are instance-local, and the owner is noise we know.
        let id = qualifier.lastIndex(of: "/")
            .map { String(qualifier[qualifier.index(after: $0)...]) } ?? qualifier
        return repos.keys.contains(id) ? id : nil
    }

    private static func bareMentionLinks(_ reference: Reference, digits: String) -> Bool {
        digits.count >= bareMinimumDigits
            || index.states[Index.key(reference.repo, reference.number)] != nil
    }

    /// The repo id behind a GitHub `owner/name`, if this instance serves it.
    private static func reference(owner: String, name: String, number: String) -> Reference? {
        guard let number = Int(number) else { return nil }
        let target = "\(owner)/\(name)".lowercased()
        for (id, ghRepo) in repos where ghRepo?.lowercased() == target {
            return Reference(repo: id, number: number)
        }
        return nil
    }

    /// A chip the first time a message names `reference`, a plain link on the
    /// same private scheme after that: still tappable, still kept in the app,
    /// just not another filled pill. The tone belongs to the chip alone.
    private static func link(label: String, to reference: Reference, ledger: Ledger) -> String {
        guard ledger.claim(reference) else {
            return "[\(escaped(label))](\(destination(for: reference)))"
        }
        let summary = index.states[Index.key(reference.repo, reference.number)]
        return TranscriptChip(
            kind: .pullRequest,
            // The web colours the whole chip by the PR's live state
            // (`a.pr-ref[data-pr-tone]`), and now so does this: a wash and a
            // label in the state's own ink. It replaces a colour emoji, which
            // was what a one-colour markdown link could manage — three of them
            // in a paragraph read like a set of traffic lights, and none of
            // them could be told apart at a glance from the emoji an agent
            // writes on purpose.
            tone: summary?.chipTone ?? .neutral,
            title: label,
            accessibilityLabel: summary.map { "Open PR \(reference.number) · \($0.label)" }
                ?? "Open PR \(reference.number)",
            destination: destination(for: reference)
        ).markdown
    }

    private static func escaped(_ label: String) -> String {
        label
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "[", with: "\\[")
            .replacingOccurrences(of: "]", with: "\\]")
    }

    private static func destination(for reference: Reference) -> String {
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "._-~")
        let repo = reference.repo
            .addingPercentEncoding(withAllowedCharacters: allowed) ?? reference.repo
        return "\(scheme):\(repo)/\(reference.number)"
    }
}
