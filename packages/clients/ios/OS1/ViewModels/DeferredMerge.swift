import Foundation
import Observation

/// One merge held back for an undo window before its request goes out.
///
/// Mirrors the web client's `deferred-merge.ts`: the merge the person just
/// confirmed waits five seconds, counting down in whole seconds, and Undo
/// during that window means the request is never sent. Nothing here reports a
/// merged state — the phase reads `.running` only once the request is on the
/// wire, and the pull request's own state still comes from the server.
///
/// The clock is injected so tests drive the window without waiting it out.
@MainActor
@Observable
final class DeferredMerge {
    enum Phase: Equatable {
        /// Nothing held.
        case idle
        /// Waiting out the undo window; the request has not been sent.
        case scheduled
        /// The request is in flight and can no longer be taken back.
        case running
    }

    /// Mirrors the web client's `MERGE_UNDO_DELAY_MS`.
    nonisolated static let undoWindow: Duration = .seconds(5)

    private(set) var phase: Phase = .idle
    /// Whole seconds until the request goes out, or nil outside the window.
    /// Never reads zero: the last tick sends rather than showing "0".
    private(set) var secondsLeft: Int?

    private let clock: any Clock<Duration>
    private var task: Task<Void, Never>?
    /// Bumped on every schedule and cancel so a task that outlived its
    /// schedule can never send on behalf of a newer one.
    private var generation = 0

    init(clock: any Clock<Duration> = ContinuousClock()) {
        self.clock = clock
    }

    /// Hold `send` for the window. Refused while a merge is already held or
    /// in flight, so a double confirmation can never send twice.
    @discardableResult
    func schedule(
        window: Duration = DeferredMerge.undoWindow,
        send: @escaping @MainActor () async throws -> Void,
        completion: @escaping @MainActor (Result<Void, any Error>) -> Void = { _ in }
    ) -> Bool {
        guard phase == .idle else { return false }
        generation += 1
        let generation = generation
        phase = .scheduled
        secondsLeft = Self.wholeSeconds(window)
        task = Task { [clock] in
            var remaining = window
            while remaining > .zero {
                let step = min(remaining, .seconds(1))
                do {
                    try await clock.sleep(for: step)
                } catch {
                    return
                }
                guard self.generation == generation, self.phase == .scheduled else { return }
                remaining -= step
                self.secondsLeft = remaining > .zero ? Self.wholeSeconds(remaining) : nil
            }
            guard self.generation == generation, self.phase == .scheduled else { return }
            self.phase = .running
            self.secondsLeft = nil
            let result: Result<Void, any Error>
            do {
                try await send()
                result = .success(())
            } catch {
                result = .failure(error)
            }
            guard self.generation == generation else { return }
            self.phase = .idle
            self.task = nil
            completion(result)
        }
        return true
    }

    /// Take the merge back. True when a held request will now never be sent;
    /// false when nothing was held or the request is already in flight.
    @discardableResult
    func cancel() -> Bool {
        guard phase == .scheduled else { return false }
        generation += 1
        task?.cancel()
        task = nil
        phase = .idle
        secondsLeft = nil
        return true
    }

    private static func wholeSeconds(_ duration: Duration) -> Int {
        max(1, Int((duration / .seconds(1)).rounded(.up)))
    }

    #if DEBUG
    /// Hold the window open at one digit with no request behind it, so a
    /// screenshot can catch the countdown. Undo clears it like any other.
    func presentFixture(secondsLeft: Int) {
        cancel()
        phase = .scheduled
        self.secondsLeft = secondsLeft
    }
    #endif
}
