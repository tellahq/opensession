import SwiftUI

/// Settings → Keychain: the credentials people lend to sessions.
///
/// A credential is a secret this instance holds on its owner's behalf. A
/// session asks for it, the owner approves, and the server either proxies the
/// call with the secret injected (an API credential, so the agent never sees
/// it) or hands the password over for a sign-in page (a login, which the agent
/// can read). Mirrors `KeychainPanel.tsx` on the web: requests only the owner
/// can answer, the signed-in person's own requests waiting on someone else,
/// what is lent out, and the credentials themselves. No secret is shown or
/// kept anywhere on this screen.
struct KeychainSettingsView: View {
    @State private var response: KeychainResponse? = SettingsCache.value("keychain")
    @State private var loading = true
    @State private var error: String?
    @State private var adding: KeychainCredentialDraft.Kind?
    @State private var revoking: KeychainGrant?
    @State private var deleting: KeychainCredential?
    @State private var answering: Set<String> = []

    var body: some View {
        container
        .navigationTitle("Keychain")
        .inlineTitleBarCompat()
        .task {
            await load()
            #if DEBUG
            if let kind = ProcessInfo.processInfo.environment["OS1_KEYCHAIN_EDITOR"]
                .flatMap(KeychainCredentialDraft.Kind.init(rawValue:)) {
                adding = kind
            }
            #endif
        }
        .refreshable { await load() }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Menu {
                    Button { adding = .api } label: { Label("Add API credential", systemImage: "key") }
                    Button { adding = .login } label: { Label("Add login", systemImage: "person.badge.key") }
                } label: {
                    Label("Add", systemImage: "plus")
                }
                .disabled(response == nil)
            }
        }
        .sheet(item: $adding) { kind in
            // The editor is a fresh view on every presentation, so a typed
            // secret never outlives the sheet that held it.
            KeychainCredentialEditor(initialKind: kind) { body in
                _ = try await SettingsAPI.addKeychainCredential(body)
                adding = nil
                await load()
            }
        }
        .alert(
            "Revoke this grant?",
            isPresented: Binding(get: { revoking != nil }, set: { if !$0 { revoking = nil } }),
            presenting: revoking
        ) { grant in
            Button("Revoke", role: .destructive) { Task { await revoke(grant) } }
            Button("Cancel", role: .cancel) {}
        } message: { grant in
            Text("The session loses access to \(serviceName(grant.credentialId)) immediately.")
        }
        .alert(
            "Delete this credential?",
            isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }),
            presenting: deleting
        ) { credential in
            Button("Delete", role: .destructive) { Task { await delete(credential) } }
            Button("Cancel", role: .cancel) {}
        } message: { credential in
            Text("Every grant on \(credential.service ?? "this credential") stops working.")
        }
    }

    /// A grouped Form on the Mac, where a List row in a Settings pane clips
    /// to one line and would hide a row's detail and its answer buttons.
    @ViewBuilder private var container: some View {
        #if os(macOS)
        Form { content }.formStyle(.grouped)
        #else
        List { content }.insetGroupedListCompat()
        #endif
    }

    @ViewBuilder private var content: some View {
        if loading, response == nil { settingsLoadingRow }
        if let error { settingsErrorRow(error) { Task { await load() } } }

        if response != nil {
            // Asks first: something is waiting on a person, and the rest of
            // the page is standing state that is not.
            if toAnswer.isEmpty == false { requestsSection }
            if waiting.isEmpty == false { waitingSection }
            if activeGrants.isEmpty == false { grantsSection }
            credentialsSection
        }
    }

    // MARK: Sections

    private var requestsSection: some View {
        Section {
            ForEach(toAnswer, id: \.id) { ask in
                VStack(alignment: .leading, spacing: 6) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text("\(ask.requestedBy ?? "Someone") wants \(askServices(ask))")
                        Text(KeychainPresentation.askDetail(ask))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    HStack(spacing: 16) {
                        ForEach(KeychainDecision.choices(for: ask), id: \.self) { decision in
                            Button(decision.label, role: decision == .decline ? .destructive : nil) {
                                Task { await answer(ask, decision) }
                            }
                            .fontWeight(decision == KeychainDecision.choices(for: ask).last ? .semibold : .regular)
                        }
                    }
                    .buttonStyle(.borderless)
                    .font(.subheadline)
                    .disabled(answering.contains(ask.id ?? ""))
                }
                .padding(.vertical, 2)
            }
        } header: {
            Text("Requests for your credentials")
        } footer: {
            Text("Allow once covers one API call, Allow run one script while it runs. The session never sees those secrets. Release password hands a login's password to the session, which can read it.")
        }
    }

    private var waitingSection: some View {
        Section {
            ForEach(waiting, id: \.id) { ask in
                VStack(alignment: .leading, spacing: 3) {
                    Text("\(serviceName(ask.credentialId)) · waiting on \(ask.owner ?? "its owner")")
                    Text(waitingDetail(ask))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .padding(.vertical, 2)
            }
        } header: {
            Text("Your pending requests")
        } footer: {
            Text("Only a credential's owner can answer, here or in their direct message.")
        }
    }

    private var grantsSection: some View {
        Section {
            ForEach(activeGrants, id: \.id) { grant in
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text("\(serviceName(grant.credentialId)) → \(grant.requestedBy ?? "a session")")
                        Text(KeychainPresentation.grantDetail(grant, expiry: expiry(grant)))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 12)
                    Button("Revoke", role: .destructive) { revoking = grant }
                        .buttonStyle(.borderless)
                }
                .padding(.vertical, 2)
            }
        } header: {
            Text("Active grants")
        } footer: {
            Text("A grant is a session's temporary permission to use one credential. Revoking takes it back straight away.")
        }
    }

    private var credentialsSection: some View {
        Section {
            if credentials.isEmpty {
                Text("No credentials yet. Add one so sessions can ask for scoped access without a token in a prompt.")
                    .foregroundStyle(.secondary)
            }
            ForEach(credentials, id: \.id) { credential in
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(credential.title)
                        if let detail = credential.detail, detail.isEmpty == false {
                            Text(detail).font(.caption).foregroundStyle(.secondary)
                        }
                        Text(credential.scopeSummary)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 12)
                    if credential.canDelete {
                        Button(role: .destructive) { deleting = credential } label: {
                            Label("Delete \(credential.service ?? "credential")", systemImage: "trash")
                        }
                        .labelStyle(.iconOnly)
                        .buttonStyle(.borderless)
                        #if os(iOS)
                        .frame(minWidth: 44, minHeight: 44)
                        #endif
                    }
                }
                .padding(.vertical, 2)
            }
        } header: {
            Text("Credentials")
        } footer: {
            Text("Any teammate's session can ask to borrow one, and its owner approves. An API secret is injected server-side, so the agent never sees it. A login's password reaches the agent once released, so add only test accounts.")
        }
    }

    // MARK: Data

    private var credentials: [KeychainCredential] {
        (response?.credentials ?? []).filter { $0.id?.isEmpty == false }
    }
    private var activeGrants: [KeychainGrant] {
        (response?.grants ?? []).filter { $0.id?.isEmpty == false && $0.isActive }
    }
    private var toAnswer: [KeychainAsk] { KeychainPresentation.asksToAnswer(response?.asks ?? []) }
    private var waiting: [KeychainAsk] { KeychainPresentation.asksWaiting(response?.asks ?? []) }

    /// A grant names a credential by id, which says nothing to a person.
    private func serviceName(_ credentialId: String?) -> String {
        credentials.first { $0.id == credentialId }?.service ?? credentialId ?? "Credential"
    }

    /// A grouped run is one answer for every credential of yours in it.
    private func askServices(_ ask: KeychainAsk) -> String {
        KeychainPresentation.sameRun(ask, in: response?.asks ?? [])
            .map { serviceName($0.credentialId) }
            .joined(separator: " and ")
    }

    private func waitingDetail(_ ask: KeychainAsk) -> String {
        let purpose = ask.purpose.flatMap { $0.isEmpty ? nil : $0 } ?? "No reason given"
        if let run = ask.run { return "\(KeychainPresentation.runSummary(run)) · \(purpose)" }
        return [KeychainPresentation.modeLabel(ask.requestedMode), purpose].compactMap { $0 }.joined(separator: " · ")
    }

    private func expiry(_ grant: KeychainGrant) -> String? {
        AccountUsageReading.formatReset(grant.expiresAt)?.replacingOccurrences(of: "resets", with: "expires")
    }

    private func load() async {
        loading = true; error = nil
        do {
            let fetched = try await SettingsAPI.keychain()
            response = fetched
            SettingsCache.save("keychain", fetched)
        } catch { self.error = error.localizedDescription }
        loading = false
    }

    private func answer(_ ask: KeychainAsk, _ decision: KeychainDecision) async {
        guard let id = ask.id else { return }
        answering.insert(id)
        defer { answering.remove(id) }
        do {
            _ = try await SettingsAPI.answerKeychainAsk(id: id, decision: decision)
            await load()
        } catch { self.error = error.localizedDescription }
    }

    private func revoke(_ grant: KeychainGrant) async {
        guard let id = grant.id else { return }
        do {
            _ = try await SettingsAPI.revokeKeychainGrant(id: id)
            await load()
        } catch { self.error = error.localizedDescription }
        revoking = nil
    }

    private func delete(_ credential: KeychainCredential) async {
        guard let id = credential.id else { return }
        do {
            _ = try await SettingsAPI.deleteKeychainCredential(id: id)
            await load()
        } catch { self.error = error.localizedDescription }
        deleting = nil
    }
}

/// Adding a credential: an API key the server injects, or a login a session
/// types into a sign-in page. The form says, where the secret is typed, which
/// of the two the agent can read. Nothing typed here is saved on the device:
/// the draft lives in this view's state, the secret is cleared on save, and
/// cancelling throws the whole view away.
private struct KeychainCredentialEditor: View {
    let onSave: ([String: Any]) async throws -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var draft: KeychainCredentialDraft
    @State private var saving = false
    @State private var saveError: String?

    init(initialKind: KeychainCredentialDraft.Kind, onSave: @escaping ([String: Any]) async throws -> Void) {
        self.onSave = onSave
        var draft = KeychainCredentialDraft()
        draft.kind = initialKind
        #if DEBUG
        // Screenshot hook: a placeholder-filled form, so the validation copy
        // can be captured without driving the keyboard.
        if ProcessInfo.processInfo.environment["OS1_KEYCHAIN_DRAFT_FIXTURE"] == "1" {
            draft.service = "acme-staging"
            draft.loginUrl = "http://app.example.test/login"
            draft.username = "qa@example.test"
            draft.secret = "placeholder"
            draft.host = "api.example.test"
            draft.methods = "GET, FETCH"
        }
        #endif
        _draft = State(initialValue: draft)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("Kind", selection: $draft.kind) {
                        ForEach(KeychainCredentialDraft.Kind.allCases) { kind in
                            Text(kind.label).tag(kind)
                        }
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()
                }

                if draft.kind == .api { apiFields } else { loginFields }

                if let message = saveError ?? draft.issue {
                    Section {
                        Label(message, systemImage: "exclamationmark.triangle")
                            .foregroundStyle(.red)
                            .font(.subheadline)
                    }
                }
            }
            .navigationTitle(draft.kind == .api ? "Add credential" : "Add login")
            .inlineTitleBarCompat()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Add") { Task { await save() } }
                        .disabled(draft.isReady == false || saving)
                }
            }
            .onChange(of: draft) { saveError = nil }
            #if os(macOS)
            .formStyle(.grouped)
            .frame(minWidth: 460, minHeight: 560)
            #endif
        }
    }

    @ViewBuilder private var apiFields: some View {
        Section {
            TextField("Service, e.g. vercel", text: $draft.service)
                .autocorrectionDisabled()
                .noAutocapitalizationCompat()
            TextField("API host, e.g. api.vercel.com", text: $draft.host)
                .urlFieldCompat()
                .autocorrectionDisabled()
            SecureField("Secret", text: $draft.secret)
                .autocorrectionDisabled()
                .noAutocapitalizationCompat()
            TextField("What it is for", text: $draft.detail)
        } footer: {
            Text("A session borrows it with your approval. The secret is injected server-side, so the agent never sees it. It is never shown again, and this device does not keep it.")
        }

        Section {
            TextField("Methods, e.g. GET, POST", text: $draft.methods)
                .autocorrectionDisabled()
                .noAutocapitalizationCompat()
            TextField("Path prefixes, e.g. /v1/projects", text: $draft.pathPrefixes)
                .autocorrectionDisabled()
                .noAutocapitalizationCompat()
            Toggle("Return only the status code", isOn: $draft.statusOnly)
        } header: {
            Text("Scope")
        } footer: {
            Text("Leave a field empty to allow all of it. A grant can only reach what the credential allows. Status only is for an API that might echo the secret back: sessions see the HTTP status, never the response.")
        }

        Section {
            TextField("Header, default Authorization", text: $draft.header)
                .autocorrectionDisabled()
                .noAutocapitalizationCompat()
            TextField("Scheme, default Bearer", text: $draft.scheme)
                .autocorrectionDisabled()
                .noAutocapitalizationCompat()
        } header: {
            Text("Injection")
        } footer: {
            Text("How the secret rides the request.")
        }
    }

    @ViewBuilder private var loginFields: some View {
        Section {
            TextField("Service, e.g. acme-staging", text: $draft.service)
                .autocorrectionDisabled()
                .noAutocapitalizationCompat()
            TextField("Sign-in page, https://…", text: $draft.loginUrl)
                .urlFieldCompat()
                .autocorrectionDisabled()
            TextField("Username", text: $draft.username)
                .autocorrectionDisabled()
                .noAutocapitalizationCompat()
            SecureField("Password", text: $draft.secret)
                .autocorrectionDisabled()
                .noAutocapitalizationCompat()
            TextField("What it is for", text: $draft.detail)
        } footer: {
            Text("Add only test accounts. You approve each release, and the agent types the password into the sign-in page, so it can read it. This device does not keep it.")
        }
    }

    private func save() async {
        guard draft.isReady else { return }
        saving = true
        defer { saving = false }
        do {
            try await onSave(draft.payload)
            draft.secret = ""
        } catch {
            saveError = error.localizedDescription
        }
    }
}
