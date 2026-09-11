import Foundation

/// Orders one user-map store's GETs against each other and against its
/// confirmed writes, so a slow response cannot overwrite a newer map.
///
/// Only the latest GET may apply. A confirmed write invalidates outstanding
/// GETs because they may predate it. Conversely, a GET begun during a PUT
/// may carry a newer map than the PUT response: the server broadcasts before
/// answering the PUT. In that case the store keeps its map and re-reads.
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

    /// The clock as it stands, without starting a GET. A write takes one so
    /// its response can tell whether a re-read began meanwhile.
    func mark() -> Ticket {
        Ticket(version: version, confirmed: confirmed)
    }

    /// A write was acknowledged; earlier GETs must not restore pre-write state.
    mutating func confirmWrite() {
        confirmed += 1
    }

    /// True while no newer GET has begun and no write has been confirmed
    /// since the ticket was issued.
    func isCurrent(_ ticket: Ticket) -> Bool {
        ticket.version == version && ticket.confirmed == confirmed
    }

    /// True once any GET has begun after `ticket` was taken, whether or not
    /// its response has landed.
    func hasHydrationBegun(since ticket: Ticket) -> Bool {
        ticket.version != version
    }
}
