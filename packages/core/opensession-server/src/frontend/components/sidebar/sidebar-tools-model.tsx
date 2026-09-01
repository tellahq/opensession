import { RepoTile } from "../RepoTile";
import {
  IconArchive,
  IconChart,
  IconFeed,
  IconFile,
  IconInbox,
  IconListCircles,
  IconMail,
  IconPullRequest,
  IconStack,
} from "../icons";
import type { SidebarToolsNavItem } from "./SidebarToolsNav";
import { cn } from "../../ui/cn";
import type { NavigationActions } from "../../lib/navigation";
import {
  SIDEBAR_GROUP_HEADER,
  SIDEBAR_GROUP_HEADER_INSET,
  SIDEBAR_GROUP_NAME,
  SIDEBAR_HEADER_ROW,
  SIDEBAR_HOVER_LAYER,
  SIDEBAR_RAIL,
  SIDEBAR_REPO_TILE,
} from "../../lib/sidebar-classes";
import {
  mergeSidebarToolOrder,
  SIDEBAR_TOOL_LABELS,
  toolFitsViewport,
  type SidebarToolId,
} from "../../lib/sidebar-tools";
import { PLAIN_ID, supportSurfaceOf } from "../../lib/support-surface";
import type { FeedDescriptor } from "../../lib/types";

interface SidebarToolsModelOptions {
  navigation: NavigationActions;
  feedActive: boolean;
  prsActive: boolean;
  tasksActive: boolean;
  taskCount: number;
  plainActive: boolean;
  catchUpActive: boolean;
  catchUpCount: number;
  supportTinderActive: boolean;
  reportsActive: boolean;
  analyticsActive: boolean;
  isPhone: boolean;
  toolOrder: SidebarToolId[];
  hiddenTools: Set<SidebarToolId>;
  hiddenFeeds: Set<string>;
  borrowedLens: boolean;
  productEmpty: boolean;
  feeds: FeedDescriptor[];
  archivedActive: boolean;
}

export function createSidebarToolsModel({
  navigation,
  feedActive,
  prsActive,
  tasksActive,
  taskCount,
  plainActive,
  catchUpActive,
  catchUpCount,
  supportTinderActive,
  reportsActive,
  analyticsActive,
  isPhone,
  toolOrder,
  hiddenTools,
  hiddenFeeds,
  borrowedLens,
  productEmpty,
  feeds,
  archivedActive,
}: SidebarToolsModelOptions) {
  // The rows below call `onClick()` with no arguments rather than handing the
  // reference to the button. A handler that takes an optional argument is
  // assignable to `() => void`, so wiring one straight to a DOM `onClick`
  // type-checks and then receives the click event: that is what left Reports
  // dead, because a mouse event carries `view` (the window, from UIEvent) and
  // it overwrote the route's own view.
  const tools: SidebarToolsNavItem[] = [
    {
      id: "feed",
      label: SIDEBAR_TOOL_LABELS.feed,
      icon: <IconFeed />,
      active: feedActive,
      onClick: navigation.openFeed,
      title: "What the team has been shipping",
    },
    {
      id: "prs",
      label: SIDEBAR_TOOL_LABELS.prs,
      icon: <IconPullRequest className="translate-x-px -translate-y-px" />,
      active: prsActive,
      onClick: navigation.openPrs,
      title: "Pull request worktrees",
    },
    {
      id: "tasks",
      label: SIDEBAR_TOOL_LABELS.tasks,
      icon: <IconListCircles />,
      active: tasksActive,
      onClick: navigation.openTasks,
      title: "Your open tasks",
      count: taskCount,
    },
    {
      id: "plain",
      label: SIDEBAR_TOOL_LABELS.plain,
      icon: <IconMail />,
      active: plainActive,
      onClick: navigation.openPlain,
      title: "Support tickets waiting in Plain",
    },
    {
      id: "catchup",
      label: SIDEBAR_TOOL_LABELS.catchup,
      icon: <IconStack />,
      active: catchUpActive,
      onClick: navigation.openCatchUp,
      title: "Swipe through your unread workspaces",
      count: catchUpCount,
    },
    {
      id: "supporttinder",
      label: SIDEBAR_TOOL_LABELS.supporttinder,
      icon: <IconInbox />,
      active: supportTinderActive,
      onClick: navigation.openSupportTinder,
      title: "Swipe through the Plain Todo queue",
    },
    {
      id: "reports",
      label: SIDEBAR_TOOL_LABELS.reports,
      icon: <IconFile />,
      active: reportsActive,
      // Called with no target: the row opens the list of reports, while an
      // automation's own report row below passes the one it names.
      onClick: () => navigation.openReports(),
      title: "Recurring automation reports",
    },
    {
      id: "analytics",
      label: SIDEBAR_TOOL_LABELS.analytics,
      icon: <IconChart />,
      active: analyticsActive,
      onClick: navigation.openAnalytics,
      title: "Sessions, tokens, models & PRs over time",
    },
  ];
  // Tools this width offers at all — the switches below only choose among
  // these, so a tool that doesn't fit the viewport is never listed as off.
  const viewportTools = tools.filter((tool) =>
    toolFitsViewport(tool.id, isPhone),
  );
  const fittingTools = mergeSidebarToolOrder(
    toolOrder,
    viewportTools.map((tool) => tool.id),
  ).flatMap((id) => {
    const tool = viewportTools.find((candidate) => candidate.id === id);
    return tool ? [tool] : [];
  });
  // None of the tools belong to the person whose sidebar you are borrowing:
  // Tasks and Catch up are yours, and Feed, Pull requests and Analytics are
  // the whole team's. Under a heading with someone else's name on it they
  // read as theirs, so a borrowed sidebar is their workspaces and nothing
  // else. Another teammate, or your own sidebar back, is a click away in
  // "Group, filter & sort" — and the strip at the top is the way out.
  // Support is the one tool whose visibility is not its own: it and the Plain
  // band are two doors onto one queue, and both at once would list the same
  // tickets twice. The tool wins when the independent stored lists say both,
  // because it is the default placement and the band is the alternate.
  const supportSurface = supportSurfaceOf(
    !hiddenTools.has(PLAIN_ID),
    !hiddenFeeds.has(PLAIN_ID),
  );
  const visibleTools = borrowedLens
    ? []
    : fittingTools.filter(
        (tool) =>
          !hiddenTools.has(tool.id) &&
          !(productEmpty && tool.id === "prs") &&
          !(tool.id === PLAIN_ID && supportSurface !== "page"),
      );

  // What the sidebar's own right-click menu offers (SidebarToolsMenu): every
  // tool and every source, ticked when it's showing.
  //
  // Support is the exception, and the reason that menu is a real one: where
  // the others tick on or off, it names which of two surfaces its queue lives
  // on, so it is a submenu of three states rather than a tick. No Plain feed
  // means no queue to place, so the row drops out entirely.
  const plainQueueExists = feeds.some((feed) => feed.id === PLAIN_ID);
  const sidebarMenuTools = fittingTools
    .filter((tool) => tool.id !== PLAIN_ID || plainQueueExists)
    .map((tool) => ({
      id: tool.id,
      label: tool.label,
      icon: tool.icon,
      shown: !hiddenTools.has(tool.id),
      ...(tool.id === PLAIN_ID ? { surface: supportSurface } : {}),
    }));
  const sidebarMenuSources = feeds
    .filter((feed) => feed.id !== PLAIN_ID)
    .map((feed) => ({
      id: feed.id,
      label: feed.title,
      icon: <RepoTile name={feed.id} className={SIDEBAR_REPO_TILE} />,
      shown: !hiddenFeeds.has(feed.id),
    }));

  // Archived is a destination, not another live workspace group. Keeping it to
  // one row means the sidebar never needs the archive index or its inline rows.
  // The shared rail centres its 20px glyph on the same line as the 18px repo tiles.
  const archivedLink = (
    <button
      className={cn(
        SIDEBAR_GROUP_HEADER,
        SIDEBAR_GROUP_HEADER_INSET,
        SIDEBAR_HEADER_ROW,
        // The one heading that navigates, so the one heading that paints a
        // fill. Its neighbours in the rail collapse a group instead and
        // deliberately take none. See the two signals in sidebar-classes.ts.
        SIDEBAR_HOVER_LAYER,
        "transition-colors",
        archivedActive && "bg-selected text-fg",
      )}
      data-selected={archivedActive || undefined}
      onClick={navigation.openArchived}
      title="View archived sessions"
    >
      <span className={SIDEBAR_RAIL}>
        <IconArchive size={20} />
      </span>
      <span className={cn(SIDEBAR_GROUP_NAME, "font-semibold")}>Archived</span>
    </button>
  );
  return { archivedLink, sidebarMenuSources, sidebarMenuTools, visibleTools };
}
