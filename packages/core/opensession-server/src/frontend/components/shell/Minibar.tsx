import { useSyncExternalStore, type ReactNode } from "react";
import { useNavigation } from "../../hooks/useNavigation";
import type { Place } from "../../lib/new-layout-place";
import {
  onSidebarToolsChanged,
  readHiddenSidebarTools,
} from "../../lib/sidebar-tools";
import { PLAIN_ID } from "../../lib/support-surface";
import { Button } from "../../ui/button";
import { Tooltip } from "../../ui/tooltip";
import { IconBook, IconFeed, IconLifebuoy, IconMessages } from "../icons";
import { OrganizationSwitcher } from "../OrganizationSwitcher";
import { UserAvatar } from "../UserAvatar";
import { useCurrentUser } from "../UserPicker";

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

  return (
    <nav
      aria-label="Places"
      // The workspace shell reads this to drop its edge shadow
      // (WORKSPACE_SHELL, lib/app-shell-classes.ts).
      data-minibar
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
          // Sessions is always your own list (filterForPlace,
          // lib/sidebar-filter.ts), however you reach it.
          onClick={onOpenSessions}
          icon={<IconMessages size={22} />}
        />
        <PlaceButton
          label="Activity"
          active={place === "activity"}
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
          aria-label="Your settings"
          onClick={() => navigation.openSettings("myAccounts")}
        />
      </Tooltip>
    </nav>
  );
}
