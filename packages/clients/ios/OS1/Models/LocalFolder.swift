import Foundation

/// A folder on someone's own computer that a session can reach through that
/// device's file bridge (the Mac app, Chrome or Edge). The native app only
/// VIEWS these: it holds no folders itself, so it shows them and lets the
/// person who connected one disconnect it, nothing more.
///
/// Mirrors the `local_folders` frame and `GET /api/local-folders` rows.
/// Tolerant: a row without a `key` cannot be addressed and is dropped by the
/// list that holds it; every other field falls back to a safe default.
struct LocalFolder: Decodable, Equatable, Hashable, Sendable, Identifiable {
    /// `<deviceId>:<folderId>`, what disconnect addresses.
    let key: String
    let folderId: String
    let name: String
    /// Shown in the folder's menu only, never in the chip.
    let displayPath: String?
    let readOnly: Bool
    let deviceId: String
    let deviceLabel: String
    /// The person who connected it, the only one who may disconnect it.
    let owner: String
    /// False while the device holding it is closed or disconnected.
    let online: Bool

    var id: String { key }

    init(
        key: String,
        folderId: String = "",
        name: String,
        displayPath: String? = nil,
        readOnly: Bool = false,
        deviceId: String = "",
        deviceLabel: String = "",
        owner: String = "",
        online: Bool = true
    ) {
        self.key = key
        self.folderId = folderId
        self.name = name
        self.displayPath = displayPath
        self.readOnly = readOnly
        self.deviceId = deviceId
        self.deviceLabel = deviceLabel
        self.owner = owner
        self.online = online
    }

    private enum CodingKeys: String, CodingKey {
        case key, id, name, displayPath, readOnly, deviceId, deviceLabel, owner, online
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let key = (try? c.decodeIfPresent(String.self, forKey: .key)) ?? nil
        guard let key, !key.isEmpty else {
            throw DecodingError.dataCorruptedError(
                forKey: .key, in: c, debugDescription: "A folder needs a key"
            )
        }
        self.key = key
        folderId = ((try? c.decodeIfPresent(String.self, forKey: .id)) ?? nil) ?? ""
        let name = ((try? c.decodeIfPresent(String.self, forKey: .name)) ?? nil) ?? ""
        self.name = name.isEmpty ? "Folder" : name
        let path = (try? c.decodeIfPresent(String.self, forKey: .displayPath)) ?? nil
        displayPath = path?.isEmpty == false ? path : nil
        readOnly = ((try? c.decodeIfPresent(Bool.self, forKey: .readOnly)) ?? nil) ?? false
        deviceId = ((try? c.decodeIfPresent(String.self, forKey: .deviceId)) ?? nil) ?? ""
        let label = ((try? c.decodeIfPresent(String.self, forKey: .deviceLabel)) ?? nil) ?? ""
        deviceLabel = label.isEmpty ? "Another computer" : label
        owner = ((try? c.decodeIfPresent(String.self, forKey: .owner)) ?? nil) ?? ""
        online = ((try? c.decodeIfPresent(Bool.self, forKey: .online)) ?? nil) ?? true
    }

    /// What the chip says after the name, as the web flap words it. The
    /// native app is never the device holding a folder, so a live writable
    /// folder names its device.
    var status: String {
        if !online { return "\(deviceLabel) is offline" }
        return readOnly ? "Read only" : deviceLabel
    }

    /// Whether this viewer connected it. The server is the authority on
    /// disconnecting; this only decides whether to offer it, so it is exact
    /// rather than the loose prefix match transcript attribution uses.
    func isOwned(byName name: String, login: String) -> Bool {
        ownerClaim(name: name, login: login) != nil
    }

    /// The form of the viewer's name that matches the owner, to claim on a
    /// server without per-person sign-in, which compares the claimed name
    /// itself (a signed-in server ignores it and uses the first name of the
    /// signed-in person). nil when none matches.
    func ownerClaim(name: String, login: String) -> String? {
        let owner = owner.trimmingCharacters(in: .whitespaces).lowercased()
        guard !owner.isEmpty else { return nil }
        let full = name.trimmingCharacters(in: .whitespaces)
        let first = full.split(separator: " ").first.map(String.init) ?? ""
        // "ios" is ServerConfig's placeholder for an unnamed viewer.
        return [full, first, login.trimmingCharacters(in: .whitespaces)].first {
            !$0.isEmpty && $0.lowercased() != "ios" && $0.lowercased() == owner
        }
    }
}

/// `GET /api/local-folders?sessionId=` answers `{ folders }`.
struct LocalFoldersResponse: Decodable, Sendable {
    let folders: [LocalFolder]

    init(folders: [LocalFolder]) { self.folders = folders }

    private enum CodingKeys: String, CodingKey { case folders }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        folders = ((try? c.decodeIfPresent(LossyList<LocalFolder>.self, forKey: .folders)) ?? nil)?
            .items ?? []
    }
}
