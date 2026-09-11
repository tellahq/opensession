import SwiftUI

/// A ```palette fence as a row of swatches that wrap. Each tile copies its
/// value on tap and shows a short "Copied" state.
struct PaletteBlockView: View {
    let entries: [PaletteEntry]

    var body: some View {
        FlowLayout(spacing: 8) {
            ForEach(Array(entries.enumerated()), id: \.offset) { _, entry in
                PaletteSwatch(entry: entry)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Colour palette")
    }
}

private struct PaletteSwatch: View {
    let entry: PaletteEntry

    @State private var copied = false

    private var fill: Color? {
        entry.rgba.map { Color(red: $0.red, green: $0.green, blue: $0.blue).opacity($0.alpha) }
    }

    var body: some View {
        Button {
            copyToPasteboard(entry.value)
            copied = true
            Task {
                try? await Task.sleep(for: .seconds(1.4))
                copied = false
            }
        } label: {
            VStack(alignment: .leading, spacing: 5) {
                ZStack {
                    // A checker under a translucent colour, so alpha reads.
                    Checkerboard()
                        .fill(OS1VisualStyle.textFaint.opacity(0.35))
                    if let fill {
                        fill
                    } else {
                        Image(systemName: "questionmark")
                            .font(.caption)
                            .foregroundStyle(OS1VisualStyle.textFaint)
                    }
                    if copied {
                        Text("Copied")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(.white)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(.black.opacity(0.6), in: Capsule())
                    }
                }
                .frame(width: 88, height: 52)
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .stroke(OS1VisualStyle.border, lineWidth: 0.5)
                }
                if !entry.name.isEmpty {
                    Text(entry.name)
                        .font(.caption.weight(.medium))
                        .foregroundStyle(OS1VisualStyle.text)
                        .lineLimit(1)
                }
                Text(entry.value)
                    .font(.system(.caption2, design: .monospaced))
                    .foregroundStyle(OS1VisualStyle.textDim)
                    .lineLimit(1)
            }
            .frame(width: 88, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(entry.name.isEmpty ? entry.value : "\(entry.name), \(entry.value)")
        .accessibilityHint("Copies the colour value")
        .help("Copy \(entry.value)")
    }
}

private struct Checkerboard: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        let side: CGFloat = 8
        var y = rect.minY
        var row = 0
        while y < rect.maxY {
            var x = rect.minX + (row % 2 == 0 ? 0 : side)
            while x < rect.maxX {
                path.addRect(CGRect(x: x, y: y, width: side, height: side))
                x += side * 2
            }
            y += side
            row += 1
        }
        return path
    }
}
