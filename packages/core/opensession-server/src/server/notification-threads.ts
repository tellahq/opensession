/**
 * Pure model of a person's notification inbox. src/server/notifications.ts
 * stores it in the central catalog; everything that decides what a record
 * looks like after an event, a read or a "done" lives here so it can be
 * tested without the catalog.
 *
 * The inbox is thread-shaped, like GitHub's: one row per subject (a session,
 * a pull request, a workspace, a reminder). A new event on a subject moves
 * that row to the top and marks it unread instead of adding a second row.
 *
 * Every event carries an optional key naming the real-world occurrence (a
 * review request's timestamp, say). A key seen recently is a replay, not news: a
 * restart that re-raises the same event changes nothing, so nothing can
 * alert twice.
 */

/**
 * People notify people: review requests and results, mentions, workspace
 * invites, and your own Desk reminders. Agent activity (questions, failed or
 * finished runs) does not; the sidebar already shows it.
 */
export const NOTIFICATION_KINDS = [
  "review_requested",
  "team_review_requested",
  "review_done",
  "mention",
  "collaborator",
  "reminder",
  "comment",
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/** What a person switches on or off in Settings. */
export const ALERT_GROUPS = {
  reviews: ["review_requested", "review_done"],
  teamReviews: ["team_review_requested"],
  mentions: ["mention", "comment"],
  collaborators: ["collaborator"],
  reminders: ["reminder"],
} as const satisfies Record<string, readonly NotificationKind[]>;
export type AlertGroup = keyof typeof ALERT_GROUPS;
export type AlertPrefs = Record<AlertGroup, boolean>;

export const DEFAULT_ALERT_PREFS: AlertPrefs = {
  reviews: true,
  teamReviews: true,
  mentions: true,
  collaborators: true,
  reminders: true,
};

export type NotificationSubjectType =
  | "session"
  | "pr"
  | "workspace"
  | "reminder";

export interface NotificationSubject {
  type: NotificationSubjectType;
  id: string;
  title: string;
  /** Repository or workspace label shown above the title. */
  context?: string;
}

/** One inbox row as clients see it. */
export interface NotificationThread {
  /** `<subject type>:<subject id>`. Stable for the life of the subject. */
  id: string;
  subject: NotificationSubject;
  kind: NotificationKind;
  /** Why this is here, short: "Needs input", "Ada asked for your review". */
  reason: string;
  /** Optional detail: the question, the error, the mention text. */
  body: string;
  actor?: string;
  /** In-app path to open. */
  url: string;
  /** ms epoch of the latest event. */
  updatedAt: number;
  unread: boolean;
  done: boolean;
}

/** Stored form: the wire thread plus the recent event keys used to dedupe. */
export interface StoredThread extends NotificationThread {
  events: Array<{ key: string; at: number }>;
}

export interface NotificationDocument {
  threads: StoredThread[];
  alerts?: Partial<AlertPrefs>;
}

export interface NotificationEvent {
  kind: NotificationKind;
  subject: NotificationSubject;
  reason: string;
  body?: string;
  actor?: string;
  url: string;
  /** Names the real occurrence. A repeat within the window is ignored. */
  eventKey?: string;
  at?: number;
}

export const MAX_THREADS = 200;
export const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
/** How long an event key keeps suppressing a replay. */
export const EVENT_DEDUPE_MS = 48 * 60 * 60 * 1000;
const MAX_EVENTS_PER_THREAD = 20;
const REASON_LEN = 120;
const BODY_LEN = 280;
const TITLE_LEN = 160;

export function threadId(subject: Pick<NotificationSubject, "type" | "id">) {
  return `${subject.type}:${subject.id}`;
}

export function kindAlertGroup(kind: NotificationKind): AlertGroup {
  for (const [group, kinds] of Object.entries(ALERT_GROUPS))
    if ((kinds as readonly NotificationKind[]).includes(kind))
      return group as AlertGroup;
  return "reviews";
}

export function alertPrefs(doc: NotificationDocument | null): AlertPrefs {
  return { ...DEFAULT_ALERT_PREFS, ...(doc?.alerts ?? {}) };
}

export function shouldAlert(
  doc: NotificationDocument | null,
  kind: NotificationKind,
): boolean {
  return alertPrefs(doc)[kindAlertGroup(kind)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function cleanThread(value: unknown): StoredThread | null {
  if (!isRecord(value) || !isRecord(value.subject)) return null;
  const subject = value.subject;
  const type = subject.type;
  if (
    type !== "session" &&
    type !== "pr" &&
    type !== "workspace" &&
    type !== "reminder"
  )
    return null;
  if (typeof subject.id !== "string" || !subject.id) return null;
  const kind = value.kind;
  if (!NOTIFICATION_KINDS.some((known) => known === kind)) return null;
  if (typeof value.url !== "string" || typeof value.updatedAt !== "number")
    return null;
  const events = Array.isArray(value.events)
    ? value.events.filter(
        (event): event is { key: string; at: number } =>
          isRecord(event) &&
          typeof event.key === "string" &&
          typeof event.at === "number",
      )
    : [];
  return {
    id: threadId({ type, id: subject.id }),
    subject: {
      type,
      id: subject.id,
      title: text(subject.title, TITLE_LEN),
      ...(typeof subject.context === "string" && subject.context
        ? { context: text(subject.context, TITLE_LEN) }
        : {}),
    },
    kind: kind as NotificationKind,
    reason: text(value.reason, REASON_LEN),
    body: text(value.body, BODY_LEN),
    ...(typeof value.actor === "string" && value.actor
      ? { actor: text(value.actor, 64) }
      : {}),
    url: value.url,
    updatedAt: value.updatedAt,
    unread: value.unread === true,
    done: value.done === true,
    events,
  };
}

export function cleanDocument(value: unknown): NotificationDocument {
  if (!isRecord(value)) return { threads: [] };
  const threads = Array.isArray(value.threads)
    ? value.threads.flatMap((thread) => cleanThread(thread) ?? [])
    : [];
  const alerts: Partial<AlertPrefs> = {};
  if (isRecord(value.alerts))
    for (const group of Object.keys(DEFAULT_ALERT_PREFS) as AlertGroup[])
      if (typeof value.alerts[group] === "boolean")
        alerts[group] = value.alerts[group];
  return {
    threads,
    ...(Object.keys(alerts).length ? { alerts } : {}),
  };
}

function prune(threads: StoredThread[], now: number): StoredThread[] {
  return threads
    .filter((thread) => now - thread.updatedAt < RETENTION_MS)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_THREADS);
}

/**
 * Apply one event. Returns the next document and the thread it touched, or
 * `thread: null` when nothing changed: the event was a replay, or the person
 * switched its group off, in which case it never reaches the inbox at all.
 */
export function applyNotificationEvent(
  doc: NotificationDocument,
  event: NotificationEvent,
): { doc: NotificationDocument; thread: StoredThread | null } {
  if (!shouldAlert(doc, event.kind)) return { doc, thread: null };
  const now = event.at ?? Date.now();
  const id = threadId(event.subject);
  const existing = doc.threads.find((thread) => thread.id === id);
  const events = (existing?.events ?? []).filter(
    (seen) => now - seen.at < EVENT_DEDUPE_MS,
  );
  if (event.eventKey && events.some((seen) => seen.key === event.eventKey))
    return { doc, thread: null };
  const thread: StoredThread = {
    id,
    subject: {
      type: event.subject.type,
      id: event.subject.id,
      title:
        text(event.subject.title, TITLE_LEN) || existing?.subject.title || "",
      ...((event.subject.context ?? existing?.subject.context)
        ? {
            context: text(
              event.subject.context ?? existing?.subject.context,
              TITLE_LEN,
            ),
          }
        : {}),
    },
    kind: event.kind,
    reason: text(event.reason, REASON_LEN),
    body: text(event.body, BODY_LEN),
    ...(event.actor ? { actor: text(event.actor, 64) } : {}),
    url: event.url,
    updatedAt: now,
    unread: true,
    done: false,
    events: event.eventKey
      ? [...events, { key: event.eventKey, at: now }].slice(
          -MAX_EVENTS_PER_THREAD,
        )
      : events,
  };
  return {
    doc: {
      ...doc,
      threads: prune(
        [thread, ...doc.threads.filter((other) => other.id !== id)],
        now,
      ),
    },
    thread,
  };
}

export interface NotificationMark {
  /** Thread ids. Omit with `all` to touch every thread. */
  ids?: string[];
  all?: boolean;
  unread?: boolean;
  done?: boolean;
}

/** Apply a read/unread/done change. Returns how many threads changed. */
export function markNotificationThreads(
  doc: NotificationDocument,
  mark: NotificationMark,
): { doc: NotificationDocument; changed: number } {
  const ids = new Set(mark.ids ?? []);
  let changed = 0;
  const threads = doc.threads.map((thread) => {
    if (!mark.all && !ids.has(thread.id)) return thread;
    const next = { ...thread };
    if (typeof mark.unread === "boolean") next.unread = mark.unread;
    if (typeof mark.done === "boolean") {
      next.done = mark.done;
      // Done implies read, like GitHub: it leaves the inbox entirely.
      if (mark.done) next.unread = false;
    }
    if (next.unread !== thread.unread || next.done !== thread.done) changed++;
    return next;
  });
  return { doc: changed ? { ...doc, threads } : doc, changed };
}

/** The client shape: dedupe keys stay on the server. */
export function wireThread(thread: StoredThread): NotificationThread {
  const { events: _events, ...wire } = thread;
  return wire;
}

export function unreadCount(doc: NotificationDocument): number {
  return doc.threads.filter((thread) => thread.unread && !thread.done).length;
}
