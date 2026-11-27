import { useEffect, useRef, useState } from "react";
import { useNotifications } from "../../hooks/useNotifications";
import { useShortcutKeys } from "../../hooks/useShortcutBindings";
import {
  INBOX_BADGE,
  INBOX_BELL,
  INBOX_POPUP,
  INBOX_POPUP_FOOTER,
  INBOX_POPUP_HEADER,
  INBOX_POPUP_LIST,
  INBOX_POPUP_TITLE,
} from "../../lib/inbox-classes";
import {
  markAllNotificationsRead,
  openInAppUrl,
  unreadNotificationCount,
  type InboxFilter,
} from "../../lib/notifications";
import { matchesShortcut } from "../../lib/shortcuts";
import { Button } from "../../ui/button";
import { Popover } from "../../ui/popover";
import { Tooltip } from "../../ui/tooltip";
import { IconBell, IconGear } from "../icons";
import { InboxFilterControl, NotificationList } from "./NotificationList";

/**
 * The bell in the sidebar's top row: the unread count, and a popover with
 * the inbox in it. The Inbox page (/inbox) is the same list at full size,
 * and where the shortcut goes when this row is hidden.
 */
export function NotificationBell() {
  const { threads } = useNotifications();
  const unread = unreadNotificationCount(threads);
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<InboxFilter>("unread");
  const trigger = useRef<HTMLButtonElement>(null);
  const keys = useShortcutKeys("notifications");

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!matchesShortcut(event, "notifications")) return;
      event.preventDefault();
      // A collapsed sidebar hides the bell; the page is the way in then.
      if (trigger.current?.offsetParent) setOpen((value) => !value);
      else openInAppUrl("/inbox");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const label = unread ? `Notifications, ${unread} unread` : "Notifications";

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        // Open on what needs you; an empty unread list shows everything.
        if (next) setFilter(unread ? "unread" : "all");
      }}
    >
      <Tooltip label="Notifications" side="bottom" shortcut={keys ?? undefined}>
        <Popover.Trigger
          ref={trigger}
          className={INBOX_BELL}
          aria-label={label}
        >
          <IconBell size={22} />
          {unread > 0 && (
            <span className={INBOX_BADGE} aria-hidden="true">
              {unread > 99 ? "99+" : unread}
            </span>
          )}
        </Popover.Trigger>
      </Tooltip>
      <Popover.Popup
        side="bottom"
        align="start"
        elevation="lg"
        initialFocus
        aria-label="Notifications"
        className={INBOX_POPUP}
      >
        <div className={INBOX_POPUP_HEADER}>
          <span className={INBOX_POPUP_TITLE}>Notifications</span>
          <InboxFilterControl
            value={filter}
            onChange={setFilter}
            unread={unread}
          />
        </div>
        <div className={INBOX_POPUP_LIST}>
          <NotificationList filter={filter} onOpen={() => setOpen(false)} />
        </div>
        <div className={INBOX_POPUP_FOOTER}>
          <Button
            size="sm"
            variant="ghost"
            disabled={!unread}
            onClick={markAllNotificationsRead}
          >
            Mark all as read
          </Button>
          <div className="flex items-center gap-1">
            <Tooltip label="Notification settings" side="top">
              <Button
                size="sm"
                variant="ghost"
                aria-label="Notification settings"
                onClick={() => {
                  setOpen(false);
                  openInAppUrl("/settings/notifications");
                }}
              >
                <IconGear size={20} />
              </Button>
            </Tooltip>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setOpen(false);
                openInAppUrl("/inbox");
              }}
            >
              Open inbox
            </Button>
          </div>
        </div>
      </Popover.Popup>
    </Popover.Root>
  );
}
