import { z } from "zod";
import { request } from "./request";

// Wire model of the server's notification inbox
// (src/server/notification-threads.ts).

export const NOTIFICATION_KINDS = [
  "review_requested",
  "team_review_requested",
  "review_done",
  "mention",
  "collaborator",
  "reminder",
  "comment",
  "huddle",
] as const;

export const notificationThreadSchema = z.object({
  id: z.string(),
  subject: z.object({
    type: z.enum(["session", "pr", "workspace", "reminder"]),
    id: z.string(),
    title: z.string(),
    context: z.string().optional(),
  }),
  kind: z.enum(NOTIFICATION_KINDS),
  reason: z.string(),
  body: z.string(),
  actor: z.string().optional(),
  url: z.string(),
  updatedAt: z.number(),
  unread: z.boolean(),
  done: z.boolean(),
});

const alertsSchema = z.object({
  reviews: z.boolean(),
  teamReviews: z.boolean().default(true),
  mentions: z.boolean(),
  collaborators: z.boolean(),
  reminders: z.boolean(),
  huddles: z.boolean().default(true),
});

const inboxSchema = z.object({
  threads: z.array(z.unknown()),
  alerts: alertsSchema,
});

export type NotificationThread = z.infer<typeof notificationThreadSchema>;
export type NotificationKind = NotificationThread["kind"];
export type NotificationAlerts = z.infer<typeof alertsSchema>;

export const DEFAULT_NOTIFICATION_ALERTS: NotificationAlerts = {
  reviews: true,
  teamReviews: true,
  mentions: true,
  collaborators: true,
  reminders: true,
  huddles: true,
};

export async function fetchNotifications(user: string): Promise<{
  threads: NotificationThread[];
  alerts: NotificationAlerts;
}> {
  const body = inboxSchema.parse(
    await request<unknown>(`/notifications?user=${encodeURIComponent(user)}`, {
      label: "Failed to load notifications",
    }),
  );
  return {
    // A row this client does not understand (a newer kind) is dropped
    // rather than failing the whole inbox.
    threads: body.threads.flatMap((thread) => {
      const parsed = notificationThreadSchema.safeParse(thread);
      return parsed.success ? [parsed.data] : [];
    }),
    alerts: body.alerts,
  };
}

export async function markNotificationsApi(
  user: string,
  mark: { ids?: string[]; all?: boolean; unread?: boolean; done?: boolean },
): Promise<void> {
  await request("/notifications/mark", {
    method: "POST",
    body: { user, ...mark },
    label: "Failed to update notifications",
  });
}

export async function saveNotificationAlertsApi(
  user: string,
  alerts: Partial<NotificationAlerts>,
): Promise<NotificationAlerts> {
  const body = z.object({ alerts: alertsSchema }).parse(
    await request<unknown>("/notifications/alerts", {
      method: "PUT",
      body: { user, alerts },
      label: "Failed to save notification settings",
    }),
  );
  return body.alerts;
}
