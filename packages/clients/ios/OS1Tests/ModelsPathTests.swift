import XCTest
@testable import OS1

@MainActor
final class ModelsPathTests: XCTestCase {
    func testModelsPathSendsTheWorkspaceAndUser() throws {
        let path = OS1API.modelsPath(workspaceId: "acme", user: "Alice")
        let components = try XCTUnwrap(URLComponents(string: path))
        XCTAssertEqual(components.path, "/api/models")
        XCTAssertEqual(components.queryItems, [
            URLQueryItem(name: "workspace", value: "acme"),
            URLQueryItem(name: "user", value: "Alice"),
        ])
    }

    func testModelsPathOmitsEmptyParameters() {
        XCTAssertEqual(OS1API.modelsPath(workspaceId: nil, user: ""), "/api/models")
    }

    func testSetupStatusPathSendsTheUser() throws {
        let path = OS1API.setupStatusPath(user: "Alice")
        let components = try XCTUnwrap(URLComponents(string: path))
        XCTAssertEqual(components.path, "/api/setup/status")
        XCTAssertEqual(components.queryItems, [URLQueryItem(name: "user", value: "Alice")])
        XCTAssertEqual(OS1API.setupStatusPath(user: ""), "/api/setup/status")
    }
}
