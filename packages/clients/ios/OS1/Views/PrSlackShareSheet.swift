import Observation
import SwiftUI

struct PrSlackShareRequest: Identifiable {
    let id = UUID()
    let title: String
    let url: URL
    let sessionId: String
    let repo: String?
    let branch: String?
    let merged: Bool
    let walkthroughSummary: String?
    let suggestedScreenshot: String?
    var composerRequestId: String?
    var initialImages: [String] = []
    var preferredChannel: String? = nil
    var onComposerResolved: ((SlackComposeReceipt) -> Void)? = nil
}

enum ShippedChangeCopy {
    /// A first draft of the Slack message announcing a merged change, shown
    /// in the composer for the person to edit before sending.
    /// Repository-neutral: it reads the walkthrough summary when there is one,
    /// and otherwise turns the PR title from an instruction into an outcome.
    static func suggestion(title: String, summary: String?) -> String {
        if let summary, let prose = outcome(summary) { return prose }
        let clean = title
            .replacingOccurrences(of: #"^\[[^\]]+\]\s*"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: #"[.!?]+$"#, with: "", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty else { return "The update is now available." }
        if clean.range(of: #"\b(now|is|are|has|have|can)\b"#, options: [.regularExpression, .caseInsensitive]) != nil {
            return sentence(clean)
        }
        let words = clean.split(separator: " ").map(String.init)
        let verb = words.first?.lowercased() ?? ""
        let object = words.dropFirst().joined(separator: " ")
        guard !object.isEmpty else { return sentence("\(clean) is now available") }
        switch verb {
        case "add", "create": return sentence("\(object) is now available")
        case "fix": return sentence("\(object) now works correctly")
        case "remove": return sentence("\(object) is now removed")
        case "improve", "polish", "redesign", "simplify":
            return sentence("\(object) is now improved")
        case "adopt", "change", "make", "replace", "update", "use":
            return sentence("\(object) is now updated")
        default: return sentence("\(clean) is now available")
        }
    }

    private static func outcome(_ markdown: String) -> String? {
        let lines = markdown
            .replacingOccurrences(of: #"!\[[^\]]*\]\([^)]*\)"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: #"\[([^\]]+)\]\([^)]*\)"#, with: "$1", options: .regularExpression)
            .components(separatedBy: .newlines)
            .map {
                $0.replacingOccurrences(
                    of: #"^\s*(?:#{1,6}|[-*+]|\d+\.)\s+"#,
                    with: "",
                    options: .regularExpression
                )
                .replacingOccurrences(of: #"[*_`~]"#, with: "", options: .regularExpression)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            }
            .filter { !$0.isEmpty }
        for line in lines {
            let value = line
                .replacingOccurrences(
                    of: #"^Deployment is live\s*[\p{Pd}:]\s*"#,
                    with: "",
                    options: [.regularExpression, .caseInsensitive]
                )
                .replacingOccurrences(
                    of: #"^This change\s+"#,
                    with: "",
                    options: [.regularExpression, .caseInsensitive]
                )
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if value.count < 20
                || value.range(
                    of: #"^(done|pushed|merged|commit|tests?|verified|pr\s*#|updated and live)\b"#,
                    options: [.regularExpression, .caseInsensitive]
                ) != nil { continue }
            let first = firstSentence(value)
            if first.range(
                of: #"^we\s+(shipped|updated|added|changed|fixed)\b"#,
                options: [.regularExpression, .caseInsensitive]
            ) == nil {
                return sentence(first)
            }
        }
        return nil
    }

    private static func firstSentence(_ value: String) -> String {
        for delimiter in [". ", "! ", "? "] {
            if let range = value.range(of: delimiter) {
                return String(value[...range.lowerBound])
            }
        }
        return value
    }

    private static func sentence(_ value: String) -> String {
        let clean = value
            .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: #"[.!?]+$"#, with: "", options: .regularExpression)
        guard let first = clean.first else { return "" }
        return first.uppercased() + String(clean.dropFirst()) + "."
    }
}

enum ShippedChangeMedia {
    static func latestScreenshot(in entries: [TranscriptEntry]) -> String? {
        for entry in entries.reversed() {
            for source in (entry.featuredMedia ?? []).reversed() {
                if let path = localScreenshotPath(source) { return path }
            }
        }
        return nil
    }

    private static func localScreenshotPath(_ source: String) -> String? {
        let path: String
        if source.hasPrefix("/media?") {
            path = URLComponents(string: source)?.queryItems?
                .first { $0.name == "path" }?.value ?? ""
        } else {
            path = source
        }
        guard path.hasPrefix("/"),
              path.range(of: #"\.(png|jpe?g|gif|webp)$"#, options: [.regularExpression, .caseInsensitive]) != nil
        else { return nil }
        return path
    }
}

struct SlackComposerDraftImage: Equatable, Sendable {
    let id: String
    let image: AttachedImage?
    var uploadedPath: String?

    init(image: AttachedImage, uploadedPath: String?) {
        id = image.id
        self.image = image
        self.uploadedPath = uploadedPath
    }

    init(uploadedPath: String) {
        id = "path:\(uploadedPath)"
        image = nil
        self.uploadedPath = uploadedPath
    }
}

/// Serializes draft saves so a slow image upload or request cannot overwrite a
/// newer edit. The sheet owns presentation state; this object owns save order.
@MainActor
@Observable
final class SlackComposerDraftPersistence {
    typealias Upload = @MainActor (AttachedImage, Int) async throws -> String
    typealias Update = @MainActor (String, String, [String]) async throws -> Void

    private struct Snapshot: Equatable {
        var message: String
        var channel: String
        var images: [SlackComposerDraftImage]
    }

    private let enabled: Bool
    private let upload: Upload
    private let update: Update
    @ObservationIgnored private var latest: Snapshot?
    @ObservationIgnored private var revision = 0
    @ObservationIgnored private var savedRevision = 0
    @ObservationIgnored private var debounceTask: Task<Void, Never>?
    @ObservationIgnored private var saveTask: Task<Void, Never>?
    @ObservationIgnored private var stopped = false

    var debounceDelay: Duration = .milliseconds(400)
    private(set) var errorMessage: String?

    init(
        enabled: Bool,
        upload: @escaping Upload,
        update: @escaping Update
    ) {
        self.enabled = enabled
        self.upload = upload
        self.update = update
    }

    func edited(
        message: String,
        channel: String,
        images: [SlackComposerDraftImage]
    ) {
        guard enabled, !stopped else { return }
        latest = normalized(Snapshot(message: message, channel: channel, images: images))
        revision += 1
        debounceTask?.cancel()
        debounceTask = Task { [weak self] in
            guard let self else { return }
            try? await Task.sleep(for: debounceDelay)
            guard !Task.isCancelled else { return }
            await saveNow()
        }
    }

    func flush(
        message: String,
        channel: String,
        images: [SlackComposerDraftImage]
    ) async {
        guard enabled, !stopped, revision > savedRevision else { return }
        let current = normalized(Snapshot(message: message, channel: channel, images: images))
        if current != latest {
            latest = current
            revision += 1
        }
        debounceTask?.cancel()
        await saveNow()
    }

    func stop() {
        stopped = true
        debounceTask?.cancel()
        saveTask?.cancel()
    }

    func resume() {
        stopped = false
    }

    private func normalized(_ snapshot: Snapshot) -> Snapshot {
        guard let latest else { return snapshot }
        var result = snapshot
        for index in result.images.indices where result.images[index].uploadedPath == nil {
            result.images[index].uploadedPath = latest.images.first {
                $0.id == result.images[index].id
            }?.uploadedPath
        }
        return result
    }

    private func saveNow() async {
        if let saveTask {
            await saveTask.value
            return
        }
        let task = Task { [weak self] in
            guard let self else { return }
            await saveLatest()
        }
        saveTask = task
        await task.value
        saveTask = nil
    }

    private func saveLatest() async {
        while !stopped, !Task.isCancelled,
              savedRevision < revision, var snapshot = latest {
            do {
                let startingRevision = revision
                for index in snapshot.images.indices where snapshot.images[index].uploadedPath == nil {
                    guard let image = snapshot.images[index].image else { continue }
                    let path = try await upload(image, index + 1)
                    snapshot.images[index].uploadedPath = path
                    if let latestIndex = latest?.images.firstIndex(where: { $0.id == image.id }),
                       latest?.images[latestIndex].uploadedPath == nil {
                        latest?.images[latestIndex].uploadedPath = path
                    }
                }
                guard !stopped, !Task.isCancelled else { return }
                guard startingRevision == revision else { continue }
                let screenshots = snapshot.images.compactMap(\.uploadedPath)
                try await update(snapshot.message, snapshot.channel, screenshots)
                savedRevision = startingRevision
                errorMessage = nil
            } catch {
                let detail = (error as? LocalizedError)?.errorDescription
                    ?? error.localizedDescription
                errorMessage = "Couldn't save this Slack draft. \(detail) Keep editing to retry."
                return
            }
        }
    }
}

/// A deliberate Slack post: the description stays editable while the pull
/// request URL is fixed, so the shared message cannot lose its destination.
struct PrSlackShareSheet: View {
    let request: PrSlackShareRequest

    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @Environment(\.scenePhase) private var scenePhase
    @State private var description: String
    @State private var images: [AttachedImage] = []
    @State private var uploadedImagePaths: [String: String] = [:]
    @State private var unloadedImagePaths: [String]
    @State private var imagesEdited = false
    @State private var channels: [SlackAPI.Channel] = []
    @State private var selectedChannel = ""
    @State private var channelEdited = false
    @State private var draftPersistence: SlackComposerDraftPersistence
    @State private var loading = true
    @State private var sending = false
    @State private var canUploadImages = true
    @State private var awaitingSlack = false
    @State private var errorText: String?
    #if os(iOS)
    @State private var consent: SafariLink?
    #endif
    @FocusState private var descriptionFocused: Bool

    init(request: PrSlackShareRequest) {
        self.request = request
        _description = State(initialValue: request.merged
            ? ShippedChangeCopy.suggestion(
                title: request.title,
                summary: request.walkthroughSummary
            )
            : request.title)
        let imagePaths = (
            [request.suggestedScreenshot].compactMap { $0 } + request.initialImages
        ).reduce(into: [String]()) { paths, path in
            if !paths.contains(path) { paths.append(path) }
        }
        _unloadedImagePaths = State(initialValue: Array(imagePaths.prefix(10)))
        let composerRequestId = request.composerRequestId
        let sessionId = request.sessionId
        _draftPersistence = State(initialValue: SlackComposerDraftPersistence(
            enabled: composerRequestId != nil,
            upload: { image, index in
                try await SlackAPI.uploadImage(image, index: index)
            },
            update: { message, channel, screenshots in
                guard let composerRequestId else { return }
                try await SlackAPI.updateComposer(
                    sessionId: sessionId,
                    requestId: composerRequestId,
                    channelId: channel,
                    message: message,
                    screenshots: screenshots
                )
            }
        ))
    }

    private var trimmedDescription: String {
        description.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var canSend: Bool {
        !sending && !loading && !selectedChannel.isEmpty
            && (!trimmedDescription.isEmpty || !images.isEmpty)
    }

    private var requiresReconnect: Bool {
        !images.isEmpty && !canUploadImages
    }

    /// A shipped change and a composer request post a message with pictures;
    /// a plain PR share posts a link, and has no Images section to paste into.
    private var acceptsImages: Bool {
        request.merged || request.composerRequestId != nil
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextEditor(text: descriptionBinding)
                        .frame(minHeight: 110)
                        .focused($descriptionFocused)
                } header: {
                    Text("Description")
                } footer: {
                    Text(acceptsImages
                        ? "Keep it to 500 characters."
                        : "The GitHub link is added automatically.")
                }

                if acceptsImages {
                    Section("Images") {
                        if !images.isEmpty {
                            AttachedImagesRow(images: images) { image in
                                setImages(images.filter { $0.id != image.id })
                            }
                        }
                        AttachImagesButton(images: imagesBinding, maxCount: 10, systemImage: "plus")
                            .accessibilityLabel("Add images")
                    }
                }

                Section("Channel") {
                    if loading {
                        HStack {
                            ProgressView().controlSize(.small)
                            Text("Loading channels")
                                .foregroundStyle(.secondary)
                        }
                    } else if channels.isEmpty {
                        Text("No Slack channels are configured.")
                            .foregroundStyle(.secondary)
                    } else {
                        Picker("Send to", selection: channelBinding) {
                            ForEach(channels) { channel in
                                Text("#\(channel.name)").tag(channel.id)
                            }
                        }
                    }
                }

                if request.composerRequestId == nil {
                    Section("Pull request") {
                        Link(destination: request.url) {
                            Text(request.url.absoluteString)
                                .lineLimit(2)
                        }
                    }
                }

                if let visibleError = errorText ?? draftPersistence.errorMessage {
                    Section {
                        Text(visibleError).foregroundStyle(.red)
                    }
                }
            }
            // A screenshot is usually already on the clipboard when you come
            // to write this message, so Cmd+V attaches it rather than pasting
            // nothing into the description. On iOS the same modifier puts
            // Paste in the text field's own edit menu.
            .pastesImages(into: imagesBinding, maxCount: 10, when: acceptsImages)
            .navigationTitle("Share to Slack")
            .inlineTitleBarCompat()
            .toolbar {
                ToolbarItem(placement: .topLeadingCompat) {
                    Button("Cancel") { cancel() }
                }
                ToolbarItem(placement: .topTrailingCompat) {
                    if sending || awaitingSlack {
                        ProgressView().controlSize(.small)
                    } else {
                        Button(requiresReconnect ? "Reconnect" : "Send") {
                            requiresReconnect ? reconnectSlack() : send()
                        }
                        .disabled(requiresReconnect ? sending : !canSend)
                    }
                }
            }
            .disabled(sending)
            .task {
                async let channelLoad: Void = loadChannels()
                async let imageLoad: Void = loadSuggestedImage()
                _ = await (channelLoad, imageLoad)
                loading = false
            }
            .task(id: awaitingSlack) {
                guard awaitingSlack else { return }
                for _ in 0..<24 {
                    try? await Task.sleep(for: .seconds(5))
                    if Task.isCancelled { return }
                    await loadChannels(focusDescription: false)
                    if canUploadImages {
                        awaitingSlack = false
                        #if os(iOS)
                        consent = nil
                        #endif
                        return
                    }
                }
                awaitingSlack = false
                errorText = "Slack access is still waiting for approval."
            }
            .onChange(of: scenePhase) {
                if scenePhase != .active { flushDraft() }
            }
            .onDisappear { flushDraft() }
        }
        .interactiveDismissDisabled(sending)
        #if os(iOS)
        .sheet(item: $consent) { link in SafariSheet(url: link.url) }
        #endif
        #if os(macOS)
        .frame(minWidth: 420, minHeight: 440)
        #endif
    }

    private var descriptionBinding: Binding<String> {
        Binding(
            get: { description },
            set: { value in
                description = String(value.prefix(500))
                draftEdited()
            }
        )
    }

    private var channelBinding: Binding<String> {
        Binding(
            get: { selectedChannel },
            set: { value in
                selectedChannel = value
                channelEdited = true
                draftEdited()
            }
        )
    }

    private var imagesBinding: Binding<[AttachedImage]> {
        Binding(get: { images }, set: { setImages($0) })
    }

    private var draftImages: [SlackComposerDraftImage] {
        let visible = images.map {
            SlackComposerDraftImage(image: $0, uploadedPath: uploadedImagePaths[$0.id])
        }
        return visible + unloadedImagePaths.map(SlackComposerDraftImage.init(uploadedPath:))
    }

    private func setImages(_ value: [AttachedImage]) {
        images = value
        imagesEdited = true
        uploadedImagePaths = uploadedImagePaths.filter { id, _ in
            value.contains { $0.id == id }
        }
        draftEdited()
    }

    private func draftEdited() {
        draftPersistence.edited(
            message: description,
            channel: selectedChannel,
            images: draftImages
        )
    }

    private func flushDraft() {
        let message = description
        let channel = selectedChannel
        let draftImages = draftImages
        Task {
            await draftPersistence.flush(
                message: message,
                channel: channel,
                images: draftImages
            )
        }
    }

    private func loadChannels(focusDescription: Bool = true) async {
        do {
            let response: SlackAPI.ChannelsResponse
            if request.merged {
                response = try await SlackAPI.shippedChangeChannels(sessionId: request.sessionId)
            } else {
                response = try await SlackAPI.channels(sessionId: request.sessionId)
            }
            channels = response.channels
            canUploadImages = response.canUploadImages ?? true
            if !channelEdited {
                let preferred = request.preferredChannel?.trimmingCharacters(in: .whitespacesAndNewlines)
                    .replacingOccurrences(of: "#", with: "")
                selectedChannel = response.channels.first {
                    $0.id == preferred || $0.name.caseInsensitiveCompare(preferred ?? "") == .orderedSame
                }?.id ?? (response.channels.contains { $0.id == response.defaultChannel }
                    ? response.defaultChannel ?? ""
                    : response.channels.first?.id ?? "")
            }
            if focusDescription { descriptionFocused = true }
        } catch {
            errorText = (error as? LocalizedError)?.errorDescription
                ?? error.localizedDescription
        }
    }

    private func loadSuggestedImage() async {
        guard acceptsImages else { return }
        let paths = [request.suggestedScreenshot].compactMap { $0 } + request.initialImages
        var loaded: [(AttachedImage, String)] = []
        for path in paths.prefix(10) {
            guard let data = try? await OS1API.media(path: path),
                  let image = AttachedImage(rawData: data) else { continue }
            loaded.append((image, path))
        }
        guard !imagesEdited else { return }
        images = loaded.map(\.0)
        uploadedImagePaths = Dictionary(uniqueKeysWithValues: loaded.map { ($0.0.id, $0.1) })
        let loadedPaths = Set(loaded.map(\.1))
        unloadedImagePaths.removeAll { loadedPaths.contains($0) }
    }

    private func send() {
        guard canSend else { return }
        Haptics.play(.send)
        sending = true
        errorText = nil
        descriptionFocused = false
        Task {
            if request.composerRequestId != nil {
                await draftPersistence.flush(
                    message: description,
                    channel: selectedChannel,
                    images: draftImages
                )
                draftPersistence.stop()
            }
            do {
                if let composerRequestId = request.composerRequestId {
                    var screenshots: [String] = []
                    for (index, image) in images.enumerated() {
                        screenshots.append(try await SlackAPI.uploadImage(image, index: index + 1))
                    }
                    let response = try await SlackAPI.sendComposer(
                        sessionId: request.sessionId,
                        requestId: composerRequestId,
                        channelId: selectedChannel,
                        message: trimmedDescription,
                        screenshots: screenshots
                    )
                    request.onComposerResolved?(SlackComposeReceipt(
                        requestId: composerRequestId,
                        status: .sent,
                        channel: response.channel.map {
                            .init(id: $0.id, name: $0.name)
                        },
                        permalink: response.permalink,
                        ts: response.ts
                    ))
                } else if request.merged {
                    var screenshots: [String] = []
                    for (index, image) in images.enumerated() {
                        screenshots.append(try await SlackAPI.uploadImage(image, index: index + 1))
                    }
                    _ = try await SlackAPI.shareShippedChange(
                        sessionId: request.sessionId,
                        repo: request.repo,
                        branch: request.branch,
                        channelId: selectedChannel,
                        message: trimmedDescription,
                        screenshots: screenshots
                    )
                } else {
                    try await SlackAPI.post(
                        channelId: selectedChannel,
                        text: "\(trimmedDescription)\n\(request.url.absoluteString)"
                    )
                }
                Haptics.play(.commit)
                dismiss()
            } catch {
                draftPersistence.resume()
                let message = (error as? LocalizedError)?.errorDescription
                    ?? error.localizedDescription
                errorText = message
                if message.contains("Reconnect Slack") { canUploadImages = false }
                Haptics.play(.warn)
            }
            sending = false
        }
    }

    private func reconnectSlack() {
        errorText = nil
        Task {
            do {
                let started = try await SettingsAPI.startMcpOauth(name: "slack")
                guard let raw = started.url, let url = URL(string: raw) else {
                    errorText = "The server did not return a consent URL."
                    return
                }
                awaitingSlack = true
                #if os(iOS)
                if SafariLink.isWeb(url) { consent = SafariLink(url: url) }
                else { openURL(url) }
                #else
                openURL(url)
                #endif
            } catch {
                errorText = (error as? LocalizedError)?.errorDescription
                    ?? error.localizedDescription
            }
        }
    }

    private func cancel() {
        guard let composerRequestId = request.composerRequestId else {
            dismiss()
            return
        }
        sending = true
        draftPersistence.stop()
        Task {
            do {
                try await SlackAPI.cancelComposer(
                    sessionId: request.sessionId,
                    requestId: composerRequestId
                )
                request.onComposerResolved?(SlackComposeReceipt(
                    requestId: composerRequestId,
                    status: .cancelled,
                    channel: nil,
                    permalink: nil
                ))
                dismiss()
            } catch {
                draftPersistence.resume()
                sending = false
                errorText = (error as? LocalizedError)?.errorDescription
                    ?? error.localizedDescription
            }
        }
    }
}
