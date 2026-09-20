import type { TranscriptEntry } from "./types";

function latestReply(entries: TranscriptEntry[]) {
  return entries.findLast(
    (entry) =>
      entry.type === "assistant" && !entry.isReasoning && entry.content.trim(),
  );
}

/** Never narrate old history when a call starts, a page loads, or the socket
 * replays. Wait for the existing agent to finish rather than reading partial
 * text, reasoning, or tool output. The canonical full reply stays in chat. */
export class SessionVoiceReplies {
  private last: TranscriptEntry | undefined;
  private sequence: number;
  private timestamp: number;
  private startedEmpty: boolean;
  private spokenId: string | undefined;

  constructor(entries: TranscriptEntry[], now = Date.now()) {
    const last = latestReply(entries);
    this.last = last ? { ...last } : undefined;
    this.startedEmpty = entries.length === 0;
    this.sequence = entries.reduce(
      (max, entry) => Math.max(max, entry.seq ?? 0),
      0,
    );
    this.timestamp = entries.length
      ? entries.reduce(
          (max, entry) => Math.max(max, Date.parse(entry.timestamp) || 0),
          0,
        )
      : now;
  }

  take(entries: TranscriptEntry[], busy: boolean): string | null {
    if (busy) return null;
    const reply = latestReply(entries);
    if (
      !reply ||
      reply.id === this.spokenId ||
      (reply.id === this.last?.id && reply.content === this.last.content)
    )
      return null;
    if (
      reply.id !== this.last?.id &&
      (reply.seq !== undefined
        ? reply.seq <= this.sequence
        : Date.parse(reply.timestamp) <= this.timestamp)
    )
      return null;
    if (this.startedEmpty && Date.parse(reply.timestamp) < this.timestamp)
      return null;
    this.startedEmpty = false;
    this.last = { ...reply };
    this.spokenId = reply.id;
    this.sequence = Math.max(this.sequence, reply.seq ?? 0);
    this.timestamp = Math.max(this.timestamp, Date.parse(reply.timestamp) || 0);
    return reply.content;
  }
}

/** Everything one call has handed to the agent. Shared by every request of
 * the call so a request can tell a sibling's delivery from an unrelated turn. */
export interface SessionVoiceRequests {
  /** User entries already matched to a request of this call. */
  claimedUsers: Set<string>;
  /** Outbox delivery ids issued for this call's requests. */
  deliveryIds: Set<string>;
}

export function sessionVoiceRequests(): SessionVoiceRequests {
  return { claimedUsers: new Set(), deliveryIds: new Set() };
}

/** Steer batches join adjacent user entries sharing the raw turn id (-j2). */
function turnIdOf(entry: TranscriptEntry) {
  return entry.id.replace(/-j\d+$/, "");
}

/** Wait for the requested task to actually reach the agent, not a reply from
 * an older run that was already in flight when the task was sent.
 *
 * Every request steers: while the agent is busy the server appends the task
 * inside the running turn, and the run's final reply answers every task it
 * absorbed. A later user entry from this same call therefore does not end a
 * request's turn, while a turn boundary or a message from anyone else still
 * does, so a request never narrates a reply to an unrelated turn. */
export class SessionVoiceAgentReply {
  private baseline: number;
  private existingUsers: Set<string>;
  private delivered = false;
  messageId: string | undefined;
  replyId: string | undefined;
  private user: TranscriptEntry | undefined;
  private answer: TranscriptEntry | undefined;
  private end: TranscriptEntry | undefined;
  constructor(
    readonly prompt: string,
    entries: TranscriptEntry[],
    private requests: SessionVoiceRequests = sessionVoiceRequests(),
  ) {
    this.baseline = entries.reduce(
      (max, entry) => Math.max(max, entry.seq ?? 0),
      0,
    );
    this.existingUsers = new Set(
      entries.filter((entry) => entry.type === "user").map((entry) => entry.id),
    );
  }
  /** Match the request's own user entry. Anchoring every pending request
   * before reading replies lets each one recognize the others' entries. */
  anchor(entries: TranscriptEntry[]): boolean {
    if (this.user) return true;
    const user = entries.find(
      (entry) =>
        entry.type === "user" &&
        !this.existingUsers.has(entry.id) &&
        (entry.seq === undefined || entry.seq > this.baseline) &&
        (this.messageId
          ? entry.sourceMessageIds?.includes(this.messageId)
          : !this.requests.claimedUsers.has(entry.id) &&
            entry.content.trim() === this.prompt.trim()),
    );
    if (!user) return false;
    this.user = user;
    this.requests.claimedUsers.add(user.id);
    return true;
  }
  private isSibling(entry: TranscriptEntry, turnId: string) {
    return (
      turnIdOf(entry) === turnId ||
      this.requests.claimedUsers.has(entry.id) ||
      !!entry.sourceMessageIds?.some((id) => this.requests.deliveryIds.has(id))
    );
  }
  take(entries: TranscriptEntry[], busy: boolean): string | null {
    if (this.delivered || !this.anchor(entries)) return null;
    const user = this.user!;
    const index = entries.findIndex((entry) => entry.id === user.id);
    // Keep the anchor across bounded transcript windows. Once matched by its
    // delivery id, it need not remain among the newest 500 entries.
    const after =
      index >= 0
        ? entries.slice(index + 1)
        : user.seq !== undefined
          ? entries.filter(
              (entry) => entry.seq !== undefined && entry.seq > user.seq!,
            )
          : [];
    const turnId = turnIdOf(user);
    // An end that left the bounded window keeps bounding by sequence. One
    // still in view is recomputed: a sibling's entry can gain its delivery id
    // after it first appeared.
    if (!this.end || after.some((entry) => entry.id === this.end?.id))
      this.end = after.find(
        (entry) =>
          entry.turnBoundary ||
          (entry.type === "user" && !this.isSibling(entry, turnId)),
      );
    const endIndex = this.end
      ? after.findIndex((entry) => entry.id === this.end?.id)
      : -1;
    const segment =
      endIndex >= 0
        ? after.slice(0, endIndex)
        : this.end
          ? after.filter(
              (entry) =>
                entry.seq !== undefined &&
                this.end?.seq !== undefined &&
                entry.seq < this.end.seq,
            )
          : after;
    this.answer = latestReply(segment) ?? this.answer;
    if (busy || !this.answer) return null;
    const reply = this.answer;
    this.delivered = true;
    this.replyId = reply.id;
    return reply.content;
  }
}
