import XCTest
@testable import OS1

final class SidebarAdditionTests: XCTestCase {
    private func session(_ json: String) throws -> Session {
        try JSONDecoder().decode(Session.self, from: Data(json.utf8))
    }

    private func intent(
        _ session: Session,
        siblings: [Session]? = nil,
        claims: Set<String> = [],
        hidden: Bool = false
    ) -> SidebarAddition.Intent? {
        SidebarAddition.intent(
            for: session,
            siblings: siblings ?? [session],
            claims: claims,
            hidden: hidden,
            viewerName: "Kent de Bruin",
            viewerLogin: "kentdebruin"
        )
    }

    func testOffersClaimForTeammateAutomationAndSpawnedSessions() throws {
        let teammate = try session(#"{"id":"team","startedBy":"Michiel"}"#)
        let automation = try session(#"{"id":"auto","startedBy":"Automation","automation":"triage"}"#)
        let spawned = try session(#"{"id":"spawned","startedBy":"Kent","spawnedBy":"parent"}"#)

        XCTAssertEqual(intent(teammate), .claim)
        XCTAssertEqual(intent(automation), .claim)
        XCTAssertEqual(intent(spawned), .claim)
    }

    func testDoesNotOfferForOwnOrdinarySessionOrItsWorkspace() throws {
        let teammate = try session(#"{"id":"team","workspaceId":"ws","startedBy":"Michiel"}"#)
        let mine = try session(#"{"id":"mine","workspaceId":"ws","startedBy":"Kent"}"#)

        XCTAssertNil(intent(mine))
        XCTAssertNil(intent(teammate, siblings: [teammate, mine]))
    }

    func testDoesNotOfferForClaimedOrArchivedSession() throws {
        let teammate = try session(#"{"id":"team","startedBy":"Michiel"}"#)
        let archived = try session(#"{"id":"old","startedBy":"Michiel","archived":true}"#)

        XCTAssertNil(intent(teammate, claims: ["team"]))
        XCTAssertNil(intent(archived))
    }

    func testHiddenRowCanBeRestoredEvenWhenAlreadyClaimedOrNatural() throws {
        let teammate = try session(#"{"id":"team","startedBy":"Michiel"}"#)
        let mine = try session(#"{"id":"mine","startedBy":"Kent"}"#)

        XCTAssertEqual(intent(teammate, claims: ["team"], hidden: true), .restore)
        XCTAssertEqual(intent(mine, hidden: true), .restore)
    }
}

@MainActor
final class LaneStoreWriteTests: XCTestCase {
    func testPreHydrationClaimIsReplayedOverRemoteState() {
        let store = LaneStore()
        store.claim([Session(id: "local")])

        store.applyHydrated(["remote": "review"], persist: false)

        XCTAssertEqual(store.claims, ["local", "remote"])
    }

    func testWriteResponseAcknowledgesOnlyCapturedChanges() {
        let store = LaneStore()
        store.claim([Session(id: "first"), Session(id: "later")])
        store.applyHydrated([:], persist: false)

        store.applySaved(
            ["first": "mine", "remote": "pending"],
            acknowledging: ["first": "mine"]
        )

        XCTAssertEqual(store.claims, ["first", "later", "remote"])
    }
}
