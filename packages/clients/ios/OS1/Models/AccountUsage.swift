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
