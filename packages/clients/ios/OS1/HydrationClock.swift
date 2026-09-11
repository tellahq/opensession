import Foundation

/// Orders one user-map store's GETs against each other and against its
/// confirmed writes, so a slow response cannot overwrite a newer map.
///
/// The stores release the main actor while a GET is in flight, and two GETs
/// overlap whenever a `user_map_changed` frame lands during the 30-second
/// tick. Without ordering, the tick's response (read before the other
/// client's write) could publish after the frame's response and drop that
/// write until the next tick. A write this client confirmed meanwhile has the
/// same effect: the GET may have been served the pre-write map, and the
/// write's own response is already the fresher one. Same rule as the web
/// `user-map`'s `hydrationVersion` and `confirmedVersions`.
struct HydrationClock {
    /// Handed out when a GET begins; presented again with its response.
    struct Ticket: Equatable {
        fileprivate let version: Int
        fileprivate let confirmed: Int
    }

    private var version = 0
    private var confirmed = 0

    /// Start a GET. Any earlier ticket is stale from here on.
    mutating func begin() -> Ticket {
        version += 1
        return Ticket(version: version, confirmed: confirmed)
    }

    /// A write's response was applied; GETs begun before it are stale.
    mutating func confirmWrite() {
        confirmed += 1
    }

    /// True while no newer GET has begun and no write has been confirmed
    /// since the ticket was issued.
    func isCurrent(_ ticket: Ticket) -> Bool {
        ticket.version == version && ticket.confirmed == confirmed
    }
}
