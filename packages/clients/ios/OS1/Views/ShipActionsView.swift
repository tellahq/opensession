import SwiftUI

/// Ship plus the repository's own buttons, the native counterpart of the
/// web's `ShipActions`. Each button sends its prompt to the session's agent;
/// the server decides what Ship says for this session's ship mode.
struct ShipActionsBand: View {
    let info: SessionShipInfo.Details
    /// The session is mid-run: the buttons wait for it to finish.
    let isRunning: Bool
    /// The id of the button just pressed, shown as sent until it clears.
    let sent: String?
    let run: (ShipButton) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            // One row when it fits, else stacked: a wrapping layout proposes
            // no width inside a List row and squeezes the buttons.
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 8) { buttons }
                VStack(alignment: .leading, spacing: 8) { buttons }
            }
            Text(isRunning ? Self.busyHint : info.destination)
                .font(.caption)
                .foregroundStyle(OS1VisualStyle.textDim)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.vertical, 4)
    }

    private var buttons: some View {
        ForEach(info.buttons) { button in
            shipButton(button).fixedSize()
        }
    }

    static let busyHint = "The agent is working. You can ship once the current run finishes."

    @ViewBuilder
    private func shipButton(_ button: ShipButton) -> some View {
        let label = HStack(spacing: 6) {
            if button.primary {
                Image(systemName: info.isDirect ? "paperplane" : "arrow.trianglehead.pull")
            }
            Text(title(button))
                .lineLimit(1)
                .fixedSize()
        }
        .font(.subheadline.weight(button.primary ? .semibold : .regular))
        if button.primary {
            Button { run(button) } label: { label }
                .buttonStyle(.borderedProminent)
                .disabled(isRunning || sent == button.id)
        } else {
            Button { run(button) } label: { label }
                .buttonStyle(.bordered)
                .disabled(isRunning || sent == button.id)
        }
    }

    private func title(_ button: ShipButton) -> String {
        guard sent == button.id else { return button.label }
        return button.primary ? "Shipping…" : "Sent"
    }
}

/// The latest direct ship: pushed, then confirmed on the remote's default
/// branch. Mirrors the web's `DirectShipNotice`.
struct DirectShipNoticeView: View {
    let ship: DirectShip

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: ship.isShipped ? "checkmark.circle.fill" : "paperplane")
                .font(.callout)
                .foregroundStyle(ship.isShipped ? OS1VisualStyle.green : OS1VisualStyle.textDim)
                .frame(width: 20)
            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(ship.isShipped ? "Shipped to \(ship.target)" : "Pushed to \(ship.target)")
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(OS1VisualStyle.text)
                    Text(ship.shortSha)
                        .font(.caption.monospaced())
                        .foregroundStyle(OS1VisualStyle.textDim)
                }
                Text(detail)
                    .font(.caption)
                    .foregroundStyle(OS1VisualStyle.textDim)
            }
        }
        .accessibilityElement(children: .combine)
    }

    private var detail: String {
        let count = ship.commits.count
        let commits = "\(count) commit\(count == 1 ? "" : "s")"
        guard ship.isShipped else { return "\(commits) · confirming on the remote" }
        guard let date = ship.shippedDate else { return commits }
        return "\(commits) · \(date.formatted(date: .abbreviated, time: .shortened))"
    }
}
