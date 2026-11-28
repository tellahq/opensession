import { useSyncExternalStore, type ReactNode } from "react";
import { useNavigation } from "../../hooks/useNavigation";
import { useNotifications } from "../../hooks/useNotifications";
import type { Route } from "../../lib/app-route";
import {
  parseMinibarItems,
  setMinibarItemShown,
  useMinibarItems,
} from "../../lib/minibar-pref";
import type { Place } from "../../lib/new-layout-place";
import { unreadNotificationCount } from "../../lib/notifications";
import {
  onSidebarToolsChanged,
  readHiddenSidebarTools,
} from "../../lib/sidebar-tools";
import { PLAIN_ID } from "../../lib/support-surface";
import {
  connectionStatusLabel,
  useConnectionStatus,
} from "../../lib/connection-status";
import { Button } from "../../ui/button";
import { Spinner } from "../../ui/spinner";
import { cn } from "../../ui/cn";
import { ContextMenu, Menu, MENU_ICON } from "../../ui/menu";
import { Tooltip } from "../../ui/tooltip";
import {
  IconChevronRight,
  IconDotsHorizontal,
  IconMessages,
  IconSliders,
} from "../icons";
import { MINIBAR_ITEMS, type MinibarItem } from "./minibar-model";
import { useHiddenChannels } from "../../lib/channel-sections";
import {
  hasUnreadConversation,
  useSlackConversations,
} from "../../lib/slack-conversations";
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
        size="xl"
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

// A menu row's glyph column is 20px; the minibar draws its glyphs at 24.
const MENU_ICON_SLOT = cn("inline-flex shrink-0 [&_svg]:size-5", MENU_ICON);

/**
 * A tick per item the minibar can carry, places first, then pages. Shared by
 * the minibar's right-click menu and ⋯ → Show in minibar, which are two ways
 * to the same choice. Rows stay open on click, so pinning three pages is one
 * visit.
 */
function MinibarItemToggles({
  items,
  shown,
}: {
  items: readonly MinibarItem[];
  shown: ReadonlySet<string>;
}) {
  const places = items.filter((item) => item.place);
  const pages = items.filter((item) => !item.place);
  const row = (item: MinibarItem) => (
    <Menu.CheckboxItem
      key={item.id}
      checked={shown.has(item.id)}
      onCheckedChange={(on) => setMinibarItemShown(item.id, on)}
    >
      <span className={MENU_ICON_SLOT}>{item.icon}</span>
      <span className="grow truncate">{item.label}</span>
      <Menu.Check on={shown.has(item.id)} size={20} className="text-dim" />
    </Menu.CheckboxItem>
  );
  return (
    <>
      <Menu.Group>
        <Menu.GroupLabel>Places</Menu.GroupLabel>
        {places.map(row)}
      </Menu.Group>
      <Menu.Separator />
      <Menu.Group>
        <Menu.GroupLabel>Pages</Menu.GroupLabel>
        {pages.map(row)}
      </Menu.Group>
    </>
  );
}

/**
 * The new layout's left edge: the organization at the top, the places under
 * it, and you at the bottom. It is the only part of the window left on the
 * chrome material; the sidebar and the workspace sit on the page beside it.
 *
 * What it carries besides Sessions is yours to choose: right-click it, or
 * use ⋯ → Show in minibar, to drop a place or pin a single page beside them
 * (lib/minibar-pref.ts). Whatever is left out sits in the ⋯ menu.
 *
 * Desktop only. In the desktop shell the traffic lights sit over its top, so
 * the organization starts one header row down and the column is a drag
 * region (`wco-chrome`, base-platform.css).
 */
export function Minibar({
  place,
  route,
  onOpenSessions,
  onOpenPlace,
  onRevealSidebar,
  connected,
  accessory,
}: {
  place: Place;
  route: Route;
  /** Show your own list (the route controller's `openSessions`). */
  onOpenSessions: () => void;
  /** Go to another place: the page you last had open there, or else
   *  `openDefault` (the route controller's `openPlace`). */
  onOpenPlace: (
    place: Exclude<Place, "sessions">,
    openDefault: () => void,
  ) => void;
  /** Open the sidebar if it is closed: a place is its list, so going to
   *  one shows it. */
  onRevealSidebar: () => void;
  connected: boolean;
  /** Sits above your account, under the connection status: the Update
   *  nudge, as an icon. */
  accessory?: ReactNode;
}) {
  const navigation = useNavigation();
  const currentUser = useCurrentUser();
  const supportShown = useSupportShown();
  const unreadNotifications = unreadNotificationCount(
    useNotifications().threads,
  );
  const shown = parseMinibarItems(useMinibarItems());

  // Support leaves the minibar along with the sidebar tool it opens.
  const items = MINIBAR_ITEMS.filter(
    (item) => item.id !== "support" || supportShown,
  );
  const inBar = items.filter((item) => shown.has(item.id));
  const inMore = items.filter((item) => !shown.has(item.id));
  // A pinned page lights instead of the place it belongs to: one lit tile
  // says where you are.
  const pinnedHere = inBar.find((item) => item.onPage?.(route));
  const channelsUnread = hasUnreadConversation(
    useSlackConversations().payload?.conversations,
    useHiddenChannels(),
  );
  const unread = (item: MinibarItem) =>
    (item.id === "activity" && unreadNotifications > 0) ||
    (item.id === "channels" && channelsUnread);
  // A place reopens what you last had open in it; a pinned page opens
  // itself.
  const open = (item: MinibarItem) => {
    const openDefault = () => item.open(navigation);
    if (!item.place || item.place === "sessions") return openDefault();
    onOpenPlace(item.place, openDefault);
    onRevealSidebar();
  };

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger
        render={
          <nav
            aria-label="Places"
            // The workspace shell reads this to drop its edge shadow
            // (WORKSPACE_SHELL, lib/app-shell-classes.ts).
            data-minibar
            className={cn(
              "wco-chrome relative flex w-[56px] shrink-0 flex-col items-center gap-1 pt-1 pb-2 [html.wco_&]:pt-[var(--desktop-header-h)]",
              // A hairline between the rail and the sidebar. It stops short
              // of the window's bottom edge by the workspace panel's own 4px
              // gap (WORKSPACE_SHELL), so the two end on one line. In the
              // desktop shell the traffic lights reach past the rail, so
              // there it starts under their row. With the sidebar closed
              // there is nothing to divide: the panel sits right beside the
              // rail.
              "after:pointer-events-none after:absolute after:top-0 after:bottom-1 after:right-0 after:w-px after:bg-divider after:content-[''] [html.wco_&]:after:top-[var(--desktop-header-h)] [.app-body.sidebar-collapsed_&]:after:hidden",
            )}
          />
        }
      >
        <OrganizationSwitcher
          connected={connected}
          onOpenSettings={navigation.openSettings}
          variant="minibar"
        />
        <div className="mt-1 flex flex-col items-center gap-1">
          <PlaceButton
            label="Sessions"
            active={place === "sessions" && !pinnedHere}
            // Your own chats with something you have not read yet (the same
            // list the next-unread button walks).
            unread={navigation.unreadChats.length > 0}
            // Sessions is always your own list (filterForPlace,
            // lib/sidebar-filter.ts), however you reach it.
            onClick={() => {
              onOpenSessions();
              onRevealSidebar();
            }}
            icon={<IconMessages size={24} />}
          />
          {inBar.map((item) => (
            <PlaceButton
              key={item.id}
              label={item.label}
              active={
                item.place
                  ? !pinnedHere && place === item.place
                  : item === pinnedHere
              }
              // The inbox lives in Activity, so its unread notifications do.
              unread={unread(item)}
              onClick={() => open(item)}
              icon={item.icon}
            />
          ))}
          <Menu.Root>
            <Tooltip label="More" side="right">
              <Menu.Trigger
                render={
                  <Button
                    variant="ghost"
                    size="xl"
                    icon={
                      <PlaceGlyph
                        icon={<IconDotsHorizontal size={24} />}
                        // Something new in a place that is not in the bar.
                        unread={inMore.some(unread)}
                      />
                    }
                    className={RAIL_TILE}
                    aria-label="More"
                  />
                }
              />
            </Tooltip>
            <Menu.Popup side="right" align="start" className="min-w-[220px]">
              {inMore.map((item) => (
                <Menu.Item key={item.id} onClick={() => open(item)}>
                  <span className={MENU_ICON_SLOT}>
                    <PlaceGlyph icon={item.icon} unread={unread(item)} />
                  </span>
                  <span className="grow truncate">{item.label}</span>
                </Menu.Item>
              ))}
              {inMore.length > 0 && <Menu.Separator />}
              <Menu.SubmenuRoot>
                <Menu.SubmenuTrigger>
                  <IconSliders size={20} className={MENU_ICON} />
                  <span className="grow">Show in minibar</span>
                  <IconChevronRight size={20} className="text-faint" />
                </Menu.SubmenuTrigger>
                <Menu.Popup className="min-w-[220px]">
                  <MinibarItemToggles items={items} shown={shown} />
                </Menu.Popup>
              </Menu.SubmenuRoot>
            </Menu.Popup>
          </Menu.Root>
        </div>
        <div className="min-h-0 flex-1" />
        <ConnectionStatusTile />
        {accessory}
        <Tooltip label="Your settings" side="right">
          <Button
            variant="ghost"
            size="xl"
            icon={<UserAvatar name={currentUser} size={30} />}
            className={RAIL_TILE}
            aria-label="Your settings"
            onClick={() => navigation.openSettings("myAccounts")}
          />
        </Tooltip>
      </ContextMenu.Trigger>
      <ContextMenu.Popup className="min-w-[220px]">
        <MinibarItemToggles items={items} shown={shown} />
      </ContextMenu.Popup>
    </ContextMenu.Root>
  );
}

/**
 * A restart or a lost connection, while it lasts: a turning ring above your
 * account, where the Update nudge lands once a restart shipped new code. It
 * replaces the status toast, which sat on the composer.
 */
function ConnectionStatusTile() {
  const status = useConnectionStatus();
  if (!status) return null;
  const label = connectionStatusLabel(status);
  return (
    <Tooltip label={label} side="right">
      <span
        role="status"
        className="grid size-10 shrink-0 place-items-center text-dim animate-[update-toast-in_var(--dur-lg)_var(--ease)] motion-reduce:animate-none"
      >
        <Spinner size="lg" />
        <span className="sr-only">{label}</span>
      </span>
    </Tooltip>
  );
}
