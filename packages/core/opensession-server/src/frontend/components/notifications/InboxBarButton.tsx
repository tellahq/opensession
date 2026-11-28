import { CountBadge } from "../../ui/badge";
import { useNotifications } from "../../hooks/useNotifications";
import { MOBILE_SEARCH_BTN } from "../../lib/app-header-classes";
import { INBOX_BADGE_PHONE } from "../../lib/inbox-classes";
import { unreadNotificationCount } from "../../lib/notifications";
import { IconBell } from "../icons";

/** The phone top bar's bell: a segment beside Search that opens the Inbox. */
export function InboxBarButton({ onOpen }: { onOpen: () => void }) {
  const { threads } = useNotifications();
  const unread = unreadNotificationCount(threads);
  return (
    <button
      type="button"
      className={MOBILE_SEARCH_BTN}
      onClick={onOpen}
      aria-label={unread ? `Notifications, ${unread} unread` : "Notifications"}
    >
      <IconBell size={22} />
      {unread > 0 && (
        <CountBadge count={unread} className={INBOX_BADGE_PHONE} />
      )}
    </button>
  );
}
