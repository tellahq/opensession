import XCTest
@testable import OS1

@MainActor
final class NewSessionImageAttachmentTests: XCTestCase {
    private let region = ImageAttachmentRegion(x: 0.12, y: 0.2, width: 0.36, height: 0.4)

    func testCommentUpdatesNewSessionPrompt() {
        let prompt = NewSessionView.appendingImageComment(
            to: "Increase contrast",
            imageIndex: 1,
            region: region,
            comment: " Make this button clearer "
        )

        XCTAssertEqual(
            prompt,
            "Increase contrast\n[Image 2 · 12–48% × 20–60%] Make this button clearer"
        )
    }

    func testRemovalUpdatesNewSessionImagesAndPrompt() {
        let images = ["one", "two", "three"].map {
            AttachedImage(id: $0, jpegData: Data($0.utf8))
        }
        let prompt = "Intro\n"
            + "[Image 1 · 10–20% × 30–40%] First\n"
            + "[Image 2 · 20–30% × 40–50%] Second\n"
            + "[Image 3 · 30–40% × 50–60%] Third"

        let state = NewSessionView.removingImage(images[1], from: images, prompt: prompt)

        XCTAssertEqual(state.images.map(\.id), ["one", "three"])
        XCTAssertEqual(
            state.prompt,
            "Intro\n[Image 1 · 10–20% × 30–40%] First\nSecond\n"
                + "[Image 2 · 30–40% × 50–60%] Third"
        )
    }
}
