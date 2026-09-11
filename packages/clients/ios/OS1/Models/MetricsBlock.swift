import Foundation

/// The ```metrics fence: a row of cards, each a big number with a small
/// label and an optional delta (docs/blocks.md, "Metrics"). Two grammars:
///
///   Requests: 1,204 (+12%)        one metric per line, delta in parentheses
///   [{"label":"p95","value":340,"unit":"ms","delta":-3}]
///
/// A fence that does not parse keeps its code block, so a half-streamed or
/// mis-shaped one is still readable.
struct Metric: Equatable {
    enum Trend: Equatable { case up, down, flat }

    var label: String
    var value: String
    var unit: String?
    var delta: String?
    var trend: Trend
}

enum MetricsBlock {
    /// The metrics a fence lists, or nil when it is not a metrics fence after
    /// all: an empty body, a JSON body that is not an array of `{label,
    /// value}` objects, or a line that is not `Label: value (delta)`.
    static func parse(_ source: String) -> [Metric]? {
        let body = source.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !body.isEmpty else { return nil }
        // Anything JSON-shaped is read as JSON: a bare object is not the
        // array the grammar asks for, and must not fall through to the line
        // reader.
        if body.hasPrefix("[") || body.hasPrefix("{") {
            return parseJson(body)
        }
        var metrics: [Metric] = []
        for raw in body.split(separator: "\n", omittingEmptySubsequences: false) {
            let line = raw.trimmingCharacters(in: .whitespaces)
            if line.isEmpty { continue }
            guard let metric = fromLine(line) else { return nil }
            metrics.append(metric)
        }
        return metrics.isEmpty ? nil : metrics
    }

    /// The direction a delta reads as, from its sign or arrow.
    static func trend(of delta: String?) -> Metric.Trend {
        guard let lead = delta?.trimmingCharacters(in: .whitespaces).first else { return .flat }
        if "+▲↑".contains(lead) { return .up }
        if "-−▼↓".contains(lead) { return .down }
        return .flat
    }

    private static func fromLine(_ line: String) -> Metric? {
        guard let colon = line.firstIndex(of: ":") else { return nil }
        let label = line[..<colon].trimmingCharacters(in: .whitespaces)
        var value = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
        guard !label.isEmpty, !value.isEmpty else { return nil }
        var delta: String?
        if value.hasSuffix(")"), let open = value.lastIndex(of: "(") {
            let inner = value[value.index(after: open)..<value.index(before: value.endIndex)]
            guard !inner.contains("("), !inner.contains(")") else { return nil }
            let trimmed = inner.trimmingCharacters(in: .whitespaces)
            delta = trimmed.isEmpty ? nil : trimmed
            value = value[..<open].trimmingCharacters(in: .whitespaces)
            guard !value.isEmpty else { return nil }
        }
        return Metric(label: label, value: value, unit: nil, delta: delta, trend: trend(of: delta))
    }

    private static let formatter: NumberFormatter = {
        let formatter = NumberFormatter()
        formatter.locale = Locale(identifier: "en_US")
        formatter.numberStyle = .decimal
        formatter.maximumFractionDigits = 2
        return formatter
    }()

    private static func parseJson(_ body: String) -> [Metric]? {
        guard let data = body.data(using: .utf8),
              let array = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]],
              !array.isEmpty
        else { return nil }
        var metrics: [Metric] = []
        for entry in array {
            guard let label = text(entry["label"]), let value = number(entry["value"]) ?? text(entry["value"])
            else { return nil }
            var delta: String?
            if let raw = entry["delta"] {
                if let n = raw as? NSNumber, !(raw is Bool) {
                    let magnitude = formatter.string(from: NSNumber(value: abs(n.doubleValue))) ?? "\(abs(n.doubleValue))"
                    delta = n.doubleValue > 0 ? "+\(magnitude)" : n.doubleValue < 0 ? "-\(magnitude)" : magnitude
                } else if let s = text(raw) {
                    delta = s
                } else if !(raw is NSNull) {
                    return nil
                }
            }
            var unit: String?
            if let raw = entry["unit"] {
                guard let s = text(raw) else { return nil }
                unit = s
            }
            metrics.append(Metric(label: label, value: value, unit: unit, delta: delta, trend: trend(of: delta)))
        }
        return metrics
    }

    /// A non-blank string, trimmed; blank is rejected, not emptied.
    private static func text(_ raw: Any?) -> String? {
        guard let s = raw as? String else { return nil }
        let trimmed = s.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    /// A value written as a number is formatted for reading.
    private static func number(_ raw: Any?) -> String? {
        guard let n = raw as? NSNumber, !(raw is Bool), n.doubleValue.isFinite else { return nil }
        return formatter.string(from: n)
    }
}
