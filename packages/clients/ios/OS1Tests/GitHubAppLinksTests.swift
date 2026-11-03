import XCTest
@testable import OS1

/// With "Open pull requests in GitHub" on, only PR pages are rerouted to the
/// GitHub app; every other link keeps its in-app landing.
final class GitHubAppLinksTests: XCTestCase {
    func testPullRequestPagesMatch() {
        for string in [
            "https://github.com/acme/widgets/pull/42",
            "https://github.com/acme/widgets/pull/42/files",
            "https://www.github.com/acme/widgets/pull/7#issuecomment-1",
            "http://GitHub.com/acme/widgets/pull/1",
        ] {
            XCTAssertTrue(GitHubAppLinks.isPullRequest(URL(string: string)!), string)
        }
    }

    func testOtherLinksDoNotMatch() {
        for string in [
            "https://github.com/acme/widgets",
            "https://github.com/acme/widgets/issues/42",
            "https://github.com/acme/widgets/pull/new",
            "https://github.com/acme/widgets/pulls",
            "https://example.test/acme/widgets/pull/42",
            "os1pr://acme/42",
        ] {
            XCTAssertFalse(GitHubAppLinks.isPullRequest(URL(string: string)!), string)
        }
    }

    func testOffByDefault() {
        let defaults = UserDefaults.standard
        let saved = defaults.object(forKey: GitHubAppLinks.preferenceKey)
        defer { defaults.set(saved, forKey: GitHubAppLinks.preferenceKey) }
        defaults.removeObject(forKey: GitHubAppLinks.preferenceKey)
        XCTAssertFalse(GitHubAppLinks.isEnabled)
    }
}
