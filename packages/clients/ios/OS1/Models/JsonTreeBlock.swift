import Foundation

/// A ```json fence large enough to be worth folding renders as a collapsible
/// tree (docs/blocks.md, "JSON tree"). The parser keeps object keys in the
/// order they were written, which `JSONSerialization` does not, so it is its
/// own small recursive descent over the text.
indirect enum JsonNode: Equatable {
    case null
    case bool(Bool)
    case number(String)
    case string(String)
    case array([JsonNode])
    case object([(key: String, value: JsonNode)])

    static func == (lhs: JsonNode, rhs: JsonNode) -> Bool {
        switch (lhs, rhs) {
        case (.null, .null): true
        case (.bool(let a), .bool(let b)): a == b
        case (.number(let a), .number(let b)): a == b
        case (.string(let a), .string(let b)): a == b
        case (.array(let a), .array(let b)): a == b
        case (.object(let a), .object(let b)):
            a.count == b.count && zip(a, b).allSatisfy { $0.key == $1.key && $0.value == $1.value }
        default: false
        }
    }

    var isContainer: Bool {
        switch self {
        case .array, .object: true
        default: false
        }
    }

    var childCount: Int {
        switch self {
        case .array(let items): items.count
        case .object(let entries): entries.count
        default: 0
        }
    }
}

enum JsonTreeBlock {
    /// A fence with more lines than this is worth folding …
    static let minLines = 30
    /// … or more characters than this (minified JSON is one long line).
    static let minCharacters = 1500
    /// Past this the tree would be heavier than the wall of text it replaces.
    static let maxCharacters = 200_000
    /// Containers at this depth and deeper start folded (root is depth 0).
    static let collapseDepth = 2
    /// Bound recursive parsing of untrusted fences. Root is depth 0.
    static let maxDepth = 64
    /// Rows rendered per container; the rest are counted in one closing row.
    static let maxChildren = 500

    /// Whether a fence is big enough that a tree beats reading it as text.
    static func worthFolding(_ source: String) -> Bool {
        let text = source.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.count > maxCharacters { return false }
        if text.count > minCharacters { return true }
        return text.filter { $0 == "\n" }.count + 1 > minLines
    }

    /// The fence as a tree, or nil when it does not parse or is not an
    /// object or array: a bare string or number has nothing to fold.
    static func parse(_ source: String) -> JsonNode? {
        var parser = Parser(text: Array(source.utf8))
        guard let node = parser.parseDocument(), node.isContainer else { return nil }
        return node
    }

    /// `{3 keys}` or `[12 items]`, for a folded container's row.
    static func summary(of node: JsonNode) -> String {
        switch node {
        case .array(let items): items.count == 1 ? "[1 item]" : "[\(items.count) items]"
        case .object(let entries): entries.count == 1 ? "{1 key}" : "{\(entries.count) keys}"
        default: ""
        }
    }

    private struct Parser {
        let text: [UInt8]
        var index = 0

        init(text: [UInt8]) { self.text = text }

        mutating func parseDocument() -> JsonNode? {
            skipWhitespace()
            guard let value = parseValue(depth: 0) else { return nil }
            skipWhitespace()
            return index == text.count ? value : nil
        }

        private mutating func skipWhitespace() {
            while index < text.count, [0x20, 0x0A, 0x0D, 0x09].contains(text[index]) { index += 1 }
        }

        private mutating func parseValue(depth: Int) -> JsonNode? {
            guard depth <= JsonTreeBlock.maxDepth, index < text.count else { return nil }
            switch text[index] {
            case UInt8(ascii: "{"): return parseObject(depth: depth)
            case UInt8(ascii: "["): return parseArray(depth: depth)
            case UInt8(ascii: "\""): return parseString().map(JsonNode.string)
            case UInt8(ascii: "t"): return literal("true", .bool(true))
            case UInt8(ascii: "f"): return literal("false", .bool(false))
            case UInt8(ascii: "n"): return literal("null", .null)
            default: return parseNumber()
            }
        }

        private mutating func literal(_ word: String, _ node: JsonNode) -> JsonNode? {
            let bytes = Array(word.utf8)
            guard index + bytes.count <= text.count, Array(text[index..<index + bytes.count]) == bytes
            else { return nil }
            index += bytes.count
            return node
        }

        private mutating func parseNumber() -> JsonNode? {
            let start = index
            if index < text.count, text[index] == UInt8(ascii: "-") { index += 1 }
            var digits = 0
            while index < text.count, text[index] >= 0x30, text[index] <= 0x39 { index += 1; digits += 1 }
            guard digits > 0 else { return nil }
            if index < text.count, text[index] == UInt8(ascii: ".") {
                index += 1
                var fraction = 0
                while index < text.count, text[index] >= 0x30, text[index] <= 0x39 { index += 1; fraction += 1 }
                guard fraction > 0 else { return nil }
            }
            if index < text.count, text[index] == UInt8(ascii: "e") || text[index] == UInt8(ascii: "E") {
                index += 1
                if index < text.count, text[index] == UInt8(ascii: "+") || text[index] == UInt8(ascii: "-") { index += 1 }
                var exponent = 0
                while index < text.count, text[index] >= 0x30, text[index] <= 0x39 { index += 1; exponent += 1 }
                guard exponent > 0 else { return nil }
            }
            return .number(String(decoding: text[start..<index], as: UTF8.self))
        }

        private mutating func parseString() -> String? {
            guard index < text.count, text[index] == UInt8(ascii: "\"") else { return nil }
            index += 1
            var bytes: [UInt8] = []
            while index < text.count {
                let byte = text[index]
                index += 1
                if byte == UInt8(ascii: "\"") {
                    return String(decoding: bytes, as: UTF8.self)
                }
                if byte == UInt8(ascii: "\\") {
                    guard index < text.count else { return nil }
                    let escape = text[index]
                    index += 1
                    switch escape {
                    case UInt8(ascii: "\""): bytes.append(0x22)
                    case UInt8(ascii: "\\"): bytes.append(0x5C)
                    case UInt8(ascii: "/"): bytes.append(0x2F)
                    case UInt8(ascii: "b"): bytes.append(0x08)
                    case UInt8(ascii: "f"): bytes.append(0x0C)
                    case UInt8(ascii: "n"): bytes.append(0x0A)
                    case UInt8(ascii: "r"): bytes.append(0x0D)
                    case UInt8(ascii: "t"): bytes.append(0x09)
                    case UInt8(ascii: "u"):
                        guard var scalar = hex4() else { return nil }
                        if (0xD800...0xDBFF).contains(scalar),
                           index + 1 < text.count, text[index] == UInt8(ascii: "\\"),
                           text[index + 1] == UInt8(ascii: "u") {
                            index += 2
                            guard let low = hex4(), (0xDC00...0xDFFF).contains(low) else { return nil }
                            scalar = 0x10000 + ((scalar - 0xD800) << 10) + (low - 0xDC00)
                        }
                        guard let unicode = Unicode.Scalar(scalar) else { return nil }
                        bytes.append(contentsOf: Array(String(Character(unicode)).utf8))
                    default: return nil
                    }
                    continue
                }
                if byte < 0x20 { return nil }
                bytes.append(byte)
            }
            return nil
        }

        private mutating func hex4() -> UInt32? {
            guard index + 4 <= text.count,
                  let value = UInt32(String(decoding: text[index..<index + 4], as: UTF8.self), radix: 16)
            else { return nil }
            index += 4
            return value
        }

        private mutating func parseArray(depth: Int) -> JsonNode? {
            index += 1
            var items: [JsonNode] = []
            skipWhitespace()
            if index < text.count, text[index] == UInt8(ascii: "]") {
                index += 1
                return .array(items)
            }
            while true {
                skipWhitespace()
                guard let value = parseValue(depth: depth + 1) else { return nil }
                items.append(value)
                skipWhitespace()
                guard index < text.count else { return nil }
                if text[index] == UInt8(ascii: ",") { index += 1; continue }
                if text[index] == UInt8(ascii: "]") { index += 1; return .array(items) }
                return nil
            }
        }

        private mutating func parseObject(depth: Int) -> JsonNode? {
            index += 1
            var entries: [(key: String, value: JsonNode)] = []
            skipWhitespace()
            if index < text.count, text[index] == UInt8(ascii: "}") {
                index += 1
                return .object(entries)
            }
            while true {
                skipWhitespace()
                guard let key = parseString() else { return nil }
                skipWhitespace()
                guard index < text.count, text[index] == UInt8(ascii: ":") else { return nil }
                index += 1
                skipWhitespace()
                guard let value = parseValue(depth: depth + 1) else { return nil }
                entries.append((key, value))
                skipWhitespace()
                guard index < text.count else { return nil }
                if text[index] == UInt8(ascii: ",") { index += 1; continue }
                if text[index] == UInt8(ascii: "}") { index += 1; return .object(entries) }
                return nil
            }
        }
    }
}
