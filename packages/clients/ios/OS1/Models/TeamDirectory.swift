import Foundation
import Observation

/// The team roster, fetched once per launch from `GET /api/people` and kept in
/// memory: first name → GitHub login, so a name that arrives over the wire
/// (presence viewers, `startedBy`) can be drawn as that person's face.
///
/// Keyed on the LOWERCASED FIRST NAME because that is the shape the server
/// sends everywhere — the WebSocket upgrade stamps each socket with the
/// signed-in person's first name, and chat integrations send full names whose
/// first token is the same key.
@MainActor
@Observable
final class TeamDirectory {
    static let shared = TeamDirectory()

    private(set) var githubLogins: [String: String] = [:]
    /// First name → the picture they uploaded, as a server-relative path.
    /// Absent for everyone who has not set one, which is the normal case.
    private(set) var profileImages: [String: String] = [:]
    /// Everyone on the roster, in the order the server lists them — what a
    /// picker offers ("ask Kent to review this"). The maps below answer
    /// questions about one name; this is the list itself.
    private(set) var names: [String] = []
    /// Teams a review can be handed to instead of a person.
    private(set) var reviewTeams: [OS1API.ReviewTeam] = []
    /// First name → the roster's own spelling of it. This is what merges one
    /// person's spellings for a filter: chat integrations write a full name
    /// where the web writes a first name, so "Kent" and "Kent de Bruin" must
    /// answer to one option (`ArchivedOwners`). The key already IS the first
    /// name, so no second map is needed the way the web needs one.
    private(set) var displayNames: [String: String] = [:]
    private var fullNames: [String: String] = [:]
    private var accountID: String?
    private var loading = false
    private var lastFailureAt: Date?

    /// GitHub login for a display name, or nil for someone outside the roster
    /// (the agent persona, "Anonymous", a teammate not yet in the config) —
    /// those fall back to a tinted initial.
    func githubLogin(for name: String) -> String? {
        guard let key = Self.key(name) else { return nil }
        return githubLogins[key]
    }

    /// The picture this person uploaded, or nil when they have not set one and
    /// their face should come from GitHub.
    func profileImage(for name: String) -> String? {
        guard let key = Self.key(name) else { return nil }
        return profileImages[key]
    }

    /// The display name behind a GitHub login ("kentdebruin" → "Kent"), or nil
    /// for a login outside the roster. The inverse of `githubLogin(for:)`,
    /// needed wherever the wire carries a login rather than a name — a pull
    /// request's author, for one — so a teammate pictures and reads as
    /// themselves instead of as their login.
    func displayName(forGithubLogin login: String) -> String? {
        let needle = login.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !needle.isEmpty else { return nil }
        guard let key = githubLogins.first(where: { $0.value.lowercased() == needle })?.key
        else { return nil }
        return displayNames[key]
    }

    /// Full name when the roster knows one, for accessibility labels and
    /// tooltips; otherwise whatever the wire called them.
    func fullName(for name: String) -> String {
        guard let key = Self.key(name) else { return name }
        return fullNames[key] ?? name
    }

    /// The directory boundary used by Team activity. Each member carries every
    /// spelling the sessions payload can use, so a full name or GitHub login
    /// resolves to the roster entry rather than becoming an invented person.
    var activityMembers: [TeamActivity.Member] {
        names.map { name in
            let key = Self.key(name) ?? name.lowercased()
            return TeamActivity.Member(
                name: name,
                aliases: [name, fullNames[key], githubLogins[key]].compactMap { $0 }
            )
        }
    }

    /// Fetch the roster unless it is already loaded or in flight. Failures
    /// retry after a cooldown instead of hammering a server that is down —
    /// a missing directory only costs initials.
    func ensureLoaded() async {
        let currentAccountID = ServerConfig.shared.activeId
        if accountID != currentAccountID {
            accountID = currentAccountID
            githubLogins = [:]
            profileImages = [:]
            names = []
            reviewTeams = []
            displayNames = [:]
            fullNames = [:]
            loading = false
            lastFailureAt = nil
        }
        guard names.isEmpty, !loading else { return }
        if let lastFailureAt, Date().timeIntervalSince(lastFailureAt) < 30 { return }
        loading = true
        defer {
            if accountID == currentAccountID { loading = false }
        }
        guard let roster = try? await OS1API.people() else {
            if accountID == currentAccountID { lastFailureAt = Date() }
            return
        }
        guard accountID == currentAccountID,
              ServerConfig.shared.activeId == currentAccountID
        else { return }
        let people = roster.people ?? []
        names = people.map(\.name)
        reviewTeams = roster.reviewTeams ?? []
        for person in people {
            guard let key = Self.key(person.name) else { continue }
            displayNames[key] = person.name
            if let github = person.github, !github.isEmpty { githubLogins[key] = github }
            // Assigned rather than merged: a person who cleared their picture
            // must lose the tile, not keep the last one the roster carried.
            if let image = person.image, !image.isEmpty {
                profileImages[key] = image
            } else {
                profileImages[key] = nil
            }
            if let fullName = person.fullName, !fullName.isEmpty { fullNames[key] = fullName }
        }
        lastFailureAt = nil
    }

    private static func key(_ name: String) -> String? {
        name.trimmingCharacters(in: .whitespacesAndNewlines)
            .split(separator: " ")
            .first?
            .lowercased()
    }
}
