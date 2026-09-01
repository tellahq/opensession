/**
 * Todos — the Desk's per-user todo list. AI-native: any interactive session
 * carries the opensession-todos in-process MCP server (todos-tools.ts), so
 * "put X on my list" works from every conversation and each item remembers
 * which session added it. The Desk overlay (DeskOverlay.tsx) is the human
 * management surface; routes/todos.ts is the HTTP surface.
 *
 * Storage: one JSON file at ~/.opensession-todos/todos.json (atomic writes —
 * items are mutable state, unlike the append-only papercuts log). Mutations
 * broadcast `todos_changed` to every UI client and mirror into the audit log
 * so a future daily-digest automation sees todo activity with no extra
 * plumbing.
 */
import { existsSync, readFileSync } from "node:fs";
import { randomUUIDv7 } from "bun";
import { audit } from "./audit";
import { sendPushToUser } from "./push";
import { stateDir } from "./paths";
import { writeJsonAtomic } from "./shared/atomic-write";
import { resolveTeammate } from "./shared/user-mappings";
import { broadcastToAll } from "./ws-hub";
import { openDirectMessage, sendSlackMessage } from "../agents/slack/slack-api";
import { personaName } from "./config";

/** Resolved per call, not at load, so a dev instance or a test that repoints
 *  the state root can never read or write the live list. */
function todosPath(): string {
  return `${stateDir("todos")}/todos.json`;
}

export type TodoStatus = "open" | "done" | "dropped";

export interface TodoSource {
  kind: "session" | "manual";
  /** Session that added the item (deep-linkable provenance). */
  sessionId?: string;
  /** Who was driving: a user name, for display. */
  by?: string;
}

export interface TodoItem {
  id: string;
  /** Owner (first-name convention, same as session createdBy). */
  user: string;
  text: string;
  status: TodoStatus;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  /** Optional provenance/context line ("boss-requested", a PR link, …). */
  note?: string;
  /** Optional ISO due date (YYYY-MM-DD). */
  due?: string;
  /** Optional reminder: ISO datetime; the reminder ticker pushes + Slack-DMs
   *  the owner once this passes (while the item is still open). */
  remindAt?: string;
  /** Set once the reminder fired, so it fires exactly once. */
  remindedAt?: string;
  source: TodoSource;
}

interface TodoStore {
  items: TodoItem[];
}

const MAX_TEXT_CHARS = 500;
const MAX_NOTE_CHARS = 500;

function readStore(): TodoStore {
  try {
    const path = todosPath();
    if (existsSync(path))
      return JSON.parse(readFileSync(path, "utf-8")) as TodoStore;
  } catch (e) {
    console.error("[todos] failed to read store:", e);
  }
  return { items: [] };
}

function writeStore(store: TodoStore): void {
  writeJsonAtomic(todosPath(), store);
}

function changed(user: string): void {
  broadcastToAll({ type: "todos_changed", user });
}

export function addTodo(input: {
  user: string;
  text: string;
  note?: string;
  due?: string;
  remindAt?: string;
  source: TodoSource;
}): TodoItem {
  const text = (input.text || "").trim().slice(0, MAX_TEXT_CHARS);
  if (!text) throw new Error("todo text is empty");
  const user = (input.user || "").trim();
  if (!user) throw new Error("todo user is empty");
  const now = new Date().toISOString();
  const item: TodoItem = {
    id: `todo-${randomUUIDv7()}`,
    user,
    text,
    status: "open",
    createdAt: now,
    updatedAt: now,
    ...(input.note ? { note: input.note.trim().slice(0, MAX_NOTE_CHARS) } : {}),
    ...(input.due ? { due: input.due } : {}),
    ...(input.remindAt ? { remindAt: input.remindAt } : {}),
    source: input.source,
  };
  const store = readStore();
  store.items.push(item);
  writeStore(store);
  audit({
    kind: "todo_added",
    session_id: input.source.sessionId,
    by: input.source.by || user,
    user,
    message: text,
  });
  changed(user);
  return item;
}

/** Newest first within a status; open items before done/dropped. */
export function listTodos(opts?: {
  user?: string;
  status?: TodoStatus | "all";
  limit?: number;
}): TodoItem[] {
  const limit = Math.min(500, Math.max(1, opts?.limit || 200));
  const status = opts?.status || "open";
  const rank: Record<TodoStatus, number> = { open: 0, done: 1, dropped: 2 };
  return readStore()
    .items.filter(
      (t) =>
        (!opts?.user || t.user === opts.user) &&
        (status === "all" || t.status === status),
    )
    .sort(
      (a, b) =>
        rank[a.status] - rank[b.status] || (a.createdAt < b.createdAt ? 1 : -1),
    )
    .slice(0, limit);
}

export function getTodo(id: string): TodoItem | undefined {
  return readStore().items.find((t) => t.id === id);
}

export function updateTodo(
  id: string,
  patch: {
    status?: TodoStatus;
    text?: string;
    note?: string | null;
    due?: string | null;
    remindAt?: string | null;
  },
  by?: string,
): TodoItem {
  const store = readStore();
  const item = store.items.find((t) => t.id === id);
  if (!item) throw new Error(`unknown todo "${id}"`);
  const now = new Date().toISOString();
  if (patch.status && patch.status !== item.status) {
    item.status = patch.status;
    if (patch.status === "open") delete item.completedAt;
    else item.completedAt = now;
  }
  if (typeof patch.text === "string" && patch.text.trim())
    item.text = patch.text.trim().slice(0, MAX_TEXT_CHARS);
  if (patch.note === null) delete item.note;
  else if (typeof patch.note === "string")
    item.note = patch.note.trim().slice(0, MAX_NOTE_CHARS);
  if (patch.due === null) delete item.due;
  else if (typeof patch.due === "string") item.due = patch.due;
  if (patch.remindAt === null) {
    delete item.remindAt;
    delete item.remindedAt;
  } else if (typeof patch.remindAt === "string") {
    item.remindAt = patch.remindAt;
    // A (re)scheduled reminder fires again.
    delete item.remindedAt;
  }
  item.updatedAt = now;
  writeStore(store);
  audit({
    kind: "todo_updated",
    by: by || item.user,
    user: item.user,
    status: item.status,
    message: item.text,
  });
  changed(item.user);
  return item;
}

// ── Reminders ────────────────────────────────────────────────────────────────
// A 30s sweep fires each open todo's remindAt exactly once: Web Push to the
// owner's devices + a Slack DM (prefixed with the agent's name, per the messaging rule).
// Started once from opensession.ts's __opensessionBooted block.

const SWEEP_MS = 30_000;

async function sweepReminders(): Promise<void> {
  const store = readStore();
  const now = new Date().toISOString();
  const due = store.items.filter(
    (t) =>
      t.status === "open" && t.remindAt && !t.remindedAt && t.remindAt <= now,
  );
  if (!due.length) return;
  for (const t of due) t.remindedAt = now;
  writeStore(store);
  for (const t of due) {
    audit({ kind: "todo_reminder", user: t.user, message: t.text });
    try {
      await sendPushToUser(
        t.user,
        {
          title: "Reminder",
          body: t.text,
          url: "/",
          tag: `todo-reminder-${t.id}`,
        },
        { dedupeKey: `todo-reminder-${t.id}` },
      );
    } catch (e) {
      console.error("[todos] reminder push failed:", e);
    }
    try {
      const teammate = resolveTeammate(t.user);
      if (teammate) {
        const channel = await openDirectMessage(teammate.slackId);
        if (channel)
          await sendSlackMessage(
            channel,
            `It's ${personaName()} — reminder from your Desk: ${t.text}`,
          );
      }
    } catch (e) {
      console.error("[todos] reminder Slack DM failed:", e);
    }
    changed(t.user);
  }
}

let reminderTimer: ReturnType<typeof setInterval> | null = null;

/** Start the reminder sweep. Call once from the __opensessionBooted block. */
export function startTodoReminderTicker(): void {
  if (reminderTimer) return;
  reminderTimer = setInterval(() => {
    sweepReminders().catch((e) =>
      console.error("[todos] reminder sweep failed:", e),
    );
  }, SWEEP_MS);
  console.log("[todos] reminder ticker started");
}
