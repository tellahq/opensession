import SwiftUI

/// Compose a new session, laid out like the palette on the desktop: the repo
/// names the iOS title bar (and reads across the top on Mac), the prompt fills
/// the middle, and how it runs sits in the footer with the attach button. Code
/// is the quiet default. Ask and
/// Sandbox sit behind More options, while dictation stays one tap away at the
/// trailing edge. Connected services have no native equivalent yet, so they
/// stay absent rather than half-present.
/// Screenshots paste straight into the attachments (Cmd+V on the Mac,
/// long-press Paste on iOS).
///
/// The prompt lives in a plain `TextEditor` inside a custom layout (not a
/// grouped Form): Form re-diffs every row on each keystroke, which is what
/// made typing lag in the old sheet.
struct NewSessionView: View {
    @Environment(\.dismiss) private var dismiss

    /// Preset repo (the per-repo "+" in the sessions list); nil = remembered.
    var initialRepo: String?

    /// Workspace this session joins as a new tab (the session's ⋯ → "New
    /// session in this workspace"); nil starts a standalone session in its own
    /// workspace.
    var initialWorkspaceId: String?

    /// A parked prompt on that workspace. Opening its sessionless row feeds
    /// the same New Session surface rather than inventing a second composer.
    var initialDraft: OS1API.WorkspaceDraft?

    /// Open with the mic already listening — the Action Button's "Start an
    /// Agent" (see `StartAgentIntent`), where the whole point is to speak
    /// before you have found the keyboard.
    var autoDictate = false

    /// Attachments handed to the app by iOS before this composer opened.
    var initialImages: [AttachedImage]
    var initialFiles: [AttachedFile]

    /// Called the moment Start is tapped, with an optimistic session row
    /// (temporary `pending-` id) plus the prompt/images to seed the
    /// conversation view instantly.
    let onCreated: (Session, SessionViewModel.OptimisticSeed) -> Void

    /// Called when the background create finishes: the temp id and either
    /// the server's real session id or the error to surface.
    let onResolved: (String, Result<String, Error>) -> Void

    /// The unsent prompt was parked without creating a session.
    let onDraftSaved: (OS1API.WorkspaceSummary) -> Void

    init(
        initialRepo: String? = nil,
        initialWorkspaceId: String? = nil,
        initialDraft: OS1API.WorkspaceDraft? = nil,
        autoDictate: Bool = false,
        initialImages: [AttachedImage] = [],
        initialFiles: [AttachedFile] = [],
        onCreated: @escaping (Session, SessionViewModel.OptimisticSeed) -> Void,
        onResolved: @escaping (String, Result<String, Error>) -> Void,
        onDraftSaved: @escaping (OS1API.WorkspaceSummary) -> Void = { _ in }
    ) {
        self.initialRepo = initialRepo
        self.initialWorkspaceId = initialWorkspaceId
        self.initialDraft = initialDraft
        self.autoDictate = autoDictate
        self.initialImages = initialImages
        self.initialFiles = initialFiles
        _images = State(initialValue: initialImages)
        _files = State(initialValue: initialFiles)
        self.onCreated = onCreated
        self.onResolved = onResolved
        self.onDraftSaved = onDraftSaved
    }

    @State private var prompt = ""
    @State private var mode = "code"
    @State private var repos: [OS1API.RepoInfo] = []
    @State private var repo = ""
    @State private var catalog: ModelCatalog?
    @State private var model = ""
    @State private var effort = ""
    @State private var fastMode = false
    @State private var images: [AttachedImage]
    @State private var files: [AttachedFile]
    @State private var stagingFileIDs: Set<String> = []
    @State private var failedFileIDs: Set<String> = []
    @State private var attachmentError: String?
    /// "" is the host. Never seeded from the instance's own default: the chip
    /// is what tells you where this session will run, so it starts on the one
    /// answer that is true everywhere.
    @State private var sandbox = SandboxOffering.host
    @State private var sandboxStatus: InstanceSandboxStatus?
    @State private var showLibrary = false
    @State private var savingDraft = false
    /// Set before the save begins and kept through dismissal, so the sheet's
    /// disappearance cannot park the same prompt twice.
    @State private var draftSaveStarted = false
    /// Starting a session also dismisses this sheet, but consumes the prompt.
    @State private var sessionStarted = false
    @State private var draftSaveError: String?
    /// Owned here, like the session composer's: the button reads it, this view
    /// keeps it alive across the layout changes a long dictation causes.
    @State private var dictation = Dictation()
    @State private var sessionProjection = ComposerSessionProjectionState()
    @FocusState private var promptFocused: Bool

    /// Remembered only for restoring Code after switching this composer to
    /// Ask. A fresh universal composer starts from the cross-device default.
    @AppStorage("os1.newSession.repo") private var lastRepo = ""
    @AppStorage("os1.composer.defaultRepo") private var preferredRepo = ""
    @AppStorage(NativePreferences.sessionCheckoutsStorageKey) private var sessionCheckouts = ""
    @AppStorage("os1.composer.defaultModel") private var preferredModel = ""
    @AppStorage("os1.composer.defaultEngine") private var preferredEngine = ""

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                #if os(macOS)
                header
                #endif
                editor
                #if os(macOS)
                if !images.isEmpty || !files.isEmpty { attachments }
                Divider()
                controls
                #endif
            }
            // Keep the sheet surface behind the translucent keyboard.
            // Otherwise its background stops at the keyboard safe-area edge,
            // leaving a hard full-width seam under the action row.
            .background(
                OS1VisualStyle.background.ignoresSafeArea(.keyboard, edges: .bottom)
            )
            #if os(iOS)
            // The selected repository is the identity of this composer. Keep
            // "New session" for the action that opened it rather than spending
            // the title slot on a state every sheet here already implies.
            .navigationTitle(repoLabel)
            #else
            .navigationTitle("New session")
            #endif
            .inlineTitleBarCompat()
            .toolbar {
                #if os(iOS)
                ToolbarItem(placement: .principal) { repoChip }

                // Both ends draw their own circle, so both hide the toolbar's
                // glass: a capsule around the send disc read as a white ring on
                // the black accent, and the ✕'s glass — white on a white sheet —
                // was nearly invisible next to it. Hiding it on one side only
                // also cost 4pt of symmetry: iOS insets a glass item and a bare
                // one differently.
                ToolbarItem(placement: .confirmationAction) { startButton }
                    .sharedBackgroundVisibility(.hidden)
                ToolbarItem(placement: .cancellationAction) { cancelButton }
                    .sharedBackgroundVisibility(.hidden)

                // Two native Liquid Glass groups: attachment and session
                // options on the left, model and voice on the right. The
                // flexible toolbar spacer keeps their materials separate, and
                // the system adds its scroll edge only while editor text moves
                // underneath. There is deliberately no permanent divider.
                ToolbarItem(placement: .bottomBar) {
                    AttachImagesButton(images: $images, usesSystemButtonStyle: true)
                }
                ToolbarItem(placement: .bottomBar) { moreOptionsMenu }
                ToolbarSpacer(.flexible, placement: .bottomBar)
                ToolbarItem(placement: .bottomBar) { modelChip }
                ToolbarItem(placement: .bottomBar) {
                    ComposerDictationButton(
                        dictation: dictation,
                        draft: $prompt,
                        usesSystemButtonStyle: true
                    )
                }

                // iOS hides the bottom bar while the software keyboard is up.
                // Repeat the same controls in its accessory so composing never
                // makes attachments, run options, model, or dictation vanish.
                // The accessory otherwise seats its glass directly on the
                // keyboard edge, so each control leaves the same 8pt breathing
                // room the session composer keeps there.
                ToolbarItemGroup(placement: .keyboard) {
                    AttachImagesButton(images: $images, usesSystemButtonStyle: true)
                        .padding(.bottom, 8)
                    moreOptionsMenu
                        .padding(.bottom, 8)
                    Spacer()
                    modelChip
                        .padding(.bottom, 8)
                    ComposerDictationButton(
                        dictation: dictation,
                        draft: $prompt,
                        usesSystemButtonStyle: true
                    )
                    .padding(.bottom, 8)
                }
                #else
                ToolbarItem(placement: .confirmationAction) { startButton }
                ToolbarItem(placement: .cancellationAction) { cancelButton }
                #endif
            }
            #if os(iOS)
            // Keep staged files above both forms of the composer toolbar: the
            // bottom bar at rest and its keyboard accessory while editing.
            // As a sibling of the editor, this shelf ended at the sheet edge
            // and the bottom toolbar floated over it.
            .safeAreaInset(edge: .bottom, spacing: 0) {
                if !images.isEmpty || !files.isEmpty {
                    VStack(spacing: 0) {
                        Divider()
                        attachments
                    }
                    .background(OS1VisualStyle.background)
                }
            }
            #endif
            .task { await load() }
            .task { await stagePendingFiles() }
            // The library is a detail of composing this session, so it pushes
            // onto the sheet's own stack: back is where you were, with the
            // prompt filled in.
            .navigationDestination(isPresented: $showLibrary) {
                LibraryView(onPick: apply)
            }
            // Coming back from the library, the editor would otherwise take
            // focus again and put the keyboard over the prompt you just chose.
            // Landing on the whole text is the point; a tap starts editing.
            .onChange(of: showLibrary) { _, shown in
                if !shown { promptFocused = false }
            }
            // Swiping the sheet away is as much a "never mind" as Cancel; the
            // mic must not outlive either.
            .onDisappear { dictation.stop() }
            .alert(
                "Couldn't save draft",
                isPresented: Binding(
                    get: { draftSaveError != nil },
                    set: { if !$0 { draftSaveError = nil } }
                )
            ) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(draftSaveError ?? "")
            }
            .alert(
                "Couldn't attach file",
                isPresented: Binding(
                    get: { attachmentError != nil },
                    set: { if !$0 { attachmentError = nil } }
                )
            ) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(attachmentError ?? "")
            }
        }
        // This belongs to the outer stack. The editor itself disappears when
        // the recipe library is pushed, which is not an exit from the sheet.
        .onDisappear { parkDraftAfterDismiss() }
        // The floor belongs to the stack, not to its first screen. A macOS
        // sheet sizes to its content, so applied inside, a push replaced it
        // with a view that asks for nothing and the sheet collapsed to its
        // title bar. That is how the whole library came up empty behind
        // "Start from a recipe".
        #if os(macOS)
        .frame(minWidth: 560, minHeight: 440)
        #endif
    }

    // ── Prompt editor ─────────────────────────────────────────────────────

    private var attachments: some View {
        VStack(spacing: 6) {
            if !images.isEmpty {
                AttachedImagesRow(images: images) { image in
                    images.removeAll { $0.id == image.id }
                }
            }
            if !files.isEmpty {
                AttachedFilesRow(
                    files: files,
                    staging: stagingFileIDs,
                    failed: failedFileIDs,
                    onRetry: { file in Task { await stage(file) } },
                    onRemove: remove
                )
            }
        }
        .padding(.horizontal, 16)
        .padding(.bottom, 6)
    }

    private var startDisabled: Bool {
        savingDraft
            || !stagingFileIDs.isEmpty
            || !failedFileIDs.isEmpty
            || files.contains(where: { !$0.isStaged })
            || (prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                && images.isEmpty
                && files.isEmpty)
    }

    /// Starting a session is the same gesture as sending a message, so on iOS
    /// it wears the composer's send disc rather than the word "Start", with the
    /// ✕ that dismisses the sheet as its pair. The Mac keeps text buttons — a
    /// bare glyph in a sheet toolbar reads as unfinished there.
    @ViewBuilder
    private var startButton: some View {
        #if os(iOS)
        Button { create() } label: {
            Image(systemName: "arrow.up")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(
                    startDisabled ? OS1VisualStyle.textDim : OS1VisualStyle.onAccent
                )
                // 44pt, not the composer's 32: this disc replaces a toolbar
                // item's own glass circle, and iOS draws that at 44 — the ✕
                // across the bar measures exactly that. At 32 the pair read as
                // two different kinds of control, and the primary action was
                // the one below the tap-target floor.
                .frame(width: 44, height: 44)
                .background(
                    startDisabled
                        ? AnyShapeStyle(OS1VisualStyle.hover)
                        : AnyShapeStyle(OS1VisualStyle.accent),
                    in: Circle()
                )
        }
        .buttonStyle(.plain)
        .disabled(startDisabled)
        // A bare toolbar item sits 20pt off the edge; the sheet's own column —
        // the chips below, and the prompt under them — is 16. Pull both circles
        // onto it so the header has one left and one right edge.
        .padding(.trailing, -4)
        .keyboardShortcut(.return, modifiers: .command)
        .accessibilityLabel("Start session")
        #else
        Button("Start") { create() }
            .keyboardShortcut(.return, modifiers: .command)
            .disabled(startDisabled)
        #endif
    }

    @ViewBuilder
    private var cancelButton: some View {
        #if os(iOS)
        // The send disc's twin: same 44pt circle, same glyph size, and the
        // neutral fill the sheet's own chips wear. Only the role colour differs,
        // so the bar reads as a pair — a bare glyph opposite a solid accent disc
        // left the sheet lopsided.
        Button { exitComposer() } label: {
            Image(systemName: "xmark")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(OS1VisualStyle.text)
                .frame(width: 44, height: 44)
                .background(OS1VisualStyle.hover, in: Circle())
        }
        .buttonStyle(.plain)
        .disabled(savingDraft)
        .padding(.leading, -4)
        .accessibilityLabel(savingDraft ? "Saving draft" : "Cancel")
        #else
        Button(savingDraft ? "Saving…" : "Cancel") { exitComposer() }
            .disabled(savingDraft)
        #endif
    }

    private var editor: some View {
        ZStack(alignment: .topLeading) {
            TextEditor(text: sessionProjection.binding(
                $prompt,
                titleGeneration: TranscriptLinks.shared.generation,
                refreshTitles: !promptFocused
            ))
                .font(.body)
                .scrollContentBackground(.hidden)
                .padding(.horizontal, 11)
                .padding(.top, 8)
                .focused($promptFocused)
                // Cmd+V with a copied screenshot attaches it; text pastes
                // flow through to the editor untouched.
                .pastesImages(into: $images)
            if prompt.isEmpty {
                VStack(alignment: .leading, spacing: 2) {
                    Text("What should this session do?")
                        .font(.body)
                        .foregroundStyle(.tertiary)
                        .allowsHitTesting(false)
                    #if os(macOS)
                    recipeButton
                    #endif
                }
                .padding(.horizontal, 16)
                .padding(.top, placeholderTopPadding)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        #if os(iOS)
        .contentShape(Rectangle())
        .onTapGesture { promptFocused = true }
        #endif
    }

    /// Offered only while the prompt is empty, under the placeholder it
    /// answers: a recipe is a way to START writing, and once there is
    /// something to send the button would be both in the way and destructive.
    private var recipeButton: some View {
        Button {
            promptFocused = false
            showLibrary = true
        } label: {
            Label("Start from a recipe", systemImage: "books.vertical")
                .font(.subheadline)
                .foregroundStyle(.tint)
                #if os(iOS)
                .frame(minHeight: 44, alignment: .leading)
                .contentShape(Rectangle())
                #endif
        }
        .buttonStyle(.plain)
    }

    /// Fill the composer from a library entry, leaving every field editable
    /// and the keyboard down: the point of prefilling rather than starting is
    /// that you read what will be sent, and a recipe prompt is longer than the
    /// two lines a raised keyboard leaves.
    private func apply(_ entry: LibraryEntry) {
        prompt = entry.prompt ?? ""
        if let entryMode = entry.mode, entryMode == "ask" || entryMode == "code" {
            selectMode(entryMode)
        }
        // Only a model this instance actually offers; a recipe naming one that
        // has since been retired keeps the composer's default instead.
        if let entryModel = entry.model, catalog?.option(for: entryModel) != nil {
            model = entryModel
            defaultEffortForCurrentModel()
        }
    }

    /// Lines the placeholder up with the editor's real text origin: the outer
    /// padding plus the platform text view's own insets. UITextView adds an
    /// 8pt top container inset (8 outer + 8 = 16); NSTextView adds none.
    /// Horizontally both add 5pt fragment padding (11 outer + 5 = 16).
    private var placeholderTopPadding: CGFloat {
        #if os(macOS)
        8
        #else
        16
        #endif
    }

    // ── Header: what the session is ───────────────────────────────────────

    /// The repo decides what the session can touch, so it sits above the prompt
    /// rather than among the run settings below it. Code is the default on iOS,
    /// so its "New branch" label stays hidden like it does on the web.
    private var header: some View {
        HStack(spacing: 8) {
            repoChip
            Spacer(minLength: 8)
            #if os(macOS)
            modeChip
            #endif
        }
        // 16, the column the prompt below already uses (11 outer + the text
        // view's own 5pt fragment padding) and the toolbar circles now sit on.
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
    }

    /// Sized off the chip's text rather than the tile's own default, so the
    /// icon reads as part of the label.
    private var repoTileSize: CGFloat {
        #if os(macOS)
        18
        #else
        16
        #endif
    }

    private var repoLabel: String {
        if repo == Session.noRepoID { return "No repo" }
        if let match = repos.first(where: { $0.id == repo }) {
            return match.label ?? match.id
        }
        return repo.isEmpty ? "No repository" : repo
    }

    private var repoChip: some View {
        Menu {
            ForEach(repos) { repoInfo in
                Button {
                    selectRepo(repoInfo.id)
                } label: {
                    Label {
                        Text(repoInfo.label ?? repoInfo.id)
                    } icon: {
                        // The checkmark takes the slot when it's the current
                        // repo — a menu row has one glyph, and which repo is
                        // selected outranks showing its icon twice (the chip
                        // above the menu already wears it).
                        if repo == repoInfo.id {
                            Image(systemName: "checkmark")
                        } else if let icon = RepoTile.menuIcon(for: repoInfo.id) {
                            icon
                        }
                    }
                }
            }
            if mode == "ask" {
                Divider()
                Button {
                    selectRepo(Session.noRepoID)
                } label: {
                    Label {
                        Text("No repo")
                    } icon: {
                        Image(systemName: repo == Session.noRepoID
                              ? "checkmark"
                              : "bubble.left.and.bubble.right")
                    }
                }
            }
        } label: {
            if repo == Session.noRepoID {
                chipLabel(
                    icon: "bubble.left.and.bubble.right",
                    text: repoLabel,
                    strong: true
                )
            } else if repo.isEmpty {
                chipLabel(icon: "folder", text: repoLabel, strong: true)
            } else {
                chipLabel(text: repoLabel, strong: true) {
                    RepoTile(name: repo, size: repoTileSize)
                }
            }
        }
        .menuStyle(.button)
        #if os(macOS)
        .buttonStyle(.plain)
        #endif
        .disabled(repos.isEmpty && mode != "ask")
    }

    /// Joining a workspace changes what code mode means: the session shares
    /// that workspace's worktree and branch rather than cutting a new one, so the
    /// chip says so instead of promising a branch it won't create.
    private var codeModeLabel: String {
        initialWorkspaceId == nil ? "New branch" : "Same branch"
    }

    /// The palette calls this "what to create from", and its two entries that
    /// exist here are a fresh branch (code) and Ask; the same words are used so
    /// the two screens describe one choice. Worktrees and scratch sessions have
    /// no native equivalent, so they aren't offered.
    private var modeChip: some View {
        Menu {
            Button {
                selectMode("code")
            } label: {
                Label {
                    Text(codeModeLabel)
                    Text(
                        initialWorkspaceId == nil
                            ? "Isolated worktree, can open a PR"
                            : "Shares this workspace's worktree"
                    )
                } icon: {
                    if mode == "code" { Image(systemName: "checkmark") }
                }
            }
            Button {
                selectMode("ask")
            } label: {
                Label {
                    Text("Ask")
                    Text("Read-only, no repo unless you pick one")
                } icon: {
                    if mode == "ask" { Image(systemName: "checkmark") }
                }
            }
        } label: {
            chipLabel(
                icon: mode == "code" ? "arrow.branch" : "text.magnifyingglass",
                text: mode == "code" ? codeModeLabel : "Ask"
            )
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
    }

    // ── Footer: how it runs ───────────────────────────────────────────────

    private var selectedModelOption: ModelOption? {
        catalog?.option(for: model)
    }

    private var effectiveModelID: String {
        model.isEmpty ? (catalog?.defaultModel ?? "") : model
    }

    private var currentEngine: String {
        catalog?.routingEngine(for: effectiveModelID)
            ?? ModelCatalog.engine(effectiveModelID)
    }

    private var engineChoices: [ModelEngineOption] {
        catalog?.availableEngines ?? []
    }

    private var availableEfforts: [String] {
        selectedModelOption?.efforts ?? []
    }

    private var fastSupported: Bool {
        selectedModelOption?.fastModeSupported == true
    }

    private var modelChipText: String {
        let id = model.isEmpty ? catalog?.defaultModel : model
        #if os(iOS)
        if id == "dial/opus-fable" { return "Opus/Fable/Oracle" }
        #endif
        return catalog?.label(for: id) ?? "Model"
    }

    /// Attach stays at the leading edge. iOS keeps mode and execution choices
    /// behind one overflow button, with model and dictation on the right. The
    /// Mac has room to keep every setting as its own chip.
    private var controls: some View {
        HStack(spacing: 8) {
            AttachImagesButton(images: $images)
            #if os(iOS)
            moreOptionsMenu
            Spacer(minLength: 8)
            modelChip
            ComposerDictationButton(dictation: dictation, draft: $prompt)
            #else
            ComposerDictationButton(dictation: dictation, draft: $prompt)
            Spacer(minLength: 8)
            if !availableEfforts.isEmpty { effortChip }
            if fastSupported { fastChip }
            if !sandboxChoices.isEmpty { sandboxChip }
            modelChip
            #endif
        }
        .padding(.horizontal, 12)
        .padding(.vertical, controlsVerticalPadding)
    }

    /// The iOS attach button carries its own 44pt tap target, so the row only
    /// needs air on the Mac.
    private var controlsVerticalPadding: CGFloat {
        #if os(macOS)
        10
        #else
        4
        #endif
    }

    /// Sandboxes this instance can actually start a session in. Empty on an
    /// instance that only runs on the host, and then the chip never appears:
    /// a picker with one entry is a label pretending to be a choice.
    private var sandboxChoices: [String] {
        if repo == Session.noRepoID { return [] }
        return SandboxOffering.choices(sandboxStatus)
    }

    private var askModeBinding: Binding<Bool> {
        Binding(
            get: { mode == "ask" },
            set: { selectMode($0 ? "ask" : "code") }
        )
    }

    /// iOS keeps mode and environment choices behind one control. Its active
    /// state remains visible when either hidden choice differs from Code on the
    /// host, with Ask using the same green as the session composer.
    private var moreOptionsMenu: some View {
        let customized = mode == "ask" || sandbox != SandboxOffering.host
        return Menu {
            Toggle(isOn: askModeBinding) {
                Label {
                    Text("Ask")
                    Text("Read-only, no repo unless you pick one")
                } icon: {
                    Image(systemName: "eye")
                }
            }
            if !sandboxChoices.isEmpty {
                Divider()
                Menu {
                    sandboxOptions
                } label: {
                    Label {
                        Text("Sandbox")
                        Text(SandboxOffering.label(sandbox))
                    } icon: {
                        Image(systemName: "cube")
                    }
                }
            }
        } label: {
            Image(systemName: "ellipsis")
                .font(.system(size: 18, weight: .medium))
                .foregroundStyle(
                    customized
                        ? (mode == "ask" ? OS1VisualStyle.green : OS1VisualStyle.accentInk)
                        : OS1VisualStyle.textDim
                )
                .frame(width: 44, height: 44)
                .background(
                    customized
                        ? (mode == "ask"
                            ? OS1VisualStyle.green.opacity(0.14)
                            : OS1VisualStyle.accent.opacity(0.14))
                        : Color.clear,
                    in: Circle()
                )
                .contentShape(Circle())
        }
        .menuStyle(.button)
        .accessibilityLabel("More options")
        .accessibilityValue(mode == "ask" ? "Ask on" : "Code")
    }

    /// The Mac keeps Sandbox visible as a chip because it has the room.
    private var sandboxChip: some View {
        Menu {
            sandboxOptions
        } label: {
            chipLabel(icon: "cube", text: SandboxOffering.label(sandbox))
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
    }

    @ViewBuilder
    private var sandboxOptions: some View {
        sandboxOption(SandboxOffering.host)
        ForEach(sandboxChoices, id: \.self) { provider in
            sandboxOption(provider)
        }
    }

    private func sandboxOption(_ provider: String) -> some View {
        Button {
            sandbox = provider
        } label: {
            if sandbox == provider {
                Label(SandboxOffering.label(provider), systemImage: "checkmark")
            } else {
                Text(SandboxOffering.label(provider))
            }
        }
    }

    private var modelChip: some View {
        Menu {
            #if os(iOS)
            if !availableEfforts.isEmpty {
                Section("Reasoning") {
                    ForEach(availableEfforts, id: \.self) { level in
                        Button {
                            effort = level
                        } label: {
                            if effort == level {
                                Label(EffortLevel.label(level), systemImage: "checkmark")
                            } else {
                                Text(EffortLevel.label(level))
                            }
                        }
                    }
                }
            }
            if fastSupported {
                Button {
                    fastMode.toggle()
                } label: {
                    if fastMode {
                        Label("Fast mode", systemImage: "checkmark")
                    } else {
                        Text("Fast mode")
                    }
                }
            }
            #endif
            if engineChoices.count > 1 {
                Section("Engine") {
                    ForEach(engineChoices) { engine in
                        engineButton(engine)
                    }
                }
            }
            if let catalog {
                if !catalog.presets.isEmpty {
                    Section("Presets") {
                        ForEach(catalog.presets) { option in
                            modelButton(option)
                        }
                    }
                }
                Section(catalog.presets.isEmpty ? "Model" : "Models") {
                    ForEach(catalog.regular) { option in
                        modelButton(option)
                    }
                }
            }
        } label: {
            chipLabel(
                icon: "cpu",
                text: modelChipText
            )
        }
        .menuStyle(.button)
        #if os(macOS)
        .buttonStyle(.plain)
        #endif
    }

    private func modelButton(_ option: ModelOption) -> some View {
        let routed = ModelCatalog.routedID(option.id, engine: currentEngine)
        return Button {
            selectModel(option)
        } label: {
            let selected = option.id == ModelCatalog.baseID(model)
            if let subtitle = option.description, !subtitle.isEmpty {
                Label {
                    Text(option.displayLabel)
                    Text(subtitle)
                } icon: {
                    if selected { Image(systemName: "checkmark") }
                }
            } else if selected {
                Label(option.displayLabel, systemImage: "checkmark")
            } else {
                Text(option.displayLabel)
            }
        }
        .disabled(routed == nil)
    }

    private func engineButton(_ engine: ModelEngineOption) -> some View {
        let routed = ModelCatalog.routedID(effectiveModelID, engine: engine.id)
        return Button {
            guard let routed else { return }
            model = routed
        } label: {
            if currentEngine == engine.id {
                Label(engine.label, systemImage: "checkmark")
            } else {
                Text(engine.label)
            }
        }
        .disabled(routed == nil)
    }

    private var effortChip: some View {
        Menu {
            ForEach(availableEfforts, id: \.self) { level in
                Button {
                    effort = level
                } label: {
                    if effort == level {
                        Label(EffortLevel.label(level), systemImage: "checkmark")
                    } else {
                        Text(EffortLevel.label(level))
                    }
                }
            }
        } label: {
            chipLabel(
                icon: "gauge.with.needle",
                text: effort.isEmpty ? "Effort" : EffortLevel.label(effort)
            )
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
    }

    private var fastChip: some View {
        Button {
            fastMode.toggle()
        } label: {
            chipLabel(icon: "bolt.fill", text: "Fast", highlighted: fastMode)
        }
        .buttonStyle(.plain)
    }

    /// `strong` is the repo's treatment: full-strength ink, as the desktop
    /// palette gives its repository trigger — the one choice on the screen you
    /// should be able to read without looking for it.
    private func chipLabel(
        icon: String, text: String, highlighted: Bool = false, strong: Bool = false
    ) -> some View {
        chipLabel(text: text, highlighted: highlighted, strong: strong) {
            Image(systemName: icon)
                #if os(iOS)
                .font(.caption2)
                #else
                .font(.caption)
                #endif
        }
    }

    /// Same chip with a view in the glyph's place, so the repo can wear its
    /// own icon rather than a folder standing in for it.
    private func chipLabel<Icon: View>(
        text: String,
        highlighted: Bool = false,
        strong: Bool = false,
        @ViewBuilder icon: () -> Icon
    ) -> some View {
        HStack(spacing: 5) {
            icon()
            Text(text)
                #if os(iOS)
                .font(.caption.weight(strong ? .medium : .regular))
                #else
                .font(.callout.weight(strong ? .medium : .regular))
                #endif
                .lineLimit(1)
        }
        .foregroundStyle(
            highlighted
                ? AnyShapeStyle(.tint)
                : (strong ? AnyShapeStyle(OS1VisualStyle.text) : AnyShapeStyle(.secondary))
        )
        #if os(iOS)
        .padding(.horizontal, 7)
        .padding(.vertical, 5)
        #else
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        #endif
        #if os(iOS)
        // The iOS labels live inside system toolbar glass. A second fill here
        // would make the repository and model look like pills inside pills.
        .frame(minHeight: 44)
        #else
        .background(
            highlighted ? AnyShapeStyle(.tint.opacity(0.15)) : AnyShapeStyle(.fill.tertiary),
            in: Capsule()
        )
        #endif
        #if os(iOS)
        .contentShape(Rectangle())
        #else
        .contentShape(Capsule())
        #endif
    }

    // ── Data ──────────────────────────────────────────────────────────────

    private func stagePendingFiles() async {
        for file in files where !file.isStaged {
            await stage(file)
        }
    }

    private func stage(_ file: AttachedFile) async {
        guard !file.isStaged, !stagingFileIDs.contains(file.id) else { return }
        stagingFileIDs.insert(file.id)
        failedFileIDs.remove(file.id)
        defer { stagingFileIDs.remove(file.id) }
        do {
            let staged = try await OS1API.uploadComposerFile(file)
            guard let index = files.firstIndex(where: { $0.id == file.id }) else { return }
            files[index] = staged
        } catch {
            guard files.contains(where: { $0.id == file.id }) else { return }
            failedFileIDs.insert(file.id)
            attachmentError = error.localizedDescription
        }
    }

    private func remove(_ file: AttachedFile) {
        files.removeAll { $0.id == file.id }
        stagingFileIDs.remove(file.id)
        failedFileIDs.remove(file.id)
    }

    private func load() async {
        if prompt.isEmpty, let initialDraft { prompt = initialDraft.text }
        promptFocused = true
        // Opened from the Action Button: the mic goes hot with the sheet, so
        // speaking is the first thing that works. Everything else below still
        // loads underneath it. Only once the permissions exist, though — the
        // first press should show the composer, not two system prompts stacked
        // over it; the mic in the footer asks for them on the first tap.
        if autoDictate, !dictation.active, Dictation.isAuthorized {
            Task { await dictation.start(base: prompt) { prompt = $0 } }
        }
        // Show an explicit scope immediately. An unscoped composer waits for
        // the repository list so a removed preference never flashes as real.
        repo = initialRepo ?? ""
        if initialRepo == Session.noRepoID { mode = "ask" }
        let requestContext = NativePreferences.context()
        async let reposFetch = OS1API.repos()
        async let modelsFetch = OS1API.models(workspaceId: initialWorkspaceId)
        async let prefsFetch = SettingsAPI.uiPrefs(user: requestContext.user)
        // A server without sandboxes, or one too old to answer, simply leaves
        // the chip off. It must never keep the composer from opening.
        async let sandboxFetch = OS1API.sandboxStatus()
        let fetchedRepos = (try? await reposFetch) ?? []
        let fetchedPrefs = try? await prefsFetch
        let livePrefs = NativePreferences.context() == requestContext ? fetchedPrefs : nil
        let livePreferredRepo = livePrefs.map {
            NativePreferences.normalizedDefaultRepository($0["default-repo"]) ?? ""
        } ?? preferredRepo
        preferredRepo = livePreferredRepo
        if let livePrefs {
            sessionCheckouts = NativePreferences.validatedSessionCheckouts(
                livePrefs["session-checkouts"]
            ) ?? ""
        }
        repos = fetchedRepos
        repo = Self.startingRepository(
            in: fetchedRepos,
            preferred: livePreferredRepo,
            explicit: initialRepo
        )
        // The picker's rows can only show an icon the cache already holds, so
        // fetch them here rather than when the menu opens.
        for repoInfo in repos { RepoTile.prefetchIcon(for: repoInfo.id) }
        sandboxStatus = try? await sandboxFetch
        if let fetched = try? await modelsFetch {
            catalog = fetched
            let livePreferred = livePrefs?["default-model"] ?? preferredModel
            let liveEngine = livePrefs?["default-engine"] ?? preferredEngine
            preferredModel = livePreferred
            preferredEngine = liveEngine
            if model.isEmpty {
                let start = fetched.option(for: livePreferred) != nil
                    ? livePreferred
                    : (fetched.defaultModel ?? "")
                // Start on their default engine too. It then stays with the
                // composer: selectModel recomposes onto currentEngine.
                model = fetched.preferredID(start, engine: liveEngine)
            }
            defaultEffortForCurrentModel()
        }
    }

    private func selectModel(_ option: ModelOption) {
        guard let routed = ModelCatalog.routedID(option.id, engine: currentEngine) else {
            return
        }
        model = routed
        defaultEffortForCurrentModel()
        if !(option.fastModeSupported == true) { fastMode = false }
    }

    /// "High" is the palette's default where supported; presets (dial) have
    /// no effort dimension so the chip hides.
    private func defaultEffortForCurrentModel() {
        let efforts = availableEfforts
        if efforts.isEmpty {
            effort = ""
        } else if !efforts.contains(effort) {
            effort = efforts.contains("high") ? "high" : efforts[0]
        }
    }

    /// Match the web palette's two-axis create: a universal Ask starts with no
    /// repo, while a repo-scoped "+" keeps that repository. Switching back to
    /// Code restores the most recent real repository.
    private func selectMode(_ selected: String) {
        mode = selected
        repo = Self.repoAfterSelectingMode(
            selected,
            current: repo,
            isRepoScoped: initialRepo != nil,
            fallback: fallbackRepo
        )
    }

    static func repoAfterSelectingMode(
        _ mode: String,
        current: String,
        isRepoScoped: Bool,
        fallback: String
    ) -> String {
        if mode == "ask", !isRepoScoped { return Session.noRepoID }
        if mode == "code", current == Session.noRepoID { return fallback }
        return current
    }

    private func selectRepo(_ selected: String) {
        repo = selected
        if selected == Session.noRepoID {
            mode = "ask"
        } else {
            lastRepo = selected
        }
    }

    /// Resolve only real repository ids. Explicit scopes win, including the
    /// no-repo Ask/Scratch sentinel. A fresh composer then uses the account's
    /// preference before the workspace/default repository. Retired `auto` and
    /// removed ids fall through safely.
    static func startingRepository(
        in repos: [OS1API.RepoInfo],
        preferred: String,
        explicit: String?
    ) -> String {
        if explicit == Session.noRepoID { return Session.noRepoID }
        if let explicit, repos.contains(where: { $0.id == explicit }) { return explicit }
        let preferred = NativePreferences.normalizedDefaultRepository(preferred) ?? ""
        if repos.contains(where: { $0.id == preferred }) { return preferred }
        return repos.first(where: { $0.isDefault == true })?.id
            ?? repos.first?.id
            ?? Session.noRepoID
    }

    private var fallbackRepo: String {
        if repos.contains(where: { $0.id == lastRepo }) { return lastRepo }
        return repos.first(where: { $0.isDefault == true })?.id ?? repos.first?.id ?? ""
    }

    /// Closing persists the current text first. Clearing a resumed draft sends
    /// the deletion before closing, while a fresh empty composer closes at once.
    /// A failed explicit close stays open with the error.
    private func exitComposer() {
        let text = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty || initialDraft != nil else {
            dictation.stop()
            dismiss()
            return
        }
        parkDraft(text, dismissWhenSaved: true)
    }

    /// Covers an interactive sheet dismissal. The outer NavigationStack owns
    /// this callback, so opening the recipe library does not count as leaving.
    private func parkDraftAfterDismiss() {
        let text = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty || initialDraft != nil else { return }
        parkDraft(text, dismissWhenSaved: false)
    }

    private func parkDraft(_ text: String, dismissWhenSaved: Bool) {
        guard !draftSaveStarted, !sessionStarted else { return }
        draftSaveStarted = true
        savingDraft = true
        dictation.stop()
        Task {
            do {
                let workspace = try await OS1API.saveWorkspaceDraft(
                    text: text,
                    repo: repo,
                    workspaceId: initialWorkspaceId,
                    autoName: initialDraft?.autoName
                )
                onDraftSaved(workspace)
                savingDraft = false
                if dismissWhenSaved { dismiss() }
            } catch {
                savingDraft = false
                draftSaveStarted = false
                if dismissWhenSaved { draftSaveError = error.localizedDescription }
            }
        }
    }

    /// Optimistic create: the sheet closes immediately and the conversation
    /// opens seeded with the prompt under a temporary id, while the real
    /// create (worktree prep — seconds) runs in the background. The list
    /// swaps the temp id for the server's when it resolves.
    private func create() {
        guard !savingDraft,
              stagingFileIDs.isEmpty,
              failedFileIDs.isEmpty,
              files.allSatisfy(\.isStaged)
        else { return }
        // Played here rather than from a trigger on the view: the sheet
        // dismisses two lines down, and a dismissed view never observes its
        // own state change. Starting a session is the same gesture as sending
        // a message, and wears the same disc — so it gets the same cue.
        Haptics.play(.send)
        dictation.stop()
        let text = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        let imageURLs = images.map(\.dataURL)
        if repo != Session.noRepoID { lastRepo = repo }
        let provisionalTitle = text.isEmpty
            ? (files.first?.name ?? "New session")
            : (text.components(separatedBy: "\n").first ?? text)
        let pending = Session.optimistic(
            id: "pending-\(UUID().uuidString)",
            title: String(provisionalTitle.prefix(80)),
            repo: repo,
            repoLess: repo == Session.noRepoID,
            mode: mode,
            model: model.isEmpty ? nil : model,
            effort: effort.isEmpty ? nil : effort,
            fastMode: fastMode,
            startedBy: ServerConfig.shared.userName,
            workspaceId: initialWorkspaceId
        )
        sessionStarted = true
        dismiss()
        onCreated(
            pending,
            SessionViewModel.OptimisticSeed(prompt: text, images: imageURLs)
        )
        Task {
            do {
                let id = try await OS1API.createSession(
                    prompt: text,
                    repo: repo,
                    mode: mode,
                    checkoutMode: NativePreferences.sessionCheckoutMode(
                        for: repo,
                        in: sessionCheckouts
                    ),
                    model: model.isEmpty ? nil : model,
                    effort: effort.isEmpty ? nil : effort,
                    fastMode: fastMode,
                    images: imageURLs,
                    files: files,
                    workspaceId: initialWorkspaceId,
                    // Only when the chip was on screen. Where it wasn't, the
                    // instance keeps deciding, exactly as before.
                    // Remote providers materialize a repository workspace, so
                    // an explicit no-repo Ask must stay on the host even when
                    // the instance has a remote sandbox default.
                    sandbox: repo == Session.noRepoID
                        ? SandboxOffering.createValue(SandboxOffering.host)
                        : (sandboxChoices.isEmpty
                            ? nil
                            : SandboxOffering.createValue(sandbox))
                )
                onResolved(pending.id, .success(id))
            } catch {
                onResolved(pending.id, .failure(error))
            }
        }
    }
}
