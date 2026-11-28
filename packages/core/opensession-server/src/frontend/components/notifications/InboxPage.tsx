import { useEffect, useState } from "react";
import { useNotifications } from "../../hooks/useNotifications";
import { docTitle, DEFAULT_DOC_TITLE } from "../../lib/brand";
import { INBOX_PAGE_LIST } from "../../lib/inbox-classes";
import {
  markAllNotificationsRead,
  unreadNotificationCount,
  type InboxFilter,
} from "../../lib/notifications";
import { Button } from "../../ui/button";
import { PageLayout } from "../../ui/page";
import { InboxFilterControl, NotificationList } from "./NotificationList";

/**
 * Every notification, at full size: the phone's way in (the bell in the top
 * bar opens it) and the desktop's when the sidebar, and its bell, is hidden.
 */
export function InboxPage() {
  const { threads } = useNotifications();
  const unread = unreadNotificationCount(threads);
  const [filter, setFilter] = useState<InboxFilter>("all");

  useEffect(() => {
    document.title = docTitle("Notifications");
    return () => {
      document.title = DEFAULT_DOC_TITLE;
    };
  }, []);

  return (
    <PageLayout
      title="Notifications"
      description={unread ? `${unread} unread` : "You're all caught up"}
      actions={
        unread ? (
          <Button
            size="md"
            variant="default"
            onClick={markAllNotificationsRead}
            className="phone:w-full"
          >
            Mark all as read
          </Button>
        ) : undefined
      }
      filters={
        <InboxFilterControl
          value={filter}
          onChange={setFilter}
          unread={unread}
        />
      }
    >
      <div className={INBOX_PAGE_LIST}>
        <NotificationList filter={filter} />
      </div>
    </PageLayout>
  );
}
