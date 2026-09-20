import Foundation
import Security

// Run only against a new disposable keychain. No default search-list changes,
// real item lookup, or interactive prompt is permitted in this fixture.
@main
struct KeychainHelperTests {
    static func main() throws {
        SecKeychainSetUserInteractionAllowed(false)
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let file = root.appendingPathComponent("fixture.keychain").path
        let password = "disposable-fixture-only"
        var keychain: SecKeychain?
        let created = password.withCString { bytes in
            SecKeychainCreate(file, UInt32(password.utf8.count), bytes, false, nil, &keychain)
        }
        guard created == errSecSuccess, let keychain else {
            fatalError("Could not create disposable fixture: \(created)")
        }
        defer { SecKeychainDelete(keychain) }

        func add(service: String, account: String, value: String) {
            let status = service.withCString { s in
                account.withCString { a in
                    value.withCString { v in
                        SecKeychainAddGenericPassword(keychain,
                            UInt32(service.utf8.count), s, UInt32(account.utf8.count), a,
                            UInt32(value.utf8.count), v, nil)
                    }
                }
            }
            precondition(status == errSecSuccess, "Fixture write failed")
        }
        add(service: "Example API", account: "demo", value: "synthetic-value")
        add(service: "Different API", account: "demo", value: "wrong-service")
        add(service: "Example API", account: "another", value: "wrong-account")
        add(service: "Unicode café", account: "demo@example.test", value: "unicode-value")
        let selected = try readGenericPassword(service: "Example API", account: "demo", keychain: keychain)
        precondition(selected == Data("synthetic-value".utf8))
        let unicode = try readGenericPassword(service: "Unicode café", account: "demo@example.test", keychain: keychain)
        precondition(unicode == Data("unicode-value".utf8))
        do {
            _ = try readGenericPassword(service: "Missing", account: "demo", keychain: keychain)
            fatalError("A missing item must fail")
        } catch KeychainReadError.unavailable {}
        for service in ["", "invalid\0suffix", "spoof\u{202e}text", String(repeating: "a", count: 301)] {
            do {
                _ = try readGenericPassword(service: service, account: "demo", keychain: keychain)
                fatalError("Invalid identifiers must fail")
            } catch KeychainReadError.invalidIdentifier {}
        }
        precondition(SecKeychainLock(keychain) == errSecSuccess)
        do {
            _ = try readGenericPassword(service: "Example API", account: "demo", keychain: keychain)
            fatalError("Locked keychain access must fail without UI; never silently unlock")
        } catch KeychainReadError.unavailable {}
        print("PASS: exact service/account, Unicode, missing item, invalid input and locked-keychain denial; disposable keychain only")
    }
}
