import Foundation

/// ```csv, ```tsv and ```table fences as a data grid (docs/blocks.md,
/// "Tables"). The first row is the header. `csv` splits on commas, `tsv` on
/// tabs, and `table` picks the delimiter from the header line (comma, tab,
/// semicolon or pipe). Fields follow RFC 4180. Parsing, numeric detection,
/// sorting, filtering and CSV output are pure functions, the web's
/// `lib/table-block.ts` in Swift.
struct DataTable: Equatable {
    var header: [String]
    /// Every row is exactly `header.count` wide.
    var rows: [[String]]
    /// Per column: every non-empty cell reads as a number.
    var numeric: [Bool]
}

enum DataTableBlock {
    static let langs: Set<String> = ["csv", "tsv", "table"]
    /// A fence with more data rows than this gets a filter field.
    static let filterThreshold = 8
    /// How many rows the grid lays out at once; the count says what was cut.
    static let renderCap = 500
    static let maxColumns = 100

    enum SortDirection { case ascending, descending }

    /// The fence as a grid, or nil when it should stay code. Rows the
    /// header's width apart are ragged. Up to one in ten (rounded up, so
    /// always at least one: the row still being streamed) are repaired; more
    /// than that and the source is not the table it claims to be.
    static func parse(_ source: String, lang: String) -> DataTable? {
        let delimiter: Character?
        switch lang {
        case "csv": delimiter = ","
        case "tsv": delimiter = "\t"
        default: delimiter = detectDelimiter(source)
        }
        guard let delimiter else { return nil }
        // A pipe table usually wears GitHub's dress: an edge pipe on both
        // sides and a `|---|---|` rule right under the header. Neither is data.
        let text = delimiter == "|" ? stripPipeEdges(source) : source
        var records = parseDelimited(text, delimiter: delimiter)
            .filter { $0.count > 1 || $0[0] != "" }
        if delimiter == "|", records.count > 1, isPipeRule(records[1]) {
            records.remove(at: 1)
        }
        guard let header = records.first, header.count >= 2, header.count <= maxColumns,
              records.count >= 2
        else { return nil }
        let body = records.dropFirst()
        let width = header.count
        var ragged = 0
        let rows = body.map { row -> [String] in
            if row.count == width { return row }
            ragged += 1
            if row.count < width {
                return row + Array(repeating: "", count: width - row.count)
            }
            return Array(row.prefix(width - 1)) + [row[(width - 1)...].joined(separator: String(delimiter))]
        }
        guard ragged <= Int((Double(body.count) / 10).rounded(.up)) else { return nil }
        return DataTable(
            header: header,
            rows: rows,
            numeric: header.indices.map { isNumericColumn(rows, column: $0) }
        )
    }

    /// RFC 4180 split: `delimiter` between fields, LF or CRLF between
    /// records, a field wrapped in double quotes may carry any of those, and
    /// `""` inside it is one quote. An unquoted field is trimmed; a quoted
    /// one keeps its whitespace. With a pipe delimiter, `\|` is a literal
    /// pipe, which is how a GitHub table carries one.
    static func parseDelimited(_ source: String, delimiter: Character) -> [[String]] {
        let escaped = delimiter == "|"
        var rows: [[String]] = []
        var row: [String] = []
        var cell = ""
        var inQuotes = false
        var wasQuoted = false
        func endCell() {
            row.append(wasQuoted ? cell : cell.trimmingCharacters(in: .whitespaces))
            cell = ""
            wasQuoted = false
        }
        func endRow() {
            endCell()
            rows.append(row)
            row = []
        }
        let chars = Array(source)
        var i = 0
        while i < chars.count {
            let c = chars[i]
            if inQuotes {
                if c != "\"" {
                    cell.append(c)
                } else if i + 1 < chars.count, chars[i + 1] == "\"" {
                    cell.append("\"")
                    i += 1
                } else {
                    inQuotes = false
                }
                i += 1
                continue
            }
            if c == "\"", !wasQuoted, cell.allSatisfy(\.isWhitespace) {
                inQuotes = true
                wasQuoted = true
                cell = ""
            } else if escaped, c == "\\", i + 1 < chars.count, chars[i + 1] == delimiter {
                cell.append(delimiter)
                i += 1
            } else if c == delimiter {
                endCell()
            } else if c == "\n" || c == "\r" {
                if c == "\r", i + 1 < chars.count, chars[i + 1] == "\n" { i += 1 }
                endRow()
            } else {
                cell.append(c)
            }
            i += 1
        }
        if !cell.isEmpty || wasQuoted || !row.isEmpty { endRow() }
        return rows
    }

    /// The delimiter a ```table fence uses, read off its first non-empty
    /// line: whichever candidate appears most, ties going to the more
    /// deliberate character (a tab or a pipe is never punctuation in prose, a
    /// comma often is).
    static func detectDelimiter(_ source: String) -> Character? {
        let line = source.split(separator: "\n").first { !$0.allSatisfy(\.isWhitespace) } ?? ""
        var best: Character?
        var bestCount = 0
        for candidate in ["\t", "|", ";", ","] as [Character] {
            let count: Int
            if candidate == "|" {
                count = line.replacingOccurrences(of: "\\|", with: "").filter { $0 == "|" }.count
            } else {
                count = line.filter { $0 == candidate }.count
            }
            if count > bestCount {
                best = candidate
                bestCount = count
            }
        }
        return best
    }

    /// `1,234.5`, `-$12`, `+3%`, `.5`: a number with the dressing a
    /// spreadsheet gives it, or nil when the cell is not one.
    static func parseNumber(_ cell: String) -> Double? {
        var s = cell.trimmingCharacters(in: .whitespaces)
        guard s.contains(where: \.isNumber) else { return nil }
        if s.hasSuffix("%") { s.removeLast() }
        var sign = 1.0
        var seenSign = false
        var body = ""
        for (index, char) in s.enumerated() {
            if (char == "-" || char == "+"), index <= 1, !seenSign, body.isEmpty {
                seenSign = true
                if char == "-" { sign = -1 }
            } else if "$€£¥".contains(char), body.isEmpty, index <= 1 {
                continue
            } else {
                body.append(char)
            }
        }
        // Thousands groups must be groups of three.
        if body.contains(",") {
            let integer = body.split(separator: ".", maxSplits: 1, omittingEmptySubsequences: false)[0]
            let groups = integer.split(separator: ",", omittingEmptySubsequences: false)
            guard groups.count > 1, let first = groups.first, (1...3).contains(first.count),
                  groups.dropFirst().allSatisfy({ $0.count == 3 })
            else { return nil }
            body = body.replacingOccurrences(of: ",", with: "")
        }
        guard body.allSatisfy({ $0.isNumber || $0 == "." }),
              body.filter({ $0 == "." }).count <= 1,
              let value = Double(body.hasPrefix(".") ? "0" + body : body)
        else { return nil }
        return sign * value
    }

    /// True when the column has a value and every value it has is a number.
    static func isNumericColumn(_ rows: [[String]], column: Int) -> Bool {
        var seen = false
        for row in rows {
            let cell = column < row.count ? row[column] : ""
            if cell.allSatisfy(\.isWhitespace) { continue }
            if parseNumber(cell) == nil { return false }
            seen = true
        }
        return seen
    }

    /// A copy of `rows` ordered by one column. Numeric columns compare as
    /// numbers, text columns with a natural, case-insensitive collation.
    /// Empty cells go last either way, and ties keep their source order.
    static func sorted(
        _ rows: [[String]],
        by column: Int,
        direction: SortDirection,
        numeric: Bool
    ) -> [[String]] {
        let sign = direction == .descending ? -1 : 1
        return rows.enumerated().sorted { lhs, rhs in
            let a = column < lhs.element.count ? lhs.element[column] : ""
            let b = column < rhs.element.count ? rhs.element[column] : ""
            let aEmpty = a.allSatisfy(\.isWhitespace), bEmpty = b.allSatisfy(\.isWhitespace)
            if aEmpty != bEmpty { return bEmpty }
            let order: Int
            if numeric {
                let x = parseNumber(a) ?? 0, y = parseNumber(b) ?? 0
                order = x < y ? -1 : x > y ? 1 : 0
            } else {
                switch a.compare(b, options: [.caseInsensitive, .numeric]) {
                case .orderedAscending: order = -1
                case .orderedDescending: order = 1
                case .orderedSame: order = 0
                }
            }
            if order != 0 { return sign * order < 0 }
            return lhs.offset < rhs.offset
        }.map(\.element)
    }

    /// Rows with `query` somewhere in them, case-insensitive; all of them for
    /// a blank query.
    static func filtered(_ rows: [[String]], query: String) -> [[String]] {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        if q.isEmpty { return rows }
        return rows.filter { row in row.contains { $0.lowercased().contains(q) } }
    }

    /// The header and rows as RFC 4180 CSV, comma separated, LF line breaks.
    static func csv(header: [String], rows: [[String]]) -> String {
        func field(_ c: String) -> String {
            c.contains(where: { "\",\r\n".contains($0) })
                ? "\"" + c.replacingOccurrences(of: "\"", with: "\"\"") + "\""
                : c
        }
        return ([header] + rows).map { $0.map(field).joined(separator: ",") }.joined(separator: "\n")
    }

    /// `20 rows`, `1 row`, or `3 of 20 rows` while a filter is narrowing; when
    /// the grid shows fewer than match, `first 500 of 3,000 rows`.
    static func rowCountLabel(shown: Int, total: Int, rendered: Int? = nil) -> String {
        let rendered = rendered ?? shown
        func n(_ value: Int) -> String {
            value.formatted(.number.locale(Locale(identifier: "en_US")))
        }
        let rows = total == 1 ? "row" : "rows"
        if rendered < shown {
            return shown == total
                ? "first \(n(rendered)) of \(n(shown)) \(rows)"
                : "first \(n(rendered)) of \(n(shown)) matches"
        }
        return shown == total ? "\(n(total)) \(rows)" : "\(n(shown)) of \(n(total)) \(rows)"
    }

    // MARK: - Pipe tables

    private static func stripPipeEdges(_ source: String) -> String {
        source.split(separator: "\n", omittingEmptySubsequences: false).map { line -> String in
            var text = Substring(line)
            let lead = text.prefix { $0 == " " || $0 == "\t" }
            if text[lead.endIndex...].first == "|" {
                text = text[text.index(after: lead.endIndex)...]
            }
            let trailing = text.reversed().prefix(while: { $0 == " " || $0 == "\t" }).count
            let body = text.dropLast(trailing)
            // The trailing edge must not be an escaped pipe: `| a \| |` ends
            // in `|`, but `| a \|` ends in a literal one.
            if body.last == "|", !body.dropLast().hasSuffix("\\") {
                text = body.dropLast()
            }
            return String(text)
        }.joined(separator: "\n")
    }

    /// A GitHub pipe-table rule: every cell is dashes, with optional colons.
    private static func isPipeRule(_ row: [String]) -> Bool {
        row.allSatisfy { cell in
            var body = Substring(cell)
            if body.hasPrefix(":") { body = body.dropFirst() }
            if body.hasSuffix(":") { body = body.dropLast() }
            return !body.isEmpty && body.allSatisfy { $0 == "-" }
        }
    }
}
