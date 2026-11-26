import SwiftUI

/// "Conversation usage" as it appears inside a model menu — the same place
/// the web put it, and for the same reason: what a turn costs belongs beside
/// the choice that decides the cost, not in a meter of its own.
///
/// A submenu, so the resting menu spends one row on it and the breakdown is
/// one step away. It renders even before the first run: `$0.00` and `0 turns`
/// is an answer, and a row that appears only once a session has spent money
/// reads as a bug the first time you look for it.
struct UsageMenuSection: View {
    let usage: SessionUsage?

    var body: some View {
        Menu {
            Section(resolved.turnsLabel) {
                Text("Cost \(resolved.costLabel())")
                if let context = resolved.contextLabel() {
                    Text("Context \(context)")
                }
            }
            // What fills the context, the web's per-section breakdown. A menu
            // draws text only, so each part is a row and its share the value.
            if let rows = resolved.context?.rows, !rows.isEmpty {
                Section("What fills the context") {
                    ForEach(rows) { row in
                        Text(
                            "\(row.label) \(SessionUsage.tokenLabel(row.tokens))"
                                + " · \(ContextBreakdown.share(row, of: rows))%"
                        )
                    }
                    if let note = resolved.compactionNote() {
                        Text(note)
                    }
                }
            } else if let note = resolved.compactionNote() {
                Section { Text(note) }
            }
            Section {
                Text("Input \(SessionUsage.tokenLabel(resolved.inputTokens))")
                Text("Output \(SessionUsage.tokenLabel(resolved.outputTokens))")
                Text("Cache read \(resolved.cacheReadLabel())")
                Text(
                    "Cache write \(SessionUsage.tokenLabel(resolved.cacheCreationTokens))"
                )
            }
        } label: {
            // Same shape as this menu's other rows ("Model — Opus 5"): the
            // thing, then the value it currently holds.
            Label(
                "Conversation usage — \(resolved.costLabel())",
                systemImage: "chart.pie"
            )
        }
    }

    /// A session that has never run has no usage at all; show it as zero
    /// rather than hiding the row, which is what the web settled on.
    private var resolved: SessionUsage { usage ?? SessionUsage() }
}
