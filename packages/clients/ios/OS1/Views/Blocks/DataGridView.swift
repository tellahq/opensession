import SwiftUI

/// A ```csv, ```tsv or ```table fence as a data grid: tap a header to sort
/// asc, desc, off; a filter field appears past eight rows and narrows by
/// substring with an "n of m rows" count; Copy CSV copies the rows on
/// screen. The grid itself is `MarkdownTableView`, which wraps cells to the
/// column and scrolls only when even the narrowest columns cannot fit.
struct DataGridView: View {
    let table: DataTable
    var dimmed = false

    @State private var sort: (column: Int, direction: DataTableBlock.SortDirection)?
    @State private var query = ""

    private var visible: [[String]] {
        var rows = DataTableBlock.filtered(table.rows, query: query)
        if let sort {
            rows = DataTableBlock.sorted(
                rows, by: sort.column, direction: sort.direction, numeric: table.numeric[sort.column]
            )
        }
        return rows
    }

    var body: some View {
        let rows = visible
        let rendered = Array(rows.prefix(DataTableBlock.renderCap))
        BlockWell(label: "Table", symbol: "tablecells") {
            Text(DataTableBlock.rowCountLabel(shown: rows.count, total: table.rows.count, rendered: rendered.count))
                .font(.caption)
                .foregroundStyle(OS1VisualStyle.textFaint)
                .monospacedDigit()
            CopyBlockControl(text: DataTableBlock.csv(header: table.header, rows: rows), label: "Copy CSV")
        } content: {
            VStack(alignment: .leading, spacing: 0) {
                if table.rows.count > DataTableBlock.filterThreshold {
                    TextField("Filter rows", text: $query)
                        .textFieldStyle(.plain)
                        .font(.footnote)
                        .padding(.horizontal, 10)
                        .frame(minHeight: 30)
                        .noAutocapitalizationCompat()
                        .overlay(alignment: .bottom) {
                            Rectangle().fill(OS1VisualStyle.border.opacity(0.6)).frame(height: 0.5)
                        }
                        .accessibilityLabel("Filter rows")
                }
                headers
                if rendered.isEmpty {
                    Text("No matching rows")
                        .font(.footnote)
                        .foregroundStyle(OS1VisualStyle.textFaint)
                        .padding(10)
                } else {
                    MarkdownTableView(table: markdownTable(rendered), dimmed: dimmed, showsHeader: false)
                        .padding(.horizontal, 10)
                }
            }
        }
    }

    /// The sortable header, drawn here rather than by the table so a tap
    /// lands on a real button with a sort indicator.
    private var headers: some View {
        HStack(alignment: .top, spacing: 8) {
            ForEach(Array(table.header.enumerated()), id: \.offset) { index, name in
                Button {
                    cycleSort(index)
                } label: {
                    HStack(spacing: 3) {
                        Text(name)
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(sort?.column == index ? OS1VisualStyle.text : OS1VisualStyle.textFaint)
                            .multilineTextAlignment(table.numeric[index] ? .trailing : .leading)
                        if let sort, sort.column == index {
                            Image(systemName: sort.direction == .ascending ? "arrow.up" : "arrow.down")
                                .font(.caption2.weight(.bold))
                                .foregroundStyle(OS1VisualStyle.accentInk)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: table.numeric[index] ? .trailing : .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Sort by \(name)")
                .accessibilityValue(sortValue(index))
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .overlay(alignment: .bottom) {
            Rectangle().fill(OS1VisualStyle.border).frame(height: 1)
        }
    }

    private func sortValue(_ column: Int) -> String {
        guard let sort, sort.column == column else { return "Not sorted" }
        return sort.direction == .ascending ? "Ascending" : "Descending"
    }

    private func cycleSort(_ column: Int) {
        if let current = sort, current.column == column {
            sort = current.direction == .ascending ? (column, .descending) : nil
        } else {
            sort = (column, .ascending)
        }
    }

    /// Cells are data, never markdown: every special is escaped so a `*` in
    /// a price list stays a star.
    private func markdownTable(_ rows: [[String]]) -> MarkdownTable {
        MarkdownTable(
            headers: table.header.map(Self.escaped),
            alignments: table.numeric.map { $0 ? .trailing : .leading },
            rows: rows.map { $0.map(Self.escaped) }
        )
    }

    private static func escaped(_ cell: String) -> String {
        var out = ""
        for char in cell {
            if "\\`*_[]<>~#|".contains(char) { out.append("\\") }
            out.append(char == "\n" ? " " : char)
        }
        return out
    }
}
