import SwiftUI

#if os(iOS)
/// What this session sent a batch of agents off to do, one level deeper than
/// the conversation.
///
/// A workflow run is a script that fanned work out — twenty tickets
/// classified, five pull requests read — and collected what came back. The
/// conversation only shows that it happened; the answers are here.
///
/// Three levels, each one answering what the level above hides: the run list
/// says which runs there were and how they ended, a run says which agents it
/// called and what they came back with, and an agent opens its own
/// conversation. Nothing on this screen starts a run: workflows are written
/// as scripts and started from the tools, and a phone is where you find out
/// what they did.
///
/// The web panel's narrator log, its tail of direct tool calls, and its write
/// agents' branch chips are all absent. Measured across every run this server
/// has stored, a log line appears in 36 runs of 248, a tool call in 6, and a
/// write agent in 2 — reference detail on the rare run that has it, and a
/// column of empty space on the rest.
struct WorkflowRunsView: View {
    let viewModel: SessionViewModel

    private var sessionId: String { viewModel.session.id }
    private var runs: [WorkflowRun] { viewModel.workflowRuns }
    /// A run waiting for a yes before it is stopped.
    @State private var confirmingCancel: WorkflowRun?
    @State private var failure: String?

    /// Any run still going. While one is, the list re-reads itself, because
    /// a phase and an agent count that stand still look the same as a run
    /// that has quietly died.
    private var hasLiveRun: Bool { runs.contains { $0.status.isRunning } }

    var body: some View {
        Group {
            if !viewModel.workflowRunsLoaded && runs.isEmpty {
                ProgressView()
                    .controlSize(.large)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if viewModel.workflowLoadFailed && runs.isEmpty {
                failedPlaceholder
            } else if runs.isEmpty {
                emptyPlaceholder
            } else {
                runList
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(OS1VisualStyle.background)
        .navigationTitle("Agents")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    Task { await load() }
                } label: {
                    Label("Refresh", systemImage: "arrow.clockwise")
                }
            }
        }
        .confirmationDialog(
            "Stop this run?",
            isPresented: Binding(
                get: { confirmingCancel != nil },
                set: { if !$0 { confirmingCancel = nil } }
            ),
            titleVisibility: .visible,
            presenting: confirmingCancel
        ) { run in
            Button("Stop", role: .destructive) {
                Task { await cancel(run) }
            }
            Button("Cancel", role: .cancel) {}
        } message: { run in
            Text("Agents still working on “\(run.name)” are cancelled. What has already finished is kept.")
        }
        .alert(
            "Couldn't stop the run",
            isPresented: Binding(
                get: { failure != nil },
                set: { if !$0 { failure = nil } }
            ),
            presenting: failure
        ) { _ in
            Button("OK", role: .cancel) {}
        } message: { message in
            Text(message)
        }
        .task(id: sessionId) {
            await load()
            // Only while something is live: a finished list never changes,
            // and a screen that keeps asking anyway is a battery cost with
            // nothing to show for it.
            while !Task.isCancelled, hasLiveRun {
                try? await Task.sleep(for: .seconds(3))
                guard !Task.isCancelled else { return }
                await load()
            }
        }
    }

    private var runList: some View {
        List {
            Section {
                ForEach(runs) { run in
                    NavigationLink(value: WorkflowRunRoute(run: run)) {
                        WorkflowRunRow(run: run)
                    }
                    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                        if run.canCancel {
                            Button(role: .destructive) {
                                confirmingCancel = run
                            } label: {
                                Label("Stop", systemImage: "stop.fill")
                            }
                        }
                    }
                }
            } footer: {
                Text(footerText)
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(OS1VisualStyle.background)
        .refreshable { await load() }
        .navigationDestination(for: WorkflowRunRoute.self) { route in
            WorkflowRunDetailView(run: liveRun(route.run))
        }
        .navigationDestination(for: WorkflowAgentRoute.self) { route in
            WorkflowAgentTranscriptView(
                runId: route.runId,
                seq: route.seq,
                title: route.label,
                sessionId: sessionId,
                keepsPolling: route.running
            )
        }
    }

    /// The pushed run, kept in step with the poll. A route carries a snapshot
    /// taken when the row was tapped; a live run's agents keep arriving, and
    /// the detail behind the push should show them.
    private func liveRun(_ pushed: WorkflowRun) -> WorkflowRun {
        runs.first { $0.runId == pushed.runId } ?? pushed
    }

    private var footerText: String {
        let live = runs.filter { $0.status.isRunning }.count
        if live > 0 {
            return "Swipe a running one to stop it. Open a run to read what each agent came back with."
        }
        return "Open a run to read what each agent came back with."
    }

    private var emptyPlaceholder: some View {
        ListPlaceholder(
            symbol: "square.stack.3d.up",
            title: "No agent runs",
            message: "When this session fans work out across a batch of agents, "
                + "each run and what it found shows up here."
        ) {
            EmptyView()
        }
    }

    private var failedPlaceholder: some View {
        ListPlaceholder(
            symbol: "exclamationmark.triangle",
            title: "Couldn't load agent runs",
            message: "The server didn't answer for this session's runs."
        ) {
            Button("Try again") { Task { await load() } }
                .buttonStyle(PlaceholderActionStyle())
        }
    }

    private func load() async {
        await viewModel.refreshWorkflowRuns()
    }

    private func cancel(_ run: WorkflowRun) async {
        do {
            let stopped = try await OS1API.cancelWorkflow(runId: run.runId)
            if !stopped {
                failure = "This run had already finished."
            }
            await load()
        } catch {
            failure = error.localizedDescription
        }
    }
}

/// A run pushed from the list. Its own type rather than the run itself, so
/// the two destinations on this stack stay distinguishable.
private struct WorkflowRunRoute: Hashable {
    let run: WorkflowRun
}

/// One agent's conversation, pushed from a run.
private struct WorkflowAgentRoute: Hashable {
    let runId: String
    let seq: Int
    let label: String
    let running: Bool
}

/// A run in the list: what it was, where it got to, and when.
private struct WorkflowRunRow: View {
    let run: WorkflowRun

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            WorkflowStatusMark(status: run.status)
                .padding(.top, 3)
            VStack(alignment: .leading, spacing: 3) {
                Text(run.name)
                    .font(.callout.weight(.medium))
                    .foregroundStyle(OS1VisualStyle.text)
                    .lineLimit(1)
                Text(run.progressLine)
                    .font(.footnote)
                    .foregroundStyle(OS1VisualStyle.textDim)
                    .lineLimit(2)
                if let started = run.started {
                    Text(started, format: .relative(presentation: .named))
                        .font(.caption)
                        .foregroundStyle(OS1VisualStyle.textFaint)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 3)
    }
}

/// The status glyph both the run list and the agent list use, so a run and
/// the agents inside it read as the same vocabulary.
private struct WorkflowStatusMark: View {
    let status: WorkflowRunStatus

    var body: some View {
        switch status {
        case .running:
            PulsingDot(color: OS1VisualStyle.yellow, size: 8)
        case .done:
            Image(systemName: "checkmark.circle.fill")
                .font(.footnote)
                .foregroundStyle(OS1VisualStyle.green)
        case .error:
            Image(systemName: "xmark.circle.fill")
                .font(.footnote)
                .foregroundStyle(OS1VisualStyle.red)
        case .cancelled, .interrupted, .unknown:
            Image(systemName: "circle.dashed")
                .font(.footnote)
                .foregroundStyle(OS1VisualStyle.textFaint)
        }
    }
}

private struct WorkflowAgentStatusMark: View {
    let status: WorkflowAgentStatus

    var body: some View {
        switch status {
        case .running:
            PulsingDot(color: OS1VisualStyle.yellow, size: 8)
        case .done:
            Image(systemName: "checkmark.circle.fill")
                .font(.footnote)
                .foregroundStyle(OS1VisualStyle.green)
        case .error:
            Image(systemName: "xmark.circle.fill")
                .font(.footnote)
                .foregroundStyle(OS1VisualStyle.red)
        case .pending, .cancelled, .unknown:
            Image(systemName: "circle.dashed")
                .font(.footnote)
                .foregroundStyle(OS1VisualStyle.textFaint)
        }
    }
}

/// One run: its agents, in the phases the script announced.
///
/// The phase sections are the whole reason this is a screen rather than a
/// longer row. A digest run is twenty agents, and read as one flat list that
/// is a wall; read as "Classify, Cluster, Write" it is three things that
/// happened, and the failure is in one of them.
private struct WorkflowRunDetailView: View {
    let run: WorkflowRun

    var body: some View {
        Group {
            if run.agents.isEmpty {
                ListPlaceholder(
                    symbol: "square.stack.3d.up.slash",
                    title: "No agents ran",
                    message: run.error ?? "This run ended before it called anything."
                ) {
                    EmptyView()
                }
            } else {
                agentList
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(OS1VisualStyle.background)
        .navigationTitle(run.name)
        .navigationBarTitleDisplayMode(.inline)
    }

    private var agentList: some View {
        List {
            if let error = run.error, !error.isEmpty {
                Section {
                    Text(error)
                        .font(.footnote)
                        .foregroundStyle(OS1VisualStyle.textDim)
                } header: {
                    Text("The run failed")
                }
            }
            ForEach(run.groupedAgents) { group in
                Section {
                    ForEach(group.agents) { agent in
                        agentRow(agent)
                    }
                } header: {
                    if let title = group.title {
                        Text(title)
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(OS1VisualStyle.background)
    }

    @ViewBuilder
    private func agentRow(_ agent: WorkflowAgent) -> some View {
        if agent.hasConversation {
            NavigationLink(
                value: WorkflowAgentRoute(
                    runId: run.runId,
                    seq: agent.seq,
                    label: agent.label,
                    running: agent.status.isRunning
                )
            ) {
                WorkflowAgentRow(agent: agent)
            }
        } else {
            WorkflowAgentRow(agent: agent)
        }
    }
}

/// One agent: what it was asked to be, how it ended, and the first of what it
/// said. The prompt it was given is not here — it is the same paragraph on
/// every row of a fan-out, and the answer is what differs.
private struct WorkflowAgentRow: View {
    let agent: WorkflowAgent

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            WorkflowAgentStatusMark(status: agent.status)
                .padding(.top, 3)
            VStack(alignment: .leading, spacing: 3) {
                Text(agent.label)
                    .font(.callout.weight(.medium))
                    .foregroundStyle(OS1VisualStyle.text)
                    .lineLimit(2)
                if !agent.detail.isEmpty {
                    Text(agent.detail)
                        .font(.caption)
                        .foregroundStyle(OS1VisualStyle.textFaint)
                        .lineLimit(1)
                }
                if let outcome = agent.outcomeLine {
                    Text(outcome)
                        .font(.footnote)
                        // Not painted red. The status palette is calibrated
                        // for marks rather than words, and the row already
                        // carries a red glyph saying this one failed.
                        .foregroundStyle(OS1VisualStyle.textDim)
                        .lineLimit(3)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 3)
    }
}

/// One workflow agent's own conversation, rendered through the same grouping
/// and rows as the session it belongs to — so a fan-out worker's tool calls
/// fold and read exactly like everything else in this app.
private struct WorkflowAgentTranscriptView: View {
    let runId: String
    let seq: Int
    let title: String
    /// The parent session, for the tool rows that resolve a path against it.
    let sessionId: String
    /// A live agent keeps writing; a finished one is read once.
    let keepsPolling: Bool

    @AppStorage("os1.appearance.turnActivity") private var turnWork = "running"
    @AppStorage("os1.appearance.toolCalls") private var toolCalls = "folded"
    @AppStorage(ThinkingMessages.storageKey) private var thinkingMessages = "latest"
    private var turnActivity: TurnActivity {
        TurnActivity(work: turnWork, tools: toolCalls)
    }

    @State private var blocks: [TranscriptBlock] = []
    @State private var loaded = false
    @State private var failed = false
    /// This agent's folds are its own.
    @State private var folds = FoldStateStore()

    var body: some View {
        Group {
            if !loaded && !failed {
                ProgressView()
                    .controlSize(.large)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if failed {
                ListPlaceholder(
                    symbol: "exclamationmark.triangle",
                    title: "Couldn't load this agent",
                    message: "The server didn't answer for its conversation."
                ) {
                    Button("Try again") { Task { await load() } }
                        .buttonStyle(PlaceholderActionStyle())
                }
            } else if blocks.isEmpty {
                ListPlaceholder(
                    symbol: "text.bubble",
                    title: "Nothing yet",
                    message: "This agent has not produced any output."
                ) {
                    EmptyView()
                }
            } else {
                transcript
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(OS1VisualStyle.background)
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .task(id: "\(seq):\(thinkingMessages)") {
            await load()
            while !Task.isCancelled, keepsPolling {
                try? await Task.sleep(for: .seconds(2))
                guard !Task.isCancelled else { return }
                await load()
            }
        }
    }

    private var transcript: some View {
        ScrollView {
            LazyVStack(spacing: 10) {
                ForEach(blocks) { block in
                    TranscriptRow(
                        block: block,
                        sessionId: sessionId,
                        worktreeDir: nil,
                        foldState: { folds.fold(for: $0, preference: turnActivity) },
                        expansionState: { folds.expansion(id: $0, defaultExpanded: $1) },
                        activity: turnActivity,
                        isActiveReasoning: keepsPolling && block.id == blocks.last?.id
                    )
                    .id(block.id)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .frame(maxWidth: OS1VisualStyle.sessionMaxWidth)
            .frame(maxWidth: .infinity)
        }
        .defaultScrollAnchor(.top)
    }

    private func load() async {
        do {
            let transcript = try await OS1API.workflowAgentTranscript(runId: runId, seq: seq)
            guard !Task.isCancelled else { return }
            let next = TranscriptGrouping.blocks(
                from: TranscriptGrouping.displayItems(from: transcript.entries),
                live: keepsPolling,
                worktreeDir: nil,
                thinkingMessages: ThinkingMessages(thinkingMessages)
            )
            if next != blocks { blocks = next }
            loaded = true
            failed = false
        } catch {
            if !loaded { failed = true }
        }
    }
}
#endif
