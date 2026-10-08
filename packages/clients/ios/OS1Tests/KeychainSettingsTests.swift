import Foundation
import XCTest
@testable import OS1

/// Settings → Keychain against the `/api/keychain` contract in
/// src/server/keychain.ts (`keychainViewFor`). Placeholder identities only.
final class KeychainSettingsTests: XCTestCase {
    /// A server from before logins, status-only keys, scripted runs and
    /// owner-scoped answering.
    private let oldFixture = #"""
    {
      "credentials": [
        {"id":"kc-1","owner":"Alex","service":"acme","description":"Deploys","host":"api.acme.test",
         "allowedMethods":["GET"],"createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"}
      ],
      "grants": [
        {"id":"gr-1","credentialId":"kc-1","owner":"Alex","sessionId":"s-1","requestedBy":"Sam",
         "purpose":"Check a deploy","mode":"standing","status":"active",
         "createdAt":"2026-01-01T00:00:00Z","expiresAt":"2099-01-01T00:00:00Z"}
      ],
      "asks": [
        {"id":"ask-1","credentialId":"kc-1","owner":"Alex","sessionId":"s-2","requestedBy":"Sam",
         "purpose":"Read logs","requestedMode":"once","status":"pending","createdAt":"2026-01-01T00:00:00Z"}
      ]
    }
    """#

    /// The current server, seen by Sam: Alex owns acme and the login, Sam owns
    /// beta. One grouped run spans acme (Alex) and two of Sam's credentials.
    private let newFixture = #"""
    {
      "credentials": [
        {"id":"kc-1","owner":"Alex","service":"acme","host":"api.acme.test","statusOnly":true,
         "allowedMethods":["GET","HEAD"],"allowedPathPrefixes":["/v1/status"],"mine":false,
         "createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z","futureField":{"x":1}},
        {"id":"kc-2","owner":"Alex","service":"acme-staging","kind":"login",
         "loginUrl":"https://app.example.test/login","username":"qa@example.test",
         "host":"app.example.test","mine":false,"createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"},
        {"id":"kc-3","owner":"Sam","service":"beta","host":"api.beta.test","mine":true,
         "createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"},
        {"id":"kc-4","owner":"Sam","service":"gamma","host":"api.gamma.test","mine":true,
         "createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"}
      ],
      "grants": [
        {"id":"gr-run","credentialId":"kc-3","owner":"Sam","sessionId":"s-1","requestedBy":"Robin",
         "purpose":"Backfill","mode":"run","status":"active","runCalls":3,
         "run":{"command":"bun scripts/backfill.ts","maxCalls":1200},
         "createdAt":"2026-01-01T00:00:00Z","expiresAt":"2099-01-01T00:00:00Z"},
        {"id":"gr-old","credentialId":"kc-3","owner":"Sam","sessionId":"s-1","requestedBy":"Robin",
         "purpose":"Old","mode":"once","status":"used",
         "createdAt":"2026-01-01T00:00:00Z","expiresAt":"2026-01-02T00:00:00Z"}
      ],
      "asks": [
        {"id":"ask-group-a","credentialId":"kc-3","owner":"Sam","sessionId":"s-3","requestedBy":"Robin",
         "purpose":"Sync","requestedMode":"run","status":"pending","canAnswer":true,"createdAt":"2026-01-01T00:00:00Z",
         "run":{"command":"bun scripts/sync.ts","maxCalls":50,"group":{"id":"grp-1","members":[
           {"service":"acme","host":"api.acme.test","owner":"Alex","maxCalls":100},
           {"service":"beta","host":"api.beta.test","owner":"Sam","maxCalls":50},
           {"service":"gamma","host":"api.gamma.test","owner":"Sam","maxCalls":2000}]}}},
        {"id":"ask-group-b","credentialId":"kc-4","owner":"Sam","sessionId":"s-3","requestedBy":"Robin",
         "purpose":"Sync","requestedMode":"run","status":"pending","canAnswer":true,"createdAt":"2026-01-01T00:00:00Z",
         "run":{"command":"bun scripts/sync.ts","maxCalls":2000,"group":{"id":"grp-1","members":[]}}},
        {"id":"ask-group-c","credentialId":"kc-1","owner":"Alex","sessionId":"s-3","requestedBy":"Robin",
         "purpose":"Sync","requestedMode":"run","status":"pending","canAnswer":false,"createdAt":"2026-01-01T00:00:00Z",
         "run":{"command":"bun scripts/sync.ts","maxCalls":100,"group":{"id":"grp-1","members":[]}}},
        {"id":"ask-login","credentialId":"kc-2","owner":"Alex","sessionId":"s-4","requestedBy":"Sam",
         "purpose":"Sign in to staging","requestedMode":"release","status":"pending","canAnswer":false,
         "createdAt":"2026-01-01T00:00:00Z"},
        {"id":"ask-done","credentialId":"kc-3","owner":"Sam","sessionId":"s-4","requestedBy":"Robin",
         "purpose":"Done","requestedMode":"once","status":"approved","canAnswer":false,"createdAt":"2026-01-01T00:00:00Z"}
      ]
    }
    """#

    private func decode(_ json: String) throws -> KeychainResponse {
        try JSONDecoder().decode(KeychainResponse.self, from: Data(json.utf8))
    }

    // MARK: Decoding

    func testOldResponseStillDecodesAndKeepsItsBehaviour() throws {
        let response = try decode(oldFixture)
        let credential = try XCTUnwrap(response.credentials?.first)
        XCTAssertFalse(credential.isLogin)
        XCTAssertNil(credential.mine)
        XCTAssertTrue(credential.canDelete, "Older servers enforce ownership on delete themselves")
        XCTAssertEqual(credential.title, "acme · api.acme.test")
        XCTAssertEqual(credential.scopeSummary, "owner Alex · GET")
        XCTAssertEqual(KeychainPresentation.modeLabel(response.grants?.first?.mode), "7 days")

        let asks = response.asks ?? []
        XCTAssertTrue(KeychainPresentation.asksToAnswer(asks).isEmpty, "No canAnswer means not yours to answer")
        XCTAssertEqual(KeychainPresentation.asksWaiting(asks).map(\.id), ["ask-1"])
    }

    func testNewResponseDecodesLoginStatusOnlyAndOwnership() throws {
        let credentials = try XCTUnwrap(decode(newFixture).credentials)
        let api = credentials[0], login = credentials[1], mine = credentials[2]

        XCTAssertEqual(api.statusOnly, true)
        XCTAssertEqual(api.scopeSummary, "owner Alex · GET/HEAD · /v1/status · status only")
        XCTAssertFalse(api.canDelete)

        XCTAssertTrue(login.isLogin)
        XCTAssertEqual(login.username, "qa@example.test")
        XCTAssertEqual(login.loginUrl, "https://app.example.test/login")
        XCTAssertEqual(login.title, "acme-staging · qa@example.test")
        XCTAssertEqual(login.scopeSummary, "Login on https://app.example.test/login · owner Alex")
        XCTAssertFalse(login.canDelete)

        XCTAssertTrue(mine.canDelete)
    }

    func testCachedResponseNeverCarriesASecret() throws {
        // Even if a server ever leaked one, the models have nowhere to put it,
        // so the on-device settings cache cannot write it.
        let leaky = #"{"credentials":[{"id":"kc-1","service":"acme","secret":"sk-placeholder","password":"pw"}]}"#
        let encoded = try JSONEncoder().encode(decode(leaky))
        let text = String(decoding: encoded, as: UTF8.self)
        XCTAssertFalse(text.contains("sk-placeholder"))
        XCTAssertFalse(text.contains("secret"))
        XCTAssertFalse(text.contains("password"))
    }

    // MARK: Owner scoping and runs

    func testOnlyTheOwnerIsOfferedAnswersAndAGroupIsOneAnswer() throws {
        let asks = try XCTUnwrap(decode(newFixture).asks)

        let toAnswer = KeychainPresentation.asksToAnswer(asks)
        XCTAssertEqual(toAnswer.map(\.id), ["ask-group-a"], "Sam's two credentials in one run are one answer")
        XCTAssertEqual(KeychainPresentation.sameRun(toAnswer[0], in: asks).map(\.id), ["ask-group-a", "ask-group-b"])

        // Alex's part of the run and Alex's login wait on Alex, not Sam.
        XCTAssertEqual(KeychainPresentation.asksWaiting(asks).map(\.id), ["ask-group-c", "ask-login"])
    }

    func testGroupedRunNamesEveryCredentialWithItsOwnerAndCap() throws {
        let ask = try XCTUnwrap(decode(newFixture).asks?.first)
        XCTAssertEqual(
            KeychainPresentation.askDetail(ask),
            "Scripted run with acme (owner Alex), beta (owner Sam), "
                + "gamma (owner Sam); starts once every owner allows it · bun scripts/sync.ts · Sync"
        )
        XCTAssertEqual(KeychainDecision.choices(for: ask), [.decline, .run])
    }

    func testSingleRunGrantAndLoginReleaseLabels() throws {
        let response = try decode(newFixture)
        let grant = try XCTUnwrap(response.grants?.first)
        XCTAssertEqual(
            KeychainPresentation.grantDetail(grant, expiry: "expires soon"),
            "Scripted run · bun scripts/backfill.ts · owner Sam · expires soon · Backfill"
        )
        let release = try XCTUnwrap(response.asks?.first { $0.id == "ask-login" })
        XCTAssertEqual(KeychainPresentation.askDetail(release), "Wants the password, which the agent will see · Sign in to staging")
        XCTAssertEqual(KeychainDecision.choices(for: release), [.decline, .release])
        XCTAssertEqual(KeychainPresentation.modeLabel("release"), "Password release")
        XCTAssertEqual(KeychainPresentation.modeLabel("once"), "One call")

        let once = KeychainAsk(requestedMode: "once", status: "pending", canAnswer: true)
        XCTAssertEqual(KeychainDecision.choices(for: once), [.decline, .standing, .once])
    }

    // MARK: Create validation

    func testAPIDraftNeedsServiceHostAndSecret() {
        var draft = KeychainCredentialDraft()
        XCTAssertFalse(draft.isReady)
        draft.service = "acme"
        draft.host = "api.acme.test"
        XCTAssertFalse(draft.isComplete)
        draft.secret = "   "
        XCTAssertFalse(draft.isComplete, "A blank secret is refused by the server")
        draft.secret = " token-placeholder "
        XCTAssertTrue(draft.isReady)
    }

    func testAPIDraftExplainsWhatTheServerWouldRefuse() {
        var draft = KeychainCredentialDraft()
        draft.service = "Acme Prod"
        XCTAssertNotNil(draft.issue)
        draft.service = "acme"
        draft.host = "api.acme.test:8443"
        XCTAssertEqual(draft.issue, "Host must be a bare host name, like api.example.test, with no port or path.")
        draft.host = "https://API.acme.test/v1"
        XCTAssertNil(draft.issue, "Scheme and path are stripped like the server does")
        draft.methods = "get, fetch"
        XCTAssertEqual(draft.issue, "FETCH is not an HTTP method.")
        draft.methods = "get, post"
        draft.pathPrefixes = "/v1, v2"
        XCTAssertEqual(draft.issue, "Path prefixes start with /, so v2 needs one.")
        draft.pathPrefixes = "/v1"
        draft.header = "X Api Key"
        XCTAssertNotNil(draft.issue)
        draft.header = "X-Api-Key"
        XCTAssertNil(draft.issue)
    }

    func testAPIPayloadIsNormalizedAndCarriesStatusOnly() {
        var draft = KeychainCredentialDraft()
        draft.service = " Acme "
        draft.host = "https://API.acme.test/v1"
        draft.secret = " token-placeholder "
        draft.methods = "get, post"
        draft.pathPrefixes = "/v1/status"
        draft.header = "X-Api-Key"
        draft.statusOnly = true
        draft.username = "ignored"

        let body = draft.payload
        XCTAssertEqual(body["service"] as? String, "acme")
        XCTAssertEqual(body["host"] as? String, "api.acme.test")
        XCTAssertEqual(body["secret"] as? String, "token-placeholder")
        XCTAssertEqual(body["allowedMethods"] as? [String], ["GET", "POST"])
        XCTAssertEqual(body["allowedPathPrefixes"] as? [String], ["/v1/status"])
        XCTAssertEqual(body["injection"] as? [String: String], ["header": "X-Api-Key"])
        XCTAssertEqual(body["statusOnly"] as? Bool, true)
        XCTAssertNil(body["kind"])
        XCTAssertNil(body["username"], "The server refuses a username on an API credential")
        XCTAssertNil(body["loginUrl"])
    }

    func testLoginDraftValidatesTheSignInPageAndUsername() {
        var draft = KeychainCredentialDraft()
        draft.kind = .login
        draft.service = "acme-staging"
        draft.loginUrl = "https://app.example.test/login"
        draft.secret = "pw-placeholder"
        XCTAssertFalse(draft.isComplete, "A login needs a username")
        draft.username = "qa@example.test"
        XCTAssertTrue(draft.isReady)

        draft.loginUrl = "http://app.example.test/login"
        XCTAssertEqual(draft.issue, "Sign-in page must be a full https:// address.")
        draft.loginUrl = "https://user:pw@app.example.test/login"
        XCTAssertNotNil(draft.issue)
        draft.loginUrl = "https://app.example.test/login"
        draft.username = String(repeating: "a", count: 201)
        XCTAssertNotNil(draft.issue)
        draft.username = "qa\u{202E}@example.test"
        XCTAssertNotNil(draft.issue)
    }

    func testLoginPayloadSendsThePasswordAsTypedAndNoAPIScope() {
        var draft = KeychainCredentialDraft()
        draft.kind = .login
        draft.service = "acme-staging"
        draft.loginUrl = " https://app.example.test/login "
        draft.username = " qa@example.test "
        draft.secret = " pw placeholder "
        draft.host = "api.acme.test"
        draft.methods = "GET"
        draft.statusOnly = true

        let body = draft.payload
        XCTAssertEqual(body["kind"] as? String, "login")
        XCTAssertEqual(body["loginUrl"] as? String, "https://app.example.test/login")
        XCTAssertEqual(body["username"] as? String, "qa@example.test")
        XCTAssertEqual(body["secret"] as? String, " pw placeholder ", "A password may begin or end with a space")
        for field in ["host", "allowedMethods", "allowedPathPrefixes", "injection", "statusOnly"] {
            XCTAssertNil(body[field], "The server refuses \(field) on a login")
        }
    }

    @MainActor
    func testCredentialPostNeverTouchesTheDiskCache() {
        // URLSession.shared's URLCache writes a POST's request, body and all,
        // into its on-disk database; the typed secret must not land there.
        let configuration = SettingsAPI.secretSession.configuration
        XCTAssertNil(configuration.urlCache)
        XCTAssertNil(configuration.httpCookieStorage?.cookies?.first)
        XCTAssertEqual(configuration.requestCachePolicy, .reloadIgnoringLocalCacheData)
    }
}
