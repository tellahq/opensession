import ActivityKit
import AppIntents
import SwiftUI
import WidgetKit

/// A Desk voice call that is running while you do something else: the call
/// timer and what the Desk is doing in the Dynamic Island, mute and hang-up
/// when you expand it or look at the Lock Screen. Tapping it opens the app on
/// the full call screen. The buttons run their intents in the app, where the
/// call is (`DeskCallMuteIntent`, `DeskCallHangUpIntent`).
struct DeskCallLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: DeskCallAttributes.self) { context in
            DeskCallLockScreen(context: context)
                .activityBackgroundTint(WidgetStyle.background)
                .activitySystemActionForegroundColor(WidgetStyle.text)
                .widgetURL(DeskCallLink.url)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Label(context.attributes.title, systemImage: "lamp.desk")
                        .font(.headline)
                        .lineLimit(1)
                        .padding(.leading, 4)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    DeskCallTimer(startedAt: context.attributes.startedAt)
                        .font(.headline)
                        .foregroundStyle(.secondary)
                        .padding(.trailing, 4)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    HStack(spacing: 12) {
                        DeskCallStatus(state: context.state)
                            .font(.subheadline)
                        Spacer(minLength: 8)
                        DeskCallButtons(state: context.state)
                    }
                    .padding(.horizontal, 4)
                    .padding(.top, 6)
                }
            } compactLeading: {
                DeskCallGlyph(state: context.state)
            } compactTrailing: {
                DeskCallTimer(startedAt: context.attributes.startedAt)
                    .font(.caption.weight(.semibold))
                    .frame(maxWidth: 44)
            } minimal: {
                DeskCallGlyph(state: context.state)
            }
            .keylineTint(WidgetStyle.accent)
            .widgetURL(DeskCallLink.url)
        }
    }
}

private struct DeskCallLockScreen: View {
    let context: ActivityViewContext<DeskCallAttributes>

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "lamp.desk")
                .font(.title3.weight(.medium))
                .foregroundStyle(WidgetStyle.accent)
                .frame(width: 28)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(context.attributes.title)
                        .font(.headline)
                        .lineLimit(1)
                    DeskCallTimer(startedAt: context.attributes.startedAt)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                DeskCallStatus(state: context.state)
                    .font(.subheadline)
            }
            Spacer(minLength: 8)
            DeskCallButtons(state: context.state)
        }
        .padding(14)
    }
}

/// Time on the call. Counted by the system, so the app never has to update
/// the Activity to keep it moving.
private struct DeskCallTimer: View {
    let startedAt: Date

    var body: some View {
        Text(timerInterval: startedAt...Date.distantFuture, countsDown: false)
            .monospacedDigit()
            .multilineTextAlignment(.trailing)
    }
}

private struct DeskCallGlyph: View {
    let state: DeskCallAttributes.ContentState

    var body: some View {
        Image(systemName: symbol)
            .foregroundStyle(state.muted || state.phase == .failed ? .secondary : WidgetStyle.accent)
            .contentTransition(.symbolEffect(.replace))
            .accessibilityLabel(state.muted ? "Desk call, muted" : "Desk call, \(state.phase.label)")
    }

    private var symbol: String {
        if state.muted { return "mic.slash.fill" }
        switch state.phase {
        case .connecting: return "phone.arrow.up.right"
        case .listening: return "waveform"
        case .thinking: return "ellipsis"
        case .speaking: return "speaker.wave.2.fill"
        case .working: return "hammer.fill"
        case .failed: return "phone.down.fill"
        }
    }
}

private struct DeskCallStatus: View {
    let state: DeskCallAttributes.ContentState

    var body: some View {
        HStack(spacing: 6) {
            DeskCallGlyph(state: state)
            Text(state.muted && state.phase != .failed ? "Muted" : state.phase.label)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
    }
}

private struct DeskCallButtons: View {
    let state: DeskCallAttributes.ContentState

    var body: some View {
        if state.phase != .failed {
            HStack(spacing: 10) {
                Button(intent: DeskCallMuteIntent()) {
                    Image(systemName: state.muted ? "mic.slash.fill" : "mic.fill")
                        .font(.system(size: 17, weight: .semibold))
                        .foregroundStyle(state.muted ? WidgetStyle.onAccent : WidgetStyle.text)
                        .frame(width: 44, height: 44)
                        .background(
                            Circle().fill(state.muted ? WidgetStyle.accent : Color.secondary.opacity(0.25))
                        )
                }
                .buttonStyle(.plain)
                .accessibilityLabel(state.muted ? "Unmute" : "Mute")

                Button(intent: DeskCallHangUpIntent()) {
                    Image(systemName: "phone.down.fill")
                        .font(.system(size: 17, weight: .semibold))
                        .foregroundStyle(.white)
                        .frame(width: 44, height: 44)
                        .background(Circle().fill(.red))
                }
                .buttonStyle(.plain)
                .accessibilityLabel("End the call")
            }
        }
    }
}
