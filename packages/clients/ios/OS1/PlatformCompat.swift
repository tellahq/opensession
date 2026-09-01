import SwiftUI
#if canImport(UIKit)
import UIKit
#else
import AppKit
#endif

// Cross-platform shims so the views share one code path between iOS and macOS.

/// The platform's font class, for the places that have to MEASURE text rather
/// than hand it to SwiftUI — a markdown table sizes its columns from real
/// glyph widths (`MarkdownTableView`).
#if os(iOS)
typealias PlatformFont = UIFont
#else
typealias PlatformFont = NSFont
#endif

/// Lifecycle signals that do not enter SwiftUI's environment graph.
///
/// A scene-phase environment update walks the view graph before it reaches an
/// `onChange` handler. That is expensive enough to trip the background
/// watchdog when a long transcript is open, even if the handler lives in a
/// small child view. Platform notifications deliver the same events without
/// invalidating any rendered view.
@MainActor
enum AppLifecycle {
    static var isActive: Bool {
        #if os(iOS)
        UIApplication.shared.applicationState == .active
        #else
        NSApplication.shared.isActive
        #endif
    }

    static var didBecomeActiveNotification: Notification.Name {
        #if os(iOS)
        UIApplication.didBecomeActiveNotification
        #else
        NSApplication.didBecomeActiveNotification
        #endif
    }

    static var willResignActiveNotification: Notification.Name {
        #if os(iOS)
        UIApplication.willResignActiveNotification
        #else
        NSApplication.willResignActiveNotification
        #endif
    }

    static var didEnterBackgroundNotification: Notification.Name {
        #if os(iOS)
        UIApplication.didEnterBackgroundNotification
        #else
        NSApplication.didHideNotification
        #endif
    }
}

extension ToolbarItemPlacement {
    /// `.topBarTrailing` / `.topBarLeading` don't exist on macOS; map them to
    /// the equivalent slots in a Mac toolbar.
    static var topTrailingCompat: ToolbarItemPlacement {
        #if os(iOS)
        .topBarTrailing
        #else
        .primaryAction
        #endif
    }

    static var topLeadingCompat: ToolbarItemPlacement {
        #if os(iOS)
        .topBarLeading
        #else
        .navigation
        #endif
    }
}

extension View {
    /// Warm transcript surfaces on iOS; retain SwiftUI's hierarchical fill on
    /// macOS so the desktop app continues to follow the system appearance.
    @ViewBuilder
    func transcriptPanelCompat<S: Shape>(in shape: S) -> some View {
        #if os(iOS)
        background(OS1VisualStyle.panel, in: shape)
        #else
        background(.fill.tertiary, in: shape)
        #endif
    }

    /// The person's own messages get the same neutral gray bubble on both
    /// platforms (`OS1VisualStyle.userMessage` resolves per appearance).
    /// `tint` overrides it for a message that is somebody else's words.
    func userMessagePanelCompat<S: Shape>(
        in shape: S,
        tint: Color? = nil
    ) -> some View {
        background(tint ?? OS1VisualStyle.userMessage, in: shape)
    }

    /// Inline nav-bar title on iOS; titles are inline by nature on macOS.
    @ViewBuilder
    func inlineTitleBarCompat() -> some View {
        #if os(iOS)
        navigationBarTitleDisplayMode(.inline)
        #else
        self
        #endif
    }

    /// URL-entry field traits — software-keyboard concepts that only exist on iOS.
    @ViewBuilder
    func urlFieldCompat() -> some View {
        #if os(iOS)
        keyboardType(.URL)
            .textContentType(.URL)
            .textInputAutocapitalization(.never)
        #else
        self
        #endif
    }

    @ViewBuilder
    func noAutocapitalizationCompat() -> some View {
        #if os(iOS)
        textInputAutocapitalization(.never)
        #else
        self
        #endif
    }

    /// Interactive keyboard dismissal only exists on iOS.
    @ViewBuilder
    func scrollDismissesKeyboardCompat() -> some View {
        #if os(iOS)
        scrollDismissesKeyboard(.interactively)
        #else
        self
        #endif
    }

    /// Immediate dismissal keeps a bottom safe-area bar from being parked
    /// behind a still-visible keyboard during an interrupted swipe.
    @ViewBuilder
    func scrollDismissesKeyboardImmediatelyCompat() -> some View {
        #if os(iOS)
        scrollDismissesKeyboard(.immediately)
        #else
        self
        #endif
    }

    /// `.insetGrouped` is iOS-only; `.inset` is the closest Mac list style.
    @ViewBuilder
    func insetGroupedListCompat() -> some View {
        #if os(iOS)
        listStyle(.insetGrouped)
        #else
        listStyle(.inset)
        #endif
    }

    /// Cover the whole screen on iOS; macOS has no `fullScreenCover`, so the
    /// nearest equivalent there is a sheet.
    @ViewBuilder
    func fullScreenCoverCompat<Content: View>(
        isPresented: Binding<Bool>,
        @ViewBuilder content: @escaping () -> Content
    ) -> some View {
        #if os(iOS)
        fullScreenCover(isPresented: isPresented, content: content)
        #else
        sheet(isPresented: isPresented, content: content)
        #endif
    }

    /// Open Session's split settings surface is resizable and minimizable. Tahoe's
    /// `Settings` scene still does not support window zoom/full-screen, so do
    /// not leave a dead grey traffic-light control in the titlebar.
    @ViewBuilder
    func macSettingsWindowChrome() -> some View {
        #if os(macOS)
        background(MacSettingsWindowConfigurator())
        #else
        self
        #endif
    }

    /// Keep the real NSWindow title useful to the Window menu and assistive
    /// technologies while a custom principal toolbar item owns the visuals.
    @ViewBuilder
    func macWindowTitle(_ title: String) -> some View {
        #if os(macOS)
        background(MacWindowTitleConfigurator(title: title))
        #else
        self
        #endif
    }
}

#if os(macOS)
private struct MacSettingsWindowConfigurator: NSViewRepresentable {
    func makeNSView(context: Context) -> NSView {
        let view = NSView()
        configureWhenAttached(view)
        return view
    }

    func updateNSView(_ view: NSView, context: Context) {
        configureWhenAttached(view)
    }

    private func configureWhenAttached(_ view: NSView) {
        DispatchQueue.main.async {
            guard let window = view.window else { return }
            window.title = "\(AppBrand.appName) Settings"
            window.styleMask.formUnion([.resizable, .miniaturizable])
            window.standardWindowButton(.miniaturizeButton)?.isEnabled = true
            window.standardWindowButton(.zoomButton)?.isHidden = true
            window.toolbarStyle = .unifiedCompact
        }
    }
}

private struct MacWindowTitleConfigurator: NSViewRepresentable {
    let title: String

    func makeNSView(context: Context) -> NSView {
        let view = NSView()
        updateTitle(whenAttached: view)
        return view
    }

    func updateNSView(_ view: NSView, context: Context) {
        updateTitle(whenAttached: view)
    }

    private func updateTitle(whenAttached view: NSView) {
        DispatchQueue.main.async {
            view.window?.title = title
        }
    }
}
#endif

/// Cross-platform "copy to clipboard".
func copyToPasteboard(_ string: String) {
    #if canImport(UIKit)
    UIPasteboard.general.string = string
    #else
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(string, forType: .string)
    #endif
}
