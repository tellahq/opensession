import Foundation

/// One vocabulary for how a Runner is doing.
///
/// Two different server fields answer that question, and a person reading both
/// screens should not have to learn two sets of words: the instance list
/// (`GET /api/runners`) reports a machine's connection `state`, while a
/// session's own Runner reference reports the `lifecycle` of that session's
/// workspace on it. Both land here.
enum RunnerStatus: Equatable, Sendable {
    case ready
    case busy
    case preparing
    case offline
    case needsAttention
    case maintenance

    /// A machine's connection state, as the instance list reports it. An
    /// unrecognized state is treated as offline rather than guessed at: a
    /// machine the server won't describe is not one to send work to.
    init(state: String?) {
        switch state {
        case "online": self = .ready
        case "busy": self = .busy
        case "maintenance": self = .maintenance
        default: self = .offline
        }
    }

    /// One session's workspace on a Runner. Anything the server hasn't named
    /// yet is still being prepared, which is what the web badge shows too.
    init(lifecycle: String?) {
        switch lifecycle {
        case "awake": self = .ready
        case "offline": self = .offline
        case "needs_attention": self = .needsAttention
        default: self = .preparing
        }
    }

    var label: String {
        switch self {
        case .ready: "Ready"
        case .busy: "Busy"
        case .preparing: "Preparing"
        case .offline: "Offline"
        case .needsAttention: "Needs attention"
        case .maintenance: "Maintenance"
        }
    }

    var icon: String {
        switch self {
        case .ready: "checkmark.circle"
        case .busy: "circle.dotted"
        case .preparing: "clock"
        case .offline: "wifi.slash"
        case .needsAttention: "exclamationmark.triangle"
        case .maintenance: "wrench.and.screwdriver"
        }
    }
}

/// A machine registered with this instance, as `GET /api/runners` reports it.
///
/// Everything but the identity is optional: the server keeps growing this
/// record, and an older app build has to keep decoding it. Note what is NOT
/// here — the instance list carries no lifecycle and no last lifecycle error.
/// Those exist only on a session's assignment to a Runner (`SessionRunner`),
/// because they describe one workspace rather than the machine.
struct WorkspaceRunner: Codable, Equatable, Sendable, Identifiable {
    struct Gpu: Codable, Equatable, Sendable {
        let kind: String?
        let model: String?
        let vramGb: Double?
    }

    struct Resources: Codable, Equatable, Sendable {
        let cpuCores: Int?
        let memoryGb: Double?
        let freeDiskGb: Double?
        let gpu: Gpu?
    }

    struct Capabilities: Codable, Equatable, Sendable {
        let toolchains: [String]?
        let tags: [String]?
    }

    struct Workload: Codable, Equatable, Sendable {
        let sessionId: String?
        let operation: String?
        let startedAt: String?
    }

    let id: String
    let name: String
    let label: String?
    let description: String?
    let location: String?
    let platform: String?
    let arch: String?
    let state: String?
    let lastSeenAt: String?
    let softwareVersion: String?
    let workspaceRoots: [String]?
    let capabilities: Capabilities?
    let resources: Resources?
    let workload: Workload?

    /// What to call this machine: an operator's label when there is one, and
    /// otherwise the name the machine registered under.
    var displayName: String {
        if let label, !label.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return label
        }
        return name
    }

    var status: RunnerStatus { RunnerStatus(state: state) }

    /// Platform, architecture and hardware in one line, in the order the web
    /// panel reads them. Empty when the machine reported none of it.
    var hardwareSummary: String {
        var parts: [String] = []
        if let platform, !platform.isEmpty { parts.append(platformLabel(platform)) }
        if let arch, !arch.isEmpty { parts.append(arch) }
        if let cores = resources?.cpuCores { parts.append("\(cores) cores") }
        if let memory = resources?.memoryGb { parts.append("\(number(memory)) GB") }
        if let gpu = resources?.gpu?.model, !gpu.isEmpty {
            if let vram = resources?.gpu?.vramGb {
                parts.append("\(gpu) · \(number(vram)) GB VRAM")
            } else {
                parts.append(gpu)
            }
        }
        return parts.joined(separator: " · ")
    }

    /// What this machine is doing right now, when it claimed something.
    var workloadSummary: String? {
        guard let workload else { return nil }
        let described = [workload.operation, workload.sessionId]
            .compactMap { $0 }
            .first { !$0.isEmpty }
        guard let described else { return nil }
        return described
    }

    private func platformLabel(_ value: String) -> String {
        switch value {
        case "darwin": "macOS"
        case "linux": "Linux"
        case "win32": "Windows"
        default: value
        }
    }

    private func number(_ value: Double) -> String {
        value == value.rounded()
            ? String(Int(value))
            : String(format: "%.1f", value)
    }
}

struct WorkspaceRunnersResponse: Codable, Sendable {
    let runners: [WorkspaceRunner]?
}
