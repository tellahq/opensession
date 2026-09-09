import Testing
@testable import OS1

/// The rule that decides whose turn it is to review. It has to match the web
/// sidebar's exactly (`wsPrRequestsReviewFrom` / `reviewAskerFor` in
/// lib/review-queue), because the two clients read the same field and a
/// disagreement shows up as a mark that is present on one device and missing
/// on the other.
struct ReviewRequestsTests {
    private func session(
        id: String,
        requested: [String]? = nil,
        author: String? = nil,
        requester: String? = nil
    ) -> Session {
        var session = Session(id: id)
        session.prReviewRequested = requested
        session.prAuthor = author
        session.prRequester = requester
        return session
    }

    @Test func matchesTheViewerByFirstNameKey() {
        #expect(
            ReviewRequests.waitsOnViewer(
                [session(id: "a", requested: ["kent"], author: "jfrolich")],
                viewerName: "Kent de Bruin",
                viewerLogin: "kentdebruin"
            )
        )
    }

    @Test func matchesADevicePastedTokenByLoginAlone() {
        #expect(
            ReviewRequests.waitsOnViewer(
                [session(id: "a", requested: ["kent"])],
                viewerName: "",
                viewerLogin: "kentdebruin"
            )
        )
    }

    @Test func ignoresARequestPointedAtSomebodyElse() {
        #expect(
            !ReviewRequests.waitsOnViewer(
                [session(id: "a", requested: ["alex"], author: "jfrolich")],
                viewerName: "Kent de Bruin",
                viewerLogin: "kentdebruin"
            )
        )
    }

    @Test func clearsOnceTheReviewIsSubmitted() {
        // GitHub drops the reviewer from the list, which is the only thing
        // this reads — so an empty list means done, whatever else the PR says.
        #expect(
            !ReviewRequests.waitsOnViewer(
                [session(id: "a", requested: [], author: "jfrolich")],
                viewerName: "Kent de Bruin",
                viewerLogin: "kentdebruin"
            )
        )
    }

    @Test func countsARequestOnAnyOfTheRowsSessions() {
        #expect(
            ReviewRequests.waitsOnViewer(
                [
                    session(id: "a", requested: [], author: "jfrolich"),
                    session(id: "b", requested: ["kent"], author: "happylinks"),
                ],
                viewerName: "Kent de Bruin",
                viewerLogin: "kentdebruin"
            )
        )
    }

    @Test func namesTheAuthorWaitingOnYou() {
        #expect(
            ReviewRequests.askerLogin(
                [
                    session(id: "a", requested: [], author: "someone-else"),
                    session(id: "b", requested: ["kent"], author: "happylinks"),
                ],
                viewerName: "Kent de Bruin",
                viewerLogin: "kentdebruin"
            ) == "happylinks"
        )
    }

    @Test func namesTheRequesterBehindABotAuthoredPullRequest() {
        #expect(
            ReviewRequests.askerLogin(
                [
                    session(
                        id: "a",
                        requested: ["kent"],
                        author: "tella-butler",
                        requester: "johnnylinsf"
                    )
                ],
                viewerName: "Kent de Bruin",
                viewerLogin: "kentdebruin"
            ) == "johnnylinsf"
        )
    }

    @Test func namesNobodyWhenNoRequestIsPointedAtYou() {
        #expect(
            ReviewRequests.askerLogin(
                [session(id: "a", requested: ["alex"], author: "happylinks")],
                viewerName: "Kent de Bruin",
                viewerLogin: "kentdebruin"
            ) == nil
        )
    }
}
