import SwiftUI

/// The model choices every model menu opens on: the five from the person's
/// recent picks and the curated best, in their synced order, then "More models" with the rest of the catalog in
/// sections by provider. See `TopModels`.
///
/// Callers draw the row, since each surface picks a model its own way; a
/// row's action calls `TopModels.recordPick`.
struct ModelMenuRows<Row: View>: View {
    @AppStorage(TopModels.storageKey) private var savedOrder = ""
    @AppStorage(TopModels.recentStorageKey) private var savedRecent = "[]"

    let catalog: ModelCatalog
    let isSelected: (ModelOption) -> Bool
    @ViewBuilder let row: (ModelOption) -> Row

    var body: some View {
        let split = catalog.topModels(
            order: TopModels.decodeOrder(savedOrder),
            recent: TopModels.decodeRecent(savedRecent) ?? []
        )
        ForEach(split.top) { option in
            row(option)
        }
        if !split.more.isEmpty {
            let groups = TopModels.providerGroups(split.more)
            // Name the current model on the trigger when it lives in here;
            // otherwise the open menu would show no checked row at all.
            let selected = split.more.first(where: isSelected)
            Menu {
                if groups.count > 1 {
                    ForEach(groups) { group in
                        Section(group.label) {
                            ForEach(group.options) { option in
                                row(option)
                            }
                        }
                    }
                } else {
                    ForEach(split.more) { option in
                        row(option)
                    }
                }
            } label: {
                Label(
                    selected.map { "More models · \($0.displayLabel)" } ?? "More models",
                    systemImage: "ellipsis.circle"
                )
            }
        }
    }
}
