import Foundation

/// A page an agent showed with `opensession-html` `html_render`: stored as a
/// session asset, shown under the turn that made it. Mirrors the protocol
/// package's `html-render.ts` (the reference, its validation, and the frame
/// height rule), so a render reads the same here as on the web.
struct HtmlRenderReference: Equatable, Sendable {
    struct Measured: Equatable, Sendable {
        var width: Double
        var height: Double
    }

    /// Root-relative URL of the stored page.
    var url: String
    var path: String
    var title: String
    /// The agent's frame height, the cap when it is below the page's own.
    var height: Double
    /// Heights measured at publish, ascending by width.
    var heights: [Measured]?

    static let minHeight: Double = 80
    static let maxHeight: Double = 2000
    /// The web reply column's width, which decides whether the agent's
    /// height was meant as a cap.
    static let columnWidth: Double = 744
    static let maxResultBytes = 4096

    private static let urlPattern = try! NSRegularExpression(
        pattern: #"^/api/sessions/[^/?#]+/assets/raw/html-renders/[^?#]+\.html$"#
    )

    static func clamp(_ height: Double) -> Double {
        guard height.isFinite else { return minHeight }
        return min(maxHeight, max(minHeight, height.rounded()))
    }

    /// The first reference in a result's text.
    static func from(resultContent content: String?) -> HtmlRenderReference? {
        all(inResultContent: content).first
    }

    /// Every reference in a result's text, in order: the tool's answer
    /// `{"htmlRender": …, "message": …}` alone, in a dispatcher's prose, or
    /// in a codemode script's report, printed as an object or as an escaped
    /// JSON string, possibly several. Mirrors the protocol package's
    /// `htmlRendersFromResult`. Only a stored render's URL is accepted, so
    /// nothing else is ever loaded from a tool result.
    static func all(inResultContent content: String?) -> [HtmlRenderReference] {
        guard let text = content, text.contains("htmlRender") else { return [] }
        var objects = renderObjects(in: text)
        if text.contains(#"\"htmlRender\""#) {
            let unescaped = text.replacingOccurrences(
                of: #"\\(["\\])"#, with: "$1", options: .regularExpression
            )
            for object in renderObjects(in: unescaped) where !objects.contains(object) {
                objects.append(object)
            }
        }
        var refs: [HtmlRenderReference] = []
        for object in objects.prefix(maxRendersPerResult) {
            guard let data = object.data(using: .utf8),
                  let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let ref = from(object: parsed["htmlRender"]),
                  !refs.contains(where: { $0.url == ref.url })
            else { continue }
            refs.append(ref)
        }
        return refs
    }

    private static let maxRendersPerResult = 12
    private static let objectStart = try! NSRegularExpression(pattern: #"\{\s*"htmlRender"\s*:"#)

    /// The `{"htmlRender": …}` objects in `text`, each cut at its closing
    /// brace (string-aware), within the size a real answer can have.
    private static func renderObjects(in text: String) -> [String] {
        let units = Array(text.utf16)
        var out: [String] = []
        for match in objectStart.matches(in: text, range: NSRange(location: 0, length: units.count)) {
            let start = match.range.location
            var depth = 0
            var inString = false
            var index = start
            let limit = min(units.count, start + maxResultBytes)
            var end: Int?
            while index < limit {
                let c = units[index]
                if inString {
                    if c == 0x5C { index += 1 } else if c == 0x22 { inString = false }
                } else if c == 0x22 {
                    inString = true
                } else if c == 0x7B {
                    depth += 1
                } else if c == 0x7D {
                    depth -= 1
                    if depth == 0 { end = index + 1; break }
                }
                index += 1
            }
            if let end { out.append(String(decoding: units[start..<end], as: UTF16.self)) }
            if out.count >= maxRendersPerResult { break }
        }
        return out
    }

    static func from(object: Any?) -> HtmlRenderReference? {
        guard let value = object as? [String: Any],
              let url = value["url"] as? String,
              urlPattern.firstMatch(in: url, range: NSRange(url.startIndex..., in: url)) != nil,
              let path = value["path"] as? String,
              let title = value["title"] as? String,
              let height = (value["height"] as? NSNumber)?.doubleValue,
              height.isFinite
        else { return nil }
        var measured: [Measured]?
        if let raw = value["heights"] as? [[Any]], !raw.isEmpty, raw.count <= 24 {
            let pairs = raw.compactMap { pair -> Measured? in
                guard pair.count == 2,
                      let width = (pair[0] as? NSNumber)?.doubleValue,
                      let height = (pair[1] as? NSNumber)?.doubleValue,
                      width >= 1, height.isFinite
                else { return nil }
                return Measured(width: width, height: clamp(height))
            }
            if pairs.count == raw.count { measured = pairs.sorted { $0.width < $1.width } }
        }
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        return HtmlRenderReference(
            url: url,
            path: path,
            title: trimmed.isEmpty ? "HTML render" : String(trimmed.prefix(200)),
            height: clamp(height),
            heights: measured
        )
    }

    /// The taller of the heights measured either side of `width`; past the
    /// measured range the nearest end stands alone.
    private func measuredHeight(at width: Double) -> Double? {
        guard let heights, !heights.isEmpty else { return nil }
        guard let high = heights.firstIndex(where: { $0.width >= width }) else {
            return heights[heights.count - 1].height
        }
        let low = heights[high].width == width ? high : max(0, high - 1)
        return max(heights[low].height, heights[high].height)
    }

    /// The frame height at a width: the page's own report when there is
    /// one, else the server's measurement, capped by the agent's height only
    /// when it asked for a scrolling frame.
    func frameHeight(width: Double, contentHeight: Double?) -> Double {
        guard let atColumn = measuredHeight(at: Self.columnWidth),
              let atWidth = measuredHeight(at: width)
        else { return Self.clamp(min(height, contentHeight ?? height)) }
        let cap = atColumn > height ? height : Self.maxHeight
        return Self.clamp(min(cap, contentHeight ?? atWidth))
    }

    /// Whether a call may be `html_render`: named so, a dispatcher call,
    /// whose inner name a large stored call can have lost, or a codemode
    /// script, which reaches the tool through `tools.mcp_call`. The result
    /// decides.
    static func mayBeRenderTool(_ rawName: String, input: JSONValue?) -> Bool {
        if isDispatcher(rawName) || isCodemode(rawName) { return true }
        guard let mcp = ToolPresentation.parseMcpTool(rawName) else { return false }
        return mcp.server == "opensession-html" && mcp.tool == "html_render"
    }

    private static func isDispatcher(_ name: String) -> Bool {
        var bare = name.lowercased()
        for prefix in ["mcp__oc__", "mcp__"] where bare.hasPrefix(prefix) {
            bare = String(bare.dropFirst(prefix.count))
        }
        return bare == "mcp_call"
    }

    private static func isCodemode(_ name: String) -> Bool {
        let lower = name.lowercased()
        return lower == "codemode" || lower.hasSuffix("__codemode")
    }
}

/// One render under a turn, keyed by the call that made it.
struct HtmlRenderItem: Identifiable, Equatable, Sendable {
    let id: String
    let render: HtmlRenderReference

    /// The turn's renders in call order. A call still running or one that
    /// failed shows nothing.
    static func renders(in tools: [ToolCallItem]) -> [HtmlRenderItem] {
        tools.flatMap { tool -> [HtmlRenderItem] in
            guard let use = tool.use,
                  let result = tool.result,
                  result.isError != true,
                  HtmlRenderReference.mayBeRenderTool(use.toolName ?? "", input: use.toolInput)
            else { return [] }
            // A script can show several pages from one call.
            return HtmlRenderReference.all(inResultContent: result.content)
                .enumerated()
                .map { index, render in
                    HtmlRenderItem(id: index == 0 ? use.id : "\(use.id):\(index)", render: render)
                }
        }
    }
}

/// The theme variables a page in a frame styles against (`--background`,
/// `--card`, `--chart-1`, …): the protocol's stock values for the
/// appearance, with the surfaces the page sits on taken from this app.
enum HtmlTheme {
    static func variables(dark: Bool, background: String, foreground: String, link: String) -> [String: String] {
        var variables = dark ? darkDefaults : lightDefaults
        variables["--background"] = background
        variables["--foreground"] = foreground
        variables["--card-foreground"] = foreground
        variables["--link"] = link
        return variables
    }

    /// The `host-context-changed` notification a page re-themes on.
    static func message(dark: Bool, variables: [String: String]) -> String {
        let payload: [String: Any] = [
            "jsonrpc": "2.0",
            "method": "ui/notifications/host-context-changed",
            "params": [
                "theme": dark ? "dark" : "light",
                "styles": ["variables": variables],
            ],
        ]
        let data = (try? JSONSerialization.data(withJSONObject: payload)) ?? Data("{}".utf8)
        return String(decoding: data, as: UTF8.self)
    }

    private static let fonts = [
        "--font-sans": "-apple-system, BlinkMacSystemFont, \"Inter\", \"Segoe UI\", sans-serif",
        "--font-mono": "\"SF Mono\", ui-monospace, \"JetBrains Mono\", Menlo, Consolas, monospace",
        "--radius": "8px",
        // The transcript's own body text: 17pt on iOS, 13pt on the Mac, in
        // the regular weight the native markdown uses.
        "--font-weight": "400",
        "--font-size": bodySize,
    ]

    #if os(iOS)
    private static let bodySize = "17px"
    #else
    private static let bodySize = "13px"
    #endif

    static let darkDefaults: [String: String] = fonts.merging([
        "--background": "#1c1c1c", "--foreground": "#e9e9e9",
        "--muted": "#262626", "--muted-foreground": "#a2a2a2", "--faint-foreground": "#767676",
        "--card": "#222222", "--card-foreground": "#e9e9e9",
        "--border": "#333333", "--border-strong": "#464646", "--input": "#292929",
        "--primary": "#e9e9e9", "--primary-foreground": "#1c1c1c",
        "--accent": "#58a6ff", "--accent-surface": "rgba(88, 166, 255, 0.13)", "--link": "#58a6ff",
        "--destructive": "#fc4a47", "--destructive-surface": "rgba(252, 74, 71, 0.12)",
        "--warning": "#d29922", "--warning-surface": "rgba(210, 153, 34, 0.14)",
        "--success": "#00bc52", "--success-surface": "rgba(0, 188, 82, 0.14)",
        "--info": "#58a6ff", "--info-surface": "rgba(88, 166, 255, 0.13)",
        "--code-background": "#0d0f13", "--code-foreground": "#b6bcc8",
        "--chart-1": "#58a6ff", "--chart-2": "#00bc52", "--chart-3": "#d29922",
        "--chart-4": "#fc4a47", "--chart-5": "#a371f7", "--chart-6": "#39c5cf",
    ]) { $1 }

    static let lightDefaults: [String: String] = fonts.merging([
        "--background": "#ffffff", "--foreground": "#1a1a1a",
        "--muted": "#f0f0f0", "--muted-foreground": "#646464", "--faint-foreground": "#949494",
        "--card": "#f6f6f6", "--card-foreground": "#1a1a1a",
        "--border": "#e2e2e2", "--border-strong": "#d0d0d0", "--input": "#ebebeb",
        "--primary": "#1a1a1a", "--primary-foreground": "#ffffff",
        "--accent": "#0969da", "--accent-surface": "rgba(9, 105, 218, 0.1)", "--link": "#0969da",
        "--destructive": "#de3334", "--destructive-surface": "rgba(222, 51, 52, 0.1)",
        "--warning": "#9a6700", "--warning-surface": "rgba(154, 103, 0, 0.12)",
        "--success": "#009740", "--success-surface": "rgba(0, 151, 64, 0.12)",
        "--info": "#0969da", "--info-surface": "rgba(9, 105, 218, 0.1)",
        "--code-background": "#f6f8fa", "--code-foreground": "#57606a",
        "--chart-1": "#0969da", "--chart-2": "#009740", "--chart-3": "#9a6700",
        "--chart-4": "#de3334", "--chart-5": "#8250df", "--chart-6": "#1b7c83",
    ]) { $1 }
}
