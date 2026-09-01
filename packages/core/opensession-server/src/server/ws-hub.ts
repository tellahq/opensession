/**
 * WebSocket fan-out hub: which sockets are watching which session, and
 * every broadcast primitive built on that. Pure client/presence state — no
 * run or queue logic lives here (see queue-state.ts / run-session.ts).
 *
 * All live state is parked on globalThis (same keys as always) so a
 * `bun --hot` reload keeps every connected client and watcher set intact.
 */

import { appendSessionFeed, isFeedEvent } from "./session-feed";

const g = globalThis as any;

// Unique per OS process (survives hot reloads, changes on a real restart) so
// clients can tell a fresh instance from a draining one and reload at the right
// moment. Every connected WebSocket is also tracked so we can warn them all
// before the process goes down for a deploy.
export const BOOT_ID: string = (g.__bootId ??= crypto.randomUUID());
export const allClients: Set<WebSocketClient> = (g.__allClients ??= new Set());

export function broadcastToAll(msg: object) {
  const payload = JSON.stringify(msg);
  for (const ws of allClients) {
    try {
      ws.send(payload);
    } catch {}
  }
}

// WebSocket client state
export interface WSClientData {
  watchingSessionId: string | null;
  user: string | null;
  /** Verified sign-in identity stamped at upgrade (web-auth.ts). When set,
   *  it overrides any client-claimed `user` in messages (ws-handlers.ts). */
  authUser?: string | null;
  /** Verified GitHub login of the signed-in user (createdByLogin stamping). */
  authLogin?: string | null;
  /** Machine sessions do not belong to the human roster. */
  authAutomation?: boolean;
  /**
   * This socket is still WATCHING its session (transcript keeps streaming, so
   * unread/notifications work) but nobody is LOOKING at it — the tab is
   * hidden or its window/app is unfocused. Presence hides these: a
   * face on a row must mean "here now", not "left a tab open on it".
   */
  away?: boolean;
  /** Last frame from this connection, including protocol heartbeat. Presence
   * uses it only to clear half-open sockets. */
  lastSeenAt?: number;
  /** When this socket's owner last did something (see PRESENCE_IDLE_MS).
   * Focus alone can't answer "here now": a window that was frontmost when
   * its owner walked away — or when the screen locked — stays visible and
   * focused all night. */
  activeAt?: number;
  /** This viewer understands ordered session_feed envelopes. */
  supportsFeed?: boolean;
  sinceFeedSeq?: number;
  feedEpoch?: string;
  /** Most recent session join, used to collapse a user's multiple sockets. */
  watchJoinedAt?: number;
  /** Monotonic guard for async watch lookup. A later watch/unwatch/close wins. */
  watchRequest?: number;
  /** This socket is served by the transcript store instead of a file watcher. */
  transcriptV2?: boolean;
  /** User-agent provenance for presence diagnostics. */
  presenceClient?: string;
  /** Automated and hosted-loopback clients never appear in presence. */
  presenceSuppressed?: boolean;
  /** Typing is a short lease refreshed by composer input. The deadline makes
   * stale indicators self-clear when a client disappears without stopping. */
  typingUntil?: number;
}

interface WebSocketClient {
  data: WSClientData;
  send(data: string): unknown;
}

// sessionId → sockets currently viewing that session (collaboration fan-out)
export const sessionWatchers: Map<
  string,
  Set<WebSocketClient>
> = (g.__sessionWatchers ??= new Map());

// Sessions whose workspace (worktree) is still being prepared by their create
// run — the create announces session_created BEFORE the slow git work, and this
// set is what tells clients to show the "Waiting for workspace" state and hold
// the first message in the queue. Cleared (and broadcast via workspace_status)
// the moment the worktree lands or the create fails.
export const preparingWorkspaces: Set<string> = (g.__preparingWorkspaces ??=
  new Set());

export function joinSession(ws: WebSocketClient, sessionId: string) {
  let set = sessionWatchers.get(sessionId);
  if (!set) {
    set = new Set();
    sessionWatchers.set(sessionId, set);
  }
  set.add(ws);
  // Global presence shows each person once, at their most recent join — this
  // stamp is how a two-tab user resolves to a single row.
  ws.data.watchJoinedAt = Date.now();
  ws.data.lastSeenAt = Date.now();
  // Opening a session is itself proof you're here; the idle window runs from now.
  ws.data.activeAt = Date.now();
  ensurePresenceSweep();
  // Presence broadcasts are change-gated, but a newly watching client needs a
  // snapshot even when this session has already been empty for a while. Without
  // one it can keep rendering the face from the session it just left.
  const viewers = broadcastPresence(sessionId, ws);
  const typing = broadcastTyping(sessionId, ws);
  try {
    ws.send(JSON.stringify({ type: "presence", sessionId, viewers }));
    ws.send(JSON.stringify({ type: "typing", sessionId, users: typing }));
  } catch {}
}

export function leaveSession(ws: WebSocketClient) {
  const sessionId = ws.data?.watchingSessionId;
  if (!sessionId) return;
  const set = sessionWatchers.get(sessionId);
  if (set) {
    set.delete(ws);
    ws.data.typingUntil = undefined;
    if (set.size === 0) {
      sessionWatchers.delete(sessionId);
      lastPresence.delete(sessionId);
      lastTyping.delete(sessionId);
      broadcastGlobalPresence();
    } else {
      broadcastPresence(sessionId);
      broadcastTyping(sessionId);
    }
  }
  ws.data.watchingSessionId = null;
}

function fanOutToSession(
  sessionId: string,
  payload: string,
  feedPayload: string | null,
  except?: WebSocketClient,
): void {
  const set = sessionWatchers.get(sessionId);
  if (!set) return;
  for (const ws of set) {
    if (ws === except) continue;
    try {
      ws.send(ws.data?.supportsFeed && feedPayload ? feedPayload : payload);
    } catch {}
  }
}

export function broadcastToSession(
  sessionId: string,
  msg: object,
  except?: WebSocketClient,
) {
  // Advance feed state even with no viewers, so a backgrounded client can
  // recover an active run on reconnect. A status frame may be normalized by
  // the feed when background activity still holds the session busy; legacy
  // clients must receive that same effective event, not the raw false.
  const feed = isFeedEvent(msg) ? appendSessionFeed(sessionId, msg) : null;
  const payload = JSON.stringify(feed?.event ?? msg);
  const feedPayload = feed ? JSON.stringify(feed) : null;
  fanOutToSession(sessionId, payload, feedPayload, except);
}

/** Broadcast an already-aggregated background-activity transition without
 * recording it as a primary model-turn boundary in the resumable feed. */
export function broadcastSessionActivityStatus(
  sessionId: string,
  isRunning: boolean,
): void {
  fanOutToSession(
    sessionId,
    JSON.stringify({ type: "session_status", sessionId, isRunning }),
    null,
  );
}

/** A focused viewer must also have a live transport. All clients heartbeat far
 * inside this window, so a crashed, sleeping, or partitioned client clears
 * promptly even though it never said goodbye. */
const PRESENCE_LIVENESS_MS = 75_000;

/**
 * How long a face outlives the last thing its owner actually did.
 *
 * Focus is the primary signal, but it cannot be the only one: a window that
 * was frontmost when its owner walked away — or when the screen locked, which
 * changes neither `visibilityState` nor `document.hasFocus()` — keeps
 * reporting itself focused for as long as the machine stays awake. Without
 * this ceiling a face sits on a session all night, which is the one thing a
 * face here must never mean.
 *
 * Long enough to read, or to watch a run without touching anything, and it
 * self-corrects: the face comes back on the next scroll or keypress. Clients
 * re-assert attention on real input (throttled to about a minute), so the
 * margin here is many missed refreshes wide.
 */
const PRESENCE_IDLE_MS = 10 * 60_000;
const PRESENCE_SWEEP_MS = 15_000;

function isPresent(
  ws: Pick<WebSocketClient, "data">,
  now = Date.now(),
): boolean {
  const data = ws?.data;
  if (!data || data.away === true) return false;
  if (now - (data.lastSeenAt || 0) >= PRESENCE_LIVENESS_MS) return false;
  return now - (data.activeAt || 0) < PRESENCE_IDLE_MS;
}

/**
 * A frame arrived on this socket. Every frame proves the transport is alive;
 * `active` says it was a person doing something rather than a heartbeat, which
 * is what keeps the face on (see PRESENCE_IDLE_MS).
 */
export function markClientSeen(ws: WebSocketClient, active = false) {
  if (!ws?.data) return;
  const was = isPresent(ws);
  ws.data.lastSeenAt = Date.now();
  if (active) ws.data.activeAt = Date.now();
  if (was || ws.data.away === true) return;
  const sessionId = ws.data.watchingSessionId;
  if (sessionId) broadcastPresence(sessionId);
  else broadcastGlobalPresence();
}

/**
 * A viewer went hidden/unfocused (or came back). The socket keeps watching — only
 * its visibility to other people changes, so both presence frames go out again.
 * `away: false` doubles as the attention refresh: clients re-send it while the
 * person keeps using the app, which is what holds a face past PRESENCE_IDLE_MS.
 */
export function setClientAway(ws: WebSocketClient, away: boolean) {
  if (!ws?.data) return;
  const was = isPresent(ws);
  const wasTyping = isTyping(ws);
  ws.data.away = away;
  ws.data.lastSeenAt = Date.now();
  if (!away) ws.data.activeAt = Date.now();
  if (away) ws.data.typingUntil = undefined;
  const sessionId = ws.data.watchingSessionId;
  if (isPresent(ws) !== was) {
    if (sessionId) broadcastPresence(sessionId);
    else broadcastGlobalPresence();
  }
  if (wasTyping && sessionId) broadcastTyping(sessionId);
}

/** Last frame sent per session / app-wide, so a sweep that changes nothing
 *  stays silent instead of waking every client every 15s. */
const lastPresence: Map<string, string> = (g.__lastPresence ??= new Map());
const lastTyping: Map<string, string> = (g.__lastTyping ??= new Map());

function presenceViewers(sessionId: string): string[] {
  const set = sessionWatchers.get(sessionId);
  return set
    ? Array.from(set)
        .filter((ws) => isPresent(ws))
        .map((ws) => ws.data.user || "Anonymous")
    : [];
}

function broadcastPresence(
  sessionId: string,
  except?: WebSocketClient,
): string[] {
  const viewers = presenceViewers(sessionId);
  const key = viewers.join("\u0000");
  if (lastPresence.get(sessionId) !== key) {
    lastPresence.set(sessionId, key);
    broadcastToSession(
      sessionId,
      { type: "presence", sessionId, viewers },
      except,
    );
  }
  if (!sessionWatchers.has(sessionId)) lastPresence.delete(sessionId);
  broadcastGlobalPresence();
  return viewers;
}

const TYPING_TTL_MS = 4_000;
const TYPING_SWEEP_MS = 1_000;

function isTyping(
  ws: Pick<WebSocketClient, "data">,
  now = Date.now(),
): boolean {
  return (
    isPresent(ws, now) &&
    ws.data.presenceSuppressed !== true &&
    (ws.data.typingUntil || 0) > now
  );
}

/** One entry per person even when they are composing on two devices. */
export function computeTypingUsers(
  watchers: ReadonlySet<Pick<WebSocketClient, "data">> | undefined,
  now = Date.now(),
): string[] {
  const users = new Set<string>();
  for (const ws of watchers || []) {
    if (!isTyping(ws, now)) continue;
    const user = ws.data.user;
    if (user && user !== "Anonymous") users.add(user);
  }
  return [...users];
}

function broadcastTyping(
  sessionId: string,
  except?: WebSocketClient,
): string[] {
  const users = computeTypingUsers(sessionWatchers.get(sessionId));
  const key = users.join("\u0000");
  if (lastTyping.get(sessionId) !== key) {
    lastTyping.set(sessionId, key);
    broadcastToSession(sessionId, { type: "typing", sessionId, users }, except);
  }
  if (!sessionWatchers.has(sessionId)) lastTyping.delete(sessionId);
  return users;
}

/** Refresh or retire the short typing lease for this socket. */
export function setClientTyping(
  ws: WebSocketClient,
  sessionId: string,
  typing: boolean,
) {
  if (
    !ws?.data ||
    ws.data.watchingSessionId !== sessionId ||
    ws.data.presenceSuppressed === true
  )
    return;
  ws.data.typingUntil = typing ? Date.now() + TYPING_TTL_MS : undefined;
  broadcastTyping(sessionId, ws);
  if (typing) ensureTypingSweep();
}

function ensureTypingSweep() {
  if (g.__typingSweep) return;
  g.__typingSweep = setInterval(() => {
    let active = false;
    for (const sessionId of sessionWatchers.keys()) {
      const users = broadcastTyping(sessionId);
      if (users.length > 0) active = true;
    }
    if (!active) {
      clearInterval(g.__typingSweep);
      g.__typingSweep = null;
    }
  }, TYPING_SWEEP_MS);
  g.__typingSweep?.unref?.();
}

/** Expire only dead transports. Change-gated broadcasts keep the sweep quiet. */
function ensurePresenceSweep() {
  if (g.__presenceSweep) return;
  g.__presenceSweep = setInterval(() => {
    if (sessionWatchers.size === 0) {
      clearInterval(g.__presenceSweep);
      g.__presenceSweep = null;
      return;
    }
    for (const sessionId of sessionWatchers.keys())
      broadcastPresence(sessionId);
  }, PRESENCE_SWEEP_MS);
  g.__presenceSweep?.unref?.();
}

/**
 * Who's looking at what, app-wide — drives the sidebar People band, the row
 * faces and follow mode. One entry per USER (a person with two tabs open would
 * otherwise show twice): the session they joined most recently wins. Anonymous
 * viewers are skipped (nothing to follow), and so are away sockets — a hidden
 * or unfocused tab still streams its session but must not claim its owner is there.
 * That also breaks the tie correctly for a person with one visible tab and one
 * hidden one: the away socket can no longer win on recency.
 */
export function computeGlobalPresence(
  watchers: ReadonlyMap<string, ReadonlySet<Pick<WebSocketClient, "data">>>,
): Array<{ user: string; sessionId: string }> {
  const latest = new Map<string, { sessionId: string; at: number }>();
  for (const [sessionId, set] of watchers) {
    for (const ws of set) {
      const user = ws.data?.user;
      if (!user || user === "Anonymous") continue;
      if (!isPresent(ws)) continue;
      const at = ws.data?.watchJoinedAt || 0;
      const prev = latest.get(user);
      if (!prev || at >= prev.at) latest.set(user, { sessionId, at });
    }
  }
  return [...latest.entries()].map(([user, v]) => ({
    user,
    sessionId: v.sessionId,
  }));
}

/**
 * The app-wide presence frame as it stands right now. Broadcasts only fire on
 * CHANGE, so a client that just connected would otherwise see an empty team
 * until someone happened to open or leave a session — send this once at the
 * handshake (ws-handlers.ts) to start it off with the truth.
 */
export function globalPresenceFrame() {
  return {
    type: "global_presence",
    viewing: computeGlobalPresence(sessionWatchers),
  };
}

function broadcastGlobalPresence() {
  const frame = JSON.stringify(globalPresenceFrame());
  if (g.__lastGlobalPresence === frame) return;
  g.__lastGlobalPresence = frame;
  for (const ws of allClients) {
    try {
      ws.send(frame);
    } catch {}
  }
}
