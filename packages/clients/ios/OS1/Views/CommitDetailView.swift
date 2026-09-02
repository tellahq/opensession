import SwiftUI

/// Route-backed detail for a commit reference in transcript prose.
struct CommitDetailView: View {
    let reference: CommitLinks.Reference

    @State private var commit: CommitDetails?
    @State private var changedFiles: [FilePatch] = []
    @State private var loading = true
    @State private var error: String?
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    #if os(iOS)
    @State private var safariLink: SafariLink?
    #endif

    var body: some View {
        NavigationStack {
            Group {
                if loading {
                    ProgressView("Looking up commit…")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if let commit {
                    detail(commit)
                } else if let error {
                    unavailable(
                        "Couldn't load commit",
                        systemImage: "exclamationmark.triangle",
                        description: error
                    )
                } else {
                    unavailable(
                        "Commit not found",
                        systemImage: "questionmark.circle",
                        description: "No configured repository has this commit."
                    )
                }
            }
            .navigationTitle("Commit \(reference.shortSha)")
            .inlineTitleBarCompat()
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        #if os(macOS)
        .frame(minWidth: 440, idealWidth: 680, minHeight: 380, idealHeight: 640)
        #endif
        .task(id: reference.id) { await load() }
        #if os(iOS)
        .sheet(item: $safariLink) { link in
            SafariSheet(url: link.url)
                .ignoresSafeArea()
        }
        #endif
    }

    private func detail(_ commit: CommitDetails) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                HStack(alignment: .firstTextBaseline) {
                    Text("+\(commit.additions)")
                        .foregroundStyle(OS1VisualStyle.green)
                    Text("−\(commit.deletions)")
                        .foregroundStyle(OS1VisualStyle.red)
                    Text("· \(commit.filesChanged) \(commit.filesChanged == 1 ? "file" : "files")")
                        .foregroundStyle(.secondary)
                    Spacer()
                    Image(systemName: "arrow.triangle.branch")
                        .foregroundStyle(.secondary)
                }
                .font(.subheadline.monospacedDigit())

                VStack(alignment: .leading, spacing: 7) {
                    Text(commit.title)
                        .font(.headline)
                    if let body = commit.body?.trimmingCharacters(in: .whitespacesAndNewlines),
                       !body.isEmpty {
                        Text(body)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                    }
                }

                Label(
                    commit.onDefaultBranch
                        ? "On \(commit.defaultBranch)"
                        : "Not on \(commit.defaultBranch) yet",
                    systemImage: commit.onDefaultBranch ? "checkmark.circle.fill" : "circle.dashed"
                )
                .font(.subheadline.weight(.medium))
                .foregroundStyle(
                    commit.onDefaultBranch ? OS1VisualStyle.green : OS1VisualStyle.textDim
                )

                Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 10) {
                    metadataRow("Author", commit.author)
                    metadataRow("Repository", RepoTile.label(for: commit.repo))
                    metadataRow("SHA", commit.sha, monospaced: true)
                    if let date = commit.committedDate {
                        metadataRow("Committed", date.formatted(date: .abbreviated, time: .shortened))
                    }
                }

                if let url = commit.url.flatMap(URL.init(string:)) {
                    Button {
                        openGitHub(url)
                    } label: {
                        Label("Open on GitHub", systemImage: "arrow.up.right.square")
                    }
                    .buttonStyle(.borderedProminent)
                }

                changes(commit)
            }
            .padding(20)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    @ViewBuilder
    private func changes(_ commit: CommitDetails) -> some View {
        if !changedFiles.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                Text("Changes")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.secondary)
                LazyVStack(alignment: .leading, spacing: 10) {
                    ForEach(changedFiles) { file in
                        CommitFileDiff(file: file)
                    }
                }
            }
        }
        if commit.patchTruncated == true {
            Text("Some large changes aren’t shown.")
                .font(.footnote)
                .foregroundStyle(OS1VisualStyle.textFaint)
        }
    }

    private func metadataRow(
        _ label: String,
        _ value: String,
        monospaced: Bool = false
    ) -> some View {
        GridRow {
            Text(label)
                .foregroundStyle(.secondary)
            Text(value)
                .font(monospaced ? .caption.monospaced() : .subheadline)
                .textSelection(.enabled)
        }
    }

    private func unavailable(
        _ title: String,
        systemImage: String,
        description: String
    ) -> some View {
        ContentUnavailableView {
            Label(title, systemImage: systemImage)
        } description: {
            Text(description)
        } actions: {
            Button("Try again") { Task { await load() } }
        }
    }

    private func load() async {
        loading = true
        error = nil
        changedFiles = []
        do {
            let loaded = try await OS1API.commit(sha: reference.sha, repo: reference.repo)
            let files = await Task.detached(priority: .userInitiated) {
                loaded?.changedFiles ?? []
            }.value
            guard !Task.isCancelled else { return }
            commit = loaded
            changedFiles = files
        } catch {
            commit = nil
            self.error = error.localizedDescription
        }
        loading = false
    }

    private func openGitHub(_ url: URL) {
        #if os(iOS)
        safariLink = SafariLink(url: url)
        #else
        openURL(url)
        #endif
    }
}

private struct CommitFileDiff: View {
    let file: FilePatch

    var body: some View {
        ToolCodeBox(label: file.path, lines: ToolCodeMetrics.lines(hunks)) {
            DiffText(patch: hunks, maxLines: 2_000)
        }
    }

    private var hunks: String {
        let lines = file.patch.split(separator: "\n", omittingEmptySubsequences: false)
        guard let first = lines.firstIndex(where: { $0.hasPrefix("@@ ") }) else {
            return file.patch
        }
        return lines[first...].joined(separator: "\n")
    }
}
