import XCTest
@testable import OS1

/// A Claude API account bills an API organization and has no subscription
/// windows. Read as a subscription, Settings draws it with empty meters, so
/// the decoding that tells the two apart is pinned here.
final class ClaudeApiAccountTests: XCTestCase {
    private func decode(_ json: String) throws -> [ProviderAccount] {
        try JSONDecoder().decode(ProviderAccountsResponse.self, from: Data(json.utf8)).accounts ?? []
    }

    func testApiKeyAccountDecodesAsAnApiAccount() throws {
        let accounts = try decode(
            """
            {"accounts": [
              {"id": "acct-api", "name": "Acme API", "tokenMasked": "sk-ant-…abcd",
               "authKind": "api-key", "mythosModels": ["claude-mythos-5-1", "claude-mythos-5-2"],
               "usable": true},
              {"id": "acct-sub", "name": "Acme Max", "tokenMasked": "sk-ant-oat…wxyz",
               "authKind": "setup-token", "plan": "default_claude_max_20x"}
            ]}
            """
        )
        XCTAssertEqual(accounts.count, 2)
        let api = accounts[0]
        XCTAssertEqual(api.authKind, "api-key")
        XCTAssertEqual(api.mythosModels, ["claude-mythos-5-1", "claude-mythos-5-2"])
        XCTAssertTrue(api.isClaudeApiAccount)
        XCTAssertEqual(api.claudeAuthLabel, "API key")
        XCTAssertNil(api.federation)

        let subscription = accounts[1]
        XCTAssertFalse(subscription.isClaudeApiAccount)
        XCTAssertNil(subscription.claudeAuthLabel)
    }

    func testFederationAccountReadsAsWorkloadIdentity() throws {
        let account = try XCTUnwrap(
            decode(
                """
                {"accounts": [{"id": "acct-wif", "name": "Acme WIF", "authKind": "federation",
                  "federation": {"organizationId": "org-1", "federationRuleId": "rule-1",
                                 "serviceAccountId": "sa-1"}}]}
                """
            ).first
        )
        XCTAssertTrue(account.isClaudeApiAccount)
        XCTAssertEqual(account.claudeAuthLabel, "API · workload identity")
        XCTAssertEqual(account.federation?.organizationId, "org-1")
    }

    /// Older servers send no authKind: those accounts are subscriptions.
    func testMissingAuthKindReadsAsASubscription() throws {
        let account = try XCTUnwrap(decode(#"{"accounts": [{"id": "a", "name": "Old"}]}"#).first)
        XCTAssertNil(account.authKind)
        XCTAssertFalse(account.isClaudeApiAccount)
    }

    func testAddedAccountCarriesTheBridgeWarning() throws {
        let added = try JSONDecoder().decode(
            ClaudeApiAccountAdded.self,
            from: Data(
                #"{"id": "acct-api", "name": "Acme API", "authKind": "api-key", "warning": "Mythos runs can't use this account yet."}"#
                    .utf8
            )
        )
        XCTAssertEqual(added.account.id, "acct-api")
        XCTAssertTrue(added.account.isClaudeApiAccount)
        XCTAssertEqual(added.warning, "Mythos runs can't use this account yet.")
    }
}
