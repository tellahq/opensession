import SwiftUI

/// Settings → Setup: what's wired up on this instance.
///
/// The phone counterpart of the web's Settings → Setup
/// (src/frontend/components/Setup.tsx), reading the same read-only
/// `/api/setup/status` snapshot and computing the same three states from it —
/// so a row that reads "Enabled — missing credentials" here says exactly that
/// on the desktop too. The state rules are ported from `setup-shared.tsx`
/// rather than sent by the server, which returns facts (`enabled`,
/// `missingRequired`) and leaves the wording to each client.
///
/// A checklist row is actionable exactly when the phone can finish the job
/// without typing a secret. Two kinds qualify, and both hand off to the
/// screen that already owns them rather than growing a second copy here:
/// picking from a list the server already holds (Repositories, which is also
/// where a repo is added), and anything completed by signing in (the account screen,
/// where the GitHub device flow and the MCP OAuth grants live).
///
/// Everything else stays read-only, and the rows say where to finish it. A
/// phone is still the wrong place to type an API key you can't see
/// afterwards: the value is pasted from a dashboard on another screen, it is
/// write-only once stored, and the mistake is invisible until an integration
/// quietly fails. So the integration rows report state and name the web.
struct SetupSettingsView: View {
    @State private var status: OS1API.SetupStatus? = SettingsCache.value("setup-status")
    @State private var loading = false
    @State private var error: String?

    var body: some View {
        List {
            if let error {
                Section { Text(error).foregroundStyle(.red) }
            }
            if let status {
                gettingStarted(status)
                yourAccounts()
                repositories(status)
            } else if loading {
                Section { ProgressView("Loading setup…") }
            } else if error == nil {
                Section {
                    Text("No setup status.").foregroundStyle(.secondary)
                }
            }
        }
        .insetGroupedListCompat()
        .navigationTitle("Setup")
        .task { await load() }
        .refreshable { await load() }
    }

    // ── Getting started ──────────────────────────────────────────────────

    @ViewBuilder
    private func gettingStarted(_ s: OS1API.SetupStatus) -> some View {
        let repos = s.repos ?? []
        Section {
            engineRow(s.engine)

            // The one checklist item a phone can complete on its own: the
            // server already knows every repo its GitHub credential can see,
            // so registering one is picking a row rather than typing a path.
            NavigationLink {
                RepositoriesSettingsView()
            } label: {
                StatusRow(
                    title: "Repositories",
                    detail: repos.isEmpty
                        ? "Add the repos sessions work in."
                        : repos.map { $0.label ?? $0.id }.joined(separator: ", "),
                    tone: repos.isEmpty ? .warn : .on,
                    label: repos.isEmpty ? "None" : "\(repos.count) registered"
                )
            }

            if !repos.isEmpty {
                let bootable = repos.filter { lifecycleState($0.lifecycle).tone == .on }
                StatusRow(
                    title: "Local dev setup",
                    detail: bootable.count == repos.count
                        ? "Every repo boots its own preview."
                        // .agents is the only directory the server looks in
                        // (LIFECYCLE_DIR in src/server/preview.ts). This row
                        // named .opensession, which no instance has read since
                        // the rename, so it sent anyone who followed it to a
                        // path that stays dark.
                        : "Repos without .agents/start.sh keep Preview disabled. See docs/repo-lifecycle.md.",
                    tone: bootable.count == repos.count
                        ? .on : (bootable.isEmpty ? .off : .warn),
                    label: "\(bootable.count)/\(repos.count) bootable"
                )
            }

            // Each remaining row is the way into the page that owns it, so
            // this screen stays a checklist. It used to repeat the roster and
            // the integration list underneath itself, which is one more place
            // for the same facts to be stated differently.
            let team = s.team
            let count = team?.count ?? 0
            NavigationLink {
                MembersSettingsView()
            } label: {
                StatusRow(
                    title: "Team roster",
                    detail: count > 0
                        ? (team?.names ?? []).joined(separator: ", ")
                        : "Add teammates so commits and sessions attribute to real people.",
                    tone: count > 0 ? .on : .warn,
                    label: count > 0 ? "\(count) \(count == 1 ? "member" : "members")" : "Empty"
                )
            }

            if let github = s.github {
                let state = IntegrationRules.githubState(github)
                NavigationLink {
                    IntegrationsSettingsView()
                } label: {
                    StatusRow(
                        title: "GitHub sign-in",
                        detail: IntegrationRules.githubDetail(github),
                        tone: state.tone,
                        label: state.label
                    )
                }
            }

            integrationsRow(s.integrations ?? [])
        } header: {
            Text("Getting started")
        }
    }

    /// The other half a phone can finish: a grant is a sign-in, not a
    /// credential to type. Both flows already have a screen, so this is a way
    /// in rather than a second copy of them.
    @ViewBuilder
    private func yourAccounts() -> some View {
        Section {
            NavigationLink {
                MyAccountsSettingsView()
            } label: {
                Label {
                    Text("Account").foregroundStyle(OS1VisualStyle.text)
                } icon: {
                    Image(systemName: "person.crop.circle")
                        .symbolRenderingMode(.monochrome)
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(OS1VisualStyle.iconTint)
                        .frame(width: 28, height: 28)
                }
            }
        } header: {
            Text("Your accounts")
        } footer: {
            Text("Connect your GitHub account and any tool that signs you in. Sessions you start then act as you rather than as the workspace account.")
        }
    }

    @ViewBuilder
    private func engineRow(_ engine: OS1API.SetupStatus.Engine?) -> some View {
        if let engine {
            let ready = engine.ready ?? false
            // The one non-optional component: an instance that can't run a
            // turn is broken however green everything under it reads.
            StatusRow(
                title: "Engine",
                detail: ready
                    ? [engine.defaultModel, accountsSummary(engine)]
                        .compactMap { $0 }.joined(separator: " · ")
                    : [engine.blocker, engine.fix].compactMap { $0 }.joined(separator: " "),
                tone: ready ? .on : .off,
                label: ready ? "Ready" : "Not ready"
            )
        }
    }

    private func accountsSummary(_ engine: OS1API.SetupStatus.Engine) -> String? {
        var parts: [String] = []
        if let n = engine.claudeAccounts, n > 0 { parts.append("\(n) Claude") }
        if let n = engine.codexAccounts, n > 0 { parts.append("\(n) OpenAI") }
        if let n = engine.xaiAccounts, n > 0 { parts.append("\(n) xAI") }
        guard !parts.isEmpty else { return nil }
        return parts.joined(separator: ", ") + " accounts"
    }

    // ── The lists behind the checklist ───────────────────────────────────

    @ViewBuilder
    private func repositories(_ s: OS1API.SetupStatus) -> some View {
        let repos = s.repos ?? []
        if !repos.isEmpty {
            Section {
                ForEach(repos, id: \.id) { repo in
                    let state = lifecycleState(repo.lifecycle)
                    HStack(spacing: 8) {
                        RepoTile(name: repo.id, size: 22)
                        Text(repo.label ?? repo.id)
                        Spacer(minLength: 8)
                        StateChip(tone: state.tone, label: state.label)
                    }
                    .padding(.vertical, 2)
                }
            } header: {
                Text("Repositories")
            } footer: {
                Text("Commit .agents/ scripts to provision worktrees and boot previews.")
            }
        }
    }

    /// How many integrations are actually on, as the way into the page that
    /// turns them on. Credentials are still typed on the web — a key is
    /// pasted from another screen and unreadable once stored — and the page
    /// says so rather than this row carrying the caveat.
    @ViewBuilder
    private func integrationsRow(_ items: [IntegrationSettings]) -> some View {
        if !items.isEmpty {
            let on = items.filter { IntegrationRules.state($0).tone == .on }
            NavigationLink {
                IntegrationsSettingsView()
            } label: {
                StatusRow(
                    title: "Integrations",
                    detail: on.isEmpty
                        ? "Connect the tools sessions read from and reply in."
                        : on.map(\.title).joined(separator: ", "),
                    tone: on.isEmpty ? .off : .on,
                    label: "\(on.count)/\(items.count) on"
                )
            }
        }
    }

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            let fetched = try await OS1API.setupStatus()
            status = fetched
            SettingsCache.save("setup-status", fetched)
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }
}

// ── The three states, ported from the web's setup-shared.tsx ─────────────

enum SetupTone {
    case on, warn, off

    var color: Color {
        switch self {
        case .on: OS1VisualStyle.green
        case .warn: OS1VisualStyle.yellow
        case .off: OS1VisualStyle.textFaint
        }
    }
}

/// `start.sh` (or an instance `previewCommand`) is the load-bearing half.
/// Without it the Preview button has nothing to run. `setup.sh` alone still
/// provisions worktrees, but nothing boots. The chip label is all a row
/// shows: the section footer explains the mechanism once.
private func lifecycleState(
    _ lifecycle: OS1API.SetupStatus.Lifecycle?
) -> (tone: SetupTone, label: String) {
    let setup = lifecycle?.setup ?? false
    let start = lifecycle?.start ?? false
    if start { return (.on, setup ? "Ready" : "Boots previews") }
    if lifecycle?.previewCommand ?? false { return (.on, "Instance preview") }
    if setup { return (.warn, "Setup only") }
    return (.off, "No previews")
}

/// The web's `StateChip`: a tone dot and its word, sized to sit at the end of
/// a row without competing with the row's own title.
struct StateChip: View {
    let tone: SetupTone
    let label: String

    var body: some View {
        HStack(spacing: 5) {
            Circle()
                .fill(tone.color)
                .frame(width: 6, height: 6)
            Text(label)
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
    }
}

/// A checklist line: what it is, where it stands, and a sentence saying why.
private struct StatusRow: View {
    let title: String
    let detail: String
    let tone: SetupTone
    let label: String

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 8) {
                Text(title)
                Spacer(minLength: 8)
                StateChip(tone: tone, label: label)
            }
            if !detail.isEmpty {
                Text(detail)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
    }
}
