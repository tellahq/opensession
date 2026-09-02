import Foundation
import XCTest
@testable import OS1

final class ModelProviderSettingsTests: XCTestCase {
    func testDecodesCustomGatewayFields() throws {
        let provider = try JSONDecoder().decode(
            ModelProvider.self,
            from: Data(#"{"id":"gateway","apiKeyMasked":"sk-…abcd","baseURL":"https://gw.test/v1","api":"openai-completions","name":"My gateway","discoverModels":true,"discoveredAt":"2026-09-01T10:00:00.000Z","catalogFile":"gateway.json","catalogModels":3,"models":["pi/gateway/a"]}"#.utf8)
        )
        XCTAssertTrue(provider.isCustomGateway)
        XCTAssertEqual(provider.displayName, "My gateway")
        XCTAssertEqual(provider.catalogModels, 3)
        XCTAssertEqual(provider.catalogFile, "gateway.json")
        XCTAssertEqual(provider.summary, "sk-…abcd · https://gw.test/v1 · OpenAI-compatible · 3 catalog rows · discovery on · 1 in picker")
    }

    func testOlderProviderPayloadStillDecodes() throws {
        let provider = try JSONDecoder().decode(
            ModelProvider.self,
            from: Data(#"{"id":"xai","apiKeyMasked":"xai-…1234","models":[]}"#.utf8)
        )
        XCTAssertFalse(provider.isCustomGateway)
        XCTAssertEqual(provider.displayName, "xai")
        XCTAssertNil(provider.discoverModels)
        XCTAssertEqual(provider.summary, "xai-…1234")
    }

    func testSaveResponseDecodesDiscoveryAndError() throws {
        let ok = try JSONDecoder().decode(
            ModelProviderSaveResponse.self,
            from: Data(#"{"provider":{"id":"gw"},"discovery":{"models":["a","b"],"added":1}}"#.utf8)
        )
        XCTAssertEqual(ok.discovery?.models?.count, 2)
        XCTAssertEqual(ok.discovery?.added, 1)
        let failed = try JSONDecoder().decode(
            ModelProviderSaveResponse.self,
            from: Data(#"{"provider":{"id":"gw"},"discoveryError":"GET /models returned 401"}"#.utf8)
        )
        XCTAssertEqual(failed.discoveryError, "GET /models returned 401")
    }

    func testDraftRequiresBaseURLForGatewayOptions() {
        var draft = ModelProviderDraft(provider: ModelProvider(id: ""))
        draft.id = "My-Gateway"
        draft.apiKey = "sk 123"
        XCTAssertEqual(draft.cleanId, "my-gateway")
        XCTAssertEqual(draft.apiKeyValue, "sk123")
        XCTAssertTrue(draft.canSave)
        draft.customGateway = true
        XCTAssertTrue(draft.needsBaseURL)
        XCTAssertFalse(draft.canSave)
        draft.baseURL = " https://gw.test/v1 "
        XCTAssertEqual(draft.trimmedBaseURL, "https://gw.test/v1")
        XCTAssertEqual(draft.apiValue, "openai-completions")
        XCTAssertTrue(draft.canSave)
        draft.customGateway = false
        XCTAssertEqual(draft.apiValue, "", "clearing the option sends an empty api so the server drops it")
    }

    func testEditingDraftKeepsStoredKeyAndSeedsFromProvider() throws {
        let provider = try JSONDecoder().decode(
            ModelProvider.self,
            from: Data(#"{"id":"gw","baseURL":"https://gw.test/v1","api":"openai-completions","name":"GW","discoverModels":true,"models":["pi/gw/a","pi/gw/b"]}"#.utf8)
        )
        let draft = ModelProviderDraft(provider: provider)
        XCTAssertTrue(draft.isEditing)
        XCTAssertNil(draft.apiKeyValue)
        XCTAssertTrue(draft.customGateway)
        XCTAssertTrue(draft.discoverModels)
        XCTAssertEqual(draft.modelIds, ["pi/gw/a", "pi/gw/b"])
        XCTAssertTrue(draft.canSave)
        var invalid = draft
        invalid.id = "Bad Id!"
        XCTAssertFalse(invalid.canSave)
    }
}
