import SwiftUI
#if os(iOS)
import UIKit
#else
import AppKit
#endif

/// A placed picture or recording: an `OPENSESSION_IMAGE` / `_VIDEO` line the
/// server rewrote into the message where it was written, shown whole at the
/// column's width under its heading with its caption, and fetched with the
/// session's credentials like every other transcript picture. A tap opens
/// the viewer; on the phone a pinch zooms it in place.
struct MediaFigureView: View {
    let figure: MediaFigure

    @Environment(\.transcriptSessionId) private var sessionId
    @Environment(\.openPanel) private var openPanel
    @State private var data: Data?
    @State private var failed = false
    @State private var retry = 0
    @State private var presented = false

    private var resolvedSessionId: String { openPanel.sessionId ?? sessionId ?? "" }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if figure.isVideo {
                ConversationVideoStrip(sources: [figure.source], sessionId: resolvedSessionId, maxWidth: .infinity)
            } else {
                still
            }
            if let caption = figure.caption {
                Text(caption)
                    .font(.caption)
                    .foregroundStyle(OS1VisualStyle.textDim)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(figure.caption ?? (figure.isVideo ? "Video" : "Image"))
    }

    @ViewBuilder
    private var still: some View {
        Group {
            if let data, let image = Self.image(data) {
                Button {
                    presented = true
                } label: {
                    image
                        .resizable()
                        .scaledToFit()
                        .frame(maxWidth: .infinity, maxHeight: Self.maxHeight, alignment: .leading)
                        .clipShape(BlockChrome.shape)
                        .overlay {
                            BlockChrome.shape.stroke(OS1VisualStyle.border.opacity(0.6), lineWidth: 0.5)
                        }
                }
                .buttonStyle(.plain)
                .accessibilityLabel(figure.caption ?? "Open image")
                #if os(iOS)
                .accessibilityHint("Shows the image full screen")
                .pinchToPeek(data, cornerRadius: 10)
                .fullScreenCover(isPresented: $presented) {
                    FullScreenImagePreview(
                        items: [PreviewImage(id: figure.source, source: .data(data), label: figure.caption)],
                        index: 0
                    )
                }
                #else
                .accessibilityHint("Shows the image larger")
                .sheet(isPresented: $presented) {
                    MacImagePreview(images: [data], index: 0)
                }
                #endif
            } else {
                Button {
                    retry += 1
                } label: {
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .fill(.fill.tertiary)
                        .frame(height: 160)
                        .overlay {
                            if failed {
                                Image(systemName: "arrow.clockwise").foregroundStyle(.tertiary)
                            } else {
                                ProgressView().controlSize(.small)
                            }
                        }
                }
                .buttonStyle(.plain)
                .disabled(!failed)
                .accessibilityLabel(failed ? "Retry image" : "Loading image")
            }
        }
        .task(id: "\(figure.source)#\(retry)") {
            guard data == nil else { return }
            failed = false
            do {
                data = try await OS1API.conversationImage(source: figure.source, sessionId: resolvedSessionId)
            } catch {
                failed = true
            }
        }
    }

    private static func image(_ data: Data) -> Image? {
        #if os(iOS)
        UIImage(data: data).map(Image.init(uiImage:))
        #else
        NSImage(data: data).map(Image.init(nsImage:))
        #endif
    }

    private static var maxHeight: CGFloat {
        #if os(iOS)
        400
        #else
        480
        #endif
    }
}
