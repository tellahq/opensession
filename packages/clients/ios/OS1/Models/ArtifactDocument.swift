import Foundation

/// The pure half of an ```artifact / ```svg block: the document a locked web
/// view shows (docs/blocks.md, "Artifacts").
///
/// An artifact is untrusted by definition. Here, as on the web, the block
/// opens the document itself: a `Content-Security-Policy` meta with
/// `default-src 'none'` (inline styles and `data:` images are the whole
/// allowance) sits ahead of the artifact's first byte, so nothing inside can
/// fetch or load from anywhere, and a `<base target>` aims every link at a
/// window the view never opens. The view adds the other half: content
/// JavaScript off, every navigation after the first refused.
struct ArtifactDocument: Equatable {
    enum Kind: Equatable { case html, svg }

    var kind: Kind
    /// The fence as written; what the Source toggle shows and copies.
    var source: String

    static let defaultHeight: CGFloat = 320
    static let minHeight: CGFloat = 120
    static let maxHeight: CGFloat = 900

    /// The policy written into the document head.
    static let csp = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; form-action 'none'; base-uri 'none'"

    /// `lang` is `artifact` or `svg`. A fence with nothing in it stays code.
    static func parse(lang: String, source: String) -> ArtifactDocument? {
        let body = source.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !body.isEmpty else { return nil }
        switch lang {
        case "artifact": return ArtifactDocument(kind: .html, source: source)
        case "svg":
            guard body.lowercased().contains("<svg") else { return nil }
            return ArtifactDocument(kind: .svg, source: source)
        default: return nil
        }
    }

    /// The HTML the web view loads. The hex values are the app's own tokens
    /// resolved for the current appearance, so a fragment reads as native in
    /// both themes.
    func html(textHex: String, linkHex: String, backgroundHex: String, dark: Bool) -> String {
        let head = """
        <!doctype html><html><head><meta charset="utf-8">
        <meta http-equiv="Content-Security-Policy" content="\(Self.csp)">
        <meta name="color-scheme" content="\(dark ? "dark" : "light")">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <base target="_blank">
        <style>html{background:\(backgroundHex)}body{margin:12px;color:\(textHex);font-family:-apple-system,system-ui,sans-serif;font-size:15px;line-height:1.4;-webkit-text-size-adjust:100%}a{color:\(linkHex)}img,svg,video,canvas{max-width:100%}</style>
        """
        switch kind {
        case .svg:
            let data = Data(source.utf8).base64EncodedString()
            return head + "</head><body style=\"margin:0\"><img src=\"data:image/svg+xml;base64,\(data)\" style=\"display:block;width:100%;height:auto\" alt=\"\"></body></html>"
        case .html:
            let lower = source.lowercased()
            if lower.contains("<html") || lower.contains("<head") || lower.contains("<body") {
                // A complete document follows the block's head: the parser
                // folds a second <html> into the open one and drops a second
                // <head> tag, so the author's head content lands after the
                // base style and wins.
                return head + source
            }
            return head + "</head><body>" + source + "</body></html>"
        }
    }
}
