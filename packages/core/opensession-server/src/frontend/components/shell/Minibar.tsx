import { useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import { useNavigation } from "../../hooks/useNavigation";
import type { Route } from "../../lib/app-route";
import {
  onSidebarToolsChanged,
  readHiddenSidebarTools,
} from "../../lib/sidebar-tools";
import { PLAIN_ID } from "../../lib/support-surface";
import { Button } from "../../ui/button";
import { MENU_ICON, Menu } from "../../ui/menu";
import { Tooltip } from "../../ui/tooltip";
import {
  IconBolt,
  IconBook,
  IconChart,
  IconDatabase,
  IconFeed,
  IconIssue,
  IconListCircles,
  IconLifebuoy,
  IconMessages,
  IconPullRequest,
  IconReport,
  IconRepo,
  IconSparkle,
  IconStack,
  IconTarget,
} from "../icons";
import { OrganizationSwitcher } from "../OrganizationSwitcher";
import { UserAvatar } from "../UserAvatar";
import { useCurrentUser } from "../UserPicker";

type Place = "sessions" | "activity" | "support" | "library";

const LIBRARY_VIEWS: ReadonlySet<Route["view"]> = new Set<Route["view"]>([
  "prs",
  "pr",
  "issues",
  "reports",
  "databases",
  "analytics",
  "automations",
  "goals",
  "security",
]);
const ACTIVITY_VIEWS: ReadonlySet<Route["view"]> = new Set<Route["view"]>([
  "feed",
  "inbox",
  "tasks",
  "catchup",
]);
const SUPPORT_VIEWS: ReadonlySet<Route["view"]> = new Set<Route["view"]>([
  "plain",
  "support",
  "supporttinder",
]);

/** The place a route belongs to. Everything that is not a list of its own is
 *  a session, which is the place the sidebar lists. */
export function placeOfRoute(route: Route): Place {
  if (ACTIVITY_VIEWS.has(route.view)) return "activity";
  if (SUPPORT_VIEWS.has(route.view)) return "support";
  if (LIBRARY_VIEWS.has(route.view)) return "library";
  return "sessions";
}

// Lit while you are in the place. Ghost buttons already light for hover and
// for their own open menu; this is the resting state of the current one.
const PLACE_ACTIVE = "bg-selected text-fg hover:bg-selected";

function PlaceButton({
  label,
  active,
  onClick,
  icon,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
}) {
  return (
    <Tooltip label={label} side="right">
      <Button
        variant="ghost"
        size="lg"
        icon={icon}
        className={active ? PLACE_ACTIVE : undefined}
        aria-label={label}
        aria-current={active ? "page" : undefined}
        onClick={onClick}
      />
    </Tooltip>
  );
}

/** A place that has no page of its own yet: the button lists the pages that
 *  will move into it. */
function PlaceMenu({
  label,
  active,
  icon,
  children,
}: {
  label: string;
  active: boolean;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <Menu.Root>
      <Tooltip label={label} side="right">
        <Menu.Trigger
          render={
            <Button
              variant="ghost"
              size="lg"
              icon={icon}
              className={active ? PLACE_ACTIVE : undefined}
              aria-label={label}
            />
          }
        />
      </Tooltip>
      <Menu.Popup side="right" align="start">
        {children}
      </Menu.Popup>
    </Menu.Root>
  );
}

function useSupportShown(): boolean {
  return useSyncExternalStore(
    onSidebarToolsChanged,
    () => !readHiddenSidebarTools().has(PLAIN_ID),
    () => true,
  );
}

/**
 * The new layout's left edge: the organization at the top, the places under
 * it, and you at the bottom. It is the only part of the window left on the
 * chrome material; the sidebar and the workspace sit on the page beside it.
 *
 * Desktop only. In the desktop shell the traffic lights sit over its top, so
 * the organization starts one header row down and the column is a drag
 * region (`wco-chrome`, base-platform.css).
 */
export function Minibar({
  route,
  connected,
}: {
  route: Route;
  connected: boolean;
}) {
  const navigation = useNavigation();
  const currentUser = useCurrentUser();
  const supportShown = useSupportShown();
  const place = placeOfRoute(route);
  // Sessions returns to the conversation you left for another place.
  const lastSession = useRef<string | null>(null);
  useEffect(() => {
    if (route.view === "session") lastSession.current = route.id;
  }, [route]);

  return (
    <nav
      aria-label="Places"
      className="wco-chrome flex w-[52px] shrink-0 flex-col items-center gap-1 pt-1.5 pb-2 [html.wco_&]:pt-[var(--desktop-header-h)]"
    >
      <OrganizationSwitcher
        connected={connected}
        onOpenSettings={navigation.openSettings}
        variant="minibar"
      />
      <div className="mt-1 flex flex-col items-center gap-1">
        <PlaceButton
          label="Sessions"
          active={place === "sessions"}
          onClick={() => {
            if (place === "sessions") return;
            if (lastSession.current)
              navigation.openSession(lastSession.current);
            else navigation.openNewWorkspace();
          }}
          icon={<IconMessages size={22} />}
        />
        <PlaceMenu
          label="Activity"
          active={place === "activity"}
          icon={<IconFeed size={22} />}
        >
          <Menu.Item onClick={navigation.openFeed}>
            <IconFeed size={20} className={MENU_ICON} />
            <span className="grow">Feed</span>
          </Menu.Item>
          <Menu.Item onClick={navigation.openTasks}>
            <IconListCircles size={20} className={MENU_ICON} />
            <span className="grow">Tasks</span>
          </Menu.Item>
          <Menu.Item onClick={navigation.openCatchUp}>
            <IconStack size={20} className={MENU_ICON} />
            <span className="grow">Catch up</span>
          </Menu.Item>
        </PlaceMenu>
        {supportShown && (
          <PlaceButton
            label="Support"
            active={place === "support"}
            onClick={navigation.openPlain}
            icon={<IconLifebuoy size={22} />}
          />
        )}
        <PlaceMenu
          label="Library"
          active={place === "library"}
          icon={<IconBook size={22} />}
        >
          <Menu.Item onClick={navigation.openPrs}>
            <IconPullRequest size={20} className={MENU_ICON} />
            <span className="grow">Pull requests</span>
          </Menu.Item>
          <Menu.Item onClick={navigation.openIssues}>
            <IconIssue size={20} className={MENU_ICON} />
            <span className="grow">Issues</span>
          </Menu.Item>
          <Menu.Separator />
          <Menu.Item onClick={() => navigation.openSettings("automations")}>
            <IconBolt size={20} className={MENU_ICON} />
            <span className="grow">Automations</span>
          </Menu.Item>
          <Menu.Item onClick={() => navigation.openSettings("goals")}>
            <IconTarget size={20} className={MENU_ICON} />
            <span className="grow">Goals</span>
          </Menu.Item>
          <Menu.Separator />
          <Menu.Item onClick={() => navigation.openReports()}>
            <IconReport size={20} className={MENU_ICON} />
            <span className="grow">Reports</span>
          </Menu.Item>
          <Menu.Item onClick={() => navigation.openDatabases()}>
            <IconDatabase size={20} className={MENU_ICON} />
            <span className="grow">Databases</span>
          </Menu.Item>
          <Menu.Item onClick={navigation.openAnalytics}>
            <IconChart size={20} className={MENU_ICON} />
            <span className="grow">Analytics</span>
          </Menu.Item>
          <Menu.Separator />
          <Menu.Item onClick={() => navigation.openSettings("repos")}>
            <IconRepo size={20} className={MENU_ICON} />
            <span className="grow">Repositories</span>
          </Menu.Item>
          <Menu.Item onClick={() => navigation.openSettings("library")}>
            <IconSparkle size={20} className={MENU_ICON} />
            <span className="grow">Skills</span>
          </Menu.Item>
          <Menu.Item onClick={() => navigation.openSettings("memory")}>
            <IconBook size={20} className={MENU_ICON} />
            <span className="grow">Memory</span>
          </Menu.Item>
        </PlaceMenu>
      </div>
      <div className="min-h-0 flex-1" />
      <Tooltip label="Your settings" side="right">
        <Button
          variant="ghost"
          size="lg"
          icon={<UserAvatar name={currentUser} size={28} />}
          aria-label="Your settings"
          onClick={() => navigation.openSettings("myAccounts")}
        />
      </Tooltip>
    </nav>
  );
}
