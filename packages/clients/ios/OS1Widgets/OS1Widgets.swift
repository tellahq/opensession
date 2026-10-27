import AppIntents
import SwiftUI
import WidgetKit

/// The Home Screen, Lock Screen and Control Center faces of "Start an Agent".
///
/// Everything here is one gesture: press, and the app opens on the new-session
/// composer with the mic already listening (`StartAgentIntent`, shared with the
/// app target — the same intent Siri, Spotlight and the Action Button run).
/// The static widgets never talk to the server or hold a token. The Live
/// Activity below receives its bounded state from ActivityKit, through the host
/// app or APNs, and likewise performs no network access itself.
@main
struct OS1Widgets: WidgetBundle {
    var body: some Widget {
        StartAgentWidget()
        StartAgentControl()
        ActiveSessionsLiveActivity()
        DeskCallLiveActivity()
    }
}

// MARK: - Home Screen / Lock Screen

/// A static widget: one entry, no timeline. There is nothing to refresh.
struct StartAgentProvider: TimelineProvider {
    struct Entry: TimelineEntry { let date = Date() }

    func placeholder(in context: Context) -> Entry { Entry() }

    func getSnapshot(in context: Context, completion: @escaping (Entry) -> Void) {
        completion(Entry())
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<Entry>) -> Void) {
        completion(Timeline(entries: [Entry()], policy: .never))
    }
}

struct StartAgentWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(
            kind: "dev.tella.os1.widget.start-agent",
            provider: StartAgentProvider()
        ) { _ in
            StartAgentTile()
        }
        .configurationDisplayName("Start an Agent")
        .description("Speak an idea and start a session on it.")
        .supportedFamilies([.systemSmall, .accessoryCircular, .accessoryRectangular])
    }
}

struct StartAgentTile: View {
    @Environment(\.widgetFamily) private var family

    var body: some View {
        // One button filling the whole widget: the entire tile is the target,
        // so there is no way to tap it and have nothing happen.
        Button(intent: StartAgentIntent()) {
            switch family {
            case .accessoryCircular: circular
            case .accessoryRectangular: rectangular
            default: small
            }
        }
        .buttonStyle(.plain)
    }

    /// Home Screen. The composer's own send disc, enlarged: an accent circle
    /// with the mic in its inverse, over the app's plain background — the
    /// widget should read as the app it opens, not as a coloured badge.
    private var small: some View {
        VStack(alignment: .leading, spacing: 0) {
            ZStack {
                Circle().fill(WidgetStyle.accent)
                Image(systemName: "mic.fill")
                    .font(.system(size: 20, weight: .semibold))
                    .foregroundStyle(WidgetStyle.onAccent)
            }
            .frame(width: 44, height: 44)

            Spacer(minLength: 8)

            Text("Start an agent")
                .font(.headline)
                .foregroundStyle(WidgetStyle.text)
            Text("Speak an idea")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .containerBackground(WidgetStyle.background, for: .widget)
    }

    /// Lock Screen, round. Accessory widgets are drawn as a stencil — the
    /// system tints them — so this is glyph-only over the standard backdrop.
    private var circular: some View {
        ZStack {
            AccessoryWidgetBackground()
            Image(systemName: "mic.fill")
                .font(.system(size: 18, weight: .semibold))
        }
        .containerBackground(.clear, for: .widget)
    }

    private var rectangular: some View {
        HStack(spacing: 6) {
            Image(systemName: "mic.fill")
                .font(.system(size: 14, weight: .semibold))
            Text("Start an agent")
                .font(.headline)
            Spacer(minLength: 0)
        }
        .containerBackground(.clear, for: .widget)
    }
}

// MARK: - Control Center / Action Button

/// A control, which is where this belongs most: iOS puts controls in Control
/// Center, on the Lock Screen, AND in the Action Button's picker, so binding
/// it needs no shortcut at all.
struct StartAgentControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: "dev.tella.os1.control.start-agent") {
            ControlWidgetButton(action: StartAgentIntent()) {
                Label("Start an Agent", systemImage: "mic.fill")
            }
        }
        .displayName("Start an Agent")
        .description("Open the composer with the mic listening.")
    }
}

// MARK: - Palette

/// The app's monochrome palette, restated for the extension. `OS1VisualStyle`
/// lives in the app target and pulls in the whole view layer with it; a widget
/// needs four colours, so it carries its own copy rather than the dependency.
/// Keep the two in step.
enum WidgetStyle {
    static let background = Color(uiColor: .systemBackground)
    static let text = Color(uiColor: .label)
    /// Black on light, white on dark — the brand fill, as in the app.
    static let accent = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark ? .white : .black
    })
    static let onAccent = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark ? .black : .white
    })
}
