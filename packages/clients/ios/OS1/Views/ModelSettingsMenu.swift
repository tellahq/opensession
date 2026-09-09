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
    @AppStorage(NativePreferences.defaultModelStorageKey) private var preferredModel = ""

    let viewModel: SessionViewModel
    let catalog: ModelCatalog?
    /// Conversation cost, above the choices that drive it. Carried where this
    /// is the whole menu; suppressed where it is nested inside one, since
    /// spend is not a model setting and the row would read as one.
    var showsUsage = true

    var body: some View {
        if showsUsage {
            UsageMenuSection(usage: viewModel.usage)
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

    /// Nothing to put back: following the default model, no effort picked, and
    /// standard speed. Drives the reset row's disabled state, so it doubles as
    /// the answer to "am I on the defaults?".
    private var isAtDefault: Bool {
        let defaultModel = catalog?.defaultModel ?? ""
        let onDefaultModel =
            viewModel.model.isEmpty || defaultModel.isEmpty || viewModel.model == defaultModel
        return onDefaultModel && viewModel.effort.isEmpty && !viewModel.fastMode
    }

    private func setAsDefault() {
        // Same write as the new-session picker: this device first, then the
        // per-user key so new sessions on every client start here.
        let model = currentModel
        Task { await NativePreferences.setDefaultModel(model) }
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
    }
}
