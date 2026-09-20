import Foundation
import Security

// A single classic macOS Keychain generic-password lookup. The Security
// framework owns the native Allow / Always Allow / Deny prompt and the item's
// ACL. Never shell out to /usr/bin/security, alter an ACL, or unlock a keychain.
enum KeychainReadError: Error {
    case invalidIdentifier
    case unavailable
    case invalidValue
}

func validKeychainIdentifier(_ value: String) -> Bool {
    !value.isEmpty && value.utf16.count <= 300 && value.unicodeScalars.allSatisfy {
        !CharacterSet.controlCharacters.contains($0) &&
        !(0x202A...0x202E).contains($0.value) && !(0x2066...0x2069).contains($0.value)
    }
}

func readGenericPassword(service: String, account: String, keychain: SecKeychain? = nil) throws -> Data {
    guard validKeychainIdentifier(service), validKeychainIdentifier(account) else {
        throw KeychainReadError.invalidIdentifier
    }
    var length: UInt32 = 0
    var bytes: UnsafeMutableRawPointer?
    let status = service.withCString { serviceBytes in
        account.withCString { accountBytes in
            SecKeychainFindGenericPassword(
                keychain, UInt32(service.utf8.count), serviceBytes,
                UInt32(account.utf8.count), accountBytes,
                &length, &bytes, nil
            )
        }
    }
    guard status == errSecSuccess else { throw KeychainReadError.unavailable }
    defer { SecKeychainItemFreeContent(nil, bytes) }
    guard let bytes, length > 0, length <= 16 * 1024 else {
        throw KeychainReadError.invalidValue
    }
    return Data(bytes: bytes, count: Int(length))
}

#if !KEYCHAIN_TESTING
@main
struct KeychainHelper {
    static func main() {
        guard CommandLine.arguments.count == 3 else { exit(1) }
        do {
            let secret = try readGenericPassword(
                service: CommandLine.arguments[1], account: CommandLine.arguments[2]
            )
            // Private pipe to the app's main process only. Never a renderer,
            // transcript, file, error message, or model-facing tool result.
            try FileHandle.standardOutput.write(contentsOf: secret)
        } catch {
            // Do not print errors or item contents. The parent returns a fixed
            // failure outcome and never forwards subprocess stdout/stderr.
            exit(1)
        }
    }
}
#endif
