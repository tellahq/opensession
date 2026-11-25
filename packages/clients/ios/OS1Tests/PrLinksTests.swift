import XCTest
@testable import OS1

/// A PR chip is a claim about which pull request a sentence means, so the
/// rewrite has to be as timid as the ones around it: a reference it cannot
/// place stays exactly as the agent wrote it, and anything quoted as code
/// survives byte for byte.
///
/// The rules being pinned here are the web's (src/frontend/lib/markdown.ts) —
/// a reference has to mean the same PR in both clients.
@MainActor
final class PrLinksTests: XCTestCase {
    private let session = "os-test"

    override func setUp() async throws {
        PrLinks.register(repos: [
            "opensession": "tellahq/opensession",
            "tella-fusion": "tellahq/tella-fusion",
            // A repo the server serves without a GitHub name: it still chips,
            // it just has nowhere external to fall back to.
            "notes": nil,
        ])
        PrLinks.register(index: PrLinks.Index.build(try sessions(
            """
            [{"id":"os-test","repo":"opensession"},
             {"id":"os-other","repo":"opensession","prNumber":92,"prState":"MERGED"}]
            """
        )))
    }

    private func sessions(_ json: String) throws -> [Session] {
        try JSONDecoder().decode([Session].self, from: Data(json.utf8))
    }

    /// A PR draws as a chip, whose label rides in the destination's query and
    /// whose live state is a tone rather than words. `chipsAsLinks` turns one
    /// back into the link it stands for, so these expectations stay about
    /// which mentions are claimed; the tone has its own test below.
    private func linkify(_ markdown: String) -> String {
        chipsAsLinks(PrLinks.linkify(markdown, sessionId: session))
    }

    // MARK: - The forms a PR is written in

    func testFullPrUrlBecomesAChip() {
        XCTAssertEqual(
            linkify("opened https://github.com/tellahq/opensession/pull/5528 for review"),
            "opened [PR #5528](os1pr:opensession/5528) for review"
        )
    }

    func testQualifiedMentionBecomesAChip() {
        XCTAssertEqual(
            linkify("landed in tella-fusion#5528 today"),
            "landed in [tella-fusion#5528](os1pr:tella-fusion/5528) today"
        )
        // `owner/repo#123` names the same repo: the id is instance-local and
        // the owner is noise we already know.
        XCTAssertEqual(
            linkify("see tellahq/opensession#128"),
            "see [tellahq/opensession#128](os1pr:opensession/128)"
        )
    }

    /// A qualified mention always links, however short its number — which is
    /// the whole reason the qualifier is matched rather than left dangling.
    func testShortQualifiedMentionStillLinks() {
        XCTAssertEqual(
            linkify("backported to tella-fusion#14"),
            "backported to [tella-fusion#14](os1pr:tella-fusion/14)"
        )
    }

    // MARK: - What must stay plain text

    /// The rule the repo convention asks for: short bare `#numbers` in prose
    /// are steps, hex colours and rankings far more often than they are PRs.
    func testBareShortNumberIsNotLinked() {
        for text in ["step #3 of the plan", "color: #333 on the panel", "ranked #29"] {
            XCTAssertEqual(linkify(text), text, text)
        }
    }

    /// Long enough to be a PR rather than prose.
    func testBareLongNumberLinksAgainstTheSessionsRepo() {
        XCTAssertEqual(
            linkify("rebased #5528 on main"),
            "rebased [#5528](os1pr:opensession/5528) on main"
        )
    }

    /// A short number links when something other than its digits says PR: the
    /// word in front of it, or a PR the sessions list already knows there.
    func testShortNumberLinksOnACue() {
        XCTAssertEqual(
            linkify("PR #14 is next"),
            "PR [#14](os1pr:opensession/14)"  + " is next"
        )
    }

    func testShortNumberLinksWhenTheListKnowsThatPr() {
        // os-other owns opensession#92, so the list can place it.
        XCTAssertEqual(
            linkify("shipped in #92"),
            "shipped in [#92](os1pr:opensession/92)"
        )
    }


    /// A repo this instance doesn't serve must never be pointed at one of
    /// ours: the mention stays text, and the URL stays a plain link for
    /// `MarkdownAutolink` to open in the browser.
    func testUnknownRepoIsLeftAlone() {
        for text in [
            "see vercel/next.js#1234 for the bug",
            "see https://github.com/vercel/next.js/pull/1234 for the bug",
        ] {
            XCTAssertEqual(linkify(text), text, text)
        }
    }

    /// Nothing to place a bare mention against — a card outside a session, or
    /// a session with no repo.
    func testBareMentionWithoutARepoIsLeftAlone() {
        let text = "rebased #5528 on main"
        XCTAssertEqual(PrLinks.linkify(text, sessionId: nil), text)
    }

    /// A word glued to the `#` is a qualified mention by that word, not a bare
    /// one — so an unknown qualifier can't leave its digits behind to be read
    /// as a PR of the session's own repo. Entities stay entities.
    func testGluedAndEntityFormsAreLeftAlone() {
        for text in ["abc#5528 in the log", "an &#8212; dash", "issue-#5528"] {
            XCTAssertEqual(linkify(text), text, text)
        }
    }

    // MARK: - Code survives

    func testNumberInACodeSpanIsLeftAlone() {
        let text = "the header said `#5528` verbatim"
        XCTAssertEqual(linkify(text), text)
    }

    func testNumberInAFenceIsLeftAlone() {
        let text = """
        Run it:

        ```sh
        git show #5528
        curl https://github.com/tellahq/opensession/pull/5528
        ```

        then read #5528
        """
        let out = linkify(text)
        XCTAssertTrue(out.contains("git show #5528\n"), out)
        XCTAssertTrue(
            out.contains("curl https://github.com/tellahq/opensession/pull/5528\n"),
            out
        )
        XCTAssertTrue(out.contains("then read [#5528](os1pr:opensession/5528)"), out)
    }

    func testIndentedCodeIsLeftAlone() {
        let text = "    git show #5528"
        XCTAssertEqual(linkify(text), text)
    }

    // MARK: - Links

    /// `[PR #5528](https://github.com/…)` is everyday agent output. The label
    /// the agent chose stays; only where it goes changes.
    func testExplicitLinkToAPrIsRetargeted() {
        XCTAssertEqual(
            linkify("see [the PR](https://github.com/tellahq/opensession/pull/5528)"),
            "see [the PR](os1pr:opensession/5528)"
        )
    }

    /// A chip inside a link would nest one link in another. The skip
    /// alternatives are what stop that.
    func testMentionInsideALinkLabelIsLeftAlone() {
        let text = "[opensession#5528](https://example.com/x)"
        XCTAssertEqual(linkify(text), text)
    }

    func testImageDestinationIsNotRetargeted() {
        let text = "![shot](https://github.com/tellahq/opensession/pull/5528)"
        XCTAssertEqual(linkify(text), text)
    }

    // MARK: - The conversation's own PR

    /// In the session that IS a PR's conversation, that PR's status pill
    /// would only repeat the toolbar, so every form of it is a plain link on
    /// the private scheme: still tappable, opening the review in place.
    /// Any other PR keeps its chip.
    func testOwnPrIsAPlainLink() {
        let own: Set<String> = [PrLinks.Index.key("opensession", 5528)]
        func raw(_ text: String) -> String {
            PrLinks.linkify(text, sessionId: session, ownPrs: own)
        }
        XCTAssertEqual(
            raw("rebased #5528 on main"),
            "rebased [#5528](os1pr:opensession/5528) on main"
        )
        XCTAssertEqual(
            raw("see opensession#5528"),
            "see [opensession#5528](os1pr:opensession/5528)"
        )
        XCTAssertEqual(
            raw("opened https://github.com/tellahq/opensession/pull/5528 for review"),
            "opened [PR #5528](os1pr:opensession/5528) for review"
        )
        XCTAssertEqual(
            raw("see [the PR](https://github.com/tellahq/opensession/pull/5528)"),
            "see [the PR](os1pr:opensession/5528)"
        )
        // The other PR is a real chip, even after the own PR was named.
        let mixed = raw("#5528 replaces tella-fusion#5528")
        XCTAssertTrue(mixed.hasPrefix("[#5528](os1pr:opensession/5528) replaces "), mixed)
        XCTAssertNotEqual(chipsAsLinks(mixed), mixed, mixed)
        XCTAssertEqual(
            chipsAsLinks(mixed),
            "[#5528](os1pr:opensession/5528) replaces [tella-fusion#5528](os1pr:tella-fusion/5528)"
        )
    }

    /// The own link points where the chip would: the same reference, so the
    /// transcript's tap handler opens the session's review for it.
    func testOwnPrLinkOpensTheSameReferenceAsAChip() throws {
        let own: Set<String> = [PrLinks.Index.key("opensession", 5528)]
        let out = PrLinks.linkify("see opensession#5528", sessionId: session, ownPrs: own)
        let start = try XCTUnwrap(out.range(of: "(os1pr:"))
        let destination = out[out.index(after: start.lowerBound)...].dropLast()
        XCTAssertEqual(
            PrLinks.reference(from: try XCTUnwrap(URL(string: String(destination)))),
            PrLinks.Reference(repo: "opensession", number: 5528)
        )
    }

    /// Without an own PR (a session with several, where `ownPrKeys` is
    /// empty) every PR mention is a chip.
    func testNoOwnPrKeepsEveryChip() {
        let out = PrLinks.linkify(
            "#5528 and opensession#92",
            sessionId: session,
            ownPrs: []
        )
        XCTAssertEqual(out.components(separatedBy: "[os1chip](").count - 1, 2, out)
        XCTAssertEqual(
            chipsAsLinks(out),
            "[#5528](os1pr:opensession/5528) and [opensession#92](os1pr:opensession/92)"
        )
    }

    func testOwnPrKeysNameTheOnePrASessionIsAbout() throws {
        let one = try sessions(
            """
            [{"id":"os-1","repo":"opensession","branch":"fix","prNumber":5528,
              "prs":[{"repo":"opensession","branch":"fix","source":"primary","number":5528}]}]
            """
        )[0]
        XCTAssertEqual(PrLinks.ownPrKeys(of: one), [PrLinks.Index.key("opensession", 5528)])

        let none = try sessions(#"[{"id":"os-2","repo":"opensession","branch":"fix"}]"#)[0]
        XCTAssertEqual(PrLinks.ownPrKeys(of: none), [])
    }

    /// A session that opened several PRs has no single PR it is about, so
    /// none of them loses its chip.
    func testSessionWithSeveralPrsHasNoOwnPr() throws {
        let several = try sessions(
            """
            [{"id":"os-3","repo":"opensession","branch":"fix","prNumber":5528,
              "prs":[{"repo":"opensession","branch":"fix","source":"primary","number":5528},
                     {"repo":"tella-fusion","branch":"fix","source":"attached","number":77}]}]
            """
        )[0]
        XCTAssertEqual(PrLinks.ownPrKeys(of: several), [])
    }

    // MARK: - Where a chip points

    func testReferenceRoundTripsThroughItsUrl() {
        let url = URL(string: "os1pr:opensession/5528")!
        XCTAssertEqual(
            PrLinks.reference(from: url),
            PrLinks.Reference(repo: "opensession", number: 5528)
        )
        XCTAssertNil(PrLinks.reference(from: URL(string: "https://tella.tv")!))
    }

    func testGithubFallbackNeedsAGithubName() {
        XCTAssertEqual(
            PrLinks.githubURL(for: .init(repo: "opensession", number: 5528)),
            URL(string: "https://github.com/tellahq/opensession/pull/5528")
        )
        XCTAssertNil(PrLinks.githubURL(for: .init(repo: "notes", number: 5528)))
    }

    func testOwnPrIsTheOneThisAppCanOpenInPlace() throws {
        let session = try sessions(
            """
            [{"id":"os-1","repo":"opensession","prNumber":5528}]
            """
        )[0]
        XCTAssertTrue(
            PrLinks.isOwnPr(.init(repo: "opensession", number: 5528), of: session)
        )
        XCTAssertFalse(
            PrLinks.isOwnPr(.init(repo: "opensession", number: 92), of: session)
        )
        XCTAssertFalse(
            PrLinks.isOwnPr(.init(repo: "tella-fusion", number: 5528), of: session)
        )
    }

    // MARK: - Live state

    /// The dot mirrors `PrChipLabel`'s, so a PR reads the same in the prose
    /// and in the toolbar. A PR no session in the list owns has no state to
    /// show and draws none.
    func testStateRidesOnTheChipOnlyWhenTheListKnowsIt() {
        // The list owns opensession#92 and knows it merged, so the chip is
        // toned; the label itself is what the sentence wrote, either way.
        let known = PrLinks.linkify("opensession#92", sessionId: session)
        XCTAssertEqual(chipParameter("chipKind", in: known), "pr")
        XCTAssertEqual(chipParameter("chipTone", in: known), "purple")
        XCTAssertEqual(chipsAsLinks(known), "[opensession#92](os1pr:opensession/92)")

        let unknown = PrLinks.linkify("opensession#5528", sessionId: session)
        XCTAssertEqual(chipParameter("chipTone", in: unknown), "neutral")
        XCTAssertEqual(chipsAsLinks(unknown), "[opensession#5528](os1pr:opensession/5528)")
    }

    func testListStateIsRankedLikeTheFetchedPr() throws {
        let index = PrLinks.Index.build(try sessions(
            """
            [{"id":"a","repo":"opensession","prNumber":1,"prState":"OPEN",
              "prChecks":{"total":3,"passed":2,"failed":1,"pending":0}},
             {"id":"b","repo":"opensession","prNumber":2,"prState":"OPEN",
              "prChecks":{"total":3,"passed":2,"failed":0,"pending":1}},
             {"id":"c","repo":"opensession","prNumber":3,"prState":"OPEN","prIsDraft":true},
             {"id":"d","repo":"opensession","prNumber":4,"prState":"OPEN"},
             {"id":"e","repo":"opensession","prNumber":5,"prState":"CLOSED"},
             {"id":"f","repo":"opensession","prNumber":6}]
            """
        ))
        let key = PrLinks.Index.key
        XCTAssertEqual(index.states[key("opensession", 1)], .failing)
        XCTAssertEqual(index.states[key("opensession", 2)], .pending)
        XCTAssertEqual(index.states[key("opensession", 3)], .draft)
        XCTAssertEqual(index.states[key("opensession", 4)], .passing)
        XCTAssertEqual(index.states[key("opensession", 5)], .closed)
        // A row with a number but no state at all says nothing about it.
        XCTAssertNil(index.states[key("opensession", 6)])
    }

    // MARK: - One chip per PR per message

    private func chipCount(_ markdown: String) -> Int {
        markdown.components(separatedBy: "[os1chip](").count - 1
    }

    /// The web's rule: the first mention is the chip, later ones are
    /// ordinary links that still open the same review, never github.com.
    func testRepeatedMentionAcrossParagraphsIsOneChip() {
        let raw = PrLinks.linkify(
            "#5528 fixes it.\n\n**opensession#5528** lands first, then PR #5528.",
            sessionId: session
        )
        XCTAssertEqual(chipCount(raw), 1, raw)
        XCTAssertEqual(
            chipsAsLinks(raw),
            "[#5528](os1pr:opensession/5528) fixes it.\n\n"
                + "**[opensession#5528](os1pr:opensession/5528)** lands first, "
                + "then PR [#5528](os1pr:opensession/5528)."
        )
    }

    /// A pasted URL and a mention are the same PR, so they share one chip;
    /// the repeat keeps the URL's short label and the private scheme.
    func testUrlAfterAMentionIsAQuietLink() {
        let raw = PrLinks.linkify(
            "opened #5528\nsee https://github.com/tellahq/opensession/pull/5528",
            sessionId: session
        )
        XCTAssertEqual(chipCount(raw), 1, raw)
        XCTAssertTrue(raw.hasSuffix("see [PR #5528](os1pr:opensession/5528)"), raw)
    }

    /// Only the same repo AND number is the same PR.
    func testDistinctReposAndNumbersEachGetAChip() {
        let raw = PrLinks.linkify(
            "#5528 and tella-fusion#5528 and #5832, then #5528 and tella-fusion#5528.",
            sessionId: session
        )
        XCTAssertEqual(chipCount(raw), 3, raw)
        XCTAssertTrue(
            raw.hasSuffix("then [#5528](os1pr:opensession/5528) and "
                + "[tella-fusion#5528](os1pr:tella-fusion/5528)."),
            raw
        )
    }

    /// The state tone belongs to the chip: the first mention carries it, and
    /// a repeat is a plain link with no chip parameters at all.
    func testToneStaysOnTheFirstChip() {
        let raw = PrLinks.linkify("opensession#92 merged. #92 is done.", sessionId: session)
        XCTAssertEqual(chipCount(raw), 1, raw)
        XCTAssertEqual(chipParameter("chipTone", in: raw), "purple")
        XCTAssertTrue(raw.hasSuffix(" [#92](os1pr:opensession/92) is done."), raw)
    }

    /// An explicit link keeps the label its author wrote and stays a link; it
    /// neither becomes a chip nor uses up the chip a later mention gets.
    func testExplicitLinkNeitherChipsNorConsumesTheChip() {
        let raw = PrLinks.linkify(
            "see [the PR](https://github.com/tellahq/opensession/pull/5528), #5528, and #5528",
            sessionId: session
        )
        XCTAssertEqual(chipCount(raw), 1, raw)
        XCTAssertEqual(
            chipsAsLinks(raw),
            "see [the PR](os1pr:opensession/5528), [#5528](os1pr:opensession/5528), "
                + "and [#5528](os1pr:opensession/5528)"
        )
    }

    /// Code is not a mention, so it can't use up the chip either.
    func testCodeNeitherLinksNorConsumesTheChip() {
        let raw = PrLinks.linkify(
            "`#5528`\n\n```\n#5528\n```\n\nthen #5528 and #5528",
            sessionId: session
        )
        XCTAssertEqual(chipCount(raw), 1, raw)
        XCTAssertTrue(raw.hasPrefix("`#5528`\n\n```\n#5528\n```\n\nthen [os1chip]("), raw)
        XCTAssertTrue(raw.hasSuffix(" and [#5528](os1pr:opensession/5528)"), raw)
    }

    /// The ledger is the message boundary: pieces of one message rendered
    /// apart (prose, a table cell, a callout) share one; a new message, or a
    /// call without one, starts over.
    func testLedgerIsTheMessageBoundary() {
        let message = PrLinks.Ledger()
        let prose = PrLinks.linkify("opened #5528", sessionId: session, ledger: message)
        let cell = PrLinks.linkify("#5528", sessionId: session, ledger: message)
        XCTAssertEqual(chipCount(prose), 1, prose)
        XCTAssertEqual(cell, "[#5528](os1pr:opensession/5528)")

        // A nested body (callout, slide) starts from what came before it.
        let callout = PrLinks.Ledger(drawn: message.drawn)
        XCTAssertEqual(
            PrLinks.linkify("#5528", sessionId: session, ledger: callout),
            "[#5528](os1pr:opensession/5528)"
        )

        let next = PrLinks.linkify("merged #5528", sessionId: session)
        XCTAssertEqual(chipCount(next), 1, next)
    }

    /// A row re-renders whenever a registry changes, and the text grows while
    /// it settles out of the stream. Each render is the whole message from
    /// scratch, so the chip never migrates or disappears.
    func testRerenderingAMessageIsStable() {
        let first = PrLinks.linkify("opened #5528", sessionId: session)
        let grown = PrLinks.linkify("opened #5528, then #5528 again", sessionId: session)
        XCTAssertEqual(PrLinks.linkify("opened #5528", sessionId: session), first)
        XCTAssertTrue(grown.hasPrefix(first), grown)
        XCTAssertEqual(chipCount(grown), 1, grown)
        XCTAssertEqual(
            PrLinks.linkify("opened #5528, then #5528 again", sessionId: session),
            grown
        )
    }

    /// A repeat is still a private-scheme link, so the transcript's `openURL`
    /// handler claims it instead of Safari.
    func testRepeatLinkReadsBackAsTheSameReference() throws {
        let raw = PrLinks.linkify("#5528 #5528", sessionId: session)
        let destination = try XCTUnwrap(raw.components(separatedBy: "](").last?.dropLast())
        XCTAssertEqual(
            PrLinks.reference(from: try XCTUnwrap(URL(string: String(destination)))),
            PrLinks.Reference(repo: "opensession", number: 5528)
        )
    }

    // MARK: - Living beside the other rewrites

    /// The order `MarkdownBody` uses. A PR URL has to become a chip before
    /// autolinking claims it, and what it produces has to survive every
    /// rewrite that runs after it.
    func testChipSurvivesTheRestOfThePipeline() {
        let out = chipsAsLinks(SessionLinks.linkify(
            MarkdownAutolink.linkify(
                PrLinks.linkify(
                    "opened https://github.com/tellahq/opensession/pull/5528 · docs at https://tella.tv",
                    sessionId: session
                )
            )
        ))
        XCTAssertEqual(
            out,
            "opened [PR #5528](os1pr:opensession/5528) · docs at [https://tella.tv](https://tella.tv)"
        )
    }
}
