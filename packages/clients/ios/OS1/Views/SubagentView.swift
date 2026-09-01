import SwiftUI

/// A spawned worker's own transcript, opened from the Task call that started
/// it. Rendered through exactly the same grouping and rows as the main session,
/// so a worker's tool calls fold and read identically.
///
/// Polls while the parent session is still running, since a worker's
/// transcript grows for as long as it is working.
struct SubagentView: View {
    let sessionId: String
    let agentId: String
    let worktreeDir: String?

    @Environment(\.dismiss) private var dismiss
    @AppStorage("os1.appearance.turnActivity") private var turnWork = "running"
    @AppStorage("os1.appearance.toolCalls") private var toolCalls = "folded"
    private var turnActivity: TurnActivity {
        TurnActivity(work: turnWork, tools: toolCalls)
    }

    @State private var transcript: SubagentTranscript?
    @State private var blocks: [TranscriptBlock] = []
    @State private var failed = false
    /// The worker's folds are its own; a fresh store per presentation.
    @State private var folds = FoldStateStore()

    private var isRunning: Bool { transcript?.sessionRunning == true }

    var body: some View {
        NavigationStack {
            Group {
                if let transcript {
                    if blocks.isEmpty {
                        empty("This sub-agent has not produced any output yet.")
                    } else {
                        list(transcript)
                    }
                } else if failed {
                    empty("Couldn't load this sub-agent's transcript.")
                } else {
                    ProgressView().controlSize(.small)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            .background(OS1VisualStyle.background.ignoresSafeArea())
            .navigationTitle(transcript?.title ?? "Sub-agent")
            .inlineTitleBarCompat()
            .toolbar {
                ToolbarItem(placement: .topTrailingCompat) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .task {
            await load()
            // A worker keeps writing while its parent runs; stop as soon as
            // the parent settles rather than polling a finished transcript.
            while !Task.isCancelled, isRunning {
                try? await Task.sleep(for: .seconds(2))
                guard !Task.isCancelled else { return }
                await load()
            }
        }
    }

    private func list(_ transcript: SubagentTranscript) -> some View {
        ScrollView {
            LazyVStack(spacing: 10) {
                if !transcript.subtitle.isEmpty {
                    HStack(spacing: 6) {
                        Image(systemName: "sparkles")
                            .font(.caption2)
                        Text(transcript.subtitle)
                            .font(.footnote)
                        if isRunning {
                            PulsingDot(color: OS1VisualStyle.yellow, size: 6)
                        }
                    }
                    .foregroundStyle(OS1VisualStyle.textDim)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.bottom, 2)
                }
                ForEach(blocks) { block in
                    TranscriptRow(
                        block: block,
                        sessionId: sessionId,
                        worktreeDir: worktreeDir,
                        foldState: { folds.fold(for: $0, preference: turnActivity) },
                        expansionState: { folds.expansion(id: $0, defaultExpanded: $1) },
                        activity: turnActivity,
                        isActiveReasoning: isRunning && block.id == blocks.last?.id
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

    private func empty(_ message: String) -> some View {
        Text(message)
            .font(.footnote)
            .foregroundStyle(OS1VisualStyle.textDim)
            .multilineTextAlignment(.center)
            .padding(24)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func load() async {
        do {
            let loaded = try await OS1API.subagent(
                sessionId: sessionId,
                agentId: agentId
            )
            let entries = loaded.entries ?? []
            let next = TranscriptGrouping.blocks(
                from: TranscriptGrouping.displayItems(from: entries),
                live: loaded.sessionRunning == true,
                worktreeDir: worktreeDir
            )
            transcript = loaded
            if next != blocks { blocks = next }
            failed = false
        } catch {
            if transcript == nil { failed = true }
        }
    }
}
