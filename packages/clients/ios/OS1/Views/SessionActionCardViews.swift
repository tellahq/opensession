import SwiftUI

/// The cards at the end of a session's transcript when the agent needs a
/// person: a credential to register, a keychain ask to answer, a force merge
/// to confirm, and the session's script runs. Same order as the web viewer.
///
/// Reads only `SessionActionCardsModel`, so a card changing re-renders this
/// stack and never the transcript around it.
struct SessionActionCardsStack: View {
    let model: SessionActionCardsModel

    var body: some View {
        VStack(spacing: 10) {
            if let pending = model.registration {
                CredentialRegistrationCard(model: model, pending: pending)
                    .id("credential-\(pending.request.id)")
            }
            ForEach(model.keychainAsks) { ask in
                KeychainAskCard(model: model, ask: ask)
            }
            if let pending = model.forceMerge {
                ForceMergeCard(model: model, pending: pending)
                    .id("force-merge-\(pending.request.id)")
            }
            ForEach(model.visibleScriptRuns) { run in
                ScriptRunCard(model: model, run: run)
            }
        }
        .animation(.snappy(duration: 0.2), value: model.attentionKey)
    }
}

// MARK: - Shared pieces

private extension View {
    /// The raised surface the question card uses, so every card that waits on
    /// a person reads as the same kind of thing.
    func actionCardShell() -> some View {
        let shape = RoundedRectangle(cornerRadius: 20, style: .continuous)
        return self
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(OS1VisualStyle.flapSurface, in: shape)
            .overlay(shape.stroke(OS1VisualStyle.border, lineWidth: 0.5))
    }
}

private struct CardHeader: View {
    let text: String
    var tint: Color = OS1VisualStyle.green

    var body: some View {
        HStack(spacing: 8) {
            Circle()
                .fill(tint)
                .frame(width: 6, height: 6)
                .background(Circle().fill(tint.opacity(0.25)).frame(width: 12, height: 12))
                .accessibilityHidden(true)
            Text(text)
                .font(.footnote.weight(.semibold))
                .foregroundStyle(OS1VisualStyle.textDim)
        }
    }
}

private struct CardError: View {
    let message: String?

    var body: some View {
        if let message {
            Text(message)
                .font(.footnote)
                .foregroundStyle(OS1VisualStyle.redInk)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isStaticText)
        }
    }
}

/// Buttons trailing on one line, stacked when the line is too narrow (a phone
/// with three keychain choices).
private struct CardButtons<Content: View>: View {
    @ViewBuilder let content: () -> Content

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 8) {
                Spacer(minLength: 0)
                content()
            }
            VStack(alignment: .trailing, spacing: 8) {
                content()
            }
            .frame(maxWidth: .infinity, alignment: .trailing)
        }
        .controlSize(.regular)
    }
}

private func describe(_ error: Error, fallback: String) -> String {
    (error as? LocalizedError)?.errorDescription ?? fallback
}

@MainActor private var agentName: String { InstanceIdentity.shared.personaName }

// MARK: - Credential registration

/// The agent asked the person driving this session to add a credential.
/// Every viewer sees the card; only the driver, as the server decides, gets
/// the field, because the credential will be theirs. The secret goes straight
/// to the keychain over HTTP and is never shown to the agent.
private struct CredentialRegistrationCard: View {
    let model: SessionActionCardsModel
    let pending: PendingCredentialRegistration

    @State private var secret = ""
    @State private var busy = false
    @State private var error: String?
    @FocusState private var fieldFocused: Bool

    private var request: CredentialRegistrationRequest { pending.request }
    private var canSave: Bool {
        !busy && !secret.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            CardHeader(text: request.isLogin
                ? "\(agentName) wants to add a login to the keychain"
                : "\(agentName) wants to add a credential to the keychain")

            VStack(alignment: .leading, spacing: 4) {
                Group {
                    if request.isLogin {
                        Text("\(Text(request.service).fontWeight(.semibold)): \(request.username ?? "") on \(request.loginUrl ?? "")")
                    } else {
                        Text("\(Text(request.service).fontWeight(.semibold)) for \(request.host)")
                    }
                }
                .font(.subheadline)
                .foregroundStyle(OS1VisualStyle.text)
                if let description = request.description, !description.isEmpty {
                    Text(description)
                        .font(.footnote)
                        .foregroundStyle(OS1VisualStyle.textDim)
                }
                if let limits = request.limits {
                    Text("Limited to \(limits)")
                        .font(.caption)
                        .foregroundStyle(OS1VisualStyle.textDim)
                }
                Text(permissionLine)
                    .font(.caption)
                    .foregroundStyle(OS1VisualStyle.textFaint)
            }
            .fixedSize(horizontal: false, vertical: true)

            if pending.canAnswer {
                SecureField(
                    request.isLogin ? "Paste the password" : "Paste the secret",
                    text: $secret
                )
                .accessibilityLabel(request.isLogin ? "Password" : "Secret")
                .textFieldStyle(.plain)
                .autocorrectionDisabled()
                #if os(iOS)
                .textInputAutocapitalization(.never)
                #endif
                .focused($fieldFocused)
                .disabled(busy)
                .onSubmit { if canSave { Task { await submit(decline: false) } } }
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
                .background(
                    OS1VisualStyle.background,
                    in: RoundedRectangle(cornerRadius: 10, style: .continuous)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .stroke(OS1VisualStyle.border, lineWidth: 0.5)
                )

                CardError(message: error)

                CardButtons {
                    Button("Decline") { Task { await submit(decline: true) } }
                        .buttonStyle(.bordered)
                        .disabled(busy)
                    Button("Save to keychain") { Task { await submit(decline: false) } }
                        .buttonStyle(.borderedProminent)
                        .disabled(!canSave)
                }
            }
        }
        .actionCardShell()
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Credential request")
    }

    private var permissionLine: String {
        if !pending.canAnswer {
            return "Waiting for \(request.owner) to add the \(request.isLogin ? "password" : "secret")."
        }
        if request.isLogin {
            return "Owned by you. Each time a session asks, you decide whether to release the password to it, and \(agentName) can read it then. Use a test account."
        }
        return "Owned by you. Teammates' sessions must ask you before using it. \(agentName) never sees the secret."
    }

    private func submit(decline: Bool) async {
        if !decline && !canSave { return }
        busy = true
        error = nil
        do {
            if decline {
                try await model.declineCredential(request)
            } else {
                try await model.registerCredential(request, secret: secret)
                Haptics.play(.commit)
            }
            secret = ""
        } catch {
            busy = false
            self.error = describe(error, fallback: "Couldn't save the credential")
        }
    }
}

// MARK: - Keychain ask

/// A keychain ask this session made for a credential the viewer owns. Only
/// the verified owner ever receives one from the server, and the answer goes
/// through the same owner-checked route as Settings.
private struct KeychainAskCard: View {
    let model: SessionActionCardsModel
    let ask: SessionKeychainAsk

    @State private var busy: SessionKeychainAsk.Decision?
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            CardHeader(text: ask.headline(agent: agentName))

            VStack(alignment: .leading, spacing: 4) {
                ForEach(Array(ask.credentials.enumerated()), id: \.offset) { _, credential in
                    Group {
                        if credential.kind == "login" {
                            Text("\(Text(credential.service).fontWeight(.semibold)): \(credential.username ?? "") on \(credential.loginUrl ?? "")")
                        } else if !credential.host.isEmpty {
                            Text("\(Text(credential.service).fontWeight(.semibold)) for \(credential.host)")
                        } else {
                            Text(credential.service).fontWeight(.semibold)
                        }
                    }
                    .font(.subheadline)
                    .foregroundStyle(OS1VisualStyle.text)
                }
                if !ask.purpose.isEmpty {
                    Text(ask.purpose)
                        .font(.footnote)
                        .foregroundStyle(OS1VisualStyle.text)
                }
                if let run = ask.run {
                    Text(run.command)
                        .font(.caption.monospaced())
                        .foregroundStyle(OS1VisualStyle.textDim)
                        .textSelection(.enabled)
                }
                Text(ask.askedBy)
                    .font(.caption)
                    .foregroundStyle(OS1VisualStyle.textDim)
            }
            .fixedSize(horizontal: false, vertical: true)

            Text(ask.summary(agent: agentName))
                .font(.caption)
                .foregroundStyle(OS1VisualStyle.textFaint)
                .fixedSize(horizontal: false, vertical: true)

            CardError(message: error)

            // The mode the agent asked for is the primary choice.
            CardButtons {
                Button("Decline") { Task { await submit(.decline) } }
                    .buttonStyle(.bordered)
                ForEach(Array(ask.choices.enumerated()), id: \.offset) { index, choice in
                    if index == ask.choices.count - 1 {
                        Button(choice.label) { Task { await submit(choice.decision) } }
                            .buttonStyle(.borderedProminent)
                    } else {
                        Button(choice.label) { Task { await submit(choice.decision) } }
                            .buttonStyle(.bordered)
                    }
                }
            }
            .disabled(busy != nil)
        }
        .actionCardShell()
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Keychain request")
    }

    private func submit(_ decision: SessionKeychainAsk.Decision) async {
        busy = decision
        error = nil
        do {
            try await model.answer(ask, decision: decision)
            Haptics.play(decision == .decline ? .selection : .commit)
        } catch {
            busy = nil
            self.error = describe(error, fallback: "Couldn't answer the request")
        }
    }
}

// MARK: - Force merge

/// The agent asked the driver to force merge a pull request. Everything but
/// the reason was read from GitHub by the server. Every viewer may cancel;
/// only the driver can confirm, and the merge runs as them.
private struct ForceMergeCard: View {
    let model: SessionActionCardsModel
    let pending: PendingForceMerge

    @State private var busy: String?
    @State private var error: String?
    @State private var confirming = false

    private var request: ForceMergeRequest { pending.request }

    /// "acme/app#12", a link to the PR when the server sent its URL.
    private var pullRequestName: AttributedString {
        var name = AttributedString("\(request.ghRepo)#\(request.number)")
        if let url = request.url.flatMap(URL.init(string:)) { name.link = url }
        return name
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            CardHeader(
                text: "\(agentName) wants to force merge a pull request",
                tint: OS1VisualStyle.red
            )

            VStack(alignment: .leading, spacing: 4) {
                Text("\(Text(pullRequestName).fontWeight(.semibold)) \(request.title)")
                .font(.subheadline)
                .foregroundStyle(OS1VisualStyle.text)
                .tint(OS1VisualStyle.text)
                Text("\(request.head) into \(request.base) · \(request.method)")
                    .font(.caption)
                    .foregroundStyle(OS1VisualStyle.textDim)
                Text("Head \(request.headSha)")
                    .font(.caption.monospaced())
                    .foregroundStyle(OS1VisualStyle.textDim)
                    .textSelection(.enabled)
            }
            .fixedSize(horizontal: false, vertical: true)

            VStack(alignment: .leading, spacing: 6) {
                Text(request.bypass.isEmpty ? "Nothing to bypass" : "Bypasses")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(OS1VisualStyle.textDim)
                ForEach(Array(request.bypass.enumerated()), id: \.offset) { _, bypass in
                    HStack(alignment: .top, spacing: 8) {
                        Circle()
                            .fill(OS1VisualStyle.red)
                            .frame(width: 6, height: 6)
                            .padding(.top, 6)
                            .accessibilityHidden(true)
                        Text(bypass.label)
                            .font(.footnote)
                            .foregroundStyle(OS1VisualStyle.text)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }

            VStack(alignment: .leading, spacing: 4) {
                Text("Reason")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(OS1VisualStyle.textDim)
                Text(request.reason)
                    .font(.footnote)
                    .foregroundStyle(OS1VisualStyle.text)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Text(pending.canConfirm
                ? "Merges with your GitHub account at this exact commit. A push before it lands cancels the merge. A comment on the PR records the reason."
                : "Waiting for \(request.driver) to confirm.")
                .font(.caption)
                .foregroundStyle(OS1VisualStyle.textFaint)
                .fixedSize(horizontal: false, vertical: true)

            CardError(message: error)

            CardButtons {
                Button("Cancel") { Task { await submit("cancel") } }
                    .buttonStyle(.bordered)
                if pending.canConfirm {
                    Button(busy == "confirm" ? "Merging…" : "Merge anyway", role: .destructive) {
                        confirming = true
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(OS1VisualStyle.red)
                }
            }
            .disabled(busy != nil)
        }
        .actionCardShell()
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Force merge request")
        .confirmationDialog(
            "Force merge \(request.ghRepo)#\(request.number)?",
            isPresented: $confirming,
            titleVisibility: .visible
        ) {
            Button("Merge anyway", role: .destructive) { Task { await submit("confirm") } }
            Button("Not now", role: .cancel) {}
        } message: {
            Text("This bypasses the branch rules listed on the card.")
        }
    }

    private func submit(_ action: String) async {
        busy = action
        error = nil
        do {
            if action == "confirm" {
                try await model.confirmForceMerge(request)
                Haptics.play(.commit)
            } else {
                try await model.cancelForceMerge(request)
            }
        } catch {
            busy = nil
            self.error = describe(error, fallback: "Couldn't answer the force merge")
        }
    }
}

// MARK: - Script runs

/// One supervised script run (start_script, run_with_credential). Runs keep
/// going through server restarts, so the card follows the server's registry.
private struct ScriptRunCard: View {
    let model: SessionActionCardsModel
    let run: ScriptRun

    @State private var showOutput = false
    @State private var confirmingStop = false
    @State private var confirmingClose = false
    @State private var error: String?

    var body: some View {
        let outcome = run.outcome
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                switch outcome.tone {
                case .running:
                    PulsingDot(color: OS1VisualStyle.green, size: 8)
                case .ok:
                    Circle().fill(OS1VisualStyle.green).frame(width: 8, height: 8)
                case .bad:
                    Circle().fill(OS1VisualStyle.red).frame(width: 8, height: 8)
                case .quiet:
                    Circle().fill(OS1VisualStyle.textFaint).frame(width: 8, height: 8)
                }
                Text(run.title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(OS1VisualStyle.text)
                    .lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if run.isRunning, let startedAt = run.startedAt {
                    TimelineView(.periodic(from: .now, by: 1)) { context in
                        Text(ScriptRun.duration(context.date.timeIntervalSince(startedAt)))
                            .font(.caption.monospacedDigit())
                            .foregroundStyle(OS1VisualStyle.textDim)
                    }
                }
                Button(action: close) {
                    Image(systemName: "xmark")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(OS1VisualStyle.textDim)
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .padding(-14)
                .accessibilityLabel("Close")
                .accessibilityHint(run.canStop
                    ? "Asks whether to stop the script too"
                    : "Hides this card on this device")
                .help("Close")
            }

            Text(statusLine(outcome.text))
                .font(.footnote)
                .foregroundStyle(OS1VisualStyle.textDim)
                .fixedSize(horizontal: false, vertical: true)

            ForEach(run.credentials) { credential in
                HStack(alignment: .firstTextBaseline) {
                    Text(credential.service).lineLimit(1)
                    Spacer(minLength: 12)
                    Text(callsLine(credential)).monospacedDigit()
                }
                .font(.caption)
                .foregroundStyle(OS1VisualStyle.textDim)
            }

            HStack {
                Button {
                    withAnimation(.snappy(duration: 0.2)) { showOutput.toggle() }
                } label: {
                    Label(showOutput ? "Hide output" : "Output",
                          systemImage: showOutput ? "chevron.down" : "chevron.right")
                        .font(.footnote.weight(.medium))
                }
                .buttonStyle(.plain)
                .foregroundStyle(OS1VisualStyle.link)
                .accessibilityValue(showOutput ? "Expanded" : "Collapsed")
                Spacer()
                if run.canStop {
                    Button("Stop", role: .destructive) { confirmingStop = true }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                }
            }

            if showOutput {
                ScriptOutputView(model: model, run: run)
            }

            CardError(message: error)
        }
        .actionCardShell()
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Script: \(run.title)")
        .confirmationDialog("Stop this script?", isPresented: $confirmingStop, titleVisibility: .visible) {
            Button("Stop", role: .destructive) { Task { await stop() } }
            Button("Keep running", role: .cancel) {}
        } message: {
            Text("It's asked to stop now and killed after 10 seconds. Work it already did stays done.")
        }
        .confirmationDialog("Close this card?", isPresented: $confirmingClose, titleVisibility: .visible) {
            Button("Hide and keep running") { model.hideScriptRun(run) }
            Button("Hide and stop", role: .destructive) { Task { await hideAndStop() } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("The script is still running. Hide the card and let it finish, or stop it too.")
        }
        #if DEBUG
        .task {
            // After the window settles: a dialog asked for mid-layout is dropped.
            guard model.fixtureConfirmCloseRunId == run.id else { return }
            try? await Task.sleep(for: .seconds(2))
            confirmingClose = true
        }
        #endif
    }

    /// An ended card closes at once. A running one asks first, since closing
    /// it could mean either "out of my way" or "I'm done with this script".
    private func close() {
        if run.canStop { confirmingClose = true } else { model.hideScriptRun(run) }
    }

    private func statusLine(_ text: String) -> String {
        var line = text
        if run.canStop, let deadline = run.deadline {
            line += " · stops by \(deadline.formatted(date: .omitted, time: .shortened))"
        }
        if !run.isRunning, let error = run.error, !error.isEmpty { line += " · \(error)" }
        return line
    }

    private func callsLine(_ credential: ScriptRun.CredentialUse) -> String {
        var line = credential.calls == 1 ? "1 call" : "\(credential.calls.formatted()) calls"
        if credential.denied > 0 { line += " · \(credential.denied.formatted()) refused" }
        return line
    }

    private func stop() async {
        error = nil
        do {
            try await model.stopScript(run)
            Haptics.play(.stop)
        } catch {
            self.error = "Couldn't stop: \(describe(error, fallback: "try again."))"
        }
    }

    /// The card stays up when the stop is refused, showing why.
    private func hideAndStop() async {
        error = nil
        do {
            try await model.hideAndStopScript(run)
            Haptics.play(.stop)
        } catch {
            self.error = "Couldn't stop: \(describe(error, fallback: "try again."))"
        }
    }
}

/// The end of the log, refreshed every 3 seconds while the run is going.
/// Mounted only while Output is open.
private struct ScriptOutputView: View {
    let model: SessionActionCardsModel
    let run: ScriptRun

    @State private var output: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ScrollView {
                Text(display)
                    .font(.caption.monospaced())
                    .foregroundStyle(OS1VisualStyle.codeWellText)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(10)
            }
            .defaultScrollAnchor(.bottom)
            .frame(maxHeight: 220)
            .background(
                OS1VisualStyle.codeWell,
                in: RoundedRectangle(cornerRadius: 10, style: .continuous)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .stroke(OS1VisualStyle.codeWellBorder, lineWidth: 0.5)
            )
            if !run.command.isEmpty {
                Text(run.command)
                    .font(.caption2.monospaced())
                    .foregroundStyle(OS1VisualStyle.textFaint)
                    .textSelection(.enabled)
            }
        }
        .task(id: "\(run.id)-\(run.isRunning)") {
            repeat {
                if let loaded = try? await model.scriptOutput(run) { output = loaded }
                guard run.isRunning else { break }
                try? await Task.sleep(for: .seconds(3))
            } while !Task.isCancelled
        }
    }

    private var display: String {
        guard let output else { return "Loading…" }
        return output.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            ? "No output yet." : output
    }
}

// MARK: - You should know

/// What a You should know note in the transcript can do. Carries the view
/// model so the row reads card state in its own body, not the transcript's.
struct YouShouldKnowAction {
    let viewModel: SessionViewModel
}

/// A You should know note with its answers: Learn more opens the
/// explanation, Ask about this quotes the note under the draft, I knew this
/// tells later checks to skip the topic, and Turn off, pressed twice, switches
/// the side agent off for this person (Settings → Preferences turns it back on).
struct YouShouldKnowNoticeView: View {
    let entry: TranscriptEntry
    let note: YouShouldKnowNote
    let state: TurnFoldState
    let action: YouShouldKnowAction

    @State private var offArmed = false

    private var cards: SessionActionCardsModel { action.viewModel.actionCards }
    private var known: Bool { cards.knownYouShouldKnow.contains(note.line) }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(note.tag)
                .font(.caption.weight(.medium))
                .foregroundStyle(OS1VisualStyle.textFaint)
            Text(note.line)
                .font(.subheadline)
                .foregroundStyle(OS1VisualStyle.text)
                .fixedSize(horizontal: false, vertical: true)
            if state.expanded, !note.explanation.isEmpty {
                MarkdownBody(note.explanation)
                    .padding(.top, 6)
            }
            buttons.padding(.top, 6)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .frame(maxWidth: 560, alignment: .leading)
        .background(
            OS1VisualStyle.chipFill,
            in: RoundedRectangle(cornerRadius: 12, style: .continuous)
        )
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(note.tag)
        .task(id: offArmed) {
            // The second press has to follow the first; a pause disarms it,
            // the way leaving the button does on the web.
            guard offArmed else { return }
            try? await Task.sleep(for: .seconds(4))
            if !Task.isCancelled { offArmed = false }
        }
    }

    private var buttons: some View {
        HStack(spacing: 6) {
            if !note.explanation.isEmpty {
                Button(state.expanded ? "Hide" : "Learn more") {
                    withAnimation(.snappy(duration: 0.2)) { state.toggle() }
                }
                .buttonStyle(.bordered)
                .accessibilityValue(state.expanded ? "Expanded" : "Collapsed")
            }
            Button("Ask about this") { askAbout() }
                .buttonStyle(.bordered)
            if !known {
                Button("I knew this") { remember(quiet: false) }
                    .buttonStyle(.borderless)
            }
            Spacer(minLength: 0)
            if !cards.youShouldKnowOff {
                Button(offArmed ? "Press again to turn off" : "Turn off") { turnOff() }
                    .buttonStyle(.borderless)
                    .foregroundStyle(offArmed ? OS1VisualStyle.redInk : OS1VisualStyle.textFaint)
            }
        }
        .font(.footnote)
        .controlSize(.small)
        .lineLimit(1)
    }

    /// As in the plugin, asking about a note also counts as having seen it.
    private func askAbout() {
        action.viewModel.appendQuotedDraft(note.chatText)
        if !known { remember(quiet: true) }
    }

    private func remember(quiet: Bool) {
        Task {
            do {
                try await cards.rememberYouShouldKnow(note)
            } catch {
                if !quiet { action.viewModel.showNotice(describe(error, fallback: "Failed to save")) }
            }
        }
    }

    private func turnOff() {
        guard offArmed else {
            offArmed = true
            Haptics.play(.armed)
            return
        }
        Task {
            do {
                try await cards.turnOffYouShouldKnow()
                action.viewModel.showNotice("You should know is off. Turn it back on in Settings.")
            } catch {
                offArmed = false
                action.viewModel.showNotice(
                    describe(error, fallback: "Failed to turn off You should know")
                )
            }
        }
    }
}
