import SwiftStreamingMarkdown
import SwiftUI
#if os(iOS)
import UIKit
#else
import AppKit
#endif

/// A GFM table in a transcript message, laid out to FIT the width it is given.
///
/// SwiftStreamingMarkdown renders tables at `max(viewport / columns,
/// min(intrinsic, 200))` per column, so any table of three or four prose
/// columns is about twice a phone's width — permanently clipped, and the only
/// way to the rest of it is a sideways drag with no indicator, no fade and
/// nothing to suggest it is there. This does what the web viewer's
/// `.markdown table` does instead: columns take the width their content asks
/// for, and when the row is wider than the message, the columns holding prose
/// give the space back and their text wraps, so the whole table is on screen.
///
/// A table with so many columns that even their longest words cannot fit —
/// six, eight, a matrix — is handed back to the library, whose boxed table
/// scrolls sideways. That is the one case where scrolling really is the only
/// answer, and the library's version of it already works.
///
/// Cell text is measured, not proposed: every cell is an `AttributedString`
/// with known fonts, so the column solver runs on real widths in one pass
/// rather than asking SwiftUI what a flexible `Text` would like to be (which
/// answers with its unwrapped single-line width, and would make every table
/// look like it must scroll).
struct MarkdownTableView: View {
    let table: MarkdownTable
    /// Narration inside a work fold renders dimmer than a final answer, the
    /// same split `MarkdownBody` makes for prose.
    var dimmed = false
    /// Off when the caller draws its own header row (`DataGridView`, whose
    /// headers are sort buttons). The scrolling fallback keeps the header:
    /// a table wider than the column would be unreadable without one.
    var showsHeader = true
    @Environment(\.transcriptQuoteSelection) private var quoteSelection

    @State private var available: CGFloat = 0

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // A zero-height, full-width probe. It is proposed the message's
            // width whatever the table does, so a table that is briefly too
            // wide can never inflate the number the column solver runs on.
            Color.clear
                .frame(height: 0)
                .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { available = $0 }
            if available > 0 {
                let layout = TableLayoutPlan(
                    table: measured,
                    available: available,
                    gutter: Self.gutter
                )
                if layout.fits {
                    grid(layout)
                } else {
                    let base = dimmed ? MarkdownRenderConfig.os1Dim : .os1Static
                    let config = quoteSelection == nil
                        ? base
                        : base.withTextContextMenu(value: .os1QuoteSelection)
                    SwiftStreamingMarkdown.MarkdownView(
                        text: table.markdownSource(),
                        config: config,
                        listener: quoteSelection?.listener
                    )
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var measured: MeasuredTable { MeasuredTable.cached(for: table) }

    @ViewBuilder
    private func grid(_ layout: TableLayoutPlan) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            if showsHeader {
                row(measured.headers, widths: layout.widths, isHeader: true)
            }
            ForEach(Array(measured.rows.enumerated()), id: \.offset) { index, cells in
                row(
                    cells,
                    widths: layout.widths,
                    isHeader: false,
                    isLast: index == measured.rows.count - 1
                )
            }
        }
        .textSelection(.enabled)
    }

    @ViewBuilder
    private func row(
        _ cells: [MeasuredCell],
        widths: [CGFloat],
        isHeader: Bool,
        isLast: Bool = false
    ) -> some View {
        HStack(alignment: .top, spacing: Self.gutter) {
            ForEach(Array(cells.enumerated()), id: \.offset) { index, cell in
                Text(cell.display)
                    .font(isHeader ? Self.headerFont : Self.bodyFont)
                    .foregroundStyle(isHeader ? OS1VisualStyle.textFaint : bodyColor)
                    .multilineTextAlignment(textAlignment(index))
                    .frame(
                        width: widths.indices.contains(index) ? widths[index] : nil,
                        alignment: frameAlignment(index)
                    )
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.vertical, isHeader ? Self.headerPadding : Self.cellPadding)
        .overlay(alignment: .bottom) {
            if !isLast {
                Rectangle()
                    .fill(isHeader ? OS1VisualStyle.border : OS1VisualStyle.border.opacity(0.6))
                    .frame(height: isHeader ? 1 : 0.5)
            }
        }
    }

    private var bodyColor: Color {
        dimmed ? OS1VisualStyle.textNarration : OS1VisualStyle.text
    }

    private func alignment(_ index: Int) -> MarkdownTable.Alignment {
        table.alignments.indices.contains(index) ? table.alignments[index] : .leading
    }

    private func textAlignment(_ index: Int) -> TextAlignment {
        switch alignment(index) {
        case .leading: .leading
        case .center: .center
        case .trailing: .trailing
        }
    }

    private func frameAlignment(_ index: Int) -> Alignment {
        switch alignment(index) {
        case .leading: .topLeading
        case .center: .top
        case .trailing: .topTrailing
        }
    }

    #if os(iOS)
    private static let gutter: CGFloat = 12
    #else
    private static let gutter: CGFloat = 16
    #endif
    #if os(iOS)
    private static let bodyFont = Font.system(size: 15)
    private static let headerFont = Font.system(size: 12, weight: .semibold)
    private static let cellPadding: CGFloat = 7
    private static let headerPadding: CGFloat = 5
    #else
    private static let bodyFont = Font.system(size: 12)
    private static let headerFont = Font.system(size: 11, weight: .semibold)
    private static let cellPadding: CGFloat = 5
    private static let headerPadding: CGFloat = 4
    #endif
}

// MARK: - Measurement

/// A cell's rendered text plus the two widths the column solver needs: what
/// it would take on one line, and the narrowest it can be wrapped to without
/// breaking a word.
struct MeasuredCell {
    let display: AttributedString
    let ideal: CGFloat
    let minimum: CGFloat
}

@MainActor
struct MeasuredTable {
    let headers: [MeasuredCell]
    let rows: [[MeasuredCell]]
    /// Per column, the widest cell measured on one line, and the widest word.
    let ideals: [CGFloat]
    let minimums: [CGFloat]

    static func cached(for table: MarkdownTable) -> MeasuredTable {
        MarkdownTableCache.shared.measured(table)
    }

    init(_ table: MarkdownTable) {
        headers = table.headers.map { MarkdownCellText.measure($0, isHeader: true) }
        rows = table.rows.map { row in row.map { MarkdownCellText.measure($0, isHeader: false) } }
        var ideals = Array(repeating: CGFloat(0), count: table.columnCount)
        var minimums = Array(repeating: CGFloat(0), count: table.columnCount)
        for column in 0..<table.columnCount {
            var ideal = headers.indices.contains(column) ? headers[column].ideal : 0
            var minimum = headers.indices.contains(column) ? headers[column].minimum : 0
            for row in rows where row.indices.contains(column) {
                ideal = max(ideal, row[column].ideal)
                minimum = max(minimum, row[column].minimum)
            }
            ideals[column] = ideal
            minimums[column] = min(minimum, ideal)
        }
        self.ideals = ideals
        self.minimums = minimums
    }
}

/// Measuring and parsing a cell is the expensive half of a table, and a
/// transcript row's `body` runs again for reasons that have nothing to do with
/// its text (presence, selection, a sibling's height). Both are cached on the
/// raw markdown so a re-render is a dictionary lookup.
@MainActor
private final class MarkdownTableCache {
    static let shared = MarkdownTableCache()

    private var tables: [MarkdownTable: MeasuredTable] = [:]
    private var cells: [CellKey: MeasuredCell] = [:]

    struct CellKey: Hashable {
        let source: String
        let isHeader: Bool
    }

    func measured(_ table: MarkdownTable) -> MeasuredTable {
        if let hit = tables[table] { return hit }
        let made = MeasuredTable(table)
        // A transcript can hold a lot of tables; keep the cache from growing
        // without bound over a long-lived session.
        if tables.count > 128 { tables.removeAll(keepingCapacity: true) }
        tables[table] = made
        return made
    }

    func cell(_ key: CellKey, make: () -> MeasuredCell) -> MeasuredCell {
        if let hit = cells[key] { return hit }
        let made = make()
        if cells.count > 2048 { cells.removeAll(keepingCapacity: true) }
        cells[key] = made
        return made
    }
}

/// Inline markdown inside a cell — bold, italic, code, links, strikethrough —
/// parsed with Foundation rather than by nesting a second markdown renderer
/// per cell. The library's renderer parses asynchronously, and a column solver
/// that has to wait for its cells to arrive cannot size anything.
@MainActor
enum MarkdownCellText {
    static func measure(_ source: String, isHeader: Bool) -> MeasuredCell {
        MarkdownTableCache.shared.cell(.init(source: source, isHeader: isHeader)) {
            build(source, isHeader: isHeader)
        }
    }

    private static func build(_ source: String, isHeader: Bool) -> MeasuredCell {
        // GFM cells can't hold a newline, so a break is written as a tag.
        let text = source
            .replacingOccurrences(of: "<br>", with: "\n")
            .replacingOccurrences(of: "<br/>", with: "\n")
            .replacingOccurrences(of: "<br />", with: "\n")
        let parsed = (try? AttributedString(
            markdown: text,
            options: .init(
                interpretedSyntax: .inlineOnlyPreservingWhitespace,
                failurePolicy: .returnPartiallyParsedIfPossible
            )
        )) ?? AttributedString(text)

        var display = AttributedString()
        var widest: CGFloat = 0
        var lineWidth: CGFloat = 0
        var minimum: CGFloat = 0
        var wordWidth: CGFloat = 0

        for run in parsed.runs {
            var piece = AttributedString(parsed[run.range])
            let intent = run.inlinePresentationIntent ?? []
            let isCode = intent.contains(.code)
            let isBold = intent.contains(.stronglyEmphasized) || isHeader
            let isItalic = intent.contains(.emphasized)
            let font = platformFont(isHeader: isHeader, isCode: isCode, isBold: isBold)

            if isCode {
                piece.font = .system(size: size(isHeader: isHeader) - 1, design: .monospaced)
                piece.backgroundColor = OS1VisualStyle.markdownInlineCode
            } else {
                var swiftUIFont = Font.system(
                    size: size(isHeader: isHeader),
                    weight: isBold ? .semibold : .regular
                )
                if isItalic { swiftUIFont = swiftUIFont.italic() }
                piece.font = swiftUIFont
            }
            if run.link != nil { piece.foregroundColor = OS1VisualStyle.link }
            if intent.contains(.strikethrough) { piece.strikethroughStyle = .single }
            display.append(piece)

            // Width bookkeeping: the ideal is the widest LINE, the minimum the
            // widest single word, both measured in the font that run renders
            // in rather than one nominal font for the whole cell.
            let plain = String(parsed[run.range].characters)
            for (index, line) in plain.components(separatedBy: "\n").enumerated() {
                if index > 0 {
                    widest = max(widest, lineWidth)
                    lineWidth = 0
                    wordWidth = 0
                }
                lineWidth += width(of: line, font: font)
                for (wordIndex, word) in line.components(separatedBy: " ").enumerated() {
                    if wordIndex > 0 {
                        minimum = max(minimum, wordWidth)
                        wordWidth = 0
                    }
                    wordWidth += width(of: word, font: font)
                }
            }
        }
        widest = max(widest, lineWidth)
        minimum = max(minimum, wordWidth)
        // SwiftUI's own layout and a bounding-rect measurement disagree by a
        // fraction of a point; a hair of slack keeps a fitting cell from
        // wrapping its last word.
        return MeasuredCell(
            display: display,
            ideal: ceil(widest) + 2,
            minimum: min(ceil(minimum) + 2, ceil(widest) + 2)
        )
    }

    private static func size(isHeader: Bool) -> CGFloat {
        #if os(iOS)
        isHeader ? 12 : 15
        #else
        isHeader ? 11 : 12
        #endif
    }

    private static func platformFont(isHeader: Bool, isCode: Bool, isBold: Bool) -> PlatformFont {
        let points = size(isHeader: isHeader)
        if isCode {
            return PlatformFont.monospacedSystemFont(ofSize: points - 1, weight: .regular)
        }
        return PlatformFont.systemFont(ofSize: points, weight: isBold ? .semibold : .regular)
    }

    private static func width(of text: String, font: PlatformFont) -> CGFloat {
        guard !text.isEmpty else { return 0 }
        return (text as NSString).size(withAttributes: [.font: font]).width
    }
}

// MARK: - Column widths

/// The column solver. Four outcomes, in order of preference: every column
/// gets its natural width; the row is too wide but the columns holding prose
/// give the space back and wrap (the web's auto table layout, and what makes
/// a table readable on a phone); not even that fits, so columns go below their
/// longest word and a long word breaks; or there are so many columns that even
/// a floor of `hardMinimum` each overflows — `fits` is false and the caller
/// hands the table to the library's scrolling one.
struct TableLayoutPlan {
    let widths: [CGFloat]
    let fits: Bool

    init(table: MeasuredTable, available: CGFloat, gutter: CGFloat) {
        let columns = table.ideals.count
        guard columns > 0 else {
            widths = []
            fits = true
            return
        }
        // Before the first layout pass nothing has been measured yet: render
        // at natural widths for one frame rather than collapsing every column
        // to nothing.
        guard available > 0 else {
            widths = table.ideals
            fits = true
            return
        }
        let budget = available - gutter * CGFloat(columns - 1)
        let ideals = table.ideals
        // What a column can shrink to before its longest word has to break.
        let soft = zip(ideals, table.minimums).map { min($0, $1) }
        // And the floor below that, where words do break — still better than
        // hiding a column off the edge of the screen.
        let hard = ideals.map { min($0, Self.hardMinimum) }
        let idealTotal = ideals.reduce(0, +)

        if idealTotal <= budget {
            widths = ideals
            fits = true
            return
        }
        // Take the overflow out of the columns that have room to wrap, in
        // proportion to how much each can give. A short "Typing" column keeps
        // its width; the sentence beside it is the one that wraps.
        if let shrunk = Self.shrink(from: ideals, toward: soft, into: budget) {
            widths = shrunk
            fits = true
            return
        }
        if let shrunk = Self.shrink(from: soft, toward: hard, into: budget) {
            widths = shrunk
            fits = true
            return
        }
        // Too many columns to show at once. The caller renders these with the
        // library instead, which scrolls; the widths are only a fallback.
        widths = soft
        fits = false
    }

    /// `widths` fitted into `budget` by capping the WIDEST columns — never
    /// below `floors` — or nil when even the floors are too wide.
    ///
    /// Largest-first rather than proportional: the space has to come out of
    /// the column holding a paragraph, not a little out of every column. Take
    /// it proportionally and a two-word heading loses the few points that make
    /// it fit, so "TypeScript" comes out as "TypeScrip / t" beside a sentence
    /// with room to spare.
    private static func shrink(
        from widths: [CGFloat],
        toward floors: [CGFloat],
        into budget: CGFloat
    ) -> [CGFloat]? {
        let total = widths.reduce(0, +)
        if total <= budget { return widths }
        // A floor can never widen a column past what it asked for.
        let bounds = zip(widths, floors).map { min($0, $1) }
        guard bounds.reduce(0, +) <= budget else { return nil }

        func capped(at cap: CGFloat) -> [CGFloat] {
            zip(widths, bounds).map { width, bound in max(min(width, cap), bound) }
        }
        var low: CGFloat = 0
        var high = widths.max() ?? 0
        for _ in 0..<40 {
            let mid = (low + high) / 2
            if capped(at: mid).reduce(0, +) <= budget { low = mid } else { high = mid }
        }
        // Floored, not rounded: a fraction over the budget on each column is
        // enough to push the last one off the edge again.
        return capped(at: low).map { max(1, $0.rounded(.down)) }
    }

    /// The narrowest a column is allowed to get before the table gives up and
    /// scrolls. Roughly four or five characters of prose — enough that a
    /// broken word still reads.
    #if os(iOS)
    private static let hardMinimum: CGFloat = 64
    #else
    private static let hardMinimum: CGFloat = 52
    #endif
}
