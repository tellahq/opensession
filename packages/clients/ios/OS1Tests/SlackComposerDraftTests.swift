import XCTest
@testable import OS1

@MainActor
final class SlackComposerDraftTests: XCTestCase {
    func testUpdateRequestUsesPatchAndCarriesTheWholeDraft() throws {
        let connection = ServerConnection(
            accountID: "work",
            baseURL: URL(string: "https://os.example.test")!,
            token: "secret"
        )

        let request = try SlackAPI.composerDraftRequest(
            connection: connection,
            sessionId: "os/a b",
            requestId: "request-1",
            channelId: "C123",
            message: "Edited message",
            screenshots: ["/tmp/one.png", "/tmp/two.png"]
        )
        let body = try XCTUnwrap(request.httpBody)
        let json = try XCTUnwrap(
            JSONSerialization.jsonObject(with: body) as? [String: Any]
        )

        XCTAssertEqual(request.httpMethod, "PATCH")
        XCTAssertEqual(request.url?.absoluteString, "https://os.example.test/api/sessions/os/a%20b/slack-composer")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer secret")
        XCTAssertEqual(json["requestId"] as? String, "request-1")
        XCTAssertEqual(json["channel"] as? String, "C123")
        XCTAssertEqual(json["message"] as? String, "Edited message")
        XCTAssertEqual(json["screenshots"] as? [String], ["/tmp/one.png", "/tmp/two.png"])
    }

    func testOrdinaryEditsAreDebounced() async {
        var updates: [(String, String)] = []
        let persistence = SlackComposerDraftPersistence(
            enabled: true,
            upload: { _, _ in XCTFail("No image should upload"); return "" },
            update: { message, channel, _ in updates.append((message, channel)) }
        )
        persistence.debounceDelay = .milliseconds(20)

        persistence.edited(message: "O", channel: "C1", images: [])
        persistence.edited(message: "Only latest", channel: "C2", images: [])
        try? await Task.sleep(for: .milliseconds(80))

        XCTAssertEqual(updates.count, 1)
        XCTAssertEqual(updates.first?.0, "Only latest")
        XCTAssertEqual(updates.first?.1, "C2")
    }

    func testSlowUploadCannotOverwriteANewerEdit() async {
        var continuation: CheckedContinuation<String, Error>?
        var updates: [(String, [String])] = []
        let persistence = SlackComposerDraftPersistence(
            enabled: true,
            upload: { _, _ in
                try await withCheckedThrowingContinuation { continuation = $0 }
            },
            update: { message, _, screenshots in updates.append((message, screenshots)) }
        )
        let image = AttachedImage(id: "new-image", jpegData: Data([1, 2, 3]))
        let draftImage = SlackComposerDraftImage(image: image, uploadedPath: nil)

        persistence.edited(message: "First", channel: "C1", images: [draftImage])
        let flush = Task {
            await persistence.flush(message: "First", channel: "C1", images: [draftImage])
        }
        while continuation == nil { await Task.yield() }
        persistence.edited(message: "Newest", channel: "C2", images: [draftImage])
        continuation?.resume(returning: "/uploads/new-image.jpg")
        await flush.value

        XCTAssertEqual(updates.count, 1)
        XCTAssertEqual(updates.first?.0, "Newest")
        XCTAssertEqual(updates.first?.1, ["/uploads/new-image.jpg"])
    }

    func testFlushKeepsExistingImagePathsWithoutUploading() async {
        var savedScreenshots: [String] = []
        let persistence = SlackComposerDraftPersistence(
            enabled: true,
            upload: { _, _ in XCTFail("Existing paths should not upload"); return "" },
            update: { _, _, screenshots in savedScreenshots = screenshots }
        )
        let existing = SlackComposerDraftImage(uploadedPath: "/tmp/existing.png")

        persistence.edited(message: "Edited", channel: "C1", images: [existing])
        await persistence.flush(message: "Edited", channel: "C1", images: [existing])

        XCTAssertEqual(savedScreenshots, ["/tmp/existing.png"])
    }

    func testSaveFailureIsActionableAndTheNextEditRetries() async {
        enum SaveError: LocalizedError {
            case offline
            var errorDescription: String? { "Check your connection." }
        }
        var attempts = 0
        let persistence = SlackComposerDraftPersistence(
            enabled: true,
            upload: { _, _ in "" },
            update: { _, _, _ in
                attempts += 1
                if attempts == 1 { throw SaveError.offline }
            }
        )

        persistence.edited(message: "First", channel: "C1", images: [])
        await persistence.flush(message: "First", channel: "C1", images: [])
        XCTAssertEqual(
            persistence.errorMessage,
            "Couldn't save this Slack draft. Check your connection. Keep editing to retry."
        )

        persistence.edited(message: "Second", channel: "C1", images: [])
        await persistence.flush(message: "Second", channel: "C1", images: [])
        XCTAssertEqual(attempts, 2)
        XCTAssertNil(persistence.errorMessage)
    }

    func testNonComposerSharesNeverPersist() async {
        var updates = 0
        let persistence = SlackComposerDraftPersistence(
            enabled: false,
            upload: { _, _ in "" },
            update: { _, _, _ in updates += 1 }
        )

        persistence.edited(message: "PR share", channel: "C1", images: [])
        await persistence.flush(message: "PR share", channel: "C1", images: [])

        XCTAssertEqual(updates, 0)
    }
}
