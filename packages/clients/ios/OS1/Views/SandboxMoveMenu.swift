import SwiftUI

/// The rows that move a host session into a Sandbox: one per Ready provider,
/// after the composer's own list. Mounted inside the iOS overflow menu's
/// "Move to Sandbox" submenu and the Mac toolbar's menu, so the two cannot
/// drift; the worktree details sheet draws the same choices as full rows.
///
/// A bare `Text` in a menu is a disabled row, which is what the waiting and
/// empty states want to be: readable, not tappable.
struct SandboxMoveMenuItems: View {
    let model: SandboxMoveViewModel
    let session: Session
    /// The server refuses a move while the agent runs; the rows say so
    /// instead of disappearing.
    let isRunning: Bool
    let onMoved: (SessionSandboxStatus) -> Void

    var body: some View {
        if let providers = model.providers {
            if providers.isEmpty {
                Text(SandboxMoveCopy.noneReady)
            } else {
                ForEach(providers, id: \.self) { provider in
                    Button {
                        Task {
                            if let status = await model.move(sessionId: session.id, to: provider) {
                                onMoved(status)
                            }
                        }
                    } label: {
                        Label(
                            SandboxMoveCopy.action(provider, working: model.working == provider),
                            systemImage: "cube"
                        )
                    }
                    .disabled(model.working != nil || model.hasMoved(session) || isRunning)
                }
                if isRunning {
                    Text(SandboxMoveCopy.waitForAgent)
                }
            }
        } else {
            Text(SandboxMoveCopy.checking)
        }
    }
}

/// The sentences every surface shares, so a phone, a Mac and the sheet say
/// the same thing about the same move.
enum SandboxMoveCopy {
    static let checking = "Checking Sandboxes…"
    static let noneReady = "No Sandbox is ready. Connect Daytona or Box in Settings > Sandboxes."
    static let waitForAgent = "Available once the agent finishes."
    static let explanation =
        "The Sandbox starts now, clones this branch from origin, and takes over on the next message. Portals on this machine stop."

    static func action(_ provider: String, working: Bool) -> String {
        let name = SandboxOffering.label(provider)
        return working ? "Moving to \(name)…" : "Move to \(name)"
    }
}

extension View {
    /// The two prompts a move can raise: the server's 428 (unpushed work
    /// stays behind; move anyway?) and a refusal. Attach to the view that
    /// hosts the rows, since rows inside a menu cannot present anything.
    func sandboxMovePrompts(
        _ model: SandboxMoveViewModel,
        onMoved: @escaping (SessionSandboxStatus) -> Void
    ) -> some View {
        modifier(SandboxMovePrompts(model: model, onMoved: onMoved))
    }
}

private struct SandboxMovePrompts: ViewModifier {
    @Bindable var model: SandboxMoveViewModel
    let onMoved: (SessionSandboxStatus) -> Void

    func body(content: Content) -> some View {
        content
            .confirmationDialog(
                model.confirmation.map { "Move to \(SandboxOffering.label($0.provider)) anyway?" }
                    ?? "Move anyway?",
                isPresented: Binding(
                    get: { model.confirmation != nil },
                    set: { if !$0 { model.confirmation = nil } }
                ),
                titleVisibility: .visible,
                presenting: model.confirmation
            ) { confirmation in
                Button("Move anyway") {
                    Task {
                        if let status = await model.move(
                            sessionId: confirmation.sessionId,
                            to: confirmation.provider,
                            confirm: true
                        ) {
                            onMoved(status)
                        }
                    }
                }
                Button("Cancel", role: .cancel) { model.confirmation = nil }
            } message: { confirmation in
                Text(confirmation.message)
            }
            .alert(
                "Couldn't move to a Sandbox",
                isPresented: Binding(
                    get: { model.error != nil },
                    set: { if !$0 { model.error = nil } }
                )
            ) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(model.error ?? "Please try again.")
            }
    }
}

#if os(macOS)
/// The Mac's way in: a toolbar menu beside the model settings, shown only
/// for a session the server would let move. The Mac has no overflow menu and
/// no worktree details sheet, so this is where the move lives there.
struct SandboxMoveToolbarMenu: View {
    let viewModel: SessionViewModel
    @State private var model = SandboxMoveViewModel()

    var body: some View {
        Menu {
            SandboxMoveMenuItems(
                model: model,
                session: viewModel.session,
                isRunning: viewModel.isRunning,
                onMoved: adopt
            )
        } label: {
            Image(systemName: "cube")
        }
        .help("Move this session into a Sandbox")
        .accessibilityLabel("Move to Sandbox")
        .sandboxMovePrompts(model, onMoved: adopt)
        .task(id: viewModel.session.id) {
            await model.loadProviders()
            #if DEBUG
            // The capture tool cannot open a menu; `OS1_SANDBOX_MOVE=<provider>`
            // presses the row for it, and `OS1_SANDBOX_MOVE_CONFIRM=1` the
            // Move anyway that a worktree with unpushed work leads to.
            let env = ProcessInfo.processInfo.environment
            if let provider = env["OS1_SANDBOX_MOVE"], !provider.isEmpty,
               let status = await model.move(
                   sessionId: viewModel.session.id,
                   to: provider,
                   confirm: env["OS1_SANDBOX_MOVE_CONFIRM"] == "1"
               ) {
                adopt(status)
            }
            #endif
        }
    }

    private func adopt(_ status: SessionSandboxStatus) {
        SandboxMoveViewModel.adopt(status, into: viewModel)
    }
}
#endif
