import Foundation

/// Who a row belongs to under the list's "My sessions" lens.
///
/// Three things make a row yours:
///
/// - a session of yours in it (automation runs never count as anyone's — they
///   carry their creator, not a person), or
/// - a CLAIM. Claiming is the per-user triage that pulls an automation's run,
///   or work someone else started, into your own list, and the web sidebar has
///   honored it since lanes went per-user (`focusWsRows` in
///   src/frontend/components/Sidebar.tsx). See `LaneStore`, or
/// - an outstanding @-mention on one of its sessions. A teammate explicitly
///   asking for you admits their row to the default "My sessions" lens.
///
/// The app used to test only the first, which is how a workspace claimed in
/// the browser could be missing from the phone entirely: nothing in it was
/// started by you, it was opened by the machine identity, and the claim that
/// made it yours was invisible here.
///
/// The web's rule has a third clause this deliberately limits to a parked
/// draft: a workspace whose `createdBy` is you. Applying it to every regular
/// workspace more than tripled one person's sidebar (31 rows to 96), while a
/// sessionless draft has no other owner signal at all.
///
/// One rule for every surface that asks the question — the live list, its
/// archived slice, and the Archived sheet — because three spellings of "mine"
/// is how they drift apart.
struct PeopleLens {
    /// Identity strings that count as you: display name, its first token
    /// (sessions store first names, e.g. "Jaap"), and the GitHub login.
    let names: Set<String>
    /// First-name key to the roster's canonical display name.
    var roster: [String: String] = [:]
    /// Session ids you have claimed (`LaneStore`).
    let claims: Set<String>
    /// Session ids where a teammate tagged you (`MentionStore`).
    var mentions: Set<String> = []

    @MainActor
    static func current() -> PeopleLens {
        var names: Set<String> = []
        let config = ServerConfig.shared
        let user = config.userName.trimmingCharacters(in: .whitespaces)
        if !user.isEmpty {
            names.insert(user.lowercased())
            if let first = user.split(separator: " ").first {
                names.insert(first.lowercased())
            }
        }
        let login = config.githubLogin
        if !login.isEmpty { names.insert(login.lowercased()) }
        return PeopleLens(
            names: names,
            roster: TeamDirectory.shared.displayNames,
            claims: LaneStore.shared.claims,
            mentions: MentionStore.shared.sessionIds
        )
    }

    /// A single session under the lens: yours to start with, or claimed.
    func isMine(_ session: Session) -> Bool {
        if claims.contains(session.id) { return true }
        guard !session.isAutomation, let startedBy = session.startedBy else {
            return false
        }
        let normalized = startedBy.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if names.contains(normalized) { return true }
        guard let canonical = ArchivedOwners.canonical(startedBy, in: roster)?.lowercased() else {
            return false
        }
        return names.contains(canonical)
    }

    /// A sidebar row under the lens. A row is yours as soon as ONE of its
    /// sessions is — a workspace is shared work, not a possession.
    func owns(_ workspace: SidebarWorkspace) -> Bool {
        if workspace.isDraftWorkspace,
           let owner = workspace.workspace?.createdBy?.lowercased() {
            return names.contains(owner)
        }
        return workspace.sessions.contains { isMine($0) || mentions.contains($0.id) }
    }
}

// ── The whole person lens ───────────────────────────────────────────────────
// The list used to ask one question, "is this mine", because it offered one
// answer besides everyone's. It now offers the web's lens: you, a teammate,
// the agent, the unassigned backlog, or everyone. `owns` above stays the rule
// for "me", and is the only branch that counts claims and @-mentions.

extension PeopleLens {
    /// A row under any lens value.
    ///
    /// The web asks this of a row's resolved `owner` field, which the wire
    /// does not carry here, so the native rule reads the evidence the row
    /// itself holds: who started its sessions, and who parked its draft.
    ///
    /// Claims and mentions count under "me" only. A teammate tagging you
    /// admits their row to YOUR list, not to theirs, and a row that mentions
    /// three people would otherwise turn up under all three.
    func matches(
        _ workspace: SidebarWorkspace,
        person: String,
        agentKey: String
    ) -> Bool {
        switch person {
        case SidebarPersonLens.everyone:
            return true
        case SidebarPersonLens.me:
            return owns(workspace)
        case SidebarPersonLens.unassigned:
            // Work nobody has picked up: no person's name on it, and nothing
            // running. The web reads its `pending` status for the same thing.
            return workspace.lane == .backlog && Self.owners(of: workspace).isEmpty
        default:
            if SidebarPersonLens.nameMatches(agentKey, key: person) {
                return Self.isAgentWork(workspace)
            }
            return Self.owners(of: workspace).contains {
                SidebarPersonLens.nameMatches($0, key: person)
            }
        }
    }

    /// One session under any lens value, for the surfaces that hold sessions
    /// rather than rows (the Archived sheet).
    func matches(_ session: Session, person: String, agentKey: String) -> Bool {
        switch person {
        case SidebarPersonLens.everyone:
            return true
        case SidebarPersonLens.me:
            return isMine(session)
        case SidebarPersonLens.unassigned:
            return !session.isAutomation && Self.personName(session) == nil
        default:
            if SidebarPersonLens.nameMatches(agentKey, key: person) {
                return session.isAutomation || AutoCreatedOrigin.wasAutoCreated(session)
            }
            guard let name = Self.personName(session) else { return false }
            return SidebarPersonLens.nameMatches(name, key: person)
        }
    }

    /// The machine's own work: an automation's runs, and the one-off
    /// workspaces an agent opened for itself. Both land under the agent
    /// because nobody has taken either.
    static func isAgentWork(_ workspace: SidebarWorkspace) -> Bool {
        if AutoCreatedOrigin.wasAutoCreated(workspace) { return true }
        return !workspace.sessions.isEmpty
            && workspace.sessions.allSatisfy { $0.isAutomation }
    }

    /// The people a row names as having started it: every ordinary session's
    /// sender, plus a parked draft's author. A draft has no other owner signal
    /// at all, which is why `owns` reads it too.
    ///
    /// The machine identity is not a person, so it never appears here. That is
    /// what keeps an agent's own workspace out of every teammate's lens and in
    /// the agent's.
    static func owners(of workspace: SidebarWorkspace) -> [String] {
        var names = workspace.sessions.compactMap(personName)
        if workspace.isDraftWorkspace,
           let author = workspace.workspace?.createdBy,
           let named = person(author) {
            names.append(named)
        }
        return names
    }

    /// The person who started this session, or nil when nobody did: an
    /// automation run carries its creator rather than an owner, and the
    /// machine identity is not a person.
    static func personName(_ session: Session) -> String? {
        guard !session.isAutomation else { return nil }
        return person(session.startedBy)
    }

    private static func person(_ name: String?) -> String? {
        guard let trimmed = name?.trimmingCharacters(in: .whitespaces),
              !trimmed.isEmpty,
              trimmed.lowercased() != AutoCreatedOrigin.machineIdentity
        else { return nil }
        return trimmed
    }
}
