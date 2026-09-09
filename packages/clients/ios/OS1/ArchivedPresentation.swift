import Foundation

/// What the Archived screen says about a row and its lenses, as values: the
/// chip trailing a title, and the word each picker wears. Mirrors the web's
/// `Archived.tsx` (`originChip` and the picker labels) so both clients name
/// the same things the same way, and sits apart from the view so a test can
/// read it without a screen.
enum ArchivedPresentation {
    /// The chip naming where a session came from. Rendered only when it says
    /// something: an automation's name is worth a chip, so is a session that
    /// arrived from Slack or Linear, or one that ran read-only. A code session
    /// started here is the default and gets none. The product's own name on
    /// every row would be a column of noise dressed as data.
    struct OriginChip: Equatable {
        enum Tone: Equatable {
            /// The plain pill: an automation, or an origin with no hue of its own.
            case neutral
            /// Green, because that is what ask means across the product.
            case ask
        }

        let label: String
        let tone: Tone
    }

    /// The source ids that mean "started here", including the pre-rename one
    /// older servers and archived rows still send.
    private static let ownSources: Set<String> = ["opensession", "backstage"]

    static func originChip(for session: Session) -> OriginChip? {
        if let name = session.automation?.name {
            return OriginChip(label: name, tone: .neutral)
        }
        if session.mode == "ask" {
            return OriginChip(label: "ask", tone: .ask)
        }
        if let source = session.source, !source.isEmpty, !ownSources.contains(source) {
            return OriginChip(label: source, tone: .neutral)
        }
        return nil
    }

    /// What the Owner picker wears for a selection: the two fixed lenses by
    /// name, a teammate by the roster's spelling, and a key the roster no
    /// longer answers to as itself rather than as nothing.
    static func ownerLabel(_ owner: String, owners: [ArchivedOwners.Owner]) -> String {
        switch owner {
        case ArchivedOwners.mine: "My archived"
        case ArchivedOwners.everyone: "Everyone"
        default: owners.first { $0.key == owner }?.label ?? owner
        }
    }

    static let allRepositories = "all"

    static func repositoryLabel(_ repo: String) -> String {
        repo == allRepositories ? "All repos" : RepoTile.label(for: repo)
    }

    struct Reason: Identifiable {
        let key: String
        let label: String

        var id: String { key }
    }

    /// The Reason lens, in the order the menu lists it.
    static let reasons: [Reason] = [
        Reason(key: "all", label: "All"),
        Reason(key: "auto", label: "Auto-archived"),
        Reason(key: "manual", label: "Manual"),
    ]

    static func reasonLabel(_ reason: String) -> String {
        reasons.first { $0.key == reason }?.label ?? reason
    }
}
