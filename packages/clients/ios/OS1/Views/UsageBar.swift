import SwiftUI

/// The usage bar: a strip above the composer with what a person checks before
/// the next send. How full the context is, what the conversation has spent,
/// how much of the account's limits is left, and which account it runs on.
/// The web's `UsageBar.tsx`, switched by the same synced `usage-bar` pref.
///
/// Its own view struct so the reads of `usage`, `model` and `accountId`
/// re-evaluate this strip alone, not `SessionView.body` and its transcript.
struct ComposerUsageBar: View {
    @AppStorage(UsageBarPref.storageKey) private var isOn = UsageBarPref.standard

    let viewModel: SessionViewModel
    let catalog: ModelCatalog?
    let accounts: [PooledAccount]

    var body: some View {
        // Hidden until the conversation has reported usage, as on the web: a
        // strip of zeros before the first turn is noise.
        if isOn || Self.captureHook != nil, let usage = viewModel.usage, usage.turns > 0 {
            UsageBarStrip(usage: usage, limits: limits)
                .transition(.opacity)
        }
    }

    /// Screenshot rig hook: `OS1_USAGE_BAR=on` shows the bar whatever the
    /// account's pref says, `context` also opens the context detail.
    static let captureHook = ProcessInfo.processInfo.environment["OS1_USAGE_BAR"]

    private var limits: SessionLimits? {
        let model = viewModel.model.isEmpty ? (catalog?.defaultModel ?? "") : viewModel.model
        return SessionLimits.read(
            accounts: accounts,
            viewer: ServerConfig.shared.userName,
            kind: WeeklyRemaining.provider(forModel: model, catalog: catalog),
            model: catalog?.option(for: model)?.composition?.first ?? model,
            accountId: viewModel.accountId
        )
    }
}

/// The strip itself, free of the view model so a preview or a test host can
/// draw it from a plain `SessionUsage`.
struct UsageBarStrip: View {
    let usage: SessionUsage
    let limits: SessionLimits?

    @State private var openDetail: Detail?

    private enum Detail: Identifiable {
        case context, spend, limits
        var id: Self { self }
    }

    var body: some View {
        // Four cells in a row where they fit; two by two on a phone.
        ViewThatFits(in: .horizontal) {
            HStack(alignment: .top, spacing: 0) {
                ForEach(Array(cells.enumerated()), id: \.offset) { index, cell in
                    if index > 0 { Divider().frame(height: 28).padding(.top, 4) }
                    cell
                }
            }
            Grid(alignment: .leading, horizontalSpacing: 0, verticalSpacing: 0) {
                let all = cells
                ForEach(Array(stride(from: 0, to: all.count, by: 2)), id: \.self) { start in
                    GridRow {
                        all[start]
                        if start + 1 < all.count { all[start + 1] } else { Color.clear }
                    }
                }
            }
        }
        .padding(.horizontal, 4)
        .padding(.vertical, 2)
        .background(OS1VisualStyle.flapSurface, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(OS1VisualStyle.border, lineWidth: 0.5)
        }
        .task {
            if ComposerUsageBar.captureHook == "context" {
                try? await Task.sleep(for: .seconds(2))
                openDetail = .context
            }
        }
    }

    private var cells: [AnyView] {
        var out: [AnyView] = [
            AnyView(button(.context, label: "Context", accessibility: contextAccessibility) {
                contextValue
            }),
            AnyView(button(.spend, label: "Usage", accessibility: spendAccessibility) {
                Text(usage.costLabel()).fontWeight(.medium).foregroundStyle(OS1VisualStyle.text)
                Text("\(SessionUsage.tokenLabel(usage.totalTokens)) tokens")
            }),
        ]
        if let limits {
            out.append(AnyView(limitsCell(limits)))
            out.append(AnyView(accountCell(limits)))
        }
        return out
    }

    // MARK: Cells

    private func cellBody(label: String, @ViewBuilder value: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label)
                .font(.caption2)
                .foregroundStyle(OS1VisualStyle.textFaint)
            HStack(spacing: 5) { value() }
                .font(.footnote)
                .monospacedDigit()
                .lineLimit(1)
                .foregroundStyle(OS1VisualStyle.textDim)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
        .contentShape(Rectangle())
    }

    private func button(
        _ detail: Detail,
        label: String,
        accessibility: String,
        @ViewBuilder value: () -> some View
    ) -> some View {
        Button {
            openDetail = detail
        } label: {
            cellBody(label: label, value: value)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(accessibility)
        .popover(isPresented: Binding(
            get: { openDetail == detail },
            set: { if !$0, openDetail == detail { openDetail = nil } }
        )) {
            Group {
                if detail == .limits, let limits {
                    LimitsDetailView(limits: limits)
                } else {
                    UsageDetailsView(usage: usage)
                }
            }
            .padding(14)
            .frame(width: 280)
            .presentationCompactAdaptation(.popover)
        }
    }

    @ViewBuilder
    private var contextValue: some View {
        let fill = usage.contextFill
        if fill.limit > 0 {
            UsageTrack(fraction: fill.fraction, fill: fill.isTight ? OS1VisualStyle.red : OS1VisualStyle.accent)
                .frame(width: 28)
            Text("\(SessionUsage.tokenLabel(fill.tokens)) / \(SessionUsage.tokenLabel(fill.limit))")
            Text("\(fill.percent)%")
                .fontWeight(.medium)
                .foregroundStyle(fill.isTight ? OS1VisualStyle.redInk : OS1VisualStyle.text)
        } else {
            Text(SessionUsage.tokenLabel(fill.tokens))
        }
    }

    private var contextAccessibility: String {
        let fill = usage.contextFill
        return "Context \(SessionUsage.tokenLabel(fill.tokens)) of \(SessionUsage.tokenLabel(fill.limit))"
    }

    private var spendAccessibility: String {
        "Usage \(usage.costLabel()), \(SessionUsage.tokenLabel(usage.totalTokens)) tokens"
    }

    @ViewBuilder
    private func limitsCell(_ limits: SessionLimits) -> some View {
        let rows = LimitsDetailView.rows(limits)
        if rows.isEmpty {
            cellBody(label: "Limits") { Text("–") }
                .accessibilityLabel("This account reports no limits")
        } else {
            button(
                .limits,
                label: "Limits",
                accessibility: "Limits "
                    + rows.map { "\($0.long) \($0.limit.used)% used" }.joined(separator: ", ")
            ) {
                ForEach(rows, id: \.short) { row in
                    HStack(spacing: 3) {
                        Text(row.short)
                        Text("\(row.limit.used)%")
                            .fontWeight(.medium)
                            .foregroundStyle(LimitsDetailView.tone(row.limit.used))
                    }
                }
            }
        }
    }

    private func accountCell(_ limits: SessionLimits) -> some View {
        cellBody(label: "Account") {
            if let logo = Brand.logo(for: limits.account.kind.brand) {
                BrandLogoShape(logo: logo)
                    .fill(OS1VisualStyle.text, style: FillStyle(eoFill: logo.evenOdd))
                    .frame(width: 13, height: 13)
                    .accessibilityHidden(true)
            }
            Text(limits.accountName)
                .foregroundStyle(OS1VisualStyle.text)
                .truncationMode(.tail)
            if limits.auto {
                Text("Auto").foregroundStyle(OS1VisualStyle.textFaint)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityHint(
            limits.auto
                ? "Picked automatically for the next turn. Pin one from the model menu."
                : "Pinned for this session"
        )
    }
}

/// A thin rounded meter, the web's `Track`.
struct UsageTrack: View {
    let fraction: Double
    let fill: Color
    var height: CGFloat = 4

    var body: some View {
        GeometryReader { proxy in
            ZStack(alignment: .leading) {
                Capsule().fill(OS1VisualStyle.hover)
                Capsule()
                    .fill(fill)
                    .frame(width: proxy.size.width * min(max(fraction, 0), 1))
            }
        }
        .frame(height: height)
        .accessibilityHidden(true)
    }
}

/// The limits popover: each window's share used and when it frees up.
struct LimitsDetailView: View {
    let limits: SessionLimits

    struct Row {
        var short: String
        var long: String
        var limit: SessionLimit
    }

    static func rows(_ limits: SessionLimits) -> [Row] {
        var out: [Row] = []
        if let short = limits.short {
            out.append(Row(short: "5h", long: "5-hour window", limit: short))
        }
        if let week = limits.week {
            out.append(Row(
                short: "Week",
                long: week.scope.map { "\($0) weekly cap" } ?? "Weekly",
                limit: week
            ))
        }
        return out
    }

    /// Yellow from 70% used, red from 90%, as the accounts page reads it.
    static func tone(_ used: Int) -> Color {
        used >= 90 ? OS1VisualStyle.redInk : used >= 70 ? OS1VisualStyle.yellowInk : OS1VisualStyle.text
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Limits used")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(OS1VisualStyle.text)
            ForEach(Self.rows(limits), id: \.short) { row in
                VStack(alignment: .leading, spacing: 4) {
                    HStack {
                        Text(row.long).foregroundStyle(OS1VisualStyle.textDim)
                        Spacer(minLength: 12)
                        Text("\(row.limit.used)%")
                            .monospacedDigit()
                            .foregroundStyle(Self.tone(row.limit.used))
                    }
                    UsageTrack(
                        fraction: Double(row.limit.used) / 100,
                        fill: row.limit.used >= 90
                            ? OS1VisualStyle.red
                            : row.limit.used >= 70 ? OS1VisualStyle.yellow : OS1VisualStyle.textFaint
                    )
                    if let reset = AccountUsageReading.formatReset(date: row.limit.resetsAt) {
                        Text(reset.prefix(1).uppercased() + reset.dropFirst())
                            .foregroundStyle(OS1VisualStyle.textFaint)
                    }
                }
            }
        }
        .font(.footnote)
    }
}

// MARK: - Usage details

/// What the conversation has spent and what fills its context, the web's
/// `UsageDetails` (UsageMeter.tsx): cost and context, the per-section
/// breakdown with the compaction point, then the token totals.
struct UsageDetailsView: View {
    let usage: SessionUsage

    var body: some View {
        let fill = usage.contextFill
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text("This conversation")
                    .fontWeight(.semibold)
                    .foregroundStyle(OS1VisualStyle.text)
                Spacer(minLength: 12)
                Text(usage.turnsLabel).foregroundStyle(OS1VisualStyle.textDim)
            }
            .padding(.bottom, 2)
            row("Cost", usage.costLabel(), strong: true)
            if let context = usage.contextLabel() {
                row("Context", context, tone: fill.isTight ? OS1VisualStyle.redInk : nil)
            }
            if let breakdown = usage.context {
                ContextBreakdownView(breakdown: breakdown)
                    .padding(.top, 4)
            }
            if let note = usage.compactionNote() {
                Text(note)
                    .foregroundStyle(OS1VisualStyle.textFaint)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 2)
            }
            Divider().padding(.vertical, 4)
            row("Input", SessionUsage.tokenLabel(usage.inputTokens))
            row("Output", SessionUsage.tokenLabel(usage.outputTokens))
            row("Cache read", usage.cacheReadLabel())
            row("Cache write", SessionUsage.tokenLabel(usage.cacheCreationTokens))
        }
        .font(.footnote)
    }

    private func row(_ label: String, _ value: String, strong: Bool = false, tone: Color? = nil) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(label).foregroundStyle(OS1VisualStyle.textDim)
            Spacer(minLength: 16)
            Text(value)
                .monospacedDigit()
                .foregroundStyle(tone ?? (strong ? OS1VisualStyle.text : OS1VisualStyle.textDim))
        }
    }
}

/// What fills the context window: one segmented bar, one row per part.
struct ContextBreakdownView: View {
    let breakdown: ContextBreakdown

    var body: some View {
        let rows = breakdown.rows
        if !rows.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                GeometryReader { proxy in
                    let total = Double(rows.reduce(0) { $0 + $1.tokens })
                    let gaps = CGFloat(rows.count - 1)
                    HStack(spacing: 1) {
                        ForEach(rows) { row in
                            Rectangle()
                                .fill(Self.swatch(row.kind))
                                .frame(width: max(1, (proxy.size.width - gaps) * Double(row.tokens) / total))
                        }
                    }
                }
                .frame(height: 6)
                .background(OS1VisualStyle.border)
                .clipShape(Capsule())
                .accessibilityHidden(true)
                ForEach(rows) { row in
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Circle()
                            .fill(Self.swatch(row.kind))
                            .frame(width: 7, height: 7)
                            .accessibilityHidden(true)
                        Text(row.label)
                            .foregroundStyle(OS1VisualStyle.textDim)
                            .lineLimit(1)
                        Spacer(minLength: 12)
                        Text(SessionUsage.tokenLabel(row.tokens))
                            .monospacedDigit()
                            .foregroundStyle(OS1VisualStyle.text)
                        Text("\(ContextBreakdown.share(row, of: rows))%")
                            .monospacedDigit()
                            .foregroundStyle(OS1VisualStyle.textFaint)
                            .frame(width: 34, alignment: .trailing)
                    }
                    .accessibilityElement(children: .combine)
                }
            }
        }
    }

    /// One colour per part. The bar and its legend are read against each
    /// other, not against meaning, so these are the palette's distinct hues
    /// rather than states; red is left out so nothing here reads as an alarm.
    static func swatch(_ kind: ContextRow.Kind) -> Color {
        switch kind {
        case .messages: OS1VisualStyle.accent
        case .summary: OS1VisualStyle.purple
        case .systemPrompt: OS1VisualStyle.blue
        case .instructions: OS1VisualStyle.green
        case .tools: OS1VisualStyle.yellow
        case .mcpTools: OS1VisualStyle.humanReply
        case .skills: OS1VisualStyle.textDim
        case .other: OS1VisualStyle.textFaint
        }
    }
}
