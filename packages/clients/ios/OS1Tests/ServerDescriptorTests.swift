import XCTest
@testable import OS1

final class ServerDescriptorTests: XCTestCase {
    func testMissingAndUnknownCapabilitiesAreUnsupported() throws {
        let empty = try JSONDecoder().decode(ServerDescriptor.self, from: Data("{}".utf8))
        XCTAssertFalse(empty.supports("deskVoice"))
        let descriptor = try JSONDecoder().decode(ServerDescriptor.self, from: Data(
            #"{"serverVersion":"future","protocolVersion":2,"capabilities":{"deskVoice":true,"future":{"version":9},"commandResults":2,"sessionVoice":"true"}}"#.utf8
        ))
        XCTAssertTrue(descriptor.supports("deskVoice"))
        XCTAssertTrue(descriptor.supports("commandResults", minimumVersion: 2))
        XCTAssertFalse(descriptor.supports("commandResults", minimumVersion: 3))
        XCTAssertFalse(descriptor.supports("sessionVoice"))
    }
}
