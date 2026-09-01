import XCTest
@testable import OS1

final class SidebarFeedsTests: XCTestCase {
    func testPlainFeedUsesTheSupportProductName() {
        XCTAssertEqual(SidebarFeeds.supportTitle, "Support")
    }

    func testHidingKeepsSourcesThisBuildDoesNotRender() {
        // The list is the account's, and the browser has bands the phone has
        // never heard of. Rewriting it must not quietly restore them.
        let stored = #"["video-library","linear"]"#
        let next = SidebarFeeds.setting(SidebarFeeds.plain, hidden: true, in: stored)

        XCTAssertEqual(SidebarFeeds.decode(next), ["video-library", "linear", "plain"])
    }

    func testShowingRemovesOnlyThatSource() {
        let stored = #"["video-library","plain","linear"]"#
        let next = SidebarFeeds.setting(SidebarFeeds.plain, hidden: false, in: stored)

        XCTAssertEqual(SidebarFeeds.decode(next), ["video-library", "linear"])
        XCTAssertFalse(SidebarFeeds.isHidden(SidebarFeeds.plain, in: next))
    }

    /// Both directions are no-ops when the value is already right — what lets
    /// `setVisible` skip the write (and the PUT behind it) on a repeat.
    func testSettingAnUnchangedValueLeavesTheListAlone() {
        let hidden = #"["plain"]"#
        XCTAssertEqual(
            SidebarFeeds.setting(SidebarFeeds.plain, hidden: true, in: hidden),
            hidden
        )
        let shown = #"["video-library"]"#
        XCTAssertEqual(
            SidebarFeeds.setting(SidebarFeeds.plain, hidden: false, in: shown),
            shown
        )
    }

    /// A stored value we can't read means nothing hidden: a missing source
    /// with no way to explain it is worse than one that came back.
    func testMalformedStorageReadsAsNothingHidden() {
        for junk in ["", "null", "{}", "[1,2]", "not json"] {
            XCTAssertEqual(SidebarFeeds.decode(junk), [], junk)
            XCTAssertFalse(SidebarFeeds.isHidden(SidebarFeeds.plain, in: junk), junk)
        }
        XCTAssertEqual(
            SidebarFeeds.decode(
                SidebarFeeds.setting(SidebarFeeds.plain, hidden: true, in: "nonsense")
            ),
            ["plain"]
        )
    }

    func testDecodeTrimsBlanksAndDuplicates() {
        XCTAssertEqual(
            SidebarFeeds.decode(#"[" plain ","","plain","video-library"]"#),
            ["plain", "video-library"]
        )
    }

    func testSourcesFollowTheServersFeeds() {
        let rows = SidebarFeeds.sources(
            known: [
                SidebarFeeds.Feed(id: "plain", title: "Plain"),
                SidebarFeeds.Feed(id: "linear", title: "Linear"),
            ],
            hidden: #"["linear"]"#
        )

        XCTAssertEqual(rows.map(\.id), ["plain", "linear"])
        XCTAssertEqual(rows.map(\.title), ["Plain", "Linear"])
        XCTAssertEqual(rows.map(\.unknown), [false, false])
    }

    /// The gap this list closes: a source hidden in the browser that this
    /// server no longer describes still needs a switch, or it can never come
    /// back from the phone.
    func testHiddenSourceTheServerDoesNotDescribeStillGetsARow() {
        let rows = SidebarFeeds.sources(
            known: [SidebarFeeds.Feed(id: "plain", title: "Plain")],
            hidden: #"["video-library","plain"]"#
        )

        XCTAssertEqual(rows.map(\.id), ["plain", "video-library"])
        // Nothing names it, so the id is the name rather than nothing at all.
        XCTAssertEqual(rows.last?.title, "video-library")
        XCTAssertEqual(rows.last?.unknown, true)
    }

    func testSourcesFallBackToTheIdWhenTheServerNamesNothing() {
        let rows = SidebarFeeds.sources(
            known: [
                SidebarFeeds.Feed(id: "video-library", title: nil),
                SidebarFeeds.Feed(id: " ", title: "Blank"),
                SidebarFeeds.Feed(id: "plain", title: "  "),
                SidebarFeeds.Feed(id: "video-library", title: "Video library"),
            ],
            hidden: "[]"
        )

        XCTAssertEqual(rows.map(\.id), ["video-library", "plain"])
        XCTAssertEqual(rows.map(\.title), ["video-library", "plain"])
    }

    func testSourcesAreEmptyWhenThereIsNothingToShow() {
        XCTAssertTrue(SidebarFeeds.sources(known: [], hidden: "[]").isEmpty)
        XCTAssertTrue(SidebarFeeds.sources(known: [], hidden: "junk").isEmpty)
    }
}
