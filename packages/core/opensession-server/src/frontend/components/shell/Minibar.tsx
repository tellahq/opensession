import { useSyncExternalStore, type ReactNode } from "react";
import { useNavigation } from "../../hooks/useNavigation";
import { useNotifications } from "../../hooks/useNotifications";
import type { Place } from "../../lib/new-layout-place";
import { unreadNotificationCount } from "../../lib/notifications";
import {
  onSidebarToolsChanged,
  readHiddenSidebarTools,
} from "../../lib/sidebar-tools";
import { PLAIN_ID } from "../../lib/support-surface";
import { Button } from "../../ui/button";
import { cn } from "../../ui/cn";
import { Tooltip } from "../../ui/tooltip";
import { IconBook, IconFeed, IconLifebuoy, IconMessages } from "../icons";
import { OrganizationSwitcher } from "../OrganizationSwitcher";
import { UserAvatar } from "../UserAvatar";
import { useCurrentUser } from "../UserPicker";

// The rail's tiles are squircles, not the Button's circle: a column of
// places reads as app tiles (the organization trigger above them has the
// same corner), where a column of circles reads as a stack of badges.
const RAIL_TILE = "rounded-control";

// Lit while you are in the place. Ghost buttons already light for hover and
// for their own open menu; this is the resting state of the current one.
const PLACE_ACTIVE = "bg-selected text-fg hover:bg-selected";

// Something new in the place: a dot on the glyph's top right corner.
const PLACE_UNREAD_DOT =
  "pointer-events-none absolute -top-0.5 -right-0.5 size-2 rounded-full bg-accent";

function PlaceGlyph({ icon, unread }: { icon: ReactNode; unread: boolean }) {
  return (
    <span className="relative inline-flex">
      {icon}
      {unread && <span className={PLACE_UNREAD_DOT} aria-hidden />}
    </span>
  );
}

function PlaceButton({
  label,
  active,
  unread = false,
  onClick,
  icon,
}: {
  label: string;
  active: boolean;
  /** Something new waits there. */
  unread?: boolean;
  onClick: () => void;
  icon: ReactNode;
}) {
  return (
    <Tooltip label={label} side="right">
      <Button
        variant="ghost"
        size="lg"
        icon={<PlaceGlyph icon={icon} unread={unread} />}
        className={cn(RAIL_TILE, active && PLACE_ACTIVE)}
        aria-label={unread ? `${label}, new activity` : label}
        aria-current={active ? "page" : undefined}
        // Called bare: a navigation action handed the click event would read
        // it as its own optional argument.
        onClick={() => onClick()}
      />
    </Tooltip>
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
  place,
  onOpenSessions,
  connected,
  accessory,
}: {
  place: Place;
  /** Show your own list (the route controller's `openSessions`). */
  onOpenSessions: () => void;
  connected: boolean;
  /** Sits above your account: the Update nudge, as an icon. */
  accessory?: ReactNode;
}) {
  const navigation = useNavigation();
  const currentUser = useCurrentUser();
  const supportShown = useSupportShown();
  const unreadNotifications = unreadNotificationCount(
    useNotifications().threads,
  );

  return (
    <nav
      aria-label="Places"
      // The workspace shell reads this to drop its edge shadow
      // (WORKSPACE_SHELL, lib/app-shell-classes.ts).
      data-minibar
      className={cn(
        "wco-chrome relative flex w-[52px] shrink-0 flex-col items-center gap-1 pt-1.5 pb-2 [html.wco_&]:pt-[var(--desktop-header-h)]",
        // A hairline between the rail and the sidebar, the full height of
        // the window. In the desktop shell the traffic lights reach past the
        // rail, so there it starts under their row.
        "after:pointer-events-none after:absolute after:inset-y-0 after:right-0 after:w-px after:bg-divider after:content-[''] [html.wco_&]:after:top-[var(--desktop-header-h)]",
      )}
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
          // Your own chats with something you have not read yet (the same
          // list the next-unread button walks).
          unread={navigation.unreadChats.length > 0}
          // Sessions is always your own list (filterForPlace,
          // lib/sidebar-filter.ts), however you reach it.
          onClick={onOpenSessions}
          icon={<IconMessages size={22} />}
        />
        <PlaceButton
          label="Activity"
          active={place === "activity"}
          // The inbox lives in Activity, so its unread notifications do.
          unread={unreadNotifications > 0}
          onClick={navigation.openFeed}
          icon={<IconFeed size={22} />}
        />
        {supportShown && (
          <PlaceButton
            label="Support"
            active={place === "support"}
            onClick={navigation.openPlain}
            icon={<IconLifebuoy size={22} />}
          />
        )}
        <PlaceButton
          label="Library"
          active={place === "library"}
          onClick={navigation.openPrs}
          icon={<IconBook size={22} />}
        />
      </div>
      <div className="min-h-0 flex-1" />
      {accessory}
      <Tooltip label="Your settings" side="right">
        <Button
          variant="ghost"
          size="lg"
          icon={<UserAvatar name={currentUser} size={28} />}
          className={RAIL_TILE}
          aria-label="Your settings"
          onClick={() => navigation.openSettings("myAccounts")}
        />
      </Tooltip>
    </nav>
  );
}
