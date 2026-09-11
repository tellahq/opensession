import SwiftUI

/// The workspace's Review rows: the two reviewers this change can have, and
/// everything you can ask of either.
///
/// One section for both, the way the web panel has it. The agent's reading and
/// a teammate's are the same question — has anybody looked at this — so they
/// sit on two rows of one plate rather than in two sections that both say
/// "review". Each row says who it is about, carries how that review stands as
/// a coloured band, and keeps its actions on its own trailing control.
struct WorkspaceReviewRows: View {
    let sessionId: String
    /// Every session in the workspace: a review request set on a sibling is a
    /// request on this workspace, and it is the sibling's id that owns it.
    let sessions: [Session]
    /// The pull request, when the workspace has one. Without it there is no
    /// agent reading to show and only the teammate row is drawn.
    let pr: PrDetails?
    let repo: String?
    /// Open the pull request. Offered on the row when a review is waiting on
    /// the person holding the device.
    var onOpenPr: (() -> Void)?
    /// Open a session the agent just started. Auto-fix does its work in a live
    /// session in this workspace rather than posting on the PR.
    var onOpenRun: ((String) -> Void)?

    /// The roster and the agent's name are fetched once per launch and read
    /// here as plain state rather than straight off the singletons: both
    /// usually arrive AFTER this section has drawn, and a row that renders
    /// "Agent" and a picker that offers nobody must not stay that way. The
    /// web subscribes to the same roster for the same reason (`usePeople`).
    ///
    /// They start at their empty values rather than at whatever the singletons
    /// already hold, because a `@State` default is evaluated while the PARENT
    /// builds this view: reading an `@Observable` there registers the roster
    /// as a dependency of the info sheet rather than of this section, which is
    /// the wrong scope to invalidate. The task below fills them in, in the same
    /// frame when the fetch has already happened.
    @State private var agentName = "Agent"
    @State private var roster: [String] = []
    @State private var teams: [OS1API.ReviewTeam] = []

    var body: some View {
        // A gap rather than the hairline the other sections divide rows with:
        // these two carry their own status fill, and a green band a pixel above
        // a yellow one reads as one striped block. The gap matches the plate's
        // padding, and the corners stay concentric — 8 inside + 6 of padding
        // is the section plate's own 14.
        VStack(spacing: 6) {
            if let pr {
                AgentReviewRow(
                    sessionId: sessionId,
                    pr: pr,
                    repo: repo,
                    agentName: agentName,
                    onOpenRun: onOpenRun
                )
            }
            ReviewerRow(
                state: WorkspaceReview.state(of: sessions, openSessionId: sessionId),
                roster: roster,
                teams: teams,
                onOpenPr: onOpenPr
            )
        }
        .padding(6)
        .task {
            await TeamDirectory.shared.ensureLoaded()
            roster = TeamDirectory.shared.names
            teams = TeamDirectory.shared.reviewTeams
            await InstanceIdentity.shared.ensureLoaded()
            agentName = InstanceIdentity.shared.personaName
        }
    }
}

/// How a review row's band reads. The colour is the state; the words on the
/// row say the same thing, so the band is never the only carrier.
enum ReviewTone {
    case green, yellow, red, blue, muted

    var fill: Color {
        switch self {
        case .green: OS1VisualStyle.green.opacity(0.10)
        case .yellow: OS1VisualStyle.yellow.opacity(0.12)
        case .red: OS1VisualStyle.red.opacity(0.10)
        case .blue: OS1VisualStyle.blue.opacity(0.10)
        case .muted: .clear
        }
    }

    var ink: Color {
        switch self {
        case .green: OS1VisualStyle.greenInk
        case .yellow: OS1VisualStyle.yellowInk
        case .red: OS1VisualStyle.redInk
        case .blue: OS1VisualStyle.blueInk
        case .muted: OS1VisualStyle.textDim
        }
    }
}

// MARK: - The agent

/// What the agent made of the pull request, and the passes you can ask it for.
private struct AgentReviewRow: View {
    let sessionId: String
    let pr: PrDetails
    let repo: String?
    /// What this instance calls its agent, resolved by the parent.
    let agentName: String
    var onOpenRun: ((String) -> Void)?

    @State private var busy: OS1API.PrAgentAction?
    /// The write-up is a sheet rather than the hover card the web shows: a
    /// phone has no hover, and the reading is long enough to want the screen.
    @State private var readingReport = false
    /// A review started here, held until a later PR refresh shows the run or a
    /// newer verdict. Without it the row flashes back to idle the moment the
    /// request returns, which reads as nothing having happened. It remembers
    /// the verdict it started from, which is what "newer" is measured against.
    @State private var queued: QueuedReview?
    @State private var started: String?
    @State private var error: String?

    private struct QueuedReview: Equatable { var previousAt: String? }

    private var review: OsReviewSummary? { pr.osReview }
    private var score: Int? { review?.confidence }
    private var risk: MergeRisk? { review?.risk }
    private var stale: Bool { review?.stale == true }
    private var actionable: Bool { pr.isOpen }
    private var active: Bool { pr.reviewActive == true || busy == .review || queued != nil }
    private var canFix: Bool { actionable && !stale && (review?.findings ?? 0) > 0 }
    private var primary: OS1API.PrAgentAction { canFix ? .autofix : .review }

    /// The marker the agent puts on its own summary comment, so the row finds
    /// the reading behind its score rather than the newest human comment.
    private static let marker = "<!-- os-review -->"

    /// What the agent wrote on the pull request, newest first. The score is a
    /// compact reading of this, so the row leads to it.
    private var report: PrComment? {
        guard review != nil else { return nil }
        return pr.comments?.last {
            $0.body.trimmingCharacters(in: .whitespacesAndNewlines).hasPrefix(Self.marker)
        }
    }

    var body: some View {
        ReviewRow(
            tone: tone,
            leading: {
                // A running pass shows a spinner rather than a pulsing glyph.
                // Never an `.animation(_:value:)` here: this sheet sits over a
                // live session and re-evaluates at streaming rates, and an
                // implicit animation on a row that rebuilds that often keeps
                // combining until the app dies in `swift_abortRetainOverflow`.
                Group {
                    if active {
                        ProgressView().controlSize(.small)
                    } else {
                        Image(systemName: "cpu")
                            .font(.system(size: 15))
                            .foregroundStyle(OS1VisualStyle.textDim)
                    }
                }
                .frame(width: 26, height: 26)
                .background(OS1VisualStyle.border.opacity(0.35), in: Circle())
            },
            name: agentName,
            detail: detail,
            detailSpoken: detailSpoken,
            tint: tone.ink,
            note: note,
            error: error,
            onTap: report == nil ? nil : { readingReport = true },
            trailing: {
                if actionable {
                    // The one the state calls for is a button, the rest are
                    // behind the caret beside it — the web's split, and the
                    // same shape the teammate row below uses when a review is
                    // waiting on you. A menu whose label names an action but
                    // needs a second tap to run it reads as a broken button.
                    HStack(spacing: 6) {
                        Button {
                            run(primary)
                        } label: {
                            ReviewActionLabel(
                                title: busy != nil ? "Starting" : primary.label,
                                spinning: busy != nil,
                                chevron: false
                            )
                        }
                        .buttonStyle(.plain)
                        .disabled(busy != nil || (primary == .review && active))
                        Menu {
                            if report != nil {
                                Button {
                                    readingReport = true
                                } label: {
                                    Label("Read the review", systemImage: "text.alignleft")
                                }
                            }
                            Section("\(agentName) can") {
                                ForEach(OS1API.PrAgentAction.allCases) { action in
                                    Button {
                                        run(action)
                                    } label: {
                                        Label(action.label, systemImage: action.symbol)
                                    }
                                    .disabled(busy != nil || (action == .review && active))
                                }
                            }
                        } label: {
                            ReviewActionLabel(title: nil, spinning: false)
                        }
                        .disabled(busy != nil)
                        .accessibilityLabel("\(agentName) actions")
                    }
                }
            }
        )
        .onChange(of: pr.reviewActive) { _, _ in settle() }
        .onChange(of: pr.osReview?.at) { _, _ in settle() }
        .sheet(isPresented: $readingReport) {
            if let report, let review {
                AgentReviewReport(report: report, review: review)
            }
        }
    }

    private var tone: ReviewTone {
        if active { return .blue }
        guard let score else { return .muted }
        if stale { return .yellow }
        if score >= 4 { return .green }
        return score == 3 ? .yellow : .red
    }

    /// The quality score, the merge risk, then the one thing worth knowing
    /// about that reading. The score leads because it is the answer; a run
    /// that has no score yet simply starts at the words. The risk is the
    /// only piece in its own colour: the row's tint is the verdict's, and a
    /// green row can still carry a red "high risk" without becoming a red row.
    private var detail: Text {
        guard !active else { return Text(state) }
        var pieces: [Text] = []
        if let score { pieces.append(Text("\(score)/5")) }
        if let risk {
            pieces.append(Text(risk.label).foregroundStyle(risk.tone(stale: stale).color))
        }
        pieces.append(Text(state))
        return pieces.dropFirst().reduce(pieces[0]) { $0 + Text(" · ") + $1 }
    }

    /// The same reading for VoiceOver, with each axis named: "4/5 · high
    /// risk" spoken as written is a number and a word with nothing saying
    /// which question each answers.
    private var detailSpoken: String {
        guard !active else { return state }
        var pieces: [String] = []
        if let score { pieces.append("quality \(score) of 5") }
        if let risk { pieces.append(risk.accessibilityLabel) }
        pieces.append(state)
        return pieces.joined(separator: ", ")
    }

    private var state: String {
        if active { return "Reviewing…" }
        if pr.state == "MERGED" { return "Merged" }
        if pr.state == "CLOSED" { return "Closed" }
        if stale { return "New commits since review" }
        if let findings = review?.findings, findings > 0 {
            let blocking = review?.blocking ?? 0
            return "\(findings) finding\(findings == 1 ? "" : "s")"
                + (blocking > 0 ? ", \(blocking) blocking" : "")
        }
        return review == nil ? "Not reviewed yet" : "No findings"
    }

    private var note: String? {
        guard let started else { return nil }
        return "Started \(started.lowercased()). Results land on the pull request."
    }

    private func run(_ action: OS1API.PrAgentAction) {
        guard busy == nil else { return }
        busy = action
        error = nil
        started = nil
        Task {
            do {
                let result = try await OS1API.triggerPrAction(
                    sessionId: sessionId,
                    kind: action,
                    repo: repo
                )
                if action == .review { queued = QueuedReview(previousAt: review?.at) }
                // Auto-fix works in a live session in this workspace, so the
                // useful thing to do with it is open it rather than say it was
                // started somewhere.
                if result.openSession == true, let id = result.bksId, let onOpenRun {
                    onOpenRun(id)
                } else {
                    started = action.label
                }
            } catch {
                self.error = (error as? LocalizedError)?.errorDescription
                    ?? error.localizedDescription
            }
            busy = nil
        }
    }

    /// Drop the latch once the polled PR shows the run, or a newer verdict.
    private func settle() {
        guard let queued else { return }
        if pr.reviewActive == true || pr.osReview?.at != queued.previousAt {
            self.queued = nil
        }
    }
}

// MARK: - The teammate

/// Who was asked to review this, and how to ask, hand over or sign off.
private struct ReviewerRow: View {
    let state: WorkspaceReview.State
    /// Who can be asked, and the teams that can be asked instead.
    let roster: [String]
    let teams: [OS1API.ReviewTeam]
    var onOpenPr: (() -> Void)?

    /// The request as this device believes it: the polled one, and whatever
    /// was picked here until the next poll confirms it.
    @State private var request: SessionReviewRequest?
    @State private var githubRequested: [String] = []
    /// Why the last pick was refused. Without it the row simply snaps back,
    /// which reads as the button doing nothing.
    @State private var error: String?

    private var viewer: ServerConfig { ServerConfig.shared }
    private var accepted: SessionReviewRequest.Signoff? { request?.accepted }

    /// A review lands on you two ways: Open Session's own request pointed at
    /// you, or GitHub still listing you as a reviewer.
    private var waitsOnMe: Bool {
        let byGithub = githubRequested.contains {
            MessageAttribution.isViewer(
                $0,
                viewerName: viewer.userName,
                viewerLogin: viewer.githubLogin
            )
        }
        if byGithub { return true }
        guard let request, request.accepted == nil else { return false }
        return request.targets(viewer.userName) || request.targets(viewer.githubLogin)
    }

    /// Somebody else's name on GitHub's list, when there is no request of our
    /// own to speak for. Only that side can clear those, which the menu does.
    private var githubOthers: [String] {
        guard request == nil else { return [] }
        return githubRequested.filter {
            !MessageAttribution.isViewer(
                $0,
                viewerName: viewer.userName,
                viewerLogin: viewer.githubLogin
            )
        }
    }

    var body: some View {
        ReviewRow(
            tone: tone,
            leading: {
                if let faceName {
                    UserAvatar(person: faceName, size: 26)
                } else {
                    Image(systemName: team == nil ? "person.2" : "person.3")
                        .font(.system(size: 14))
                        .foregroundStyle(OS1VisualStyle.textDim)
                        .frame(width: 26, height: 26)
                        .background(OS1VisualStyle.border.opacity(0.35), in: Circle())
                }
            },
            name: rowName,
            detail: Text(rowState),
            detailSpoken: rowState,
            tint: tone.ink,
            note: nil,
            error: error,
            trailing: {
                HStack(spacing: 8) {
                    if waitsOnMe, let onOpenPr {
                        Button("Review now", action: onOpenPr)
                            .buttonStyle(.plain)
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(OS1VisualStyle.redInk)
                    }
                    Menu {
                        if request != nil {
                            if accepted != nil {
                                Button {
                                    // A sign-off GitHub decided has nothing
                                    // local to reopen: ask the same person
                                    // again instead.
                                    if state.acceptedFromPr, let to = request?.to {
                                        pick(to, recipients: request?.recipients)
                                    } else {
                                        accept(false)
                                    }
                                } label: {
                                    Label("Reopen review", systemImage: "bell")
                                }
                            } else {
                                Button {
                                    accept(true)
                                } label: {
                                    Label("Mark as reviewed", systemImage: "checkmark")
                                }
                            }
                        }
                        Section("Ask a teammate") {
                            ForEach(roster, id: \.self) { name in
                                Button {
                                    pick(name)
                                } label: {
                                    Label(
                                        name,
                                        systemImage: request?.to == name
                                            ? "checkmark.circle" : "person"
                                    )
                                }
                            }
                        }
                        if !teams.isEmpty {
                            Section("Ask a team") {
                                ForEach(teams) { team in
                                    Button {
                                        pick(team.github, recipients: team.members)
                                    } label: {
                                        Label(
                                            team.name,
                                            systemImage: request?.to == team.github
                                                ? "checkmark.circle" : "person.3"
                                        )
                                    }
                                }
                            }
                        }
                        if request != nil || !githubRequested.isEmpty {
                            Button(role: .destructive) {
                                pick(nil)
                            } label: {
                                Label("Clear review request", systemImage: "xmark")
                            }
                        }
                    } label: {
                        ReviewActionLabel(
                            title: waitsOnMe
                                ? nil
                                : (request != nil || !githubOthers.isEmpty ? "Change" : "Request"),
                            spinning: false
                        )
                    }
                    .accessibilityLabel("Review options")
                }
            }
        )
        .onAppear { adopt() }
        .onChange(of: state) { _, _ in adopt() }
    }

    private var team: OS1API.ReviewTeam? {
        guard let to = request?.to else { return nil }
        return teams.first { $0.github == to }
    }

    private var tone: ReviewTone {
        if waitsOnMe { return .red }
        if accepted != nil { return .green }
        return request != nil || !githubOthers.isEmpty ? .yellow : .muted
    }

    /// The face is whoever the review sits with — you, when it is waiting on
    /// you, even though the words say so rather than naming you.
    private var faceName: String? {
        if team != nil { return nil }
        if waitsOnMe { return viewer.userName }
        if let accepted { return accepted.by }
        if let request { return request.to }
        return githubOthers.first
    }

    private var rowName: String? {
        if waitsOnMe { return nil }
        if let accepted { return accepted.by }
        if let team { return team.name }
        if let request { return request.to }
        guard let first = githubOthers.first else { return nil }
        let more = githubOthers.count - 1
        let name = Self.personName(first)
        return more > 0 ? "\(name) +\(more)" : name
    }

    /// GitHub's reviewer list arrives as person keys ("michiel") or logins.
    /// The roster spells the same person the way the rest of the app does.
    private static func personName(_ key: String) -> String {
        let directory = TeamDirectory.shared
        return directory.displayNames[key.lowercased()]
            ?? directory.displayName(forGithubLogin: key)
            ?? key
    }

    private var rowState: String {
        if waitsOnMe { return "Needs your review" }
        if accepted != nil { return "Reviewed" }
        return request != nil || !githubOthers.isEmpty ? "Requested" : "No reviewer"
    }

    /// Follow the polled workspace, and drop whatever this device was showing
    /// optimistically once the server's answer arrives.
    private func adopt() {
        request = state.request
        githubRequested = state.githubRequested
        error = nil
    }

    private func pick(_ name: String?, recipients: [String]? = nil) {
        let previous = request
        let previousGithub = githubRequested
        // Re-assigning drops any sign-off: a fresh reviewer, a fresh review.
        request = name.map {
            SessionReviewRequest(
                to: $0,
                recipients: recipients,
                by: viewer.userName,
                at: ISO8601DateFormatter().string(from: Date()),
                accepted: nil
            )
        }
        // Clearing a workspace that has no request of its own withdraws
        // GitHub's pending ones, which is what the server does with the call.
        if name == nil && previous == nil { githubRequested = [] }
        error = nil
        let target = state.ownerId
        Task {
            do {
                try await OS1API.setSessionReviewer(sessionId: target, reviewer: name)
                Haptics.play(.selection)
            } catch {
                request = previous
                githubRequested = previousGithub
                self.error = (error as? LocalizedError)?.errorDescription
                    ?? error.localizedDescription
            }
        }
    }

    private func accept(_ value: Bool) {
        guard let current = request else { return }
        let previous = current
        var next = current
        next.accepted = value
            ? SessionReviewRequest.Signoff(
                by: viewer.userName,
                at: ISO8601DateFormatter().string(from: Date())
            )
            : nil
        request = next
        error = nil
        let target = state.ownerId
        Task {
            do {
                try await OS1API.setReviewAccepted(sessionId: target, accepted: value)
                Haptics.play(.selection)
            } catch {
                request = previous
                self.error = (error as? LocalizedError)?.errorDescription
                    ?? error.localizedDescription
            }
        }
    }
}

// MARK: - The reading behind the score

/// The agent's own write-up, as it was posted on the pull request. The row
/// gives a score out of five; this is the reasoning it came from, so it is
/// rendered as what it is — the comment, in the app's markdown.
private struct AgentReviewReport: View {
    let report: PrComment
    let review: OsReviewSummary

    @Environment(\.dismiss) private var dismiss

    private var score: Int? { review.confidence }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    if let risk = review.risk {
                        MergeRiskLine(risk: risk, review: review)
                    }
                    MarkdownBody(text)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
            }
            .background(OS1VisualStyle.chatCanvas)
            .navigationTitle("Review")
            .inlineTitleBarCompat()
            .toolbar {
                ToolbarItem(placement: .topLeadingCompat) {
                    if let score {
                        Text("\(score)/5")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(OS1VisualStyle.textDim)
                            .monospacedDigit()
                            .accessibilityLabel("Quality \(score) of 5")
                    }
                }
                ToolbarItem(placement: .topTrailingCompat) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }

    /// The comment without the marker the agent tags its own summaries with.
    private var text: String {
        report.body
            .replacingOccurrences(of: "<!-- os-review -->", with: "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

/// Merge risk above the write-up: the level in its ink, then how long a
/// wrong change takes to undo and what earned the level. The comment below
/// says the same at length; this is the one line to read before it.
private struct MergeRiskLine: View {
    let risk: MergeRisk
    let review: OsReviewSummary

    private var stale: Bool { review.stale == true }

    /// "days to recover · schema migration, no tests", or nothing when the
    /// server sent only the level.
    private var evidence: String? {
        var parts: [String] = []
        if let recovery = review.recovery { parts.append(recovery.label) }
        if let factors = review.riskFactors, !factors.isEmpty {
            parts.append(factors.map(MergeRiskFactor.label).joined(separator: ", "))
        }
        if stale { parts.append("new commits since") }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("\(risk.word) merge risk")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(risk.tone(stale: stale).color)
            if let evidence {
                Text(evidence)
                    .font(.caption)
                    .foregroundStyle(OS1VisualStyle.textDim)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(risk.accessibilityLabel + (evidence.map { ", \($0)" } ?? ""))
    }
}

// MARK: - Shared row chrome

/// One review row: who, how it stands, and what you can do about it.
private struct ReviewRow<Leading: View, Trailing: View>: View {
    let tone: ReviewTone
    @ViewBuilder let leading: Leading
    /// Nil when the state already says who it is about ("Needs your review").
    let name: String?
    let detail: Text
    /// The detail as VoiceOver reads it, where the printed one leans on
    /// colour or on a number's position to say what it is.
    let detailSpoken: String
    let tint: Color
    let note: String?
    let error: String?
    /// Set when the row leads somewhere to read — who and how it stands become
    /// one target, and the trailing controls stay their own.
    var onTap: (() -> Void)?
    @ViewBuilder let trailing: Trailing

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 10) {
                if let onTap {
                    Button(action: onTap) { identity }
                        .buttonStyle(.plain)
                        .accessibilityLabel(spoken)
                        .accessibilityHint("Opens the review")
                } else {
                    identity
                        .accessibilityElement(children: .combine)
                        .accessibilityLabel(spoken)
                }
                Spacer(minLength: 8)
                trailing
            }
            if let note {
                Text(note)
                    .font(.caption2)
                    .foregroundStyle(OS1VisualStyle.textDim)
            }
            if let error {
                Text(error)
                    .font(.caption2)
                    .foregroundStyle(OS1VisualStyle.redInk)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 10)
        .frame(minHeight: 56)
        .background(
            tone.fill,
            in: RoundedRectangle(cornerRadius: 8, style: .continuous)
        )
    }

    private var spoken: String {
        [name, detailSpoken].compactMap { $0 }.joined(separator: ", ")
    }

    /// Who the row is about and where that review stands. One block, because
    /// it is one tap target when the row leads to the reading behind it.
    private var identity: some View {
        HStack(spacing: 10) {
            leading
            VStack(alignment: .leading, spacing: 1) {
                if let name {
                    Text(name)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(OS1VisualStyle.text)
                        .lineLimit(1)
                }
                detail
                    .font(.caption)
                    .foregroundStyle(tint)
                    .lineLimit(2)
            }
        }
        .contentShape(Rectangle())
    }
}

/// The trailing control on a review row: a small capsule that opens a menu.
/// Title-less while a review is waiting on you, where the row's own action
/// carries the words and this only holds the rest.
private struct ReviewActionLabel: View {
    let title: String?
    let spinning: Bool
    /// False for the plain action beside a menu: only the control that opens
    /// something carries the caret.
    var chevron = true

    var body: some View {
        HStack(spacing: 3) {
            if spinning {
                ProgressView().controlSize(.mini)
            }
            if let title {
                Text(title)
            }
            if chevron {
                Image(systemName: "chevron.down")
                    .font(.caption2.weight(.semibold))
            }
        }
        .font(.footnote.weight(.semibold))
        .foregroundStyle(OS1VisualStyle.text)
        .padding(.horizontal, title == nil ? 7 : 10)
        .padding(.vertical, 6)
        .background(OS1VisualStyle.border.opacity(0.3), in: Capsule())
    }
}
