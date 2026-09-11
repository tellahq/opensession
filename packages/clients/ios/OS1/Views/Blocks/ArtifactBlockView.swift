import SwiftUI
import WebKit

/// An ```artifact or ```svg fence in a locked web view: content JavaScript
/// off, a `default-src 'none'` policy ahead of the artifact's first byte
/// (`ArtifactDocument`), and every navigation after the first refused, so a
/// link inside goes nowhere. The header has a Source toggle back to the
/// fence and an expand button that opens the same document in a sheet. The
/// frame starts at 320pt with a drag grip.
struct ArtifactBlockView: View {
    let document: ArtifactDocument

    @Environment(\.colorScheme) private var colorScheme
    @State private var showSource = false
    @State private var height = ArtifactDocument.defaultHeight
    @State private var dragStart: CGFloat?
    @State private var expanded = false

    private var label: String { document.kind == .svg ? "SVG" : "Artifact" }

    var body: some View {
        BlockWell(label: label, symbol: document.kind == .svg ? "square.on.circle" : "doc.richtext") {
            BlockControl(showSource ? "Preview" : "Source", symbol: showSource ? "eye" : "chevron.left.forwardslash.chevron.right") {
                showSource.toggle()
            }
            if showSource {
                CopyBlockControl(text: document.source)
            }
            BlockControl(symbol: "arrow.up.left.and.arrow.down.right", accessibilityLabel: "Expand") {
                expanded = true
            }
        } content: {
            if showSource {
                SyntaxHighlightedCodeText(text: document.source, language: document.kind == .svg ? "xml" : "html")
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(10)
            } else {
                VStack(spacing: 0) {
                    ArtifactWebView(html: html)
                        .frame(height: height)
                    grip
                }
            }
        }
        .accessibilityLabel(label)
        #if os(iOS)
        .fullScreenCover(isPresented: $expanded) {
            ExpandedArtifact(label: label, html: html)
        }
        #else
        .sheet(isPresented: $expanded) {
            ExpandedArtifact(label: label, html: html)
                .frame(minWidth: 720, idealWidth: 900, minHeight: 520, idealHeight: 700)
        }
        #endif
    }

    private var html: String {
        let dark = colorScheme == .dark
        return document.html(
            textHex: OS1VisualStyle.hex(of: OS1VisualStyle.text, dark: dark),
            linkHex: OS1VisualStyle.hex(of: OS1VisualStyle.link, dark: dark),
            backgroundHex: OS1VisualStyle.hex(of: OS1VisualStyle.background, dark: dark),
            dark: dark
        )
    }

    private var grip: some View {
        Capsule()
            .fill(OS1VisualStyle.textFaint)
            .frame(width: 36, height: 4)
            .frame(maxWidth: .infinity)
            .frame(height: 16)
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 1)
                    .onChanged { value in
                        let start = dragStart ?? height
                        dragStart = start
                        height = min(ArtifactDocument.maxHeight, max(ArtifactDocument.minHeight, start + value.translation.height))
                    }
                    .onEnded { _ in dragStart = nil }
            )
            .accessibilityLabel("Resize")
            .accessibilityValue("\(Int(height)) points")
            .accessibilityAdjustableAction { direction in
                let step: CGFloat = direction == .increment ? 60 : -60
                height = min(ArtifactDocument.maxHeight, max(ArtifactDocument.minHeight, height + step))
            }
    }
}

private struct ExpandedArtifact: View {
    let label: String
    let html: String

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text(label)
                    .font(.headline)
                Spacer()
                Button("Done") { dismiss() }
                    .keyboardShortcut(.cancelAction)
            }
            .padding()
            ArtifactWebView(html: html)
                .background(OS1VisualStyle.background)
        }
        .background(OS1VisualStyle.background)
    }
}

/// The locked frame. Loaded by string with no base URL, so relative
/// references have nothing to resolve against; JavaScript off in the
/// configuration; and a navigation delegate that lets the string load and
/// cancels everything else, including the `_blank` target every link wears.
private struct ArtifactWebView: PlatformViewRepresentable {
    let html: String

    #if os(iOS)
    func makeUIView(context: Context) -> WKWebView { context.coordinator.make() }
    func updateUIView(_ webView: WKWebView, context: Context) { context.coordinator.load(html, in: webView) }
    #else
    func makeNSView(context: Context) -> WKWebView { context.coordinator.make() }
    func updateNSView(_ webView: WKWebView, context: Context) { context.coordinator.load(html, in: webView) }
    #endif

    func makeCoordinator() -> Coordinator { Coordinator() }

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        private var loaded: String?

        func make() -> WKWebView {
            let configuration = WKWebViewConfiguration()
            configuration.websiteDataStore = .nonPersistent()
            configuration.defaultWebpagePreferences.allowsContentJavaScript = false
            let webView = WKWebView(frame: .zero, configuration: configuration)
            webView.navigationDelegate = self
            webView.uiDelegate = self
            return webView
        }

        func load(_ html: String, in webView: WKWebView) {
            guard loaded != html else { return }
            loaded = html
            webView.loadHTMLString(html, baseURL: nil)
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
        ) {
            // The string load arrives as `.other` on `about:blank`; a click,
            // a form, a redirect or a meta refresh is anything else.
            let isDocumentLoad = navigationAction.navigationType == .other
                && navigationAction.request.url?.absoluteString == "about:blank"
            decisionHandler(isDocumentLoad ? .allow : .cancel)
        }

        func webView(
            _ webView: WKWebView,
            createWebViewWith configuration: WKWebViewConfiguration,
            for navigationAction: WKNavigationAction,
            windowFeatures: WKWindowFeatures
        ) -> WKWebView? {
            nil
        }
    }
}

#if os(iOS)
private typealias PlatformViewRepresentable = UIViewRepresentable
#else
private typealias PlatformViewRepresentable = NSViewRepresentable
#endif
