import XCTest
@testable import OS1

/// Team-note read receipts: decoding `seenBy`, and who the newest comment
/// tags. Ported from src/frontend/lib/comment-threads.test.ts.
final class NoteReceiptsTests: XCTestCase {
    private let people: [NoteReceipts.Person] = [
        .init(name: "Ada", fullName: "Ada Lovelace"),
        .init(name: "Bob", fullName: "Bob Ross"),
        .init(name: "Cy", fullName: "Cy Twombly"),
    ]

    private func note(_ text: String, seenBy: [ThreadSeen] = []) -> CommentThread {
        CommentThread(
            id: "n1",
            sessionId: "os-1",
            createdBy: "Ada",
            ts: 1_000,
            updatedAt: 1_000,
            comments: [ThreadComment(id: "n1", user: "Ada", text: text, ts: 1_000)],
            seenBy: seenBy
        )
    }

    // MARK: - Decoding

    func testSeenByDecodesAndSkipsMalformedReceipts() throws {
        let thread = try JSONDecoder().decode(CommentThread.self, from: Data(#"""
        {"id":"n1","comments":[{"id":"n1","user":"Ada","text":"@Bob","ts":1000}],
         "seenBy":[{"user":"Bob","ts":1500},{"user":"","ts":1},{"ts":2},{"user":"Cy"},"junk",{"user":"Dee","ts":"x"}]}
        """#.utf8))
        XCTAssertEqual(thread.seenBy, [ThreadSeen(user: "Bob", ts: 1_500)])
    }

    func testAMissingOrMalformedSeenByIsEmpty() throws {
        for extra in ["", #","seenBy":null"#, #","seenBy":"Bob""#, #","seenBy":{"user":"Bob"}"#] {
            let json = #"{"id":"n1","comments":[{"id":"n1","user":"Ada","text":"hi","ts":1}]"# + extra + "}"
            let thread = try JSONDecoder().decode(CommentThread.self, from: Data(json.utf8))
            XCTAssertEqual(thread.seenBy, [], extra)
        }
    }

    // MARK: - Tagged receipts

    func testOnlyPeopleTaggedInTheNewestCommentGetAReceipt() {
        XCTAssertEqual(NoteReceipts.tagged(note("Ship it"), people: people), [])
        XCTAssertEqual(NoteReceipts.tagged(note("@Ada and @nobody"), people: people), [])
        let thread = note("@Bob @cy can you sign it? cc @Bob", seenBy: [
            ThreadSeen(user: "Bob", ts: 1_500),
            ThreadSeen(user: "Cy", ts: 900),
            ThreadSeen(user: "Dee", ts: 1_600),
        ])
        XCTAssertEqual(NoteReceipts.tagged(thread, people: people), [
            TagReceipt(name: "Bob", seenAt: 1_500),
            TagReceipt(name: "Cy"),
        ])
    }

    func testAFullNameReceiptAndTrailingPunctuationCount() {
        let thread = note("Thanks @bob, see https://example.test/@Cy", seenBy: [ThreadSeen(user: "Bob Ross", ts: 1_200)])
        XCTAssertEqual(NoteReceipts.tagged(thread, people: people), [TagReceipt(name: "Bob", seenAt: 1_200)])
    }

    func testOnlyATaggedViewerOwesAReceiptUntilTheirsIsFresh() {
        XCTAssertTrue(NoteReceipts.needsSeenMark(note("@Bob look"), me: "Bob", people: people))
        XCTAssertFalse(NoteReceipts.needsSeenMark(note("@Bob look"), me: "Cy", people: people))
        XCTAssertFalse(NoteReceipts.needsSeenMark(note("look"), me: "Bob", people: people))
        XCTAssertFalse(NoteReceipts.needsSeenMark(
            note("@Bob look", seenBy: [ThreadSeen(user: "bob", ts: 1_000)]),
            me: "Bob",
            people: people
        ))
        XCTAssertFalse(NoteReceipts.needsSeenMark(note("@Bob look"), me: " ", people: people))
    }

    func testNamesReadNaturally() {
        XCTAssertEqual(NoteReceipts.label(["Ada"]), "Ada")
        XCTAssertEqual(NoteReceipts.label(["Ada", "Bob"]), "Ada and Bob")
        XCTAssertEqual(NoteReceipts.label(["Ada", "Bob", "Cy"]), "Ada, Bob and Cy")
        XCTAssertEqual(NoteReceipts.label(["Ada", "Bob", "Cy", "Di"]), "Ada, Bob and 2 others")
    }

    func testTheLineSplitsSeenFromNotSeen() {
        XCTAssertNil(NoteReceipts.line([]))
        XCTAssertEqual(
            NoteReceipts.line([TagReceipt(name: "Bob", seenAt: 1), TagReceipt(name: "Cy")]),
            "Seen by Bob \u{00b7} Not seen by Cy"
        )
        XCTAssertEqual(NoteReceipts.line([TagReceipt(name: "Cy")]), "Not seen by Cy")
    }
}
