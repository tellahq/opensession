import Foundation
import SwiftUI

/// One directory-backed owner whose recent work appears in the compact Team
/// section. `allSessions` is retained for parity with the web grouping even
/// though native deliberately renders only the active window.
struct TeamActivityGroup: Identifiable, Equatable {
    let key: String
    let label: String
    let activeSessions: [Session]
    let allSessions: [Session]

    var id: String { key }
}

/// Pure grouping for the Team section. This is independent of every workspace
/// lens: it starts from the complete live payload, admits only directory
/// members, excludes the signed-in person, and files ownerless automation runs
/// under Agent.
enum TeamActivity {
    static let recentInterval: TimeInterval = 15 * 60
    static let agentKey = "agent"
    static let agentLabel = "Agent"

    struct Member: Equatable {
        let name: String
        let aliases: [String]

        init(name: String, aliases: [String] = []) {
            self.name = name
            self.aliases = aliases.isEmpty ? [name] : aliases
        }
    }

    static func isRecentlyActive(_ session: Session, now: Date) -> Bool {
        if session.isRunning == true { return true }
        guard session.ran == true, let activity = session.lastActivityDate else { return false }
        return activity >= now.addingTimeInterval(-recentInterval)
    }

    static func groups(
        sessions: [Session],
        members: [Member],
        currentUser: String,
        automationOwners: [String: String] = [:],
        now: Date = Date()
    ) -> [TeamActivityGroup] {
        let current = member(matching: currentUser, in: members)
        var order: [String] = []
        var grouped: [String: (label: String, active: [Session], all: [Session])] = [:]

        for session in sessions where session.archived != true && session.desk != true {
            let owner: Member?
            let key: String
            let label: String
            if session.isAutomation {
                let configuredOwner = session.automation?.name
                    .flatMap { automationOwners[$0] }?.trimmingCharacters(
                        in: .whitespacesAndNewlines
                    )
                if let configuredOwner, !configuredOwner.isEmpty,
                   let resolved = member(matching: configuredOwner, in: members) {
                    owner = resolved
                    key = memberKey(resolved)
                    label = resolved.name
                } else {
                    owner = nil
                    key = agentKey
                    label = agentLabel
                }
            } else {
                guard let startedBy = session.startedBy,
                      let resolved = member(matching: startedBy, in: members)
                else { continue }
                owner = resolved
                key = memberKey(resolved)
                label = resolved.name
            }

            if let owner, isCurrent(owner, currentUser: currentUser, resolved: current) {
                continue
            }
            if grouped[key] == nil {
                order.append(key)
                grouped[key] = (label, [], [])
            }
            var group = grouped[key]!
            group.all.append(session)
            if isRecentlyActive(session, now: now) {
                group.active.append(session)
            }
            grouped[key] = group
        }

        return order.compactMap { key in
            guard let group = grouped[key], !group.active.isEmpty else { return nil }
            return TeamActivityGroup(
                key: key,
                label: group.label,
                activeSessions: group.active,
                allSessions: group.all
            )
        }
    }

    private static func member(matching value: String, in members: [Member]) -> Member? {
        let needle = normalized(value)
        guard !needle.isEmpty else { return nil }
        return members.first { member in
            member.aliases.contains { normalized($0) == needle }
                || normalized(member.name) == needle
                || SidebarPersonLens.nameMatches(member.name, key: value)
        }
    }

    private static func isCurrent(
        _ member: Member, currentUser: String, resolved current: Member?
    ) -> Bool {
        if let current, memberKey(member) == memberKey(current) { return true }
        let currentKey = normalized(currentUser)
        return !currentKey.isEmpty && member.aliases.contains { alias in
            normalized(alias) == currentKey
                || SidebarPersonLens.nameMatches(alias, key: currentUser)
        }
    }

    private static func memberKey(_ member: Member) -> String {
        normalized(member.name).split(separator: " ").first.map(String.init) ?? normalized(member.name)
    }

    private static func normalized(_ value: String) -> String {
        value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }
}

#if os(iOS)
/// Whose work you are looking at, and who is around to have made it.
///
/// Two shapes for one choice, because the web draws it in two places and the
/// phone reads both. `TeamLensPile` is the pile of faces at the right edge of
/// the sidebar's Feed row, which is where the desktop sidebar carries it
/// (`TeamLensMenu` in components/Sidebar.tsx): a lens you can reach without
/// leaving the row you are on. `SidebarPresenceStrip` is the Feed page's own
/// row of chips (`components/Feed.tsx`), which is a strip because that page
/// has the width for one and picking a face is the page's main gesture.
///
/// Both read `PresenceStore`, which is `@Observable`, so a frame landing
/// repaints the faces and nothing else.

/// Everyone on the roster, present people first, in the roster's own order
/// after that. Presence leads because a face is worth showing for saying who
/// is around; a name that never moves reads as furniture wherever it sits.
@MainActor
private func lensTeammates(excluding currentUser: String) -> [String] {
    let presence = PresenceStore.shared
    return TeamDirectory.shared.names
        .filter { !SidebarPersonLens.nameMatches($0, key: currentUser) }
        .enumerated()
        .sorted { lhs, rhs in
            let left = presence.isPresent(lhs.element)
            let right = presence.isPresent(rhs.element)
            if left != right { return left }
            return lhs.offset < rhs.offset
        }
        .map(\.element)
}

/// The team at the right edge of the sidebar's Feed row.
///
/// A sibling of the row's button rather than a child of it, because a button
/// nested in another swallows its taps on iOS: a tap on the faces opens the
/// lens, a tap anywhere else opens Feed. The pile is the same one the session
/// rows wear, so "who is here" reads as one thing across the list.
struct TeamLensPile: View {
    @Binding var person: String
    let currentUser: String

    var body: some View {
        let team = lensTeammates(excluding: currentUser)
        if team.isEmpty {
            EmptyView()
        } else {
            Menu {
                Picker("Show work by", selection: $person) {
                    Text("Everyone").tag(SidebarPersonLens.everyone)
                    Text(currentUser.isEmpty ? "You" : "\(currentUser) (you)")
                        .tag(SidebarPersonLens.me)
                    ForEach(team, id: \.self) { name in
                        // The qualifier says who is around, since a menu row
                        // has no face to hang a dot on.
                        Text(PresenceStore.shared.isPresent(name)
                            ? "\(name) · here now"
                            : name)
                            .tag(name.lowercased())
                    }
                }
            } label: {
                PresenceFacepile(
                    viewers: team,
                    size: 22,
                    separation: .seam,
                    maxFaces: 4
                )
                    // Pads the trigger out to the row's own height so the faces
                    // are a thumb-sized target rather than a 22pt one. Reach
                    // only: nothing about it reads larger at rest.
                    .padding(.vertical, 11)
                    .padding(.leading, 10)
                    .contentShape(Rectangle())
            }
            .accessibilityLabel("Show work by someone")
        }
    }
}

/// The Feed page's row of faces: who is around, and how you narrow the page to
/// one of them.
///
/// A face carries presence the way the web's chip does. A dot in the corner,
/// green while that person has something open right now, ringed in the page's
/// own canvas so it reads as a gap in the picture rather than a mark on it.
struct SidebarPresenceStrip: View {
    /// The person key this strip sets, in the same spellings the sidebar lens
    /// uses.
    @Binding var person: String
    /// Whoever is signed in, so "you" is one row rather than two spellings.
    let currentUser: String

    var body: some View {
        ScrollView(.horizontal) {
            HStack(spacing: 10) {
                everyoneChip
                if !currentUser.isEmpty {
                    chip(
                        name: currentUser,
                        key: SidebarPersonLens.me,
                        label: "You",
                        present: true
                    )
                }
                ForEach(lensTeammates(excluding: currentUser), id: \.self) { name in
                    chip(
                        name: name,
                        key: name.lowercased(),
                        label: name,
                        present: PresenceStore.shared.isPresent(name)
                    )
                }
            }
            // The strip bleeds to the screen edge and pads itself, so a face
            // scrolled to the end sits on the list's own margin rather than
            // stopping short of it.
            .padding(.horizontal, 16)
            .padding(.vertical, 2)
        }
        .scrollIndicators(.hidden)
        .task { await TeamDirectory.shared.ensureLoaded() }
    }

    private var everyoneChip: some View {
        let selected = person == SidebarPersonLens.everyone
        return Button {
            pick(SidebarPersonLens.everyone)
        } label: {
            Image(systemName: "person.2")
                .font(.system(size: 15, weight: .medium))
                .foregroundStyle(selected ? OS1VisualStyle.onAccent : OS1VisualStyle.textDim)
                .frame(width: faceSize, height: faceSize)
                .background(
                    SquircleCapsule().fill(selected ? OS1VisualStyle.accent : OS1VisualStyle.hover)
                )
                .lensRing(selected: selected)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(selected ? "Everyone, selected" : "Everyone")
    }

    private func chip(
        name: String,
        key: String,
        label: String,
        present: Bool
    ) -> some View {
        let selected = person == key
        return Button {
            pick(key)
        } label: {
            UserAvatar(person: name, size: faceSize)
                .lensRing(selected: selected)
                .overlay(alignment: .bottomTrailing) {
                    if present {
                        Circle()
                            .fill(OS1VisualStyle.green)
                            .frame(width: 9, height: 9)
                            .background(
                                Circle()
                                    .fill(OS1VisualStyle.background)
                                    .frame(width: 13, height: 13)
                            )
                            .offset(x: 1, y: 1)
                    }
                }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(accessibilityLabel(label, present: present, selected: selected))
    }

    private func accessibilityLabel(
        _ label: String,
        present: Bool,
        selected: Bool
    ) -> String {
        var parts = [label]
        if present { parts.append("here now") }
        if selected { parts.append("selected") }
        return parts.joined(separator: ", ")
    }

    /// Tapping the person you are already on clears back to everyone, so the
    /// strip is its own undo and never strands a list you cannot widen.
    private func pick(_ key: String) {
        Haptics.play(.selection)
        withAnimation(.snappy(duration: 0.22)) {
            person = person == key && key != SidebarPersonLens.everyone
                ? SidebarPersonLens.everyone
                : key
        }
    }

    private let faceSize: CGFloat = 34
}

private extension View {
    /// The accent ring a picked face wears, in the face's own shape. Struck
    /// outside the avatar rather than on it, so the picture keeps its full
    /// size whether or not it is the one selected and the strip never shifts
    /// when you tap along it.
    func lensRing(selected: Bool) -> some View {
        overlay {
            if selected {
                SquircleCapsule()
                    .stroke(OS1VisualStyle.accent, lineWidth: 2)
                    .padding(-3)
            }
        }
    }
}
#endif
