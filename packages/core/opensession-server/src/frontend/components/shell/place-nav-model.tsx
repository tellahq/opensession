import React from "react";
import type { NavigationActions } from "../../lib/navigation";
import type { Place } from "../../lib/new-layout-place";
import { SECTIONS, type SettingsSectionKey } from "../../lib/settings-sections";
import type { SidebarToolId } from "../../lib/sidebar-tools";
import type { SidebarToolsNavItem } from "../sidebar/SidebarToolsNav";
import type { PlaceNavItem } from "./PlaceNav";

// Which of today's pages each place lists, in runs. A tool is a page of the
// app. A settings section is one Settings defines: Automations, Goals and
// Security are pages of the app here, and the rest open in Settings until
// they have a page in their place.
type Entry =
  | { tool: SidebarToolId }
  | { settings: SettingsSectionKey; label?: string };

const PLACE_PAGES: Partial<Record<Place, Entry[][]>> = {
  activity: [[{ tool: "feed" }, { tool: "tasks" }, { tool: "catchup" }]],
  library: [
    [{ tool: "prs" }, { tool: "issues" }],
    [
      { settings: "automations" },
      { settings: "goals" },
      { settings: "security" },
    ],
    [{ tool: "reports" }, { tool: "databases" }, { tool: "analytics" }],
    [
      { settings: "repos" },
      { settings: "library", label: "Skills" },
      { settings: "memory", label: "Memory" },
    ],
  ],
};

/** The rows a place lists above its own content, or null for a place that
 *  lists none (Sessions and Support keep the session list). */
export function placeNavGroups(
  place: Place,
  tools: SidebarToolsNavItem[],
  navigation: NavigationActions,
  openPage?: SettingsSectionKey,
): PlaceNavItem[][] | null {
  const pages = PLACE_PAGES[place];
  if (!pages) return null;
  return pages.map((run) =>
    run.flatMap((entry): PlaceNavItem[] => {
      if ("tool" in entry) {
        const tool = tools.find((candidate) => candidate.id === entry.tool);
        return tool ? [tool] : [];
      }
      const section = SECTIONS.find(
        (candidate) => candidate.key === entry.settings,
      );
      if (!section) return [];
      return [
        {
          id: `settings:${section.key}`,
          label: entry.label ?? section.label,
          icon: React.cloneElement(section.icon, { size: 22 }),
          active: section.key === openPage,
          onClick: () => navigation.openSettings(section.key),
        },
      ];
    }),
  );
}
