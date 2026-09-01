import type { PromptOutboxItem } from "./prompt-outbox";

/**
 * Which optimistic "just sent" bubbles the server has accounted for.
 *
 * A bubble is CLAIMED when its message shows up for real: a queued entry or a
 * steer receipt echoed back, or a transcript user entry recorded around or
 * after the send. A bubble nothing claims within PENDING_GIVE_UP_MS is EXPIRED
 * instead, which is a weaker statement: the prompt may still be in flight, so a
 * caller may hide the bubble but must not treat the message as delivered.
 */

/** How far before a bubble's own send a transcript entry may be recorded and
 *  still claim it. Clocks differ between this tab and the server. */
export const PENDING_MATCH_WINDOW_MS = 30_000;
/** After this long with nothing claiming it, stop showing a bubble so a dead
 *  send never sticks as "sending…". */
export const PENDING_GIVE_UP_MS = 120_000;

export interface PendingPrompt {
  id: string;
  content: string;
  user?: string;
  sentAt: number;
  /** Causal transcript position captured when the message was sent. Unlike a
   *  timestamp, this stays valid across client/server clock skew and delayed
   *  assistant frames. `null` means the transcript was empty. */
  transcriptAfterEntryId?: string | null;
  transcriptAfterSeq?: number;
  /** The delivery response says this prompt started a turn. A transient queue
   *  receipt must not retire its transcript bubble before the real entry lands. */
  serverStarted?: true;
}

export interface OptimisticPendingPrompt extends PendingPrompt {
  images?: string[];
  busyMode?: "queue" | "steer";
}

/**
 * An idle send briefly appears in the server queue before its delivery result
 * says whether it really started or parked. Keep that echo off the queue
 * surface while the same prompt is still rendered as an optimistic transcript
 * bubble, so actor admission cannot show one message in both places.
 */
export function withoutPendingTranscriptEchoes<T extends { id?: string }>(
  items: readonly T[],
  pendingBubbles: readonly OptimisticPendingPrompt[],
): T[] {
  const pendingDeliveryIds = new Set(
    pendingBubbles.flatMap((item) =>
      item.id.startsWith("outbox-") ? [item.id.slice("outbox-".length)] : [],
    ),
  );
  return items.filter((item) => !item.id || !pendingDeliveryIds.has(item.id));
}

/**
 * A pristine idle outbox item is the same optimistic message even when React's
 * local pending row has already reconciled or has not committed yet. Project it
 * onto the transcript instead of exposing the outbox's transport status.
 */
export function optimisticOutboxFallbacks(
  items: readonly PromptOutboxItem[],
  pendingIds: ReadonlySet<string>,
  landedIds: ReadonlySet<string>,
): OptimisticPendingPrompt[] {
  return items
    .filter((item) => {
      const id = `outbox-${item.clientId}`;
      return (
        item.state !== "failed" &&
        item.attempts === 0 &&
        item.busyMode !== "queue" &&
        !pendingIds.has(id) &&
        !landedIds.has(id)
      );
    })
    .map((item) => ({
      id: `outbox-${item.clientId}`,
      content: item.content,
      user: item.user,
      sentAt: item.createdAt,
      transcriptAfterEntryId: item.transcriptAfterEntryId,
      transcriptAfterSeq: item.transcriptAfterSeq,
      ...(item.busyMode === "steer" ? { busyMode: "steer" as const } : {}),
      ...(item.images?.length ? { images: item.images } : {}),
    }));
}

/**
 * The composer places a new optimistic prompt from its last-known running
 * state. The server can make the opposite decision in the send race: a run
 * that looked busy may finish before intake, so the authoritative result is
 * `started`. Move that prompt back to the transcript surface. If a transient
 * queue echo already claimed and removed it, restore the bubble until its real
 * transcript entry arrives.
 */
export function markPendingStarted(
  pending: OptimisticPendingPrompt[],
  started: OptimisticPendingPrompt,
): OptimisticPendingPrompt[] {
  const index = pending.findIndex((item) => item.id === started.id);
  if (index < 0) return [...pending, { ...started, serverStarted: true }];
  if (pending[index].serverStarted && !pending[index].busyMode) return pending;
  const next = pending.slice();
  const transcriptBubble = { ...pending[index], serverStarted: true as const };
  delete transcriptBubble.busyMode;
  next[index] = transcriptBubble;
  return next;
}

/** The authoritative delivery result says a prompt joined the running turn or
 *  its queue. Keep the optimistic row on that surface until its live echo lands. */
export function markPendingBusy(
  pending: OptimisticPendingPrompt[],
  delivered: OptimisticPendingPrompt,
  busyMode: "queue" | "steer",
): OptimisticPendingPrompt[] {
  const index = pending.findIndex((item) => item.id === delivered.id);
  if (index < 0) return [...pending, { ...delivered, busyMode }];
  if (pending[index].busyMode === busyMode && !pending[index].serverStarted)
    return pending;
  const next = pending.slice();
  const busyPrompt = { ...pending[index], busyMode };
  delete busyPrompt.serverStarted;
  next[index] = busyPrompt;
  return next;
}

export interface ReconcileResult {
  /** Confirmed by the server. Safe to retire every optimistic record of it. */
  landed: Set<string>;
  /** Unclaimed for too long. Hide only — the send may still be in flight. */
  expired: Set<string>;
}

export function reconcilePending(
  pending: readonly OptimisticPendingPrompt[],
  entries: readonly {
    id?: string;
    type: string;
    content: string;
    timestamp: string;
    sourceMessageIds?: string[];
  }[],
  echoes: readonly { id?: string; content: string }[],
  now: number,
): ReconcileResult {
  const landed = new Set<string>();
  const expired = new Set<string>();
  if (pending.length === 0) return { landed, expired };
  const userPool = entries
    .filter((e) => e.type === "user")
    .map((e) => ({
      id: e.id,
      sourceMessageIds: new Set(e.sourceMessageIds ?? []),
      c: e.content.trim(),
      t: new Date(e.timestamp).getTime(),
    }));
  // A just-sent message is confirmed by a queued echo, a steer receipt
  // (busy/fold-in path), or a real transcript user entry.
  const echoPool = echoes.map((q) => ({ id: q.id, content: q.content.trim() }));
  for (const p of pending) {
    const c = p.content.trim();
    const deliveryId = p.id.startsWith("outbox-")
      ? p.id.slice("outbox-".length)
      : undefined;
    // A single prompt uses the outbox id as its durable row id; a batch carries
    // every constituent id in sourceMessageIds. Claim identity before falling
    // back to legacy content/time matching: server normalization may strip
    // context or add attribution, and neither should leave the optimistic copy
    // alive beside the real turn.
    const exactEntry = deliveryId
      ? userPool.findIndex(
          (entry) =>
            entry.id === deliveryId || entry.sourceMessageIds.has(deliveryId),
        )
      : -1;
    if (exactEntry >= 0) {
      const matched = userPool[exactEntry]!;
      const hadSourceIds = matched.sourceMessageIds.size > 0;
      matched.sourceMessageIds.delete(deliveryId!);
      if (!hadSourceIds || matched.sourceMessageIds.size === 0)
        userPool.splice(exactEntry, 1);
      landed.add(p.id);
      continue;
    }
    const exactEcho = deliveryId
      ? echoPool.findIndex((q) => q.id === deliveryId)
      : -1;
    // Every idle send is durably queued before dispatch. Its queue_update can
    // therefore beat the HTTP admission result even though the server is about
    // to return `started`. Do not turn that transient ownership record into a
    // visible "Waiting to send" row. The delivery observer first marks an
    // authoritative queued/steered result as busy; a started result waits only
    // for its transcript entry. Reserve an exact echo even when ignoring it so
    // identical prompts cannot claim each other's receipt by content.
    if (exactEcho >= 0) {
      echoPool.splice(exactEcho, 1);
      if (p.busyMode && !p.serverStarted) {
        landed.add(p.id);
        continue;
      }
    } else if (!p.serverStarted && (p.busyMode || !deliveryId)) {
      const qi = echoPool.findIndex((q) => q.content === c);
      if (qi >= 0) {
        echoPool.splice(qi, 1);
        landed.add(p.id);
        continue;
      }
    }
    // Interrupt/steer-path sends land in the transcript with a "[user] "
    // attribution prefix (added server-side), while the optimistic bubble
    // holds the raw text — accept either form so a redirected message's
    // bubble reconciles instead of sticking as "redirecting…".
    const attributed = p.user ? `[${p.user}] ${c}` : c;
    const ui = userPool.findIndex(
      (u) =>
        (u.c === c || u.c === attributed) &&
        u.t >= p.sentAt - PENDING_MATCH_WINDOW_MS,
    );
    if (ui >= 0) {
      userPool.splice(ui, 1);
      landed.add(p.id);
      continue;
    }
    // Steers pending at the same turn boundary get joined into ONE user
    // turn ("\n\n"-separated, each with its attribution prefix), possibly
    // alongside a harness nudge — so the exact match above never fires.
    // The "[user] " prefix is distinctive enough to claim by containment.
    // Don't splice: the same joined entry may cover other bubbles too.
    if (
      p.user &&
      userPool.some(
        (u) =>
          u.c.includes(attributed) && u.t >= p.sentAt - PENDING_MATCH_WINDOW_MS,
      )
    ) {
      landed.add(p.id);
      continue;
    }
    if (now - p.sentAt >= PENDING_GIVE_UP_MS) expired.add(p.id);
  }
  return { landed, expired };
}
