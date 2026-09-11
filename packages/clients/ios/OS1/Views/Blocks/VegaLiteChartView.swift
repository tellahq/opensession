import Charts
import SwiftUI

/// A ```vega-lite fence drawn with Swift Charts: the platform's own chart,
/// with its own palette, axes and Dynamic Type, for the subset
/// `VegaLiteChart` reads. The context menu copies the spec.
struct VegaLiteChartView: View {
    let chart: VegaLiteChart
    let source: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let title = chart.title {
                Text(title)
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(OS1VisualStyle.text)
            }
            Chart {
                ForEach(Array(chart.points.enumerated()), id: \.offset) { _, point in
                    marks(point)
                }
            }
            .chartXAxisLabel(chart.xTitle)
            .chartYAxisLabel(chart.yTitle)
            .chartLegend(chart.points.contains { $0.series != nil } ? .visible : .hidden)
            .frame(height: 220)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(OS1VisualStyle.markdownCodeWell, in: BlockChrome.shape)
        .overlay {
            BlockChrome.shape.stroke(OS1VisualStyle.border.opacity(0.6), lineWidth: 0.5)
        }
        .contextMenu {
            Button {
                copyToPasteboard(source)
            } label: {
                Label("Copy spec", systemImage: "document.on.document")
            }
        }
        .accessibilityLabel(chart.title ?? "Chart")
    }

    @ChartContentBuilder
    private func marks(_ point: VegaLiteChart.Point) -> some ChartContent {
        let series = point.series ?? ""
        switch point.x {
        case .category(let x):
            mark(x: .value(chart.xTitle, x), point: point, series: series)
        case .number(let x):
            mark(x: .value(chart.xTitle, x), point: point, series: series)
        case .date(let x):
            mark(x: .value(chart.xTitle, x), point: point, series: series)
        }
    }

    @ChartContentBuilder
    private func mark<X: Plottable>(
        x: PlottableValue<X>,
        point: VegaLiteChart.Point,
        series: String
    ) -> some ChartContent {
        let y: PlottableValue<Double> = .value(chart.yTitle, point.y)
        let key = chart.seriesTitle ?? "Series"
        switch chart.mark {
        case .bar:
            if chart.grouped {
                BarMark(x: x, y: y)
                    .position(by: .value(key, series))
                    .foregroundStyle(by: .value(key, series))
            } else {
                BarMark(x: x, y: y)
                    .foregroundStyle(by: .value(key, series))
            }
        case .line:
            LineMark(x: x, y: y)
                .foregroundStyle(by: .value(key, series))
        case .area:
            AreaMark(x: x, y: y)
                .foregroundStyle(by: .value(key, series))
        case .point, .circle, .square:
            PointMark(x: x, y: y)
                .foregroundStyle(by: .value(key, series))
        case .tick:
            RectangleMark(x: x, y: y, height: .fixed(2))
                .foregroundStyle(by: .value(key, series))
        }
    }
}
