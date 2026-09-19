import XCTest
@testable import OS1

/// The Usage page reads three or four limits per account and draws each one.
/// Getting the reading wrong is invisible in a screenshot — a stale window
/// still draws a plausible bar — so the rules are tested rather than eyeballed.
final class AccountUsageTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_700_000_000)

    private func window(_ label: String, _ utilization: Double?, resets: TimeInterval? = nil, scoped: Bool = false) -> LimitWindow {
        LimitWindow(
            label: label,
            utilization: utilization,
            resetsAt: resets.map { ISO8601DateFormatter().string(from: now.addingTimeInterval($0)) },
            scoped: scoped
        )
    }

    func testEveryLimitWithANumberIsDrawn() {
        let live = AccountUsageReading.liveLimits(
            [window("5h", 12), window("7d", 84), window("Fable", 40, scoped: true)],
            now: now
        )
        XCTAssertEqual(live.map(\.label), ["5h", "7d", "Fable"])
        XCTAssertEqual(live.map(\.utilization), [12, 84, 40])
    }

    /// A per-model cap holds up one model rather than the account, so it reads
    /// after the account's own windows.
    func testPerModelCapsComeAfterTheAccountsOwnWindows() {
        let live = AccountUsageReading.liveLimits(
            [window("Spark 1w", 0, scoped: true), window("Codex 1w", 82)],
            now: now
        )
        XCTAssertEqual(live.map(\.label), ["Codex 1w", "Spark 1w"])
    }

    /// "Unknown" and "nothing used" are different states: a token that cannot
    /// read usage must not draw an empty bar.
    func testWindowsWithoutANumberAreLeftOutRatherThanDrawnEmpty() {
        let live = AccountUsageReading.liveLimits([window("5h", nil), window("7d", 3)], now: now)
        XCTAssertEqual(live.map(\.label), ["7d"])
        XCTAssertTrue(AccountUsageReading.liveLimits([window("5h", nil)], now: now).isEmpty)
    }

    /// A window whose reset has already passed is provably stale. Counting it
    /// at its last value would pin a just-reset account at 100% until the next
    /// poll.
    func testAPassedResetCountsAsEmpty() {
        let stale = window("5h", 100, resets: -60)
        XCTAssertEqual(AccountUsageReading.liveUtilization(stale, now: now), 0)

        let live = AccountUsageReading.liveLimits([stale, window("7d", 20)], now: now)
        XCTAssertEqual(live.map(\.utilization), [0, 20])
    }

    /// Utilization arrives as 0-100, the same scale the web meter takes.
    /// Reading it as a fraction printed every busy account as "10000%".
    func testUtilizationIsAPercentageNotAFraction() {
        XCTAssertEqual(AccountUsageReading.percentLabel(98), "98%")
        XCTAssertEqual(AccountUsageReading.fraction(98), 0.98, accuracy: 0.0001)
        XCTAssertEqual(AccountUsageReading.fraction(140), 1, accuracy: 0.0001)
        XCTAssertEqual(AccountUsageReading.fraction(nil), 0, accuracy: 0.0001)
    }

    func testColourOnlyMeansRunningOut() {
        XCTAssertFalse(AccountUsageReading.isWarning(69))
        XCTAssertTrue(AccountUsageReading.isWarning(70))
        XCTAssertFalse(AccountUsageReading.isNearLimit(89))
        XCTAssertTrue(AccountUsageReading.isNearLimit(90))
    }

    /// What a person wants from a limit is how long until it frees up.
    func testResetReadsAsTimeRemaining() {
        XCTAssertEqual(AccountUsageReading.formatReset(iso(now.addingTimeInterval(1800)), now: now), "resets in 30m")
        XCTAssertEqual(AccountUsageReading.formatReset(iso(now.addingTimeInterval(7200)), now: now), "resets in 2h")
        XCTAssertEqual(AccountUsageReading.formatReset(iso(now.addingTimeInterval(86400 * 3)), now: now), "resets in 3d")
        XCTAssertEqual(AccountUsageReading.formatReset(iso(now.addingTimeInterval(-60)), now: now), "resets now")
        XCTAssertNil(AccountUsageReading.formatReset(nil, now: now))
    }

    func testClaudeLimitsCarryTheRollingWindowsAndTheScopedCaps() {
        let usage = AccountUsage(
            fiveHour: UsageWindow(utilization: 10, resetsAt: nil),
            sevenDay: UsageWindow(utilization: 20, resetsAt: nil),
            scopedLimits: [ScopedUsageLimit(label: "Fable", utilization: 30, resetsAt: nil)]
        )
        let limits = AccountUsageReading.claudeLimits(usage)
        XCTAssertEqual(limits.map(\.label), ["5h", "7d", "Fable"])
        XCTAssertEqual(limits.filter(\.scoped).map(\.label), ["Fable"])
    }

    /// Both of a bucket's windows carry its name, so the length is what tells
    /// them apart. With one bucket the name adds nothing and the length stands
    /// alone, as it does on the web.
    func testCodexLimitsAreNamedForTheirWindowLength() {
        let oneBucket = AccountUsage(
            buckets: [
                CodexUsageBucket(
                    id: "codex",
                    primary: UsageWindow(utilization: 40, resetsAt: nil, windowDurationMins: 300),
                    secondary: UsageWindow(utilization: 90, resetsAt: nil, windowDurationMins: 10_080)
                )
            ]
        )
        XCTAssertEqual(AccountUsageReading.codexLimits(oneBucket).map(\.label), ["5h", "1w"])

        let twoBuckets = AccountUsage(
            buckets: [
                CodexUsageBucket(
                    id: "codex",
                    primary: UsageWindow(utilization: 82, resetsAt: nil, windowDurationMins: 10_080)
                ),
                CodexUsageBucket(
                    id: "spark",
                    label: "GPT-5.3-Codex-Spark",
                    primary: UsageWindow(utilization: 0, resetsAt: nil, windowDurationMins: 10_080)
                ),
            ]
        )
        let limits = AccountUsageReading.codexLimits(twoBuckets)
        XCTAssertEqual(limits.map(\.label), ["codex 1w", "GPT-5.3-Codex-Spark 1w"])
        // The named bucket is a per-model budget, so it sorts after the plan's
        // own window even though both windows are the same length.
        XCTAssertEqual(limits.filter(\.scoped).map(\.label), ["GPT-5.3-Codex-Spark 1w"])
    }

    /// Every field is optional, as everywhere else in this client: a server
    /// that reports a shape this build has never seen still decodes.
    func testUsageDecodesFromAPartialPayload() throws {
        let json = Data(#"{"fetchedAt":"2026-08-16T10:00:00Z","fiveHour":{"utilization":42}}"#.utf8)
        let usage = try JSONDecoder().decode(AccountUsage.self, from: json)
        XCTAssertEqual(usage.fiveHour?.utilization, 42)
        XCTAssertNil(usage.sevenDay)
        XCTAssertNil(usage.buckets)
    }

    private func iso(_ date: Date) -> String {
        ISO8601DateFormatter().string(from: date)
    }

    // MARK: Weekly remaining

    private func pooled(
        _ id: String, _ name: String, kind: AccountKind = .claude, owner: String? = nil,
        usable: Bool? = true, usage: AccountUsage? = nil
    ) -> PooledAccount {
        var account = ProviderAccount()
        account.id = id
        account.name = name
        account.owner = owner
        account.usable = usable
        account.usage = usage
        return PooledAccount(account: account, kind: kind)
    }

    private func claudeUsage(week: Double?, fable: Double? = nil, resets: TimeInterval = 3600 * 70) -> AccountUsage {
        var usage = AccountUsage()
        usage.fiveHour = UsageWindow(utilization: 60, resetsAt: iso(now.addingTimeInterval(7200)))
        usage.sevenDay = UsageWindow(utilization: week, resetsAt: iso(now.addingTimeInterval(resets)))
        if let fable {
            usage.scopedLimits = [ScopedUsageLimit(label: "Fable", utilization: fable, resetsAt: iso(now.addingTimeInterval(resets + 3600)))]
        }
        return usage
    }

    /// The 5-hour window stops a turn; the week decides which account to run
    /// the day on, so only the week and the per-model caps are weekly.
    func testClaudeWeeklyLimitsAreTheSevenDayWindowAndScopedCaps() {
        let limits = WeeklyRemaining.limits(claudeUsage(week: 97, fable: 45), kind: .claude)
        XCTAssertEqual(limits.map(\.scope), [nil, "Fable"])
        XCTAssertEqual(limits.map(\.utilization), [97, 45])
    }

    func testCodexWeeklyLimitsAreTheWeekLongWindows() {
        var usage = AccountUsage()
        usage.buckets = [
            CodexUsageBucket(
                id: "codex",
                primary: UsageWindow(utilization: 20, resetsAt: nil, windowDurationMins: 300),
                secondary: UsageWindow(utilization: 98, resetsAt: nil, windowDurationMins: 10_080)
            ),
            CodexUsageBucket(
                id: "spark", label: "Spark",
                primary: nil,
                secondary: UsageWindow(utilization: 0, resetsAt: nil, windowDurationMins: 10_080)
            ),
        ]
        let limits = WeeklyRemaining.limits(usage, kind: .codex)
        XCTAssertEqual(limits.map(\.utilization), [98, 0])
        XCTAssertEqual(limits.map(\.scope), [nil, "Spark"])
    }

    /// SuperGrok budgets a billing period rather than a week; it is still the
    /// number that decides whether the account has anything left.
    func testXaiCreditPeriodCountsAsTheWeeklyBudget() {
        var usage = AccountUsage()
        usage.creditUsagePercent = 12
        usage.periodEnd = iso(now.addingTimeInterval(86400 * 9))
        let limits = WeeklyRemaining.limits(usage, kind: .xai)
        XCTAssertEqual(limits.map(\.utilization), [12])
        XCTAssertTrue(WeeklyRemaining.limits(AccountUsage(), kind: .xai).isEmpty)
        XCTAssertTrue(WeeklyRemaining.limits(nil, kind: .claude).isEmpty)
    }

    /// Yours first, then the pool, and nobody else's personal subscription.
    func testRowsListYourAccountsThenThePoolAndNobodyElses() {
        let usage = claudeUsage(week: 50)
        let rows = WeeklyRemaining.rows(
            [
                pooled("pool", "Pool", usage: usage),
                pooled("mine", "Mine", owner: "Kent", usage: usage),
                pooled("mine-long", "Mine long", kind: .codex, owner: "Kent de Bruin", usage: usage),
                pooled("theirs", "Theirs", owner: "Michiel", usage: usage),
            ],
            viewer: "Kent",
            now: now
        )
        XCTAssertEqual(rows.map(\.accountId), ["mine", "pool"])
        XCTAssertEqual(rows.map(\.owner), ["Kent", nil])
    }

    func testOneRowPerWeeklyLimitWithRemainingAndTone() {
        let rows = WeeklyRemaining.rows(
            [pooled("a", "Work", usage: claudeUsage(week: 97, fable: 45)), pooled("c", "No usage")],
            viewer: "Kent",
            now: now
        )
        XCTAssertEqual(rows.map(\.label), ["Work", "Work · Fable"])
        XCTAssertEqual(rows.map(\.remaining), [3, 55])
        XCTAssertEqual(rows.map(\.tone), [.low, .ok])
        XCTAssertEqual(rows[0].resetsAt, now.addingTimeInterval(3600 * 70))
    }

    /// A window whose reset already passed reads as full, as it does everywhere else.
    func testAPassedWeeklyResetReadsAsFull() {
        let rows = WeeklyRemaining.rows(
            [pooled("a", "Work", usage: claudeUsage(week: 100, resets: -3600))],
            viewer: "Kent",
            now: now
        )
        XCTAssertEqual(rows.map(\.remaining), [100])
        XCTAssertEqual(WeeklyRemaining.resetDay(rows[0].resetsAt, now: now), "now")
        XCTAssertEqual(WeeklyRemaining.resetDetail(rows[0].resetsAt, now: now), "Resets now")
    }

    func testResetDayIsTheWeekday() {
        let locale = Locale(identifier: "en_US")
        // 1_700_000_000 is a Tuesday (2023-11-14 22:13 UTC).
        XCTAssertEqual(WeeklyRemaining.resetDay(now.addingTimeInterval(86400 * 2), now: now, locale: locale), "Thu")
        XCTAssertNil(WeeklyRemaining.resetDay(nil, now: now))
        XCTAssertEqual(WeeklyRemaining.resetDetail(now.addingTimeInterval(86400 * 2), now: now, locale: locale)?.hasPrefix("Resets Thu"), true)
    }

    func testTonesAndTheTightestRow() {
        XCTAssertEqual(RemainingTone(remaining: 0), .low)
        XCTAssertEqual(RemainingTone(remaining: 10), .low)
        XCTAssertEqual(RemainingTone(remaining: 30), .warn)
        XCTAssertEqual(RemainingTone(remaining: 31), .ok)
        let rows = WeeklyRemaining.rows(
            [pooled("a", "A", usage: claudeUsage(week: 40)), pooled("b", "B", usage: claudeUsage(week: 90))],
            viewer: "Kent",
            now: now
        )
        XCTAssertEqual(WeeklyRemaining.lowest(rows)?.accountId, "b")
        XCTAssertNil(WeeklyRemaining.lowest([]))
    }

    /// A Claude model with its own weekly bucket is stopped by that bucket,
    /// not by the general 7-day window.
    func testReadoutShowsTheModelBucketOnYourOwnAccount() {
        let accounts = [
            pooled("pool", "Pool", usage: claudeUsage(week: 100, fable: 100)),
            pooled("mine", "Main", owner: "Kent", usage: claudeUsage(week: 100, fable: 45)),
        ]
        let rows = WeeklyRemaining.rows(accounts, viewer: "Kent", now: now)
        let readout = WeeklyRemaining.readout(
            rows: rows, accounts: accounts, viewer: "Kent", kind: .claude,
            model: "pi/anthropic/claude-fable-5-1", accountId: nil
        )
        XCTAssertEqual(readout?.accountId, "mine")
        XCTAssertEqual(readout?.scope, "Fable")
        XCTAssertEqual(readout?.remaining, 55)
    }

    func testReadoutUsesAUsablePin() {
        let accounts = [
            pooled("pool", "Pool", usage: claudeUsage(week: 80)),
            pooled("mine", "Mine", owner: "Kent", usage: claudeUsage(week: 20)),
        ]
        let rows = WeeklyRemaining.rows(accounts, viewer: "Kent", now: now)
        let readout = WeeklyRemaining.readout(
            rows: rows, accounts: accounts, viewer: "Kent", kind: .claude,
            model: "claude-sonnet-5", accountId: "pool"
        )
        XCTAssertEqual(readout?.accountId, "pool")
    }

    func testReadoutFallsBackToThePoolWhenYourModelCapIsSpent() {
        let accounts = [
            pooled("pool", "Pool", usage: claudeUsage(week: 10, fable: 40)),
            pooled("mine", "Mine", owner: "Kent", usage: claudeUsage(week: 10, fable: 100)),
        ]
        let rows = WeeklyRemaining.rows(accounts, viewer: "Kent", now: now)
        let readout = WeeklyRemaining.readout(
            rows: rows, accounts: accounts, viewer: "Kent", kind: .claude,
            model: "claude-fable-5-1", accountId: nil
        )
        XCTAssertEqual(readout?.accountId, "pool")
        XCTAssertEqual(readout?.remaining, 60)
    }

    /// The catalog says which pool a model spends from; ids it does not list
    /// follow the server's prefix rules, and a preset follows its lead model.
    func testProviderForModel() throws {
        let data = Data("""
        {"models":[
          {"id":"pi/anthropic/claude-fable-5-1","accountProvider":"claude"},
          {"id":"pi/dial/opus-fable","group":"dial","composition":["pi/anthropic/claude-opus-5"]}
        ],"default":"pi/anthropic/claude-fable-5-1"}
        """.utf8)
        let catalog = try JSONDecoder().decode(ModelCatalog.self, from: data)
        XCTAssertEqual(WeeklyRemaining.provider(forModel: "pi/anthropic/claude-fable-5-1", catalog: catalog), .claude)
        XCTAssertEqual(WeeklyRemaining.provider(forModel: "pi/dial/opus-fable", catalog: catalog), .claude)
        XCTAssertEqual(WeeklyRemaining.provider(forModel: "pi/openai/gpt-5.6-sol", catalog: nil), .codex)
        XCTAssertEqual(WeeklyRemaining.provider(forModel: "pi/xai-oauth/grok-5", catalog: nil), .xai)
        XCTAssertNil(WeeklyRemaining.provider(forModel: "pi/google/gemini-4", catalog: nil))
    }

    func testMenuRowDetailReadsOwnershipDayAndRemaining() {
        let row = WeeklyRemainingRow(
            accountId: "a", kind: .claude, scope: "Fable", name: "Main", owner: "Kent",
            remaining: 8, resetsAt: nil
        )
        XCTAssertEqual(ModelSettingsMenu.rowDetail(row, now: now), "Yours · 8% left · running out")
        XCTAssertEqual(
            ModelSettingsMenu.rowSpokenLabel(row, pinned: false, pinnable: false, now: now),
            "Main · Fable, yours, 8 percent left, not for this model"
        )
    }

    /// The scope is the row's own badge, not a suffix on the name, so a long
    /// account name truncates without hiding which budget the number is.
    func testMenuRowKeepsScopeOutOfTheName() {
        let scoped = WeeklyRemainingRow(
            accountId: "a", kind: .claude, scope: "Fable", name: "Michael-Tella-Engineering-Shared",
            owner: nil, remaining: 0, resetsAt: nil
        )
        XCTAssertEqual(scoped.name, "Michael-Tella-Engineering-Shared")
        XCTAssertEqual(scoped.scope, "Fable")
        XCTAssertEqual(scoped.label, "Michael-Tella-Engineering-Shared · Fable")
        XCTAssertEqual(ModelSettingsMenu.rowDetail(scoped, now: now), "Shared · 0% left · running out")
        // VoiceOver still hears the name and the bucket together.
        XCTAssertEqual(
            ModelSettingsMenu.rowSpokenLabel(scoped, pinned: true, pinnable: true, now: now),
            "Michael-Tella-Engineering-Shared · Fable, shared, 0 percent left, used for this session"
        )
        let general = WeeklyRemainingRow(
            accountId: "a", kind: .claude, scope: nil, name: "Main", owner: "Kent", remaining: 88, resetsAt: nil
        )
        XCTAssertNil(general.scope)
        XCTAssertEqual(general.label, "Main")
    }

    func testMenuHeaderNamesTheScopedBucket() {
        XCTAssertEqual(ModelSettingsMenu.headerTitle(nil), "Weekly remaining")
        let general = WeeklyRemainingRow(
            accountId: "a", kind: .claude, scope: nil, name: "Main", owner: "Kent", remaining: 88, resetsAt: nil
        )
        XCTAssertEqual(ModelSettingsMenu.headerTitle(general), "Weekly remaining · 88%")
        let scoped = WeeklyRemainingRow(
            accountId: "a", kind: .claude, scope: "Fable", name: "Main", owner: "Kent", remaining: 0, resetsAt: nil
        )
        XCTAssertEqual(ModelSettingsMenu.headerTitle(scoped), "Weekly remaining · Fable 0%")
        let other = WeeklyRemainingRow(
            accountId: "b", kind: .claude, scope: "Sonnet", name: "Shared", owner: nil,
            remaining: 12, resetsAt: nil
        )
        XCTAssertEqual(ModelSettingsMenu.headerTitle(other), "Weekly remaining · Sonnet 12%")
    }

    #if DEBUG
    func testWeeklyFixtureShowsAnEmptyScopedBucketBehindALongName() {
        let rows = WeeklyRemaining.rows(ModelSettingsMenu.fixtureAccounts(viewer: "Kent", now: now), viewer: "Kent", now: now)
        XCTAssertEqual(rows.map { [$0.name, $0.scope ?? "-", "\($0.remaining)"] }, [
            ["Main", "-", "55"],
            ["Main", "Fable", "45"],
            ["Michael-Tella-Engineering-Shared", "-", "88"],
            ["Michael-Tella-Engineering-Shared", "Fable", "0"],
        ])
    }
    #endif
}
