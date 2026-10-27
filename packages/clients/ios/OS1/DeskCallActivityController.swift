#if os(iOS)
import ActivityKit
import AVFoundation
import UIKit

/// Puts the Desk voice call in the Dynamic Island and on the Lock Screen, and
/// runs "Talk to Desk" presses.
///
/// Every Desk call gets a Live Activity, however it started. That is what lets
/// a call keep going once the app leaves the screen: the Activity is the
/// call's visible face (the system's own rule for `AudioRecordingIntent`, and
/// ours for any open mic), and it carries mute and hang-up buttons. When the
/// Activity cannot be shown, the call is held to the old rule and ends with
/// the Desk sheet.
@MainActor
final class DeskCallActivityController {
    private static let shared = DeskCallActivityController()

    private let engine = DeskVoiceEngine.desk
    private var activity: Activity<DeskCallAttributes>?
    private var lastContent: DeskCallAttributes.ContentState?

    /// Called once at launch, before any intent can run.
    static func install() {
        shared.attach()
    }

    private func attach() {
        engine.onCallChange = { [weak self] in self?.sync() }
        DeskCallHooks.start = { [weak self] intent in try await self?.start(from: intent) }
        DeskCallHooks.toggleMute = { [weak self] in self?.engine.toggleMute() }
        DeskCallHooks.hangUp = { [weak self] in self?.engine.stop() }
        // A call never outlives its process, so any Activity still up from
        // an earlier launch is showing a call that is gone.
        for stale in Activity<DeskCallAttributes>.activities {
            Task { await stale.end(nil, dismissalPolicy: .immediate) }
        }
        NotificationCenter.default.addObserver(
            forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main
        ) { _ in
            Task { @MainActor in DeskCallActivityController.shared.surfaceRunningCall() }
        }
    }

    /// Coming back to the app during a call opens the call screen, the way
    /// the Phone app does. The system hides the Dynamic Island while the app
    /// is open, so otherwise a call started from the Action Button would be
    /// running with nothing on screen.
    private func surfaceRunningCall() {
        guard engine.active, !engine.callPresented else { return }
        DeskCallRequest.shared.ask()
    }

    // MARK: - Talk to Desk

    private func start(from intent: TalkToDeskIntent) async throws {
        let foreground = UIApplication.shared.applicationState == .active
        if engine.active {
            // A second press from outside the app hangs up, the way a press
            // stops a Voice Memos recording. Inside the app it brings the call
            // screen back.
            if foreground {
                DeskCallRequest.shared.ask()
            } else {
                engine.stop()
            }
            return
        }
        if foreground {
            DeskCallRequest.shared.ask()
            return
        }
        // The mic prompt can only appear in the app, and without a Live
        // Activity the system will not let a background call record.
        guard AVAudioApplication.shared.recordPermission == .granted,
              ActivityAuthorizationInfo().areActivitiesEnabled
        else {
            try await intent.continueInForeground(nil, alwaysConfirm: false)
            DeskCallRequest.shared.ask()
            return
        }
        // Awaited: the intent's background grant has to cover opening the mic.
        // `start()` returns once the audio is running.
        await engine.start()
    }

    // MARK: - Live Activity

    private func sync() {
        guard let phase = Self.phase(for: engine.state) else {
            end(showing: nil)
            return
        }
        let content = DeskCallAttributes.ContentState(phase: phase, muted: engine.muted)
        if phase == .failed {
            end(showing: content)
            return
        }
        if let activity {
            guard content != lastContent else { return }
            lastContent = content
            Task { await activity.update(ActivityContent(state: content, staleDate: nil)) }
            return
        }
        do {
            activity = try Activity.request(
                attributes: DeskCallAttributes(title: engine.callTitle, startedAt: Date()),
                content: ActivityContent(state: content, staleDate: nil),
                pushType: nil
            )
            lastContent = content
            engine.shownOutsideApp = true
        } catch {
            engine.shownOutsideApp = false
            // A call nobody can see must not keep the mic open. Deferred:
            // this runs inside the engine's own state change.
            if UIApplication.shared.applicationState != .active {
                Task { [engine] in engine.stop() }
            }
        }
    }

    /// End the Activity. A failed call stays up briefly so the Island says
    /// what happened; a hang-up clears it at once.
    private func end(showing content: DeskCallAttributes.ContentState?) {
        engine.shownOutsideApp = false
        lastContent = nil
        guard let activity else { return }
        self.activity = nil
        let policy: ActivityUIDismissalPolicy = content == nil
            ? .immediate
            : .after(Date().addingTimeInterval(8))
        Task {
            await activity.end(
                content.map { ActivityContent(state: $0, staleDate: nil) },
                dismissalPolicy: policy
            )
        }
    }

    private static func phase(for state: DeskVoiceState) -> DeskCallPhase? {
        switch state {
        case .idle: nil
        case .connecting: .connecting
        case .listening: .listening
        case .thinking: .thinking
        case .speaking: .speaking
        case .action: .working
        case .error: .failed
        }
    }
}
#endif
