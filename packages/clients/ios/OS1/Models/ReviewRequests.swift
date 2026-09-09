import Foundation

/// Whether a pull-request review is still waiting on the person holding this
/// device, and who is waiting for it.
///
/// GitHub drops a reviewer from `prReviewRequested` the instant they submit a
/// review, and puts them back on a re-request, so "still listed" is the whole
/// test: the mark clears when you have actually reviewed rather than when you
/// have looked at the row. That is the same rule the web sidebar's Needs
/// review band applies (`wsPrRequestsReviewFrom` in lib/review-queue), kept in
/// step deliberately so the two clients never disagree about whose turn it is.
///
/// Team requests are expanded to their members server-side, so a request made
/// to a team reaches every member here, exactly as it does in GitHub's own
/// review queue.
enum ReviewRequests {
    /// `viewerName` is the display name the app knows itself by, `viewerLogin`
    /// the GitHub login — a device whose token was pasted rather than signed
    /// in has only the second.
    static func waitsOnViewer(
        _ sessions: [Session],
        viewerName: String,
        viewerLogin: String
    ) -> Bool {
        sessions.contains { session in
            (session.prReviewRequested ?? []).contains { reviewer in
                MessageAttribution.isViewer(
                    reviewer,
                    viewerName: viewerName,
                    viewerLogin: viewerLogin
                )
            }
        }
    }

    /// Who is waiting: the pull request's AUTHOR, or on a bot-authored PR the
    /// teammate it was opened for (`Session.prRequester`).
    ///
    /// GitHub does not record who added you as a reviewer, so the author is
    /// the closest true answer — and it is the one worth knowing either way,
    /// since they are the person blocked on you. Callers must phrase it as
    /// whose pull request it is rather than as who asked.
    ///
    /// Returns a GitHub login, which `TeamDirectory` resolves to a teammate's
    /// own name where it knows one.
    static func askerLogin(
        _ sessions: [Session],
        viewerName: String,
        viewerLogin: String
    ) -> String? {
        sessions.first { session in
            session.prAuthor?.isEmpty == false
                && (session.prReviewRequested ?? []).contains { reviewer in
                    MessageAttribution.isViewer(
                        reviewer,
                        viewerName: viewerName,
                        viewerLogin: viewerLogin
                    )
                }
        }
        .flatMap { session in
            session.prRequester?.isEmpty == false ? session.prRequester : session.prAuthor
        }
    }
}
