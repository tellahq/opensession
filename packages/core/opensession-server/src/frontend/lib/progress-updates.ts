import type {
  TranscriptEntry,
  TranscriptIndexEntry,
} from "@tellahq/opensession-protocol/session";
import { classifyEntry } from "@tellahq/opensession-protocol/notices";
import { agentMessageText } from "./agent-message";

export interface ProgressUpdate {
  topic: string;
  state: "running" | "done";
  text: string;
}

export interface ProgressGroup {
  latest: ProgressUpdate;
  entries: TranscriptEntry[];
}

/** An opt-in, ordinary Markdown line. Other clients can display it unchanged.
 * Never infer progress from arbitrary prose or hide a message with extra content. */
export function parseProgressUpdate(
  entry: TranscriptEntry,
): ProgressUpdate | null {
  if (
    entry.type !== "assistant" ||
    entry.isReasoning ||
    entry.isError ||
    entry.contentClamped ||
    entry.pastedTexts?.length ||
    entry.images?.length ||
    entry.videos?.length ||
    entry.files?.length ||
    (entry.contentLength !== undefined &&
      entry.contentLength > entry.content.length)
  )
    return null;
  const match = /^(✓|◷) \*\*([^*\r\n]{1,48})\*\*: ([^\r\n]{1,200})$/.exec(
    entry.content.trim(),
  );
  if (
    !match ||
    !match[2]!.trim() ||
    !match[3]!.trim() ||
    match[3]!.includes("?")
  )
    return null;
  return {
    topic: match[2]!.trim(),
    state: match[1] === "✓" ? "done" : "running",
    text: match[3]!.trim(),
  };
}

/** First loaded update owns the row; later ones replace its label, not its
 * history. Human messages and team notes start a new scope. The full outline
 * keeps unloaded human turns from accidentally joining two different tasks. */
export function collectProgressUpdates(
  entries: TranscriptEntry[],
  index: TranscriptIndexEntry[] = [],
  noteTimes: number[] = [],
): Map<string, ProgressGroup | null> {
  const projection = new Map<string, ProgressGroup | null>();
  const updates = new Map<string, ProgressUpdate>();
  for (const entry of entries) {
    const update = parseProgressUpdate(entry);
    if (update) updates.set(entry.id, update);
  }
  // Most transcripts have no opt-in statuses. Do not walk their full outline.
  if (!updates.size) return projection;
  const active = new Map<string, ProgressGroup>();
  const boundaries = index.filter(
    (row) => row.role === "user" || row.role === "review_handoff",
  );
  let boundary = 0;
  const notes = [...noteTimes].sort((a, b) => a - b);
  let note = 0;
  // Only a turn's final output owns a status row. An update followed by more
  // work is narration and remains in the work fold, not an invisible anchor.
  const indexedIds = new Set(index.map((row) => row.id));
  const outline = index.map((row) => ({ id: row.id, role: row.role }));
  const order = [
    ...outline,
    ...entries
      .filter((entry) => !indexedIds.has(entry.id))
      .map((entry) => ({
        id: entry.id,
        role: agentMessageText(entry) !== null ? "agent_message" : entry.type,
      })),
  ];
  const finals = new Set<string>();
  let nextRole: string | undefined;
  for (let i = order.length - 1; i >= 0; i--) {
    const row = order[i]!;
    if (row.role === "tool_result" || row.role === "hidden") continue;
    if (
      row.role === "assistant" &&
      nextRole !== "assistant" &&
      nextRole !== "tool_use" &&
      nextRole !== "agent_message"
    )
      finals.add(row.id);
    nextRole = row.role;
  }
  for (const entry of entries) {
    while (
      boundary < boundaries.length &&
      boundaries[boundary]!.seq <= (entry.seq ?? Infinity)
    ) {
      active.clear();
      boundary++;
    }
    while (note < notes.length && notes[note]! <= Date.parse(entry.timestamp)) {
      active.clear();
      note++;
    }
    const classified = entry.type === "user" ? classifyEntry(entry) : entry;
    if (
      classified.type === "user" &&
      !classified.turnBoundary &&
      (!classified.notice || classified.notice.kind === "review-handoff")
    )
      active.clear();
    const update = finals.has(entry.id) ? updates.get(entry.id) : null;
    if (!update) continue;
    const key = update.topic.toLowerCase();
    const existing = active.get(key);
    if (existing) {
      existing.latest = update;
      existing.entries.push(entry);
      projection.set(entry.id, null);
    } else {
      const group = { latest: update, entries: [entry] };
      active.set(key, group);
      projection.set(entry.id, group);
    }
  }
  return projection;
}
