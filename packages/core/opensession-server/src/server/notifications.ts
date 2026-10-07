/**
 * The notification inbox: one durable record per person and subject, stored
 * in the central catalog (src/server/notification-threads.ts has the model).
 *
 * This is the only way the server notifies a person. `notifyUser` records the
 * event, tells that person's open clients over the WebSocket, and sends Web
 * Push to their devices. An event in a group the person switched off is not
 * recorded at all, so it neither alerts nor lands in the inbox. Clients never
 * work out notifications by diffing session lists: a banner can only come
 * from a new record, so reconnecting or restarting an app cannot replay one.
 *
 * Delivery is best-effort. A failed push or broadcast never fails the flow
 * that raised the event.
 */
import { catalogDocuments } from "./catalog-documents";
import {
  alertPrefs,
  applyNotificationEvent,
  cleanDocument,
  markNotificationThreads,
  unreadCount,
  wireThread,
  type AlertPrefs,
  type NotificationDocument,
  type NotificationEvent,
  type NotificationMark,
  type NotificationThread,
} from "./notification-threads";
import { canonicalName } from "./shared/user-store-key";

export type {
  AlertPrefs,
  NotificationEvent,
  NotificationKind,
  NotificationThread,
} from "./notification-threads";

const documents = catalogDocuments("notifications");

/** The subject for an event about a session, labelled by its repository. */
export function sessionSubject(
  sessionId: string,
  session?: { id?: string; title?: string | null; repo?: string | null } | null,
): NotificationEvent["subject"] {
  return {
    type: "session",
    id: session?.id || sessionId,
    title: session?.title || "Untitled session",
    ...(session?.repo ? { context: session.repo } : {}),
  };
}

export function sessionUrl(sessionId: string): string {
  return `/session/${encodeURIComponent(sessionId)}`;
}

/** One inbox per person, whatever case their name arrives in. */
function inboxKey(user: string): string {
  return canonicalName(user.trim().toLowerCase());
}

function validUser(user: string | null | undefined): user is string {
  return typeof user === "string" && user.trim().length > 0;
}

async function readDocument(user: string): Promise<NotificationDocument> {
  return cleanDocument(await documents.get(inboxKey(user)));
}

export interface NotificationInbox {
  threads: NotificationThread[];
  unread: number;
  alerts: AlertPrefs;
}

export async function getNotificationInbox(
  user: string,
): Promise<NotificationInbox> {
  if (!validUser(user))
    return { threads: [], unread: 0, alerts: alertPrefs(null) };
  const doc = await readDocument(user);
  return {
    threads: doc.threads.map(wireThread),
    unread: unreadCount(doc),
    alerts: alertPrefs(doc),
  };
}

async function announceChanged(user: string): Promise<void> {
  try {
    const { broadcastToUser } = await import("./ws-hub");
    broadcastToUser(user, { type: "notifications_changed", user });
  } catch {}
}

/**
 * Record an event for `user` and deliver it. Returns the thread, or null when
 * the event was a replay (same `eventKey` recently) and nothing was sent.
 */
export async function notifyUser(
  user: string | null | undefined,
  event: NotificationEvent,
): Promise<NotificationThread | null> {
  if (!validUser(user)) return null;
  // Written by the mutator, which the catalog may rerun on a conflict: the
  // last run is the one that committed.
  // A group the person switched off records nothing, so the thread is null
  // and nothing is broadcast or pushed.
  const outcome: { thread: NotificationThread | null } = { thread: null };
  try {
    await documents.update(inboxKey(user), (current) => {
      const result = applyNotificationEvent(cleanDocument(current), event);
      outcome.thread = result.thread ? wireThread(result.thread) : null;
      return result.doc;
    });
  } catch (error) {
    console.warn(
      "[notifications] could not record:",
      error instanceof Error ? error.message : error,
    );
    return null;
  }
  const { thread } = outcome;
  if (!thread) return null;
  try {
    const { broadcastToUser } = await import("./ws-hub");
    broadcastToUser(user, {
      type: "notification",
      user,
      notification: thread,
      // Always true now that a switched-off group never records; kept on
      // the wire for clients that still check it.
      alert: true,
    });
  } catch {}
  try {
    const { sendPushToUser } = await import("./push");
    await sendPushToUser(user, {
      title: thread.reason,
      body: [thread.subject.title, thread.body].filter(Boolean).join(": "),
      url: thread.url,
      // One OS notification per thread: a newer event replaces the older
      // banner instead of stacking, on every device.
      tag: `os-notification-${thread.id}`,
      id: thread.id,
    });
  } catch (error) {
    console.warn(
      "[notifications] push failed:",
      error instanceof Error ? error.message : error,
    );
  }
  return thread;
}

/** Mark threads read, unread, done or not done, and tell the person's devices. */
export async function markNotifications(
  user: string,
  mark: NotificationMark,
): Promise<number> {
  if (!validUser(user)) return 0;
  let changed = 0;
  await documents.update(inboxKey(user), (current) => {
    const result = markNotificationThreads(cleanDocument(current), mark);
    changed = result.changed;
    return result.doc;
  });
  if (changed) await announceChanged(user);
  return changed;
}

export async function setAlertPrefs(
  user: string,
  patch: Partial<AlertPrefs>,
): Promise<AlertPrefs> {
  if (!validUser(user)) return alertPrefs(null);
  let next: AlertPrefs = alertPrefs(null);
  await documents.update(inboxKey(user), (current) => {
    const doc = cleanDocument(current);
    const alerts = { ...alertPrefs(doc) };
    for (const group of Object.keys(alerts) as Array<keyof AlertPrefs>)
      if (typeof patch[group] === "boolean") alerts[group] = patch[group];
    next = alerts;
    return { ...doc, alerts };
  });
  await announceChanged(user);
  return next;
}
