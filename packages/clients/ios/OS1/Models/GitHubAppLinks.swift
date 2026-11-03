import Foundation
#if os(iOS)
import UIKit
#endif

/// The "Open pull requests in GitHub" preference: a PR link in a transcript
/// goes straight to the GitHub app instead of the session's Review panel or
/// the in-app browser.
///
/// Device-local, like haptics: whether the GitHub app is installed is a fact
/// about this phone, not the account. Absent means off, so the review panel
/// stays the default landing.
enum GitHubAppLinks {
    static let preferenceKey = "os1.links.prsInGitHubApp"

    static var isEnabled: Bool {
        UserDefaults.standard.bool(forKey: preferenceKey)
    }

    /// Whether `url` is a pull request page on github.com
    /// (`https://github.com/<owner>/<repo>/pull/<number>[/…]`). Only these are
    /// rerouted; every other web link keeps opening in the in-app browser.
    static func isPullRequest(_ url: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased(), scheme == "https" || scheme == "http",
              let host = url.host?.lowercased(), host == "github.com" || host == "www.github.com"
        else { return false }
        let parts = url.path.split(separator: "/")
        guard parts.count >= 4, parts[2] == "pull" else { return false }
        return Int(parts[3]) != nil
    }

    #if os(iOS)
    /// Hands `url` to the GitHub app through its universal link. When the app
    /// is not installed iOS refuses a universal-link-only open, and the link
    /// lands on `fallback` instead (the in-app browser), so the tap is never
    /// lost.
    @MainActor
    static func open(_ url: URL, fallback: @escaping @MainActor (URL) -> Void) {
        UIApplication.shared.open(url, options: [.universalLinksOnly: true]) { opened in
            if !opened {
                Task { @MainActor in fallback(url) }
            }
        }
    }
    #endif
}
