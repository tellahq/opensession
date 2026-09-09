import Foundation

/// How full a subscription account is, and when it frees up.
///
/// The web shows this in Settings → Providers beside the model defaults.
/// `src/frontend/lib/account-usage.ts` defines the same reading rules. An
/// account reports three or four limits, any of them can
/// be the one that stops a run, and they free up at different times, so a row
/// draws them all.
struct UsageWindow: Codable, Sendable, Equatable {
    var utilization: Double?
    var resetsAt: String?
    /// How long the window is. It is what tells one Codex bucket's two limits
    /// apart, since both carry the bucket's name.
    var windowDurationMins: Double?
}

struct ScopedUsageLimit: Codable, Sendable, Equatable {
    var label: String?
    var utilization: Double?
    var resetsAt: String?
}

/// Pay-as-you-go spend past the subscription's included limits. Credits are
/// cents, as the OAuth usage endpoint reports them.
struct ExtraUsage: Codable, Sendable, Equatable {
    var enabled: Bool?
    var usedCredits: Double?
    var monthlyLimit: Double?
}

/// One model bucket of a Codex account's usage.
struct CodexUsageBucket: Codable, Sendable, Equatable, Identifiable {
    var id: String?
    var label: String?
    var plan: String?
    var primary: UsageWindow?
    var secondary: UsageWindow?
}

/// The `usage` field both account pools carry. One shape for both: the Claude
/// half fills the rolling windows, the Codex half fills `buckets`, and a client
/// that meets a server reporting neither still decodes.
struct AccountUsage: Codable, Sendable, Equatable {
    var fetchedAt: String?

    // Claude
    var fiveHour: UsageWindow?
    var sevenDay: UsageWindow?
    var scopedLimits: [ScopedUsageLimit]?
    var extraUsage: ExtraUsage?
    /// "meridian" = observed through a live proxy rather than the OAuth
    /// endpoint, so it is a floor rather than the account's own number.
    var source: String?

    // Codex
    var buckets: [CodexUsageBucket]?
    var resetCreditsAvailable: Double?

    // SuperGrok: one credit budget per billing period, cents as the proxy
    // reports them, plus an optional on-demand pool past the included credits.
    var creditUsagePercent: Double?
    var usedCents: Double?
    var monthlyLimitCents: Double?
    var onDemandEnabled: Bool?
    var onDemandUsedCents: Double?
    var onDemandCapCents: Double?
    var periodType: String?
    var periodEnd: String?

    var error: String?
    var errorStatus: Int?
}

/// One named limit an account runs against.
struct LimitWindow: Sendable, Equatable {
    var label: String
    var utilization: Double?
    var resetsAt: String?
    /// A per-model cap rather than an account-wide window. Wins a tie, because
    /// a spent one sidelines the account for that model specifically.
    var scoped: Bool = false
}

/// The pure half of the Usage page, kept out of the view so it can be tested
/// against real payloads.
enum AccountUsageReading {
    /// Mirrors the server's own read: a window whose reset has already passed
    /// is provably stale, so it counts as empty rather than pinning a
    /// just-reset account at 100% until the next poll.
    static func liveUtilization(_ window: LimitWindow, now: Date = Date()) -> Double? {
        guard let utilization = window.utilization else { return nil }
        if let resetsAt = window.resetsAt, let date = parse(resetsAt), date <= now { return 0 }
        return utilization
    }

    /// Every limit the account reports a number for, account-wide windows
    /// first and per-model caps after. A window reporting no number is left
    /// out rather than drawn empty — "unknown" and "nothing used" are
    /// different states, and an empty bar claims the second.
    static func liveLimits(_ windows: [LimitWindow], now: Date = Date()) -> [LimitWindow] {
        var accountWide: [LimitWindow] = []
        var perModel: [LimitWindow] = []
        for window in windows {
            guard let pct = liveUtilization(window, now: now) else { continue }
            var resolved = window
            resolved.utilization = pct
            if window.scoped {
                perModel.append(resolved)
            } else {
                accountWide.append(resolved)
            }
        }
        return accountWide + perModel
    }

    /// Every limit a Claude account reports: the two rolling windows, plus the
    /// per-model weekly caps that arrive separately.
    static func claudeLimits(_ usage: AccountUsage?) -> [LimitWindow] {
        guard let usage else { return [] }
        var windows: [LimitWindow] = [
            LimitWindow(label: "5h", utilization: usage.fiveHour?.utilization, resetsAt: usage.fiveHour?.resetsAt),
            LimitWindow(label: "7d", utilization: usage.sevenDay?.utilization, resetsAt: usage.sevenDay?.resetsAt),
        ]
        for limit in usage.scopedLimits ?? [] {
            windows.append(
                LimitWindow(
                    label: limit.label ?? "Model",
                    utilization: limit.utilization,
                    resetsAt: limit.resetsAt,
                    scoped: true
                )
            )
        }
        return windows
    }

    /// A Codex account reports one or two windows per model bucket, so a label
    /// is the window's length ("1w") and, when the account has more than one
    /// bucket, the model it belongs to. A bucket the account names is a
    /// per-model budget rather than the plan's own window.
    static func codexLimits(_ usage: AccountUsage?) -> [LimitWindow] {
        guard let usage else { return [] }
        let buckets = usage.buckets ?? []
        let manyBuckets = buckets.count > 1
        var windows: [LimitWindow] = []
        for bucket in buckets {
            let name = bucket.label ?? bucket.plan ?? bucket.id ?? "Limit"
            for window in [bucket.primary, bucket.secondary].compactMap({ $0 }) {
                let duration = windowLength(window.windowDurationMins)
                windows.append(
                    LimitWindow(
                        label: manyBuckets ? "\(name) \(duration)" : duration,
                        utilization: window.utilization,
                        resetsAt: window.resetsAt,
                        scoped: bucket.label != nil
                    )
                )
            }
        }
        return windows
    }

    /// A SuperGrok account reports one credit budget for its billing period
    /// and, once that is spent, an optional on-demand pool with its own cap.
    /// The period label names the budget ("Monthly credits"); the period end
    /// is when it refills.
    static func xaiLimits(_ usage: AccountUsage?) -> [LimitWindow] {
        guard let usage else { return [] }
        let period = (usage.periodType ?? "")
            .replacingOccurrences(of: "USAGE_PERIOD_TYPE_", with: "")
            .lowercased()
        let label = period.isEmpty
            ? "Included credits"
            : "\(period.prefix(1).uppercased())\(period.dropFirst()) credits"
        var windows = [
            LimitWindow(label: label, utilization: usage.creditUsagePercent, resetsAt: usage.periodEnd)
        ]
        if usage.onDemandEnabled == true, let cap = usage.onDemandCapCents, cap > 0 {
            let used = usage.onDemandUsedCents ?? 0
            windows.append(
                LimitWindow(
                    label: "On-demand",
                    utilization: min(100, used / cap * 100),
                    resetsAt: nil,
                    scoped: true
                )
            )
        }
        return windows
    }

    /// A window's length, in the unit it divides evenly into: "1w", "7d", "5h".
    static func windowLength(_ minutes: Double?) -> String {
        guard let minutes, minutes > 0 else { return "Usage" }
        let mins = Int(minutes.rounded())
        if mins % 10_080 == 0 { return "\(mins / 10_080)w" }
        if mins % 1_440 == 0 { return "\(mins / 1_440)d" }
        if mins % 60 == 0 { return "\(mins / 60)h" }
        return "\(mins)m"
    }

    /// What a person wants from a limit is how long until it frees up, not the
    /// wall-clock time it happens at — an account reports three or four
    /// windows, and four absolute timestamps in a column is unreadable.
    static func formatReset(_ resetsAt: String?, now: Date = Date()) -> String? {
        guard let resetsAt, let date = parse(resetsAt) else { return nil }
        let minutes = Int((date.timeIntervalSince(now) / 60).rounded())
        if minutes <= 0 { return "resets now" }
        if minutes < 60 { return "resets in \(minutes)m" }
        let hours = Int((Double(minutes) / 60).rounded())
        if hours < 24 { return "resets in \(hours)h" }
        return "resets in \(Int((Double(hours) / 24).rounded()))d"
    }

    /// Percent, as the row prints it. Utilization arrives as 0-100, not as a
    /// fraction — the same scale the web's meter takes.
    static func percentLabel(_ utilization: Double?) -> String? {
        guard let utilization else { return nil }
        return "\(Int(utilization.rounded()))%"
    }

    /// A meter's fill, clamped: a provider that reports past its own limit
    /// should fill the bar, not overrun it.
    static func fraction(_ utilization: Double?) -> Double {
        min(max((utilization ?? 0) / 100, 0), 1)
    }

    /// Colour means "this one is running out", nothing else. An account with
    /// headroom is the normal case and gets neutral ink, so the two accounts
    /// near a limit are the only things on the page that catch the eye. Same
    /// thresholds as the web meter.
    static func isNearLimit(_ utilization: Double?) -> Bool { (utilization ?? 0) >= 90 }
    static func isWarning(_ utilization: Double?) -> Bool { (utilization ?? 0) >= 70 }

    // Formatters are cached: this runs inside list rows, several times per
    // account, and again for every limit `liveLimits` reads.
    private static let withFractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static let plain = ISO8601DateFormatter()

    static func parse(_ value: String) -> Date? {
        withFractional.date(from: value) ?? plain.date(from: value)
    }
}

// MARK: - Weekly remaining

/// One account together with the pool it came from. `ProviderAccount` is the
/// wire record and carries no provider of its own: the route it was fetched
/// from is what says whether it is a Claude, Codex or SuperGrok account.
struct PooledAccount: Identifiable, Equatable, Sendable {
    var account: ProviderAccount
    var kind: AccountKind

    var id: String { "\(kind.id):\(account.id ?? account.name ?? "account")" }
}

extension AccountKind {
    /// The pool key the server uses in `accountProvider` and `/account`
    /// replies: "claude", "codex" or "xai".
    init?(providerKey: String?) {
        guard let providerKey else { return nil }
        guard let kind = Self.allCases.first(where: { $0.brand == providerKey }) else { return nil }
        self = kind
    }
}

/// A limit that refills on a weekly (or billing-period) cadence: the number
/// that decides which account to run the day on. The 5-hour window is what
/// stops a turn; the week is what runs out.
struct WeeklyLimit: Equatable, Sendable {
    /// Model the cap is scoped to ("Fable"), or nil for the whole account.
    var scope: String?
    var utilization: Double
    var resetsAt: String?
}

/// Colour means "this one is running out", nothing else. Same thresholds as
/// the accounts page reads utilization: 90% used is low, 70% used is a warning.
enum RemainingTone: Equatable, Sendable {
    case low, warn, ok

    init(remaining: Int) {
        self = remaining <= 10 ? .low : remaining <= 30 ? .warn : .ok
    }
}

/// One line of the weekly overview in the model menu.
struct WeeklyRemainingRow: Identifiable, Equatable, Sendable {
    var accountId: String
    var kind: AccountKind
    /// Model the cap is scoped to ("Fable"), or nil for the whole account.
    var scope: String?
    var name: String
    /// The account's owner when it is a personal subscription; nil for the
    /// shared pool.
    var owner: String?
    /// Whole percent left, 0-100.
    var remaining: Int
    var resetsAt: Date?

    var id: String { "\(kind.id):\(accountId):\(scope ?? "")" }
    /// Account name, with the model a scoped cap applies to.
    var label: String { scope.map { "\(name) · \($0)" } ?? name }
    var tone: RemainingTone { RemainingTone(remaining: remaining) }
    var isPersonal: Bool { owner != nil }
}

/// The weekly budget each subscription account has left, read the way the
/// model menu shows it. Mirrors `lib/account-limits.ts` on the web: the same
/// rows, the same order, the same readout for the menu's own line.
enum WeeklyRemaining {
    private static let weekMinutes: Double = 7 * 24 * 60

    /// Flatten an account's `usage` into its weekly limits. Unknown or missing
    /// usage yields nothing rather than a row that claims "0% used".
    static func limits(_ usage: AccountUsage?, kind: AccountKind) -> [WeeklyLimit] {
        guard let usage else { return [] }
        switch kind {
        case .claude:
            var out: [WeeklyLimit] = []
            if let week = usage.sevenDay, let utilization = week.utilization {
                out.append(WeeklyLimit(scope: nil, utilization: utilization, resetsAt: week.resetsAt))
            }
            for limit in usage.scopedLimits ?? [] {
                guard let utilization = limit.utilization else { continue }
                out.append(WeeklyLimit(scope: limit.label, utilization: utilization, resetsAt: limit.resetsAt))
            }
            return out
        case .codex:
            var out: [WeeklyLimit] = []
            for bucket in usage.buckets ?? [] {
                for window in [bucket.primary, bucket.secondary].compactMap({ $0 }) {
                    guard let utilization = window.utilization,
                          (window.windowDurationMins ?? 0) >= weekMinutes else { continue }
                    out.append(WeeklyLimit(scope: bucket.label, utilization: utilization, resetsAt: window.resetsAt))
                }
            }
            return out
        case .xai:
            // SuperGrok budgets a billing period rather than a week; it is
            // still the number that decides whether the account has anything
            // left to give.
            guard let percent = usage.creditUsagePercent else { return [] }
            return [WeeklyLimit(scope: nil, utilization: percent, resetsAt: usage.periodEnd)]
        }
    }

    /// Can `viewer` run on this account: it sits in the shared pool, or it is
    /// their own personal subscription. Someone else's personal account is not
    /// theirs to spend, so its budget is noise here. Same loose name compare
    /// as the web's `ownerMatchesPerson`.
    static func isAvailable(_ account: ProviderAccount, to viewer: String) -> Bool {
        guard let owner = account.owner, !owner.isEmpty else { return true }
        return SidebarPersonLens.nameMatches(owner, key: viewer)
    }

    /// The overview: every account `viewer` can use that reports a weekly
    /// number, one row per limit. Your own subscriptions first: they are the
    /// ones routing spends before the pool, so they are the numbers you want
    /// at a glance. A window whose reset already passed reads as full, as it
    /// does everywhere else.
    static func rows(_ accounts: [PooledAccount], viewer: String, now: Date = Date()) -> [WeeklyRemainingRow] {
        var personal: [WeeklyRemainingRow] = []
        var pool: [WeeklyRemainingRow] = []
        for pooled in accounts {
            let account = pooled.account
            guard let accountId = account.id, !accountId.isEmpty,
                  isAvailable(account, to: viewer) else { continue }
            let owner = account.owner?.isEmpty == false ? account.owner : nil
            for limit in limits(account.usage, kind: pooled.kind) {
                let window = LimitWindow(label: "", utilization: limit.utilization, resetsAt: limit.resetsAt)
                guard let used = AccountUsageReading.liveUtilization(window, now: now) else { continue }
                let row = WeeklyRemainingRow(
                    accountId: accountId,
                    kind: pooled.kind,
                    scope: limit.scope,
                    name: account.name ?? account.email ?? "Account",
                    owner: owner,
                    remaining: max(0, min(100, Int((100 - used).rounded()))),
                    resetsAt: limit.resetsAt.flatMap(AccountUsageReading.parse)
                )
                if owner != nil { personal.append(row) } else { pool.append(row) }
            }
        }
        return personal + pool
    }

    /// The tightest budget among `rows`.
    static func lowest(_ rows: [WeeklyRemainingRow]) -> WeeklyRemainingRow? {
        rows.min { $0.remaining < $1.remaining }
    }

    /// The day a window refills, as the row prints it: "now" once the reset
    /// has passed, otherwise the short weekday. Nil when the account does not
    /// say.
    static func resetDay(_ resetsAt: Date?, now: Date = Date(), locale: Locale = .current) -> String? {
        guard let resetsAt else { return nil }
        if resetsAt <= now { return "now" }
        let formatter = DateFormatter()
        formatter.locale = locale
        formatter.setLocalizedDateFormatFromTemplate("EEE")
        return formatter.string(from: resetsAt)
    }

    /// The exact refill time, for the row's spoken description.
    static func resetDetail(_ resetsAt: Date?, now: Date = Date(), locale: Locale = .current) -> String? {
        guard let resetsAt else { return nil }
        if resetsAt <= now { return "Resets now" }
        let formatter = DateFormatter()
        formatter.locale = locale
        formatter.setLocalizedDateFormatFromTemplate("EEE MMM d HH:mm")
        return "Resets \(formatter.string(from: resetsAt))"
    }

    /// Which account pool a model draws on. The catalog says so for every
    /// model it lists (`accountProvider`); a preset resolves through its lead
    /// model. Ids the catalog does not know fall back to the server's own
    /// prefix rules (`accountProviderForModel`).
    static func provider(forModel model: String, catalog: ModelCatalog?) -> AccountKind? {
        if let option = catalog?.option(for: model) {
            if let kind = AccountKind(providerKey: option.accountProvider) { return kind }
            if let lead = option.composition?.first, lead != model {
                return provider(forModel: lead, catalog: catalog)
            }
        }
        let tail = model.hasPrefix("pi/") ? String(model.dropFirst(3)) : model
        let upstream = tail.split(separator: "/", maxSplits: 1).count == 2
            ? String(tail.split(separator: "/", maxSplits: 1)[0]) : nil
        if upstream == "anthropic" || tail.hasPrefix("claude-") { return .claude }
        if upstream == "openai" || tail.hasPrefix("gpt-") || tail.hasPrefix("codex-") { return .codex }
        if upstream == "xai-oauth" { return .xai }
        return nil
    }

    private static let claudeScopedFamilies = ["fable", "opus", "sonnet", "haiku"]

    /// The limit that can stop `model` on one account. A Claude model with a
    /// dedicated weekly bucket uses that bucket instead of the general 7-day
    /// one; every other pool reads the account-wide rows.
    static func rows(for model: String, in rows: [WeeklyRemainingRow]) -> [WeeklyRemainingRow] {
        guard rows.first?.kind == .claude else { return rows }
        let normalized = model.lowercased()
        let family = normalized.contains("mythos")
            ? "fable"
            : claudeScopedFamilies.first { normalized.contains($0) }
        guard let family else { return rows.filter { $0.scope == nil } }
        let scoped = rows.filter { $0.scope?.lowercased().contains(family) == true }
        return scoped.isEmpty ? rows.filter { $0.scope == nil } : scoped
    }

    /// The number for the account automatic routing will use: a usable pin,
    /// otherwise the viewer's personal subscription before the shared pool.
    /// Within a group, the account with the most model-specific headroom,
    /// which is close enough to the pool's least-used choice without exposing
    /// runner state.
    static func readout(
        rows: [WeeklyRemainingRow],
        accounts: [PooledAccount],
        viewer: String,
        kind: AccountKind?,
        model: String,
        accountId: String?
    ) -> WeeklyRemainingRow? {
        let providerRows = kind.map { kind in rows.filter { $0.kind == kind } } ?? rows
        struct Candidate {
            let account: ProviderAccount
            let row: WeeklyRemainingRow
        }
        let candidates: [Candidate] = accounts.compactMap { pooled in
            guard kind == nil || pooled.kind == kind,
                  isAvailable(pooled.account, to: viewer),
                  let id = pooled.account.id else { return nil }
            let own = self.rows(for: model, in: providerRows.filter { $0.accountId == id })
            return lowest(own).map { Candidate(account: pooled.account, row: $0) }
        }
        let available = candidates.filter { $0.account.usable != false && $0.row.remaining > 0 }
        func best(_ choices: [Candidate]) -> WeeklyRemainingRow? {
            choices.max { $0.row.remaining < $1.row.remaining }?.row
        }
        if let accountId, !accountId.isEmpty,
           let pinned = available.first(where: { $0.account.id == accountId }) {
            return pinned.row
        }
        let personal = { (list: [Candidate]) in list.filter { $0.account.owner?.isEmpty == false } }
        let pool = { (list: [Candidate]) in list.filter { !($0.account.owner?.isEmpty == false) } }
        return best(personal(available))
            ?? best(pool(available))
            ?? best(personal(candidates))
            ?? best(pool(candidates))
            ?? lowest(providerRows)
    }
}
