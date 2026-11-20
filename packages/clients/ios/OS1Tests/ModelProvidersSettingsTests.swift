import Foundation
import XCTest
@testable import OS1

/// Settings → Providers against `src/server/routes/connections.ts`: the
/// Gemini card's save (a key with `discoverModels`), the discover route, and
/// decoding `canDiscover`. Placeholder hosts and keys only.
@MainActor
final class ModelProvidersSettingsTests: XCTestCase {
    private let connection = SettingsAPI.Connection(
        baseURL: URL(string: "https://os.example.test")!,
        token: "test-token"
    )
    private var session: URLSession!

    override func setUp() {
        super.setUp()
        MemoryStubProtocol.reset()
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MemoryStubProtocol.self]
        session = URLSession(configuration: configuration)
    }

    func testProvidersDecodeCanDiscoverAndSplitOutGemini() throws {
        let json = #"""
        {"providers":[
          {"id":"xai","apiKeyMasked":"xai-…abcd","catalogModels":0,"models":["pi/xai/grok-4"]},
          {"id":"google","apiKeyMasked":"AIza…wxyz","discoverModels":true,"canDiscover":true,"catalogModels":3,
           "models":["pi/google/gemini-3.5-flash","pi/google/gemini-3.1-pro-preview"]},
          {"id":"gateway","apiKeyMasked":"sk-…1234","baseURL":"https://llm.example.test/v1","api":"openai-completions","canDiscover":true,"models":[]}
        ],"pickerModels":[]}
        """#
        let providers = try JSONDecoder().decode(ModelProvidersResponse.self, from: Data(json.utf8)).providers ?? []
        let split = ModelProvider.splitGemini(providers)
        let gemini = try XCTUnwrap(split.gemini)
        XCTAssertEqual(gemini.canDiscover, true)
        XCTAssertEqual(gemini.discoverModels, true)
        XCTAssertEqual(gemini.modelNames, ["gemini-3.5-flash", "gemini-3.1-pro-preview"])
        XCTAssertEqual(split.own.map(\.id), ["xai", "gateway"])
        XCTAssertEqual(split.own.map(\.canDiscover), [nil, true])
    }

    func testCachedProvidersFromAnOlderBuildStillDecode() throws {
        let old = #"[{"id":"xai","apiKeyMasked":"xai-…abcd","models":["pi/xai/grok-4"]}]"#
        let providers = try JSONDecoder().decode([ModelProvider].self, from: Data(old.utf8))
        XCTAssertNil(providers.first?.canDiscover)
        XCTAssertNil(ModelProvider.splitGemini(providers).gemini)
    }

    func testCleanKeyStripsWrappedWhitespace() {
        XCTAssertEqual(ModelProvider.cleanKey("  AIza abc\n def\t "), "AIzaabcdef")
    }

    func testGeminiSaveSendsKeyAndDiscovery() async throws {
        MemoryStubProtocol.respond { _ in
            (200, #"{"provider":{"id":"google","apiKeyMasked":"AIza…wxyz","canDiscover":true,"models":[]},"discovery":{"added":2,"models":["gemini-3.5-flash","gemini-3.1-pro-preview","gemini-3-flash"]}}"#)
        }
        let result = try await SettingsAPI.upsertModelProvider(
            id: ModelProvider.geminiID, apiKey: "AIzaKEY", discoverModels: true,
            connection: connection, session: session
        )
        let request = try XCTUnwrap(MemoryStubProtocol.requests.first)
        XCTAssertEqual(request.method, "PUT")
        XCTAssertEqual(request.path, "/api/settings/model-providers/google")
        let body = try XCTUnwrap(request.body as? [String: Any])
        XCTAssertEqual(body["apiKey"] as? String, "AIzaKEY")
        XCTAssertEqual(body["discoverModels"] as? Bool, true)
        XCTAssertNil(body["models"], "the Gemini card leaves the picker models to the server")
        XCTAssertNil(body["baseURL"])
        XCTAssertEqual(result.geminiSummary, "Gemini key saved, 3 models available")
        XCTAssertFalse(result.discoveryFailed)
    }

    func testGenericSaveOmitsDiscovery() async throws {
        MemoryStubProtocol.respond { _ in (200, #"{"provider":{"id":"xai"}}"#) }
        try await SettingsAPI.upsertModelProvider(
            id: "xai", apiKey: "k", models: ["grok-4"], connection: connection, session: session
        )
        let body = try XCTUnwrap(MemoryStubProtocol.requests.first?.body as? [String: Any])
        XCTAssertNil(body["discoverModels"])
        XCTAssertEqual(body["models"] as? [String], ["grok-4"])
    }

    func testSaveSummaries() throws {
        let failed = try JSONDecoder().decode(
            ModelProviderSaveResult.self,
            from: Data(#"{"provider":{"id":"google"},"discoveryError":"Gemini API returned 400"}"#.utf8)
        )
        XCTAssertEqual(failed.geminiSummary, "Gemini key saved. Gemini API returned 400")
        XCTAssertTrue(failed.discoveryFailed)
        let plain = try JSONDecoder().decode(ModelProviderSaveResult.self, from: Data(#"{"provider":{"id":"google"}}"#.utf8))
        XCTAssertEqual(plain.geminiSummary, "Gemini key saved")
    }

    func testDiscoverPostsAndSummarizes() async throws {
        MemoryStubProtocol.respond { _ in (200, #"{"added":1,"models":["a","b"],"provider":{"id":"google","canDiscover":true}}"#) }
        let result = try await SettingsAPI.discoverModelProviderModels(id: "google", connection: connection, session: session)
        let request = try XCTUnwrap(MemoryStubProtocol.requests.first)
        XCTAssertEqual(request.method, "POST")
        XCTAssertEqual(request.path, "/api/settings/model-providers/google/discover")
        XCTAssertEqual(result.summary, "2 models listed, 1 added to the picker")
    }

    func testDiscoverFailureSurfacesTheServerMessage() async {
        MemoryStubProtocol.respond { _ in (502, #"{"error":"Gemini API returned 403"}"#) }
        do {
            _ = try await SettingsAPI.discoverModelProviderModels(id: "google", connection: connection, session: session)
            XCTFail("expected a failure")
        } catch {
            XCTAssertEqual(error.localizedDescription, "Gemini API returned 403")
        }
    }
}
