import XCTest
@testable import OS1

final class TranscriptRichBlocksTests: XCTestCase {
    // MARK: - Segmenting

    func testPlainProseStaysOneMarkdownBlock() {
        let blocks = TranscriptRichBlocks.blocks(of: "# Title\n\nSome prose with `code` in it.")
        XCTAssertEqual(blocks.count, 1)
        guard case .markdown(let text) = blocks[0] else { return XCTFail("expected markdown") }
        XCTAssertEqual(text, "# Title\n\nSome prose with `code` in it.")
    }

    func testFenceParserRefusalKeepsTheFenceAsCode() {
        let text = "Before.\n\n```choices\n```\n\nAfter."
        let blocks = TranscriptRichBlocks.blocks(of: text)
        XCTAssertEqual(blocks.count, 1)
        guard case .markdown(let value) = blocks[0] else { return XCTFail("expected markdown") }
        XCTAssertEqual(value, text)
    }

    func testUnterminatedFenceStaysProse() {
        let text = "Look:\n\n```metrics\nRequests: 12"
        let blocks = TranscriptRichBlocks.blocks(of: text)
        XCTAssertEqual(blocks.count, 1)
        guard case .markdown(let value) = blocks[0] else { return XCTFail("expected markdown") }
        XCTAssertEqual(value, text)
    }

    func testChoicesAndTreeInOneMessage() {
        let text = """
        The fix touches these files:

        ```tree
        acme-todo/
        ├── src/
        │   ├── upload.ts  # retry loop
        │   └── upload.test.ts
        └── package.json
        ```

        How do you want to proceed?

        ```choices
        - Merge the PR
        - Add a test
        ```
        """
        let blocks = TranscriptRichBlocks.blocks(of: text)
        XCTAssertEqual(blocks.count, 4)
        guard case .tree(let nodes) = blocks[1] else { return XCTFail("expected tree") }
        XCTAssertEqual(nodes.count, 1)
        XCTAssertEqual(nodes[0].name, "acme-todo")
        XCTAssertEqual(nodes[0].children.map(\.name), ["src", "package.json"])
        XCTAssertEqual(nodes[0].children[0].children[0].note, "retry loop")
        guard case .choices(let choices) = blocks[3] else { return XCTFail("expected choices") }
        XCTAssertEqual(choices, ["Merge the PR", "Add a test"])
    }

    func testMermaidStillSplitsThroughTheSharedSegmenter() {
        let text = "```mermaid\ngraph TD\nA-->B\n```"
        let blocks = TranscriptRichBlocks.blocks(of: text)
        guard blocks.count == 1, case .mermaid(let source) = blocks[0] else { return XCTFail("expected mermaid") }
        XCTAssertEqual(source, "graph TD\nA-->B")
        XCTAssertEqual(MermaidSegmenter.split(text), [.mermaid("graph TD\nA-->B")])
    }

    func testPlacedFigureAndCaption() {
        let text = "## Proof\n\n![All three attempts run](/media?path=%2Ftmp%2Fa.png)\n\nBoth stills come from the rerun."
        let blocks = TranscriptRichBlocks.blocks(of: text)
        XCTAssertEqual(blocks.count, 3)
        guard case .figure(let figure) = blocks[1] else { return XCTFail("expected figure") }
        XCTAssertEqual(figure.source, "/media?path=%2Ftmp%2Fa.png")
        XCTAssertEqual(figure.caption, "All three attempts run")
        XCTAssertFalse(figure.isVideo)
        XCTAssertTrue(MediaFigure(source: "/media?path=%2Ftmp%2Fdemo.mp4", caption: nil).isVideo)
    }

    func testImageThatIsNotSessionMediaStaysProse() {
        let text = "![logo](https://example.com/logo.png)"
        guard case .markdown = TranscriptRichBlocks.blocks(of: text)[0] else { return XCTFail("expected markdown") }
    }

    func testCalloutLiftsTitledQuoteOnly() {
        let text = "> [!WARNING]\n> Mind the gap.\n> Second line.\n\n> Plain quote."
        let blocks = TranscriptRichBlocks.blocks(of: text)
        XCTAssertEqual(blocks.count, 2)
        guard case .callout(let callout) = blocks[0] else { return XCTFail("expected callout") }
        XCTAssertEqual(callout.kind, .warning)
        XCTAssertEqual(callout.body, "Mind the gap.\nSecond line.")
        guard case .markdown(let rest) = blocks[1] else { return XCTFail("expected markdown") }
        XCTAssertEqual(rest, "\n> Plain quote.")
        guard case .markdown = TranscriptRichBlocks.blocks(of: "> [!NOTE] inline text")[0] else {
            return XCTFail("a marker with text after it is a plain quote")
        }
    }

    func testDisplayMathBlockAndFence() {
        let blocks = TranscriptRichBlocks.blocks(of: "Energy:\n\n$$\nE = mc^2\n$$\n\n```math\n\\frac{a}{b}\n```")
        XCTAssertEqual(blocks.count, 3)
        guard case .math(let lines, let source) = blocks[1] else { return XCTFail("expected math") }
        XCTAssertEqual(source, "E = mc^2")
        XCTAssertEqual(lines.count, 1)
        guard case .math = blocks[2] else { return XCTFail("expected math fence") }
    }

    func testTablesStillLiftOutOfProse() {
        let blocks = TranscriptRichBlocks.blocks(of: "| a | b |\n| - | - |\n| 1 | 2 |")
        guard blocks.count == 1, case .table = blocks[0] else { return XCTFail("expected table") }
    }

    // MARK: - Grammars

    func testChoicesGrammar() {
        XCTAssertEqual(ChoicesBlock.parse("- Merge\n* Merge\n1. Explain\n\nSkip"), ["Merge", "Explain", "Skip"])
        XCTAssertNil(ChoicesBlock.parse(String(repeating: "x", count: 201)))
        XCTAssertNil(ChoicesBlock.parse((1...13).map { "choice \($0)" }.joined(separator: "\n")))
        let entries = [
            TranscriptEntry(id: "a", type: "assistant", content: ""),
            TranscriptEntry(id: "u", type: "user", content: ""),
            TranscriptEntry(id: "b", type: "assistant", content: ""),
        ]
        XCTAssertEqual(ChoicesBlock.openEntryIds(entries), ["b"])
    }

    func testTreeIndentedGrammarAndMatching() {
        let nodes = TreeBlock.parse("src/\n  app.ts\n  lib/\n    util.ts\nREADME.md")
        XCTAssertEqual(nodes?.map(\.name), ["src", "README.md"])
        XCTAssertEqual(nodes?[0].children[1].children[0].name, "util.ts")
        XCTAssertNil(TreeBlock.parse("a\n  b\n      c"), "a skipped level is not a tree")
        XCTAssertEqual(TreeBlock.match(path: "upload.ts", in: ["src/upload.ts", "docs/a.md"]), "src/upload.ts")
        XCTAssertNil(TreeBlock.match(path: "a.md", in: ["docs/a.md", "x/a.md"]))
    }

    func testCompareGrammar() {
        let spec = CompareSpec.parse("before: /media?path=a\nafter: /media?path=b\ncaption: Retry timeline")
        XCTAssertEqual(spec, CompareSpec(before: "/media?path=a", after: "/media?path=b", caption: "Retry timeline"))
        XCTAssertNil(CompareSpec.parse("before: /a\nafter: file.png"))
        XCTAssertNil(CompareSpec.parse("before: /a"))
    }

    func testPaletteGrammarAndPainting() {
        let entries = PaletteBlock.parse("#ff0080 Brand pink\nInk: rgb(0, 0, 0);\nhsl(120 100% 25%)\ntransparent\noklch(0.7 0.1 200)")
        XCTAssertEqual(entries?.map(\.name), ["Brand pink", "Ink", "", "", ""])
        XCTAssertEqual(entries?[0].rgba?.red, 1)
        XCTAssertEqual(entries?[0].rgba?.green ?? 1, 0)
        XCTAssertEqual(entries?[1].rgba?.red, 0)
        XCTAssertEqual(entries?[2].rgba?.green ?? 0, 0.5, accuracy: 0.01)
        XCTAssertEqual(entries?[3].rgba?.alpha, 0)
        XCTAssertNotNil(entries?[4].rgba)
        XCTAssertNil(PaletteBlock.parse("#ff0080\nnot a colour"))
        XCTAssertNil(PaletteBlock.parse("color-mix(in srgb, red, blue)"))
    }

    func testDataTableGrammar() {
        let table = DataTableBlock.parse("name,qty,price\n\"Widget, large\",2,\"$1,204.50\"\nBolt,10,0.25", lang: "csv")
        XCTAssertEqual(table?.header, ["name", "qty", "price"])
        XCTAssertEqual(table?.rows[0], ["Widget, large", "2", "$1,204.50"])
        XCTAssertEqual(table?.numeric, [false, true, true])
        XCTAssertNil(DataTableBlock.parse("only,header", lang: "csv"))
        XCTAssertNil(DataTableBlock.parse("a,b\n1\n2\n3", lang: "csv"), "too many ragged rows")
        let pipe = DataTableBlock.parse("| a | b |\n|---|---|\n| 1 | x \\| y |", lang: "table")
        XCTAssertEqual(pipe?.rows, [["1", "x | y"]])
        XCTAssertEqual(DataTableBlock.parseNumber("$1,204.50"), 1204.5)
        XCTAssertEqual(DataTableBlock.parseNumber("+3%"), 3)
        XCTAssertNil(DataTableBlock.parseNumber("1,23"))
        let sorted = DataTableBlock.sorted([["b", "2"], ["", "1"], ["a", "10"]], by: 1, direction: .descending, numeric: true)
        XCTAssertEqual(sorted.map { $0[1] }, ["10", "2", "1"])
        XCTAssertEqual(DataTableBlock.rowCountLabel(shown: 3, total: 20), "3 of 20 rows")
        XCTAssertEqual(DataTableBlock.rowCountLabel(shown: 3000, total: 3000, rendered: 500), "first 500 of 3,000 rows")
        XCTAssertEqual(DataTableBlock.csv(header: ["a"], rows: [["x,y"], ["q\"r"]]), "a\n\"x,y\"\n\"q\"\"r\"")
    }

    func testJsonTreeThresholdsAndOrder() {
        let small = "{\"a\": 1}"
        XCTAssertFalse(JsonTreeBlock.worthFolding(small))
        let big = "{" + (1...40).map { "\"k\($0)\": \($0)" }.joined(separator: ",\n") + "}"
        XCTAssertTrue(JsonTreeBlock.worthFolding(big))
        guard case .object(let entries)? = JsonTreeBlock.parse(big) else { return XCTFail("expected object") }
        XCTAssertEqual(entries.first?.key, "k1")
        XCTAssertEqual(entries.last?.key, "k40")
        XCTAssertNil(JsonTreeBlock.parse("[1, 2,]"), "a trailing comma is not JSON")
        XCTAssertNil(JsonTreeBlock.parse("\"scalar\""))
        XCTAssertEqual(JsonTreeBlock.parse("{\"s\": \"a\\u00e9\\n\", \"n\": -1.5e3, \"t\": true, \"z\": null}"),
                       .object([("s", .string("aé\n")), ("n", .number("-1.5e3")), ("t", .bool(true)), ("z", .null)]))
        guard case .markdown = TranscriptRichBlocks.blocks(of: "```json\n\(small)\n```")[0] else {
            return XCTFail("small JSON stays a code fence")
        }
    }

    func testAnsiClaimsAndSpelledEscapes() {
        XCTAssertTrue(AnsiBlock.claims(lang: "ansi", source: "plain"))
        XCTAssertFalse(AnsiBlock.claims(lang: "bash", source: "ls"))
        XCTAssertTrue(AnsiBlock.claims(lang: "bash", source: "\u{1B}[31mred"))
        let parsed = AnsiBlock.lines(lang: "ansi", source: "\\x1b[1;32mok\\x1b[0m done")
        XCTAssertEqual(parsed.plain, "ok done")
        XCTAssertEqual(parsed.lines[0].runs.first?.style.ink, .indexed(2))
        XCTAssertEqual(parsed.lines[0].runs.first?.style.bold, true)
    }

    func testMetricsGrammars() {
        let lines = MetricsBlock.parse("Requests: 1,204 (+12%)\np95: 340 ms")
        XCTAssertEqual(lines?.map(\.value), ["1,204", "340 ms"])
        XCTAssertEqual(lines?[0].delta, "+12%")
        XCTAssertEqual(lines?[0].trend, .up)
        XCTAssertEqual(lines?[1].trend, .flat)
        let json = MetricsBlock.parse("[{\"label\":\"p95\",\"value\":1204,\"unit\":\"ms\",\"delta\":-3}]")
        XCTAssertEqual(json?[0].value, "1,204")
        XCTAssertEqual(json?[0].delta, "-3")
        XCTAssertEqual(json?[0].trend, .down)
        XCTAssertEqual(json?[0].unit, "ms")
        XCTAssertNil(MetricsBlock.parse("{\"label\": \"x\"}"))
        XCTAssertNil(MetricsBlock.parse("no colon here"))
    }

    func testMathTypesetting() {
        let lines = MathTypesetter.typeset("E = mc^2 \\cdot \\alpha_{ij}")
        XCTAssertEqual(lines?.count, 1)
        let runs = lines![0]
        XCTAssertEqual(runs.map(\.text).joined(), "E = mc2 · αij")
        XCTAssertEqual(runs.first { $0.text == "2" }?.script, .superscript)
        XCTAssertEqual(runs.first { $0.text == "ij" }?.script, .lowered)
        XCTAssertEqual(runs.first?.identifier, true)
        XCTAssertEqual(MathTypesetter.typeset("\\frac{a+b}{2}")?[0].map(\.text).joined(), "(a+b)⁄2")
        XCTAssertEqual(MathTypesetter.typeset("a \\\\ b")?.count, 2)
        XCTAssertNil(MathTypesetter.typeset("\\unknowncommand{x}"))
        XCTAssertNil(MathTypesetter.typeset("{unbalanced"))
    }

    func testSlidesSplit() {
        let slides = SlidesBlock.split("---\n# One\n---\n```\n---\n```\nTwo\n---\n")
        XCTAssertEqual(slides, ["# One", "```\n---\n```\nTwo"])
    }

    func testVegaLiteSubset() {
        let spec = """
        {"title": "Retries", "mark": "bar", "data": {"values": [
          {"attempt": "1st", "build": "before", "n": 31}, {"attempt": "1st", "build": "after", "n": 30}]},
         "encoding": {"x": {"field": "attempt", "type": "nominal"}, "xOffset": {"field": "build"},
                      "y": {"field": "n", "type": "quantitative", "title": "Runs"}, "color": {"field": "build"}}}
        """
        let chart = VegaLiteChart.parse(spec)
        XCTAssertEqual(chart?.title, "Retries")
        XCTAssertEqual(chart?.mark, .bar)
        XCTAssertEqual(chart?.grouped, true)
        XCTAssertEqual(chart?.yTitle, "Runs")
        XCTAssertEqual(chart?.points.map(\.series), ["before", "after"])
        XCTAssertNil(VegaLiteChart.parse("{\"layer\": []}"))
        XCTAssertNil(VegaLiteChart.parse("{\"mark\": \"bar\", \"data\": {\"url\": \"x.csv\"}, \"encoding\": {}}"))
        let counted = VegaLiteChart.parse("{\"mark\":\"bar\",\"data\":{\"values\":[{\"k\":\"a\"},{\"k\":\"a\"},{\"k\":\"b\"}]},\"encoding\":{\"x\":{\"field\":\"k\"},\"y\":{\"aggregate\":\"count\"}}}")
        XCTAssertEqual(counted?.points.map(\.y), [2, 1])
    }

    func testArtifactDocumentLocksTheHead() {
        let fragment = ArtifactDocument.parse(lang: "artifact", source: "<p>hi</p>")!
        let html = fragment.html(textHex: "#111111", linkHex: "#0000ff", backgroundHex: "#ffffff", dark: false)
        XCTAssertTrue(html.hasPrefix("<!doctype html>"))
        XCTAssertTrue(html.contains("Content-Security-Policy"))
        XCTAssertTrue(html.contains("<base target=\"_blank\">"))
        XCTAssertTrue(html.hasSuffix("<body><p>hi</p></body></html>"))
        XCTAssertNil(ArtifactDocument.parse(lang: "svg", source: "<p>not svg</p>"))
        XCTAssertNil(ArtifactDocument.parse(lang: "artifact", source: "  "))
        let svg = ArtifactDocument.parse(lang: "svg", source: "<svg></svg>")!
        XCTAssertTrue(svg.html(textHex: "#000", linkHex: "#000", backgroundHex: "#000", dark: true).contains("data:image/svg+xml;base64,"))
    }

    func testPlacedMediaLeavesUnplacedForTheStrip() {
        let body = "![cap](/media?path=a)\n\n```compare\nbefore: /media?path=b\nafter: /media?path=c\n```"
        XCTAssertEqual(PlacedMedia.unplaced(["/media?path=a", "/media?path=b", "/media?path=c", "/media?path=d"], in: body),
                       ["/media?path=d"])
        XCTAssertEqual(PlacedMedia.unplaced(["x"], in: "no media"), ["x"])
        XCTAssertEqual(PlacedMedia.unplaced(nil, in: body), [])
    }
}
