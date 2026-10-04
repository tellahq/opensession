import SwiftUI

/// The Desk: a summonable sheet onto the user's standing concierge session
/// (`OS1API.ensureDesk`), plus its optional live voice mode. Presented as a
/// full-height sheet from the sessions list, on both platforms.
struct DeskSheet: View {
    private enum LoadState {
        case loading
        case failed(String)
        case ready(SessionViewModel)
    }

    /// Two hours: long enough that stepping away mid-thought keeps the thread,
    /// short enough that yesterday's chat never owns the surface you summoned
    /// for today's work. Frozen when the sheet opens, so nothing said in this
    /// sitting can age out from under you.
    private static let staleAfter: TimeInterval = 2 * 60 * 60

    @Environment(\.dismiss) private var dismiss
    @AppStorage("os1.desk.voice") private var deskVoice = "off"

    @State private var loadState: LoadState = .loading
    @State private var voiceSupported = false
    @State private var engine = DeskVoiceEngine()

    var body: some View {
        @Bindable var engine = engine
        return VStack(spacing: 0) {
            VStack(spacing: 0) {
                header
                Divider()
            }
            .background(OS1VisualStyle.chatCanvas)
            // SessionView's top transcript wash deliberately overhangs its
            // bounds to dissolve rows under navigation chrome. The Desk owns
            // its header outside SessionView, so keep that opaque header above
            // the wash instead of letting the later sibling fade its controls.
            .zIndex(1)
            content
        }
        .task {
            voiceSupported = await OS1API.serverDescriptor()?.supports("deskVoice") == true
            #if DEBUG
            // Dev loop: start the call on open (`OS1_VOICE_AUTOSTART=1`) so
            // simulator voice runs need no UI driving.
            if voiceSupported && ProcessInfo.processInfo.environment["OS1_VOICE_AUTOSTART"] != nil {
                engine.open()
            }
            #endif
            await load()
        }
        .onDisappear {
            // A full-screen cover takes its presenter off screen, so this
            // fires when the CALL opens — hanging up the call it just
            // presented. Only a sheet that is really going away stops it.
            if !engine.callPresented { engine.stop() }
        }
        .task {
            for await _ in NotificationCenter.default.notifications(
                named: AppLifecycle.didEnterBackgroundNotification
            ) {
                // A backgrounded app must never hold the mic open. Inactive is
                // not backgrounded: a notification banner or Control Center
                // must not silently end a conversation.
                engine.stop()
            }
        }
        .fullScreenCoverCompat(isPresented: $engine.callPresented) {
            DeskVoiceCallView(engine: engine)
        }
    }

    @ViewBuilder
    private var content: some View {
        switch loadState {
        case .loading:
            VStack(spacing: 10) {
                ProgressView()
                Text("Opening…")
                    .font(.footnote)
                    .foregroundStyle(OS1VisualStyle.textDim)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .failed(let message):
            Text(message)
                .font(.footnote)
                .foregroundStyle(OS1VisualStyle.textDim)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 32)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .ready(let model):
            SessionView(viewModel: model, tabs: [model.session])
                .emptyContent { earlierLink(model: model) }
                .composerAccessory { suggestionPills(model: model) }
        }
    }

    /// All that stands in for an empty Desk transcript: the way back to a
    /// conversation the staleness cutoff is holding.
    ///
    /// It used to be a list of your open work — blocked, unread, running —
    /// and that was a second inbox to read past on the way to the composer.
    /// The sessions list behind this sheet already answers "what's going on";
    /// the Desk is for handing over the next thing.
    @ViewBuilder
    private func earlierLink(model: SessionViewModel) -> some View {
        if model.hiddenEarlierCount > 0 {
            Button("Show earlier conversation") { model.hideBefore = nil }
                .font(.footnote)
                .foregroundStyle(OS1VisualStyle.textDim)
                .frame(maxWidth: .infinity)
                .padding(.top, 4)
        }
    }

    /// Starter prompts for the composer, named after what the Desk can
    /// actually do — session status, archiving, delegation, capture — rather
    /// than generic assistant filler. The trailing-ellipsis ones are
    /// deliberately unfinished: a pill FILLS the composer instead of sending,
    /// so an opening you complete yourself is the point, and the ones naming
    /// an action with side effects must never fire on a single tap.
    /// The web copy lives in lib/desk-suggestions.ts.
    private static let suggestions = [
        "What\u{2019}s running?",
        "What needs me?",
        "Archive what\u{2019}s done",
        "What shipped today?",
        "Look into\u{2026}",
        "Remind me to\u{2026}",
    ]

    private func suggestionPills(model: SessionViewModel) -> some View {
        ScrollView(.horizontal) {
            HStack(spacing: 6) {
                ForEach(Self.suggestions, id: \.self) { suggestion in
                    Button {
                        model.draft = suggestion
                    } label: {
                        Text(suggestion)
                            .font(.footnote.weight(.medium))
                            .foregroundStyle(OS1VisualStyle.textDim)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 7)
                            // No outline, and a fill you look past: these are
                            // suggestions you may never take, so they read as
                            // grey shapes rather than controls asking to be
                            // pressed. quaternarySystemFill is the system's
                            // own fill for small shapes like this, and it
                            // carries the capsule without a border.
                            .background(Capsule().fill(OS1VisualStyle.hover))
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 8)
        }
        .scrollIndicators(.hidden)
    }

    private var header: some View {
        HStack(spacing: 10) {
            Image(systemName: "lamp.desk")
                .font(.system(size: 17, weight: .medium))
                .foregroundStyle(OS1VisualStyle.text)
            Text("Desk")
                .font(.headline.weight(.semibold))
                .foregroundStyle(OS1VisualStyle.text)
            Spacer(minLength: 8)
            voiceStatusLabel
            if deskVoice == "on" && voiceSupported {
                micButton
            }
            Button {
                dismiss()
            } label: {
                headerGlyph("xmark", color: OS1VisualStyle.textDim)
            }
            .accessibilityLabel("Close")
        }
        // The sheet's drag indicator sits directly above this row, so the
        // title needs real clearance or the two read as one crowded band.
        //
        // The trailing number is smaller than the leading one because the
        // icon buttons carry 9pt of their own inset inside a 34pt tap
        // target — but matching the two so the GLYPHS both land at 18pt was
        // a measurement, not a look: an ✕ is drawn edge to edge in its box
        // while the lamp and the title start well inside theirs, so equal
        // numbers read as a right side jammed against the edge. The glyph
        // gets 24pt instead, which is what makes the two sides look equal.
        .padding(.leading, 18)
        .padding(.trailing, 15)
        .padding(.top, Self.headerTopPadding)
        .padding(.bottom, 14)
    }

    /// Clearance under the drag indicator. macOS has no grabber, so it keeps
    /// the tighter value.
    #if os(iOS)
    private static let headerTopPadding: CGFloat = 18
    #else
    private static let headerTopPadding: CGFloat = 12
    #endif

    /// A header icon with a real touch target. Bare glyphs here were both
    /// too small to hit reliably and visually crowded against each other.
    private func headerGlyph(_ name: String, color: Color) -> some View {
        Image(systemName: name)
            .font(.system(size: 16, weight: .medium))
            .foregroundStyle(color)
            .frame(width: 34, height: 34)
            .contentShape(Rectangle())
    }

    @ViewBuilder
    private var voiceStatusLabel: some View {
        if engine.state != .idle {
            Text(voiceStatusText)
                .font(.footnote)
                .foregroundStyle(engine.state == .error ? .red : OS1VisualStyle.textDim)
                .lineLimit(1)
                .frame(maxWidth: 160, alignment: .trailing)
        }
    }

    private var voiceStatusText: String {
        engine.state == .error
            ? (engine.errorMessage ?? engine.state.label)
            : engine.state.label
    }

    /// Starts a call, or returns to one that is already running — a minimized
    /// call stays live, so this button is the way back to it. Hanging up
    /// happens on the call screen.
    private var micButton: some View {
        Button {
            engine.open()
        } label: {
            headerGlyph(
                engine.active ? "mic.fill" : "mic",
                color: engine.active ? OS1VisualStyle.accentInk : OS1VisualStyle.textDim
            )
        }
        .accessibilityLabel(engine.active ? "Return to the voice call" : "Start a voice call")
    }

    private func load() async {
        loadState = .loading
        do {
            let ensure = try await OS1API.ensureDesk()
            let model = SessionViewModel(session: Session(id: ensure.sessionId))
            // The server's "Clear" marker and the staleness cutoff are the same
            // kind of thing — hide everything before the later of the two.
            let cleared = ensure.clearedAt.flatMap(Session.parseISO)
            let stale = Date().addingTimeInterval(-Self.staleAfter)
            model.hideBefore = max(cleared ?? stale, stale)
            loadState = .ready(model)
        } catch {
            loadState = .failed(error.localizedDescription)
        }
    }
}
