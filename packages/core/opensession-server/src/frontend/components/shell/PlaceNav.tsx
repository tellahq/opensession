import type { ReactNode } from "react";
import type { Place } from "../../lib/new-layout-place";
import {
  SIDEBAR_DENSITY_VARS,
  SIDEBAR_NAV_X,
  SIDEBAR_PLACE_TITLE,
  SIDEBAR_PLACE_TITLE_GAP,
} from "../../lib/sidebar-classes";
import { cn } from "../../ui/cn";
import { ListRow } from "../../ui/list-row";
import {
  SidebarToolRowBody,
  sidebarToolRowClass,
} from "../sidebar/SidebarToolsNav";

export interface PlaceNavItem {
  id: string;
  label: string;
  icon: ReactNode;
  active: boolean;
  onClick: () => void;
  count?: number;
}

const PLACE_TITLES: Record<Place, string> = {
  sessions: "Sessions",
  activity: "Activity",
  support: "Support",
  library: "Library",
};

/**
 * The top of the sidebar in a place that is not Sessions: its name, then the
 * pages inside it. Each array in `groups` is one run of rows, set apart from
 * the next by a gap, so related pages read together without a caption each.
 */
export function PlaceNav({
  place,
  density,
  groups,
}: {
  place: Place;
  density: string;
  groups: PlaceNavItem[][];
}) {
  return (
    <nav
      aria-label={PLACE_TITLES[place]}
      data-density={density}
      className={cn(
        "block max-w-full min-w-0 flex-none pb-1.5",
        SIDEBAR_DENSITY_VARS,
        SIDEBAR_NAV_X,
      )}
    >
      <div
        className={cn(
          SIDEBAR_PLACE_TITLE,
          SIDEBAR_PLACE_TITLE_GAP,
          "flex h-[var(--sidebar-band-slot)] items-center px-4",
        )}
      >
        {PLACE_TITLES[place]}
      </div>
      {groups
        .filter((group) => group.length > 0)
        .map((group, index) => (
          <div
            key={group[0]!.id}
            className={cn(
              "flex flex-col gap-0.5 px-[var(--sidebar-nav-x)]",
              index > 0 && "mt-3",
            )}
          >
            {group.map((item) => (
              <ListRow
                key={item.id}
                className={cn(
                  sidebarToolRowClass(item.active),
                  // The row brings its own hover layer, which composites over
                  // the selected fill; ListRow's would replace it.
                  item.active ? "hover:bg-selected" : "hover:bg-transparent",
                )}
                aria-current={item.active ? "page" : undefined}
                onClick={() => item.onClick()}
              >
                <SidebarToolRowBody
                  icon={item.icon}
                  label={item.label}
                  count={item.count}
                  active={item.active}
                />
              </ListRow>
            ))}
          </div>
        ))}
    </nav>
  );
}
