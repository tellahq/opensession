import SwiftUI

/// Model, reasoning effort and speed for the next turn, as one row per
/// setting: each row names its current value and opens a submenu, mirroring
/// the web composer's pill menu.
///
/// Mounted twice so the two surfaces can't drift: the macOS toolbar's own
/// control, and the iOS session overflow menu, where these settings used to be
/// reachable only by opening the worktree details sheet.
///
/// Its own view struct for the reason `SessionActionsMenu` is: it reads
/// `effort`, `fastMode` and `usage`, and reading those inside
/// `SessionView.body` re-evaluates the whole body, transcript included, every
/// time one of them moves.
struct ModelSettingsMenu: View {
    @AppStorage("os1.composer.defaultModel") private var preferredModel = ""

    let viewModel: SessionViewModel
    let catalog: ModelCatalog?
    /// Every subscription account the server lists, for the weekly overview.
    /// Empty until the pools load, which only costs the Weekly remaining row.
    var accounts: [PooledAccount] = []
    /// Conversation cost, above the choices that drive it. Carried where this
    /// is the whole menu; suppressed where it is nested inside one, since
    /// spend is not a model setting and the row would read as one.
    var showsUsage = true
    var onShowWeeklyRemaining: (() -> Void)?

    var body: some View {
        if showsUsage {
            UsageMenuSection(usage: viewModel.usage)
        }
        if !weeklyRows.isEmpty {
            if let onShowWeeklyRemaining {
                Button(action: onShowWeeklyRemaining) {
                    Label(Self.headerTitle(weeklyReadout), systemImage: Self.gaugeSymbol(weeklyReadout?.tone))
                }
            } else {
                weeklyRemainingMenu
            }
        }
        if let catalog {
            Menu {
                ForEach(catalog.presets + catalog.regular) { option in
                    let routed = ModelCatalog.routedID(option.id, engine: currentEngine)
                    Button {
                        if let routed { viewModel.changeModel(to: routed) }
                    } label: {
                        if option.id == ModelCatalog.baseID(currentModel) {
                            Label(option.displayLabel, systemImage: "checkmark")
                        } else {
                            Text(option.displayLabel)
                        }
                    }
                    .disabled(routed == nil)
                }
            } label: {
                Label("Model · \(catalog.label(for: currentModel))", systemImage: "cpu")
            }
            if engineChoices.count > 1 {
                Menu {
                    ForEach(engineChoices) { engine in
                        let routed = ModelCatalog.routedID(currentModel, engine: engine.id)
                        Button {
                            if let routed { viewModel.changeModel(to: routed) }
                        } label: {
                            if engine.id == currentEngine {
                                Label(engine.label, systemImage: "checkmark")
                            } else {
                                Text(engine.label)
                            }
                        }
                        .disabled(routed == nil)
                    }
                } label: {
                    Label("Engine · \(currentEngineLabel)", systemImage: "gearshape.2")
                }
            }
        }
        if !supportedEfforts.isEmpty {
            Menu {
                ForEach(supportedEfforts, id: \.self) { level in
                    Button {
                        viewModel.effort = level
                    } label: {
                        // Checked against the RESOLVED effort, not the stored
                        // one: "" means the server's default rather than no
                        // choice, so comparing the raw value leaves an
                        // untouched session with nothing checked at all.
                        if effectiveEffort == level {
                            Label(EffortLevel.label(level), systemImage: "checkmark")
                        } else {
                            Text(EffortLevel.label(level))
                        }
                    }
                }
            } label: {
                Label("Effort · \(EffortLevel.label(effectiveEffort))", systemImage: "brain")
            }
        }
        if catalog?.option(for: currentModel)?.fastModeSupported == true {
            Menu {
                ForEach([false, true], id: \.self) { fast in
                    Button {
                        viewModel.fastMode = fast
                    } label: {
                        if viewModel.fastMode == fast {
                            Label(Self.speedLabel(fast), systemImage: "checkmark")
                        } else {
                            Text(Self.speedLabel(fast))
                        }
                    }
                }
            } label: {
                Label(
                    "Speed · \(Self.speedLabel(viewModel.fastMode))",
                    systemImage: "bolt"
                )
            }
        }
        Section {
            Button(action: setAsDefault) {
                Label(
                    "Set as default",
                    systemImage: isPreferredDefault ? "checkmark" : "pin"
                )
            }
            .disabled(currentModel.isEmpty || isPreferredDefault)

            Button(action: reset) {
                Label("Reset to default", systemImage: "arrow.uturn.backward")
            }
            .disabled(isAtDefault)
        }
    }

    // MARK: Weekly remaining

    /// One line per weekly budget the viewer can spend, the way the web menu
    /// lists them: yours first, then the pool. The menu row itself reads out
    /// the tightest budget for the account the current model will run on. A
    /// row for the current model's pool pins that account for this session;
    /// a row for another pool is listed for the overview but cannot be picked.
    private var weeklyRemainingMenu: some View {
        Menu {
            Section {
                Button {
                    viewModel.pinAccount(nil)
                } label: {
                    if viewModel.accountId.isEmpty {
                        Label("Auto", systemImage: "checkmark")
                    } else {
                        Text("Auto")
                    }
                }
                .disabled(currentProvider == nil)
                ForEach(weeklyRows) { row in
                    let pinnable = row.kind == currentProvider
                    let pinned = pinnable && row.accountId == viewModel.accountId
                    Button {
                        pinAccount(for: row)
                    } label: {
                        Text(row.name)
                        Text(Self.rowDetail(row))
                        // Not hidden from accessibility: hiding the mark
                        // drops the whole row from the menu's tree on iOS 26.
                        Image(systemName: pinned ? "checkmark" : (row.isPersonal ? "person" : "person.2"))
                    }
                    // Native menu badges reserve space independently of the name.
                    .badge(row.scope.map { Text($0).foregroundStyle(OS1VisualStyle.textDim) })
                    .disabled(!pinnable)
                    .accessibilityLabel(Self.rowSpokenLabel(row, pinned: pinned, pinnable: pinnable))
                }
            } footer: {
                if currentProvider != nil {
                    Text("Choose one to use it for this session")
                }
            }
        } label: {
            Label(Self.headerTitle(weeklyReadout), systemImage: Self.gaugeSymbol(weeklyReadout?.tone))
        }
    }

    /// iOS menus ignore `.badge`, so the phone presents the same accounts in
    /// a native sheet. Only the name yields width to the scope and pin mark.
    var weeklyRemainingOverview: some View {
        List {
            Section {
                Button {
                    viewModel.pinAccount(nil)
                } label: {
                    HStack {
                        Text("Auto")
                        Spacer()
                        if viewModel.accountId.isEmpty { Image(systemName: "checkmark") }
                    }
                }
                .disabled(currentProvider == nil)
                ForEach(weeklyRows) { row in
                    let pinnable = row.kind == currentProvider
                    let pinned = pinnable && row.accountId == viewModel.accountId
                    Button {
                        pinAccount(for: row)
                    } label: {
                        HStack(spacing: 12) {
                            Image(systemName: pinned ? "checkmark" : (row.isPersonal ? "person" : "person.2"))
                                .frame(width: 24)
                            VStack(alignment: .leading, spacing: 4) {
                                HStack(spacing: 8) {
                                    Text(row.name)
                                        .lineLimit(1)
                                        .foregroundStyle(OS1VisualStyle.text)
                                    if let scope = row.scope {
                                        Text(scope)
                                            .font(.caption.weight(.medium))
                                            .foregroundStyle(OS1VisualStyle.textDim)
                                            .padding(.horizontal, 8)
                                            .padding(.vertical, 3)
                                            .background(OS1VisualStyle.hover, in: Capsule())
                                            .fixedSize()
                                    }
                                }
                                Text(Self.rowDetail(row))
                                    .font(.subheadline)
                                    .foregroundStyle(OS1VisualStyle.textDim)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                            Spacer(minLength: 0)
                        }
                    }
                    .disabled(!pinnable)
                    .accessibilityLabel(Self.rowSpokenLabel(row, pinned: pinned, pinnable: pinnable))
                }
            } header: {
                Text(Self.headerTitle(weeklyReadout))
            } footer: {
                if currentProvider != nil {
                    Text("Choose one to use it for this session")
                }
            }
        }
    }

    private func pinAccount(for row: WeeklyRemainingRow) {
        guard let account = accounts.first(where: {
            $0.kind == row.kind && $0.account.id == row.accountId
        }) else { return }
        viewModel.pinAccount(account.account)
    }

    /// The menu row's own line. A scoped readout names its bucket beside the
    /// number, so a full general week is not read as Fable headroom.
    static func headerTitle(_ readout: WeeklyRemainingRow?) -> String {
        guard let readout else { return "Weekly remaining" }
        let scope = readout.scope.map { "\($0) " } ?? ""
        return "Weekly remaining · \(scope)\(readout.remaining)%"
    }

    private var viewer: String { ServerConfig.shared.userName }

    private var weeklyRows: [WeeklyRemainingRow] {
        WeeklyRemaining.rows(accounts, viewer: viewer)
    }

    /// The pool the current model spends from, which decides which rows can
    /// be pinned.
    private var currentProvider: AccountKind? {
        WeeklyRemaining.provider(forModel: currentModel, catalog: catalog)
    }

    private var weeklyReadout: WeeklyRemainingRow? {
        WeeklyRemaining.readout(
            rows: weeklyRows,
            accounts: accounts,
            viewer: viewer,
            kind: currentProvider,
            model: catalog?.option(for: currentModel)?.composition?.first ?? currentModel,
            accountId: viewModel.accountId
        )
    }

    /// The gauge fills with what is left, so an account that is running out
    /// reads as a near-empty dial before the number is read.
    private static func gaugeSymbol(_ tone: RemainingTone?) -> String {
        switch tone {
        case .low: "gauge.with.dots.needle.0percent"
        case .warn: "gauge.with.dots.needle.33percent"
        case .ok, nil: "gauge.with.dots.needle.67percent"
        }
    }

    /// The row's second line: whose it is, the day it refills, what is left.
    static func rowDetail(_ row: WeeklyRemainingRow, now: Date = Date()) -> String {
        var parts = [row.isPersonal ? "Yours" : "Shared"]
        if let day = WeeklyRemaining.resetDay(row.resetsAt, now: now) { parts.append(day) }
        parts.append("\(row.remaining)% left")
        if row.tone == .low { parts.append("running out") }
        return parts.joined(separator: " · ")
    }

    /// What VoiceOver reads for a row: the same facts as the two lines, plus
    /// the exact refill time and whether the row can be picked.
    static func rowSpokenLabel(
        _ row: WeeklyRemainingRow, pinned: Bool, pinnable: Bool, now: Date = Date()
    ) -> String {
        var parts = [row.label, row.isPersonal ? "yours" : "shared", "\(row.remaining) percent left"]
        if let detail = WeeklyRemaining.resetDetail(row.resetsAt, now: now) { parts.append(detail) }
        if pinned {
            parts.append("used for this session")
        } else if !pinnable {
            parts.append("not for this model")
        }
        return parts.joined(separator: ", ")
    }

    #if DEBUG
    /// Accounts for a screenshot of the overview: a name long enough to
    /// truncate, whose Fable bucket is empty while its week is nearly full.
    /// `OS1_WEEKLY_REMAINING_FIXTURE=1` swaps these in for the live pools.
    static func fixtureAccounts(viewer: String, now: Date = Date()) -> [PooledAccount] {
        let iso = ISO8601DateFormatter()
        let week = UsageWindow(utilization: 12, resetsAt: iso.string(from: now.addingTimeInterval(86400 * 3)))
        var pool = ProviderAccount(id: "fixture-pool", name: "Michael-Tella-Engineering-Shared")
        pool.usage = AccountUsage(
            sevenDay: week,
            scopedLimits: [
                ScopedUsageLimit(label: "Fable", utilization: 100, resetsAt: week.resetsAt)
            ]
        )
        var personal = ProviderAccount(id: "fixture-personal", name: "Main", owner: viewer)
        personal.usage = AccountUsage(
            sevenDay: UsageWindow(utilization: 45, resetsAt: week.resetsAt),
            scopedLimits: [
                ScopedUsageLimit(label: "Fable", utilization: 55, resetsAt: week.resetsAt)
            ]
        )
        return [
            PooledAccount(account: personal, kind: .claude),
            PooledAccount(account: pool, kind: .claude),
        ]
    }
    #endif

    // MARK: Model settings

    /// Fast mode reads as a speed, so it sits beside Effort as a value rather
    /// than as a switch of its own. Same wording as the web menu.
    private static func speedLabel(_ fast: Bool) -> String {
        fast ? "Fast" : "Standard"
    }

    private var currentModel: String {
        viewModel.model.isEmpty ? (catalog?.defaultModel ?? "") : viewModel.model
    }

    private var engineChoices: [ModelEngineOption] {
        catalog?.availableEngines ?? []
    }

    private var currentEngine: String {
        catalog?.routingEngine(for: currentModel) ?? ModelCatalog.engine(currentModel)
    }

    private var currentEngineLabel: String {
        engineChoices.first(where: { $0.id == currentEngine })?.label
            ?? currentEngine.capitalized
    }

    private var supportedEfforts: [String] {
        catalog?.option(for: currentModel)?.efforts ?? []
    }

    /// What the next turn will actually run at. `effort` is "" until someone
    /// picks one, and a model that dropped the stored level since then leaves
    /// it stale, so both fall back the way the server does.
    private var effectiveEffort: String {
        let efforts = supportedEfforts
        if efforts.contains(viewModel.effort) { return viewModel.effort }
        return efforts.contains("high") ? "high" : (efforts.first ?? "")
    }

    private var isPreferredDefault: Bool {
        !currentModel.isEmpty && preferredModel == currentModel
    }

    /// Nothing to put back: following the default model, no effort picked,
    /// standard speed, account on auto. Drives the reset row's disabled
    /// state, so it doubles as the answer to "am I on the defaults?".
    private var isAtDefault: Bool {
        let defaultModel = catalog?.defaultModel ?? ""
        let onDefaultModel =
            viewModel.model.isEmpty || defaultModel.isEmpty || viewModel.model == defaultModel
        return onDefaultModel && viewModel.effort.isEmpty && !viewModel.fastMode
            && viewModel.accountId.isEmpty
    }

    private func setAsDefault() {
        let model = currentModel
        guard !model.isEmpty, model != preferredModel else { return }

        // Match the web preference: update this device immediately, then sync
        // the same per-user key so new sessions on every client start here.
        let requestContext = NativePreferences.context()
        NativePreferences.beginLocalWrite()
        preferredModel = model
        Task {
            defer { NativePreferences.endLocalWrite() }
            guard let response = try? await SettingsAPI.updateUiPrefs(
                user: requestContext.user,
                prefs: ["default-model": model]
            ) else { return }
            var confirmed = response
            if confirmed["default-model"] == nil { confirmed["default-model"] = model }
            _ = NativePreferences.apply(confirmed, for: requestContext)
        }
    }

    private func reset() {
        // `/model` has no "follow the default" form — the web sends "" through
        // its own picker, but the slash command takes an id — so this pins the
        // default id. The next run resolves to the same model either way.
        if let defaultModel = catalog?.defaultModel, !defaultModel.isEmpty {
            viewModel.changeModel(to: defaultModel)
        }
        // `changeModel` clears both itself, but it no-ops when the model is
        // already the default, which is the common case for a reset.
        viewModel.effort = ""
        viewModel.fastMode = false
        viewModel.pinAccount(nil)
    }
}
