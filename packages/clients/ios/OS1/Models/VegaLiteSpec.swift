import Foundation

/// The subset of a Vega-Lite spec this app draws with Swift Charts: one
/// unit view with inline data, a bar, line, area, point or tick mark, an x
/// and y encoding, and optionally a colour series (docs/blocks.md,
/// "Diagrams and charts"). The web runs vega itself; a spec outside this
/// subset (layers, transforms, a data URL, a repeat) keeps its code fence,
/// which is what the web does with source vega cannot compile.
struct VegaLiteChart: Equatable {
    enum Mark: String, Equatable { case bar, line, area, point, circle, square, tick }

    enum Value: Hashable {
        case category(String)
        case number(Double)
        case date(Date)

        var label: String {
            switch self {
            case .category(let text): text
            case .number(let value): value.formatted(.number.precision(.fractionLength(0...2)))
            case .date(let date): date.formatted(date: .abbreviated, time: .omitted)
            }
        }
    }

    struct Point: Equatable {
        var x: Value
        var y: Double
        var series: String?
    }

    var title: String?
    var mark: Mark
    var xTitle: String
    var yTitle: String
    var seriesTitle: String?
    /// True when the x channel is nominal or ordinal: bars group by category.
    var xIsCategorical: Bool
    /// True when the series channel is `xOffset`: grouped, not stacked, bars.
    var grouped: Bool
    var points: [Point]

    /// The spec as a chart, or nil for anything outside the subset. Inline
    /// `data.values` only: a URL would have to be fetched, and only this
    /// instance's asset route would be safe to fetch from.
    static func parse(_ source: String) -> VegaLiteChart? {
        guard let data = source.data(using: .utf8),
              let spec = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return nil }
        for unsupported in ["layer", "hconcat", "vconcat", "concat", "repeat", "facet", "spec", "transform"]
        where spec[unsupported] != nil { return nil }
        guard let mark = parseMark(spec["mark"]),
              let values = (spec["data"] as? [String: Any])?["values"] as? [[String: Any]], !values.isEmpty,
              let encoding = spec["encoding"] as? [String: Any],
              let x = encoding["x"] as? [String: Any], let xField = x["field"] as? String,
              let y = encoding["y"] as? [String: Any]
        else { return nil }
        let yField = y["field"] as? String
        let aggregate = (y["aggregate"] as? String)?.lowercased()
        guard yField != nil || aggregate == "count" else { return nil }
        let xType = ((x["type"] as? String) ?? "nominal").lowercased()
        let series = encoding["color"] as? [String: Any] ?? encoding["xOffset"] as? [String: Any]
        let seriesField = series?["field"] as? String

        var points: [Point] = []
        for row in values {
            guard let xValue = value(row[xField], type: xType) else { continue }
            let seriesValue = seriesField.flatMap { row[$0] }.map(text)
            if aggregate == nil {
                guard let yField, let yValue = number(row[yField]) else { continue }
                points.append(Point(x: xValue, y: yValue, series: seriesValue))
            } else {
                points.append(Point(x: xValue, y: yField.flatMap { number(row[$0]) } ?? 0, series: seriesValue))
            }
        }
        guard !points.isEmpty else { return nil }
        if let aggregate {
            points = aggregated(points, by: aggregate)
            guard !points.isEmpty else { return nil }
        }
        let yTitleDefault: String
        if let aggregate {
            yTitleDefault = yField.map { "\(aggregate) of \($0)" } ?? "Count"
        } else {
            yTitleDefault = yField ?? ""
        }
        return VegaLiteChart(
            title: titleText(spec["title"]),
            mark: mark,
            xTitle: (x["title"] as? String) ?? xField,
            yTitle: (y["title"] as? String) ?? yTitleDefault,
            seriesTitle: series.flatMap { ($0["title"] as? String) } ?? seriesField,
            xIsCategorical: xType == "nominal" || xType == "ordinal",
            grouped: encoding["xOffset"] != nil,
            points: points
        )
    }

    private static func parseMark(_ raw: Any?) -> Mark? {
        let name = (raw as? String) ?? ((raw as? [String: Any])?["type"] as? String)
        return name.flatMap { Mark(rawValue: $0.lowercased()) }
    }

    private static func titleText(_ raw: Any?) -> String? {
        if let text = raw as? String { return text }
        if let object = raw as? [String: Any], let text = object["text"] as? String { return text }
        return nil
    }

    private static func number(_ raw: Any?) -> Double? {
        if let n = raw as? NSNumber, !(raw is Bool) { return n.doubleValue.isFinite ? n.doubleValue : nil }
        if let s = raw as? String { return Double(s) }
        return nil
    }

    private static func text(_ raw: Any) -> String {
        if let s = raw as? String { return s }
        if let n = raw as? NSNumber { return n.stringValue }
        return String(describing: raw)
    }

    private static let isoDate: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withFullDate]
        return formatter
    }()

    private static func value(_ raw: Any?, type: String) -> Value? {
        guard let raw, !(raw is NSNull) else { return nil }
        switch type {
        case "quantitative":
            return number(raw).map(Value.number)
        case "temporal":
            if let s = raw as? String {
                if let date = Session.parseISO(s) ?? isoDate.date(from: s) { return .date(date) }
                return nil
            }
            return number(raw).map { .date(Date(timeIntervalSince1970: $0 / 1000)) }
        default:
            return .category(text(raw))
        }
    }

    /// `count`, `sum`, `mean`/`average`, `min`, `max` over rows sharing an x
    /// and a series, in first-seen order.
    private static func aggregated(_ points: [Point], by aggregate: String) -> [Point] {
        struct Key: Hashable { let x: Value; let series: String? }
        var order: [Key] = []
        var groups: [Key: [Point]] = [:]
        for point in points {
            let key = Key(x: point.x, series: point.series)
            if groups[key] == nil { order.append(key) }
            groups[key, default: []].append(point)
        }
        return order.compactMap { key -> Point? in
            guard let group = groups[key], let first = group.first else { return nil }
            let ys = group.map(\.y)
            let y: Double
            switch aggregate {
            case "count": y = Double(group.count)
            case "sum": y = ys.reduce(0, +)
            case "mean", "average": y = ys.reduce(0, +) / Double(ys.count)
            case "min": y = ys.min() ?? 0
            case "max": y = ys.max() ?? 0
            default: return nil
            }
            return Point(x: first.x, y: y, series: first.series)
        }
    }
}
