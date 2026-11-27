import type { ReactNode } from "react";
import type { Route } from "../../lib/app-route";
import type { MinibarItemId } from "../../lib/minibar-items";
import type { NavigationActions } from "../../lib/navigation";
import type { Place } from "../../lib/new-layout-place";
import {
  IconBook,
  IconChart,
  IconClock,
  IconDatabase,
  IconFeed,
  IconFile,
  IconHash,
  IconIssue,
  IconLifebuoy,
  IconListCircles,
  IconPullRequest,
  IconShieldCheck,
  IconStack,
  IconTarget,
} from "../icons";

/**
 * One thing the minibar can carry besides Sessions. A place switches the
 * sidebar to its list (and opens the sidebar if it is closed); a page is one
 * of the pages a place lists, pinned beside the places for a shorter way in.
 */
export interface MinibarItem {
  id: MinibarItemId;
  label: string;
  /** Drawn at the minibar's 22px; menus resize it to their own column. */
  icon: ReactNode;
  /** Set on a place: the one it stands for. */
  place?: Place;
  open: (navigation: NavigationActions) => void;
  /** A page: whether the route is on it. Places light from `place`. */
  onPage?: (route: Route) => boolean;
}

const onView =
  (...views: Route["view"][]) =>
  (route: Route) =>
    views.includes(route.view);

// Same glyphs as the place lists (PlaceNav, sidebar-tools-model), so a page
// pinned here looks like the row it came from.
export const MINIBAR_ITEMS: readonly MinibarItem[] = [
  {
    id: "channels",
    label: "Channels",
    icon: <IconHash size={24} />,
    place: "channels",
    open: (navigation) => navigation.openChannels(),
  },
  {
    id: "activity",
    label: "Activity",
    icon: <IconFeed size={24} />,
    place: "activity",
    open: (navigation) => navigation.openFeed(),
  },
  {
    id: "support",
    label: "Support",
    icon: <IconLifebuoy size={24} />,
    place: "support",
    open: (navigation) => navigation.openPlain(),
  },
  {
    id: "library",
    label: "Library",
    icon: <IconBook size={24} />,
    place: "library",
    open: (navigation) => navigation.openPrs(),
  },
  {
    id: "prs",
    label: "Pull requests",
    icon: <IconPullRequest size={24} />,
    open: (navigation) => navigation.openPrs(),
    onPage: onView("prs", "pr"),
  },
  {
    id: "issues",
    label: "Issues",
    icon: <IconIssue size={24} />,
    open: (navigation) => navigation.openIssues(),
    onPage: onView("issues"),
  },
  {
    id: "tasks",
    label: "Tasks",
    icon: <IconListCircles size={24} />,
    open: (navigation) => navigation.openTasks(),
    onPage: onView("tasks"),
  },
  {
    id: "catchup",
    label: "Catch up",
    icon: <IconStack size={24} />,
    open: (navigation) => navigation.openCatchUp(),
    onPage: onView("catchup"),
  },
  {
    id: "automations",
    label: "Automations",
    icon: <IconClock size={24} />,
    open: (navigation) => navigation.openSettings("automations"),
    onPage: onView("automations"),
  },
  {
    id: "goals",
    label: "Goals",
    icon: <IconTarget size={24} />,
    open: (navigation) => navigation.openSettings("goals"),
    onPage: onView("goals"),
  },
  {
    id: "security",
    label: "Security",
    icon: <IconShieldCheck size={24} />,
    open: (navigation) => navigation.openSettings("security"),
    onPage: onView("security"),
  },
  {
    id: "reports",
    label: "Reports",
    icon: <IconFile size={24} />,
    open: (navigation) => navigation.openReports(),
    onPage: onView("reports"),
  },
  {
    id: "databases",
    label: "Databases",
    icon: <IconDatabase size={24} />,
    open: (navigation) => navigation.openDatabases(),
    onPage: onView("databases"),
  },
  {
    id: "analytics",
    label: "Analytics",
    icon: <IconChart size={24} />,
    open: (navigation) => navigation.openAnalytics(),
    onPage: onView("analytics"),
  },
];
