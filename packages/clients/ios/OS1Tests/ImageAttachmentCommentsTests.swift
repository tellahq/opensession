import XCTest
@testable import OS1

final class ImageAttachmentCommentsTests: XCTestCase {
    private let region = ImageAttachmentRegion(x: 0.124, y: 0.201, width: 0.3, height: 0.4)

    func testFormatsClampedRoundedReference() {
        XCTAssertEqual(
            ImageAttachmentComments.reference(imageIndex: 1, region: region),
            "[Image 2 · 12–42% × 20–60%]"
        )
        XCTAssertEqual(
            ImageAttachmentComments.reference(
                imageIndex: 0,
                region: ImageAttachmentRegion(x: -0.2, y: 0.996, width: 1.5, height: 0.2)
            ),
            "[Image 1 · 0–100% × 100–100%]"
        )
    }

    func testAppendsMultipleComments() {
        let first = ImageAttachmentComments.appending(
            to: "Intro", imageIndex: 0, region: region, comment: " Fix this "
        )
        let second = ImageAttachmentComments.appending(
            to: first, imageIndex: 1, region: region, comment: "And this"
        )
        XCTAssertEqual(
            second,
            "Intro\n[Image 1 · 12–42% × 20–60%] Fix this\n[Image 2 · 12–42% × 20–60%] And this"
        )
    }

    func testRemovingImageStripsItsReferencesAndRebasesLaterImages() {
        let draft = "[Image 1 · 12–42% × 20–60%] First\n"
            + "[Image 2 · 12–42% × 20–60%] Second\n"
            + "[Image 3 · 1–2% × 3–4%] Third"

        XCTAssertEqual(
            ImageAttachmentComments.rebasing(draft, removingImageAt: 0),
            "First\n[Image 1 · 12–42% × 20–60%] Second\n[Image 2 · 1–2% × 3–4%] Third"
        )
    }
}
