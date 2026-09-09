import XCTest
@testable import OS1

/// What the Archived screen writes on a row and on its pickers, pinned as
/// values. These mirror the web's `originChip` and picker labels, so a
/// divergence between the two clients fails here rather than on a phone.
final class ArchivedPresentationTests: XCTestCase {
    private func session(_ json: String) throws -> Session {
        try JSONDecoder().decode(Session.self, from: Data(json.utf8))
    }

    // MARK: - The origin chip

    func testAReadOnlySessionWearsTheAskChipInGreen() throws {
        let row = try session(#"{"id":"os-1","mode":"ask","source":"opensession"}"#)

        XCTAssertEqual(
            ArchivedPresentation.originChip(for: row),
            ArchivedPresentation.OriginChip(label: "ask", tone: .ask)
        )
    }

    func testAnAutomationIsNamedByItsChip() throws {
        let row = try session(#"{"id":"os-1","automation":"docs-sync","mode":"ask"}"#)

        // The automation's name outranks how it ran, as on the web.
        XCTAssertEqual(
            ArchivedPresentation.originChip(for: row),
            ArchivedPresentation.OriginChip(label: "docs-sync", tone: .neutral)
        )
    }

    func testABareAutomationFlagHasNoNameToShow() throws {
        let row = try session(#"{"id":"os-1","automation":true}"#)

        XCTAssertNil(ArchivedPresentation.originChip(for: row))
    }

    func testASessionFromAnIntegrationNamesItsSource() throws {
        for source in ["slack", "linear"] {
            let row = try session(#"{"id":"os-1","mode":"code","source":"\#(source)"}"#)

            XCTAssertEqual(
                ArchivedPresentation.originChip(for: row),
                ArchivedPresentation.OriginChip(label: source, tone: .neutral)
            )
        }
    }

    /// A code session started here is the default. The product's own name on
    /// every row would say nothing, and older rows still carry the pre-rename id.
    func testACodeSessionStartedHereGetsNoChip() throws {
        for json in [
            #"{"id":"os-1","mode":"code","source":"opensession"}"#,
            #"{"id":"os-1","mode":"code","source":"backstage"}"#,
            #"{"id":"os-1"}"#,
        ] {
            XCTAssertNil(ArchivedPresentation.originChip(for: try session(json)), json)
        }
    }

    // MARK: - The pickers

    func testTheOwnerPickerWearsItsValue() {
        let owners = [ArchivedOwners.Owner(key: "michiel", label: "Michiel")]

        XCTAssertEqual(ArchivedPresentation.ownerLabel(ArchivedOwners.mine, owners: owners), "My archived")
        XCTAssertEqual(ArchivedPresentation.ownerLabel(ArchivedOwners.everyone, owners: owners), "Everyone")
        XCTAssertEqual(ArchivedPresentation.ownerLabel("michiel", owners: owners), "Michiel")
        // A key the roster no longer answers to still reads as itself.
        XCTAssertEqual(ArchivedPresentation.ownerLabel("sam", owners: owners), "sam")
    }

    func testTheRepositoryPickerWearsItsValue() {
        XCTAssertEqual(ArchivedPresentation.repositoryLabel(ArchivedPresentation.allRepositories), "All repos")
        XCTAssertEqual(ArchivedPresentation.repositoryLabel("tella-fusion"), "tella-fusion")
        XCTAssertEqual(ArchivedPresentation.repositoryLabel("backstage"), "opensession")
    }

    // MARK: - A lens control stays while it holds a choice

    func testTheRepositoryPickerStaysWhileItsFilterIsActive() {
        // Nothing to choose between, nothing selected: no picker.
        XCTAssertFalse(ArchivedPresentation.showsRepositoryPicker(
            repositories: ["b"], selected: ArchivedPresentation.allRepositories
        ))
        XCTAssertTrue(ArchivedPresentation.showsRepositoryPicker(
            repositories: ["a", "b"], selected: ArchivedPresentation.allRepositories
        ))
        // A's last row was restored while A was selected: the picker is the
        // only way back to All repos, so it stays.
        XCTAssertTrue(ArchivedPresentation.showsRepositoryPicker(repositories: ["b"], selected: "a"))
        XCTAssertTrue(ArchivedPresentation.showsRepositoryPicker(repositories: [], selected: "a"))
    }

    func testTheRepositoryPickerKeepsListingTheSelectedRepository() {
        XCTAssertEqual(
            ArchivedPresentation.repositoryOptions(["b", "c"], selected: "a"), ["a", "b", "c"]
        )
        XCTAssertEqual(ArchivedPresentation.repositoryOptions(["a", "b"], selected: "a"), ["a", "b"])
        XCTAssertEqual(
            ArchivedPresentation.repositoryOptions(["b"], selected: ArchivedPresentation.allRepositories),
            ["b"]
        )
    }

    func testTheOwnerPickerKeepsListingTheSelectedTeammate() {
        let owners = [ArchivedOwners.Owner(key: "michiel", label: "Michiel")]

        XCTAssertEqual(
            ArchivedPresentation.ownerOptions(owners, selected: "sam").map(\.key), ["michiel", "sam"]
        )
        XCTAssertEqual(
            ArchivedPresentation.ownerOptions(owners, selected: "michiel").map(\.key), ["michiel"]
        )
        // The fixed lenses have their own entries and add nothing.
        XCTAssertEqual(
            ArchivedPresentation.ownerOptions(owners, selected: ArchivedOwners.mine).map(\.key), ["michiel"]
        )
        XCTAssertEqual(
            ArchivedPresentation.ownerOptions(owners, selected: ArchivedOwners.everyone).map(\.key),
            ["michiel"]
        )
    }

    func testTheReasonMenuStaysWhileANarrowReasonIsSelected() {
        XCTAssertFalse(ArchivedPresentation.showsReasonMenu(hasAutoArchived: false, selected: "all"))
        XCTAssertTrue(ArchivedPresentation.showsReasonMenu(hasAutoArchived: true, selected: "all"))
        // The last auto-archived row was restored under Auto-archived: the
        // menu is the only way back to All, so it stays.
        XCTAssertTrue(ArchivedPresentation.showsReasonMenu(hasAutoArchived: false, selected: "auto"))
        XCTAssertTrue(ArchivedPresentation.showsReasonMenu(hasAutoArchived: false, selected: "manual"))
    }

    func testTheReasonMenuListsAllThenAutoThenManual() {
        XCTAssertEqual(ArchivedPresentation.reasons.map(\.key), ["all", "auto", "manual"])
        XCTAssertEqual(ArchivedPresentation.reasonLabel("auto"), "Auto-archived")
        XCTAssertEqual(ArchivedPresentation.reasonLabel("manual"), "Manual")
        XCTAssertEqual(ArchivedPresentation.reasonLabel("all"), "All")
    }
}
