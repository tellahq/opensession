import SwiftUI
import PhotosUI
#if canImport(UIKit)
import UIKit
#endif

/// The composer's "+" — the web input's add menu, natively. Attaching an image
/// is one row inside it rather than the whole button: the same menu carries the
/// camera and the session goal, which is everything the paperclip it replaced
/// could never say it did.
struct ComposerAddMenu: View {
    @Binding var images: [AttachedImage]
    var hasGoal: Bool = false
    /// Nil when the session can't take a goal — `/goal` is a backstage-native
    /// slash command, so Slack/Linear-sourced sessions don't get the row.
    var onSetGoal: (() -> Void)?
    /// Opens the `@`-mention picker. Nil where mention search isn't available.
    var onReferenceFile: (() -> Void)?
    /// Opens the Files browser, for a surface that takes any file rather than
    /// only pictures — a Plain reply carries logs and PDFs too. Nil in a
    /// session composer, which has nowhere to put one.
    var onBrowseFiles: (() -> Void)?
    /// Scheduling needs something to schedule, so the row dims on an empty
    /// draft rather than opening a picker that can't submit.
    var hasDraft: Bool = false
    var onSchedule: (() -> Void)?
    /// Notes accept images but not arbitrary files. This picker is image-only,
    /// so it remains available in either composer mode.
    var attachmentsEnabled = true
    /// The session's one-message note mode. It sits beside the ordinary
    /// attachment actions so the same "+" menu owns every composer mode.
    var noteMode = false
    var onToggleNoteMode: (() -> Void)?
    /// Set only for an ask-mode session that the server would let promote.
    var onSwitchToCode: (() -> Void)?
    var promoting: Bool = false
    var maxCount: Int = 6

    @State private var pickerItems: [PhotosPickerItem] = []
    #if os(iOS)
    @State private var showingPhotos = false
    @State private var showingCamera = false
    #else
    @State private var importing = false
    #endif

    private var remaining: Int { max(0, maxCount - images.count) }

    var body: some View {
        Menu {
            if attachmentsEnabled {
                Button {
                    #if os(iOS)
                    showingPhotos = true
                    #else
                    importing = true
                    #endif
                } label: {
                    Label(attachLabel, systemImage: "photo.on.rectangle")
                }
                .disabled(remaining == 0)

                #if os(iOS)
                if CameraPicker.isAvailable {
                    Button {
                        showingCamera = true
                    } label: {
                        Label("Take a photo", systemImage: "camera")
                    }
                    .disabled(remaining == 0)
                }
                #endif

                if let onBrowseFiles {
                    Button(action: onBrowseFiles) {
                        Label("Choose a file", systemImage: "folder")
                    }
                    .disabled(remaining == 0)
                }
            }

            if let onReferenceFile {
                Button(action: onReferenceFile) {
                    Label("Reference a file", systemImage: "at")
                }
            }

            if let onSetGoal {
                Button(action: onSetGoal) {
                    Label(hasGoal ? "Edit goal" : "Set a goal", systemImage: "target")
                }
            }

            if let onSwitchToCode {
                Button(action: onSwitchToCode) {
                    Label(
                        promoting ? "Switching to code…" : "Switch to code",
                        systemImage: "eye"
                    )
                }
                .disabled(promoting)
            }

            if let onSchedule {
                Button(action: onSchedule) {
                    Label("Send later", systemImage: "clock")
                }
                .disabled(!hasDraft)
            }

            if let onToggleNoteMode {
                Button(action: onToggleNoteMode) {
                    Label(
                        noteMode ? "Back to prompting" : "Write a team note",
                        systemImage: noteMode ? "arrow.uturn.backward" : "note.text"
                    )
                }
            }
        } label: {
            icon
        }
        .menuIndicator(.hidden)
        // A Menu tints its own label, which paints the "+" in the brand fill over the
        // secondary mic beside it — the glyph is a quiet affordance, not a
        // call to action. Tinting the menu (not just the label) is what sticks.
        .tint(OS1VisualStyle.textDim)
        .buttonStyle(.plain)
        #if os(macOS)
        .menuStyle(.button)
        .fixedSize()
        #endif
        .accessibilityLabel("Attach files and session options")
        #if os(iOS)
        .photosPicker(
            isPresented: $showingPhotos,
            selection: $pickerItems,
            maxSelectionCount: remaining,
            matching: .images
        )
        .onChange(of: pickerItems) {
            guard !pickerItems.isEmpty else { return }
            let picked = pickerItems
            pickerItems = []
            Task {
                for item in picked {
                    guard let data = try? await item.loadTransferable(type: Data.self)
                    else { continue }
                    append(data)
                }
            }
        }
        .fullScreenCover(isPresented: $showingCamera) {
            CameraPicker { data in append(data) }
                .ignoresSafeArea()
        }
        #else
        .fileImporter(
            isPresented: $importing,
            allowedContentTypes: [.image],
            allowsMultipleSelection: true
        ) { result in
            guard case .success(let urls) = result else { return }
            for url in urls.prefix(remaining) {
                let scoped = url.startAccessingSecurityScopedResource()
                defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                guard let data = try? Data(contentsOf: url) else { continue }
                append(data)
            }
        }
        #endif
    }

    private var attachLabel: String {
        #if os(iOS)
        "Photo library"
        #else
        "Attach an image"
        #endif
    }

    private func append(_ data: Data) {
        guard images.count < maxCount, let image = AttachedImage(rawData: data)
        else { return }
        images.append(image)
    }

    /// Same metrics as the send/mic buttons beside it: a secondary glyph in a
    /// full-size tap target, so the row reads as one set of controls.
    private var icon: some View {
        Image(systemName: "plus")
            .font(.system(size: 18, weight: .medium))
            .foregroundStyle(OS1VisualStyle.textDim)
            #if os(iOS)
            .frame(width: 44, height: 44)
            #else
            .frame(width: 27, height: 27)
            #endif
            .contentShape(Circle())
    }
}

/// Editor for the session goal. A goal is appended to every prompt in the
/// session until it's cleared, so the sheet offers clearing as plainly as
/// setting.
struct GoalSheet: View {
    let hadGoal: Bool
    let onSubmit: (String?) -> Void

    @State private var text: String
    @Environment(\.dismiss) private var dismiss

    init(initial: String, hadGoal: Bool, onSubmit: @escaping (String?) -> Void) {
        _text = State(initialValue: initial)
        self.hadGoal = hadGoal
        self.onSubmit = onSubmit
    }

    private var trimmed: String {
        text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Session goal")
                .font(.headline)
            Text("Rides every prompt in this session until you clear it.")
                .font(.footnote)
                .foregroundStyle(.secondary)

            TextField(
                "What should this session keep working toward?",
                text: $text,
                axis: .vertical
            )
            .lineLimit(3...6)
            .textFieldStyle(.roundedBorder)

            HStack {
                if hadGoal {
                    Button("Clear goal", role: .destructive) {
                        onSubmit(nil)
                        dismiss()
                    }
                }
                Spacer()
                Button("Cancel") { dismiss() }
                Button("Set goal") {
                    onSubmit(trimmed)
                    dismiss()
                }
                .buttonStyle(.borderedProminent)
                .disabled(trimmed.isEmpty)
            }
        }
        .padding(20)
        .frame(minWidth: 320)
        #if os(iOS)
        .presentationDetents([.medium])
        #endif
    }
}

/// Dedicated file-reference search for the composer's `+` menu. Typing `@`
/// now opens the shared inline palette; this sheet remains the direct route
/// when someone wants to browse files without starting a token first.
struct ReferenceFileSheet: View {
    let sessionId: String
    let onPick: (FileMention) -> Void

    @State private var query = ""
    @State private var results: [FileMention] = []
    @State private var searching = false
    @State private var failed = false
    @Environment(\.dismiss) private var dismiss

    /// `.navigationBarDrawer` doesn't exist on macOS — keeping the placement
    /// here rather than in the modifier chain keeps that one platform
    /// difference to a single `#if` (and kept the Mac target from building
    /// at all when it was inline).
    private static var searchPlacement: SearchFieldPlacement {
        #if os(iOS)
        .navigationBarDrawer(displayMode: .always)
        #else
        .automatic
        #endif
    }

    var body: some View {
        NavigationStack {
            List {
                if results.isEmpty, !query.isEmpty, !searching {
                    Text(failed ? "Couldn't search this session's files." : "No matches.")
                        .foregroundStyle(.secondary)
                }
                ForEach(results) { match in
                    Button {
                        onPick(match)
                        dismiss()
                    } label: {
                        HStack(spacing: 10) {
                            Image(systemName: match.symbol)
                                .foregroundStyle(.secondary)
                                .frame(width: 18)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(match.display)
                                    .lineLimit(1)
                                    .truncationMode(.head)
                                if let repo = match.repo, !repo.isEmpty {
                                    Text(repo)
                                        .font(.caption2)
                                        .foregroundStyle(.tertiary)
                                }
                            }
                        }
                    }
                    .buttonStyle(.plain)
                }
            }
            .listStyle(.plain)
            .searchable(text: $query, placement: Self.searchPlacement, prompt: "Search files")
            .navigationTitle("Reference a file")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
            .overlay {
                if searching, results.isEmpty { ProgressView() }
            }
        }
        // Re-runs on every keystroke, cancelling the in-flight task — the
        // sleep is the debounce, so only a settled query reaches the server.
        .task(id: query) {
            let term = query.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !term.isEmpty else {
                results = []
                failed = false
                return
            }
            try? await Task.sleep(for: .milliseconds(180))
            guard !Task.isCancelled else { return }
            searching = true
            defer { searching = false }
            do {
                let found = try await OS1API.fileMentions(query: term, sessionId: sessionId)
                guard !Task.isCancelled else { return }
                results = found
                failed = false
            } catch {
                guard !Task.isCancelled else { return }
                results = []
                failed = true
            }
        }
    }
}

/// "Send later": the draft is held server-side and sent at the chosen time,
/// app running or not. Quick picks mirror the web composer's — later today,
/// tomorrow morning, next week — with a full picker behind "Pick a time".
struct SchedulePromptSheet: View {
    let onSchedule: (Date) async -> String?

    @State private var custom = Date().addingTimeInterval(3600)
    @State private var showingCustom = false
    @State private var saving = false
    @State private var error: String?
    @Environment(\.dismiss) private var dismiss

    /// Contextual, always in the future, at sensible hours — the same three
    /// the web offers.
    private var quickPicks: [(label: String, at: Date)] {
        let calendar = Calendar.current
        let now = Date()
        var out: [(String, Date)] = []

        func add(_ label: String, _ date: Date?) {
            guard let date, date.timeIntervalSince(now) > 30 else { return }
            out.append((label, date))
        }

        add("Later today", calendar.date(bySettingHour: 18, minute: 0, second: 0, of: now))
        if let tomorrow = calendar.date(byAdding: .day, value: 1, to: now) {
            add(
                "Tomorrow morning",
                calendar.date(bySettingHour: 9, minute: 0, second: 0, of: tomorrow)
            )
        }
        // Next Monday, 9am — "next week" in the only sense a workday has.
        let weekday = calendar.component(.weekday, from: now)
        let toMonday = ((9 - weekday) % 7 == 0) ? 7 : (9 - weekday) % 7
        if let monday = calendar.date(byAdding: .day, value: toMonday, to: now) {
            add("Monday morning", calendar.date(bySettingHour: 9, minute: 0, second: 0, of: monday))
        }
        return Array(out.prefix(3))
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(quickPicks, id: \.label) { pick in
                        Button {
                            submit(pick.at)
                        } label: {
                            HStack {
                                Text(pick.label)
                                Spacer()
                                Text(pick.at, format: .dateTime.weekday().hour().minute())
                                    .foregroundStyle(.secondary)
                            }
                        }
                        .buttonStyle(.plain)
                    }
                    Button("Pick a time…") { showingCustom = true }
                        .buttonStyle(.plain)
                } footer: {
                    Text("The server holds and sends the draft, so this app can be closed.")
                }

                if showingCustom {
                    Section {
                        DatePicker(
                            "Send at",
                            selection: $custom,
                            in: Date()...,
                            displayedComponents: [.date, .hourAndMinute]
                        )
                        Button("Schedule") { submit(custom) }
                            .disabled(saving)
                    }
                }

                if let error {
                    Section { Text(error).foregroundStyle(OS1VisualStyle.redInk) }
                }
            }
            .navigationTitle("Send later")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
            .disabled(saving)
        }
        #if os(iOS)
        .presentationDetents([.medium, .large])
        #endif
    }

    private func submit(_ at: Date) {
        guard !saving else { return }
        saving = true
        error = nil
        Task {
            let failure = await onSchedule(at)
            saving = false
            if let failure {
                error = failure
            } else {
                dismiss()
            }
        }
    }
}

#if os(iOS)
/// UIKit's camera, wrapped — SwiftUI has no camera picker of its own, and the
/// photo library picker can't take a new shot.
struct CameraPicker: UIViewControllerRepresentable {
    static var isAvailable: Bool {
        UIImagePickerController.isSourceTypeAvailable(.camera)
    }

    let onCapture: (Data) -> Void

    @Environment(\.dismiss) private var dismiss

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ picker: UIImagePickerController, context: Context) {}

    final class Coordinator: NSObject, UIImagePickerControllerDelegate,
        UINavigationControllerDelegate
    {
        private let parent: CameraPicker

        init(_ parent: CameraPicker) { self.parent = parent }

        func imagePickerController(
            _ picker: UIImagePickerController,
            didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]
        ) {
            // The raw capture is re-encoded by AttachedImage (downscale +
            // JPEG), so hand over the least-lossy data we have.
            if let image = info[.originalImage] as? UIImage,
               let data = image.jpegData(compressionQuality: 0.95) {
                parent.onCapture(data)
            }
            parent.dismiss()
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            parent.dismiss()
        }
    }
}
#endif
