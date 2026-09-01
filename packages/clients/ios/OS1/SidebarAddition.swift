import Foundation

/// Decides whether an open session needs an explicit personal lane claim.
/// The unit is the whole sidebar row: one ordinary session the viewer started
/// already represents every sibling, while teammate, automation, and spawned
/// work needs a claim. A hidden row can always be restored without adding a
/// redundant claim.
enum SidebarAddition {
    enum Intent: Equatable {
        case claim
        case restore
    }

    static func intent(
        for session: Session,
        siblings: [Session],
        claims: Set<String>,
        hidden: Bool,
        viewerName: String,
        viewerLogin: String
    ) -> Intent? {
        guard session.archived != true else { return nil }
        let row = siblings.isEmpty ? [session] : siblings
        if hidden { return .restore }
        guard !row.contains(where: { claims.contains($0.id) }),
              !row.contains(where: {
                  $0.spawnedBy?.isEmpty != false
                      && !$0.isAutomation
                      && MessageAttribution.isViewer(
                          $0.startedBy ?? "",
                          viewerName: viewerName,
                          viewerLogin: viewerLogin
                      )
              })
        else { return nil }
        return .claim
    }

    @MainActor
    static func currentIntent(for session: Session, siblings: [Session]) -> Intent? {
        let hidden = !Set(SidebarRowKeys.candidateKeys(for: session))
            .isDisjoint(with: HideStore.shared.hides.keys)
        let config = ServerConfig.shared
        return intent(
            for: session,
            siblings: siblings,
            claims: LaneStore.shared.claims,
            hidden: hidden,
            viewerName: config.userName,
            viewerLogin: config.githubLogin
        )
    }

    @MainActor
    static func add(session: Session, siblings: [Session]) {
        guard let intent = currentIntent(for: session, siblings: siblings) else { return }
        HideStore.shared.unhide(for: session)
        if intent == .claim {
            LaneStore.shared.claim(siblings.isEmpty ? [session] : siblings)
        }
    }
}
