import SwiftUI

/// The machines this instance trusts to run sessions, read-only.
///
/// Connecting a Runner, changing what it may do, and revoking one are
/// deliberately absent: they are workspace setup, they need a pairing
/// command typed on the machine itself, and none of that is what you open a
/// phone for. What you open a phone for is "is my Mac still connected, and
/// where does it keep its workspaces" — so that is what this shows.
///
/// The status word comes from `RunnerStatus`, the same vocabulary the Runner
/// card in a session's workspace details uses.
struct RunnersSettingsView: View {
    @State private var runners: [WorkspaceRunner]? = SettingsCache.value("runners")
    @State private var loading = true
    @State private var error: String?

    var body: some View {
        List {
            // Always rendered, so the task it carries survives the loading row
            // swapping out — the pattern the other settings panes use. No
            // header: the screen is already called Runners, and a section of
            // the same name reads as a second, emptier heading under the first.
            Section {
                Text("Computers your workspace trusts for work that needs their hardware. They are not isolated sandboxes.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if loading, runners == nil {
                    HStack { Spacer(); ProgressView("Loading…"); Spacer() }
                }
                if let error {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(error).foregroundStyle(OS1VisualStyle.red)
                        Button("Retry") { Task { await load() } }
                    }
                }
                if let runners, runners.isEmpty, error == nil {
                    Text("No runners connected.").foregroundStyle(.secondary)
                }
            }
            .task { await load() }

            ForEach(runners ?? []) { runner in
                Section(runner.displayName) { rows(for: runner) }
            }
        }
        .insetGroupedListCompat()
        .navigationTitle("Runners")
        .refreshable { await load() }
    }

    @ViewBuilder
    private func rows(for runner: WorkspaceRunner) -> some View {
        LabeledContent("Status") {
            HStack(spacing: 6) {
                Circle()
                    .fill(dotColor(runner.status))
                    .frame(width: 8, height: 8)
                Text(runner.status.label)
            }
            .accessibilityElement(children: .combine)
        }
        if !runner.hardwareSummary.isEmpty {
            LabeledContent("Machine", value: runner.hardwareSummary)
        }
        if let description = runner.description, !description.isEmpty {
            Text(description).font(.footnote).foregroundStyle(.secondary)
        }
        // A Runner keeps session workspaces under these roots, and the one
        // thing you cannot look up from a phone is where your unpushed work
        // physically lives.
        workspaceRows(runner.workspaceRoots ?? [])
        if let toolchains = runner.capabilities?.toolchains, !toolchains.isEmpty {
            LabeledContent("Toolchains", value: toolchains.joined(separator: " · "))
        }
        if let tags = runner.capabilities?.tags, !tags.isEmpty {
            LabeledContent("Tags", value: tags.joined(separator: " · "))
        }
        if let workload = runner.workloadSummary {
            LabeledContent("Working on", value: workload)
        }
        if let location = runner.location, !location.isEmpty {
            LabeledContent("Location", value: location)
        }
        if let lastSeen = runner.lastSeenAt, let seen = Session.parseISO(lastSeen) {
            LabeledContent("Last seen", value: seen.formatted(.relative(presentation: .named)))
        }
        if let version = runner.softwareVersion, !version.isEmpty {
            LabeledContent("Runner version", value: version)
        }
    }

    @ViewBuilder
    private func workspaceRows(_ roots: [String]) -> some View {
        if roots.isEmpty {
            LabeledContent("Workspace", value: "No workspace root set")
        } else {
            ForEach(Array(roots.enumerated()), id: \.offset) { index, root in
                LabeledContent(index == 0 ? "Workspace" : "") {
                    Text(root)
                        .font(.footnote.monospaced())
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                        .truncationMode(.head)
                }
            }
        }
    }

    /// The web panel's dot: green for a machine you can use, yellow while it is
    /// working or coming up, and grey for one that is not there.
    private func dotColor(_ status: RunnerStatus) -> Color {
        switch status {
        case .ready: OS1VisualStyle.green
        case .busy, .preparing: OS1VisualStyle.yellow
        case .needsAttention: OS1VisualStyle.red
        case .offline, .maintenance: Color.secondary
        }
    }

    private func load() async {
        loading = true
        error = nil
        do {
            let fetched = try await SettingsAPI.runners().runners ?? []
            runners = fetched
            SettingsCache.save("runners", fetched)
        } catch {
            self.error = error.localizedDescription
        }
        loading = false
    }
}
