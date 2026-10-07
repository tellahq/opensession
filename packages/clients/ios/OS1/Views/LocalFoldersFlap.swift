import SwiftUI

/// The folders on people's own computers this session can reach, as a row of
/// chips above the composer: name, then the device, "Read only", or "<device>
/// is offline". Each chip's menu names the folder and device and, for the
/// person who connected it, offers Disconnect. Nothing else: this app holds
/// no folders, so connecting one and allowing edits stay on the device that
/// does (the Mac app, Chrome or Edge).
///
/// Its own view struct so the folder list never invalidates the transcript.
struct LocalFoldersFlap: View {
    let model: SessionLocalFoldersModel
    let contentMaxWidth: CGFloat
    let horizontalInset: CGFloat

    var body: some View {
        if !model.folders.isEmpty || model.error != nil {
            VStack(alignment: .leading, spacing: 4) {
                if !model.folders.isEmpty {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 4) {
                            ForEach(model.folders) { folder in
                                chip(folder)
                            }
                        }
                    }
                    .scrollClipDisabled()
                }
                if let error = model.error {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Image(systemName: "exclamationmark.triangle.fill")
                        Text(error)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        Button {
                            model.dismissError()
                        } label: {
                            Image(systemName: "xmark")
                        }
                        .buttonStyle(.borderless)
                        .accessibilityLabel("Dismiss")
                    }
                    .font(.footnote)
                    .foregroundStyle(OS1VisualStyle.redInk)
                    .padding(.horizontal, 8)
                }
            }
            .frame(maxWidth: contentMaxWidth, alignment: .leading)
            .frame(maxWidth: .infinity)
            .padding(.horizontal, horizontalInset)
            .padding(.top, 4)
            .animation(.smooth(duration: 0.2), value: model.folders)
            .animation(.smooth(duration: 0.2), value: model.error)
        }
    }

    private func chip(_ folder: LocalFolder) -> some View {
        let busy = model.disconnecting.contains(folder.key)
        return Menu {
            Section("\(folder.displayPath ?? folder.name) on \(folder.deviceLabel)") {
                if model.canDisconnect(folder) {
                    Button(role: .destructive) {
                        Task { await model.disconnect(folder) }
                    } label: {
                        Label("Disconnect", systemImage: "xmark")
                    }
                    .disabled(busy)
                } else if !folder.owner.isEmpty {
                    Text("Only \(folder.owner) can disconnect it")
                }
            }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "folder")
                    .font(.footnote)
                    .foregroundStyle(
                        folder.online ? OS1VisualStyle.textDim : OS1VisualStyle.textFaint
                    )
                Text(folder.name)
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(folder.online ? .primary : OS1VisualStyle.textDim)
                    .lineLimit(1)
                Text(folder.status)
                    .font(.footnote)
                    .foregroundStyle(OS1VisualStyle.textFaint)
                    .lineLimit(1)
                if busy { ProgressView().controlSize(.mini) }
            }
            .padding(.horizontal, 10)
            .frame(minHeight: 30)
            .background(OS1VisualStyle.flapSurface, in: Capsule())
            .overlay { Capsule().stroke(OS1VisualStyle.border, lineWidth: 0.5) }
            .contentShape(Capsule())
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .fixedSize()
        .accessibilityLabel("\(folder.name) on \(folder.deviceLabel), \(folder.status)")
    }
}
