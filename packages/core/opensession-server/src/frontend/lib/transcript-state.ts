import type { TranscriptEntry } from "./types";
import { classifyEntry } from "@tellahq/opensession-protocol/notices";
import { personKey } from "./review-queue";

// Entry objects are replaced (never mutated) on change, so the parsed
// timestamp can be memoized per object. Date.parse in a sort comparator was
// the hottest transcript path on big sessions: every live frame without a seq
// re-sorted the whole transcript, re-parsing each timestamp per comparison.
const parsedTimes = new WeakMap<TranscriptEntry, number>();
function time(entry: TranscriptEntry): number {
  const cached = parsedTimes.get(entry);
  if (cached !== undefined) return cached;
  const parsed = Date.parse(entry.timestamp);
  const value = Number.isFinite(parsed) ? parsed : 0;
  parsedTimes.set(entry, value);
  return value;
}

/** Authoritative transcript ordering: v2 rows use immutable seq; legacy and
 * synthetic decorations fall back to timestamp while preserving stable ties. */
export function orderTranscriptEntries(
  entries: TranscriptEntry[],
): TranscriptEntry[] {
  const sequenced: TranscriptEntry[] = [];
  const decorations: { entry: TranscriptEntry; index: number }[] = [];
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!;
    if (entry.seq !== undefined) sequenced.push(entry);
    else decorations.push({ entry, index });
  }
  if (!sequenced.length) {
    return decorations
      .sort((a, b) => time(a.entry) - time(b.entry) || a.index - b.index)
      .map(({ entry }) => entry);
  }
  sequenced.sort((a, b) => a.seq! - b.seq!);
  if (!decorations.length) return sequenced;
  // Synthetic decorations have no seq. Insert them by timestamp around the
  // immutable seq spine without ever allowing timestamps to reorder v2 rows:
  // each decoration lands after every sequenced row whose time is <= its own
  // (and after earlier decorations at the same time), in one merge pass.
  decorations.sort(
    (a, b) => time(a.entry) - time(b.entry) || a.index - b.index,
  );
  const result: TranscriptEntry[] = [];
  let next = 0;
  for (const { entry } of decorations) {
    const at = time(entry);
    while (next < sequenced.length && time(sequenced[next]!) <= at)
      result.push(sequenced[next++]!);
    result.push(entry);
  }
  while (next < sequenced.length) result.push(sequenced[next++]!);
  return result;
}

/** A just-sent row carries the durable position that was visible at send time.
 * The anchor is UI-only and disappears when the durable user row replaces it. */
export type OptimisticTranscriptEntry = TranscriptEntry & {
  optimisticAfterEntryId?: string | null;
  optimisticAfterSeq?: number;
};

/**
 * Insert optimistic user rows into an already-authoritative transcript without
 * comparing clocks. The current tail id is the primary causal anchor; seq is a
 * fallback when that payload was paged out or replaced during reconciliation.
 *
 * The common path is linear in the loaded transcript plus pending rows. If an
 * anchor payload was paged out, a lazily-built seq index adds O(log n) per
 * pending row. The old timestamp sort was O(n log n) and could put assistant
 * output above its prompt whenever the browser clock ran ahead of the server or
 * a frame landed late.
 */
export function mergeOptimisticTranscriptEntries(
  entries: TranscriptEntry[],
  optimistic: OptimisticTranscriptEntry[],
): TranscriptEntry[] {
  if (optimistic.length === 0) return entries;
  const positions = new Map(entries.map((entry, index) => [entry.id, index]));
  const buckets = new Map<number, OptimisticTranscriptEntry[]>();
  let seqPositions: Array<{ seq: number; position: number }> | undefined;

  for (const entry of optimistic) {
    let index: number | undefined;
    const anchorId = entry.optimisticAfterEntryId;
    if (anchorId === null) {
      index = 0;
    } else if (anchorId !== undefined) {
      const exact = positions.get(anchorId);
      const optimisticAlias = positions.get(`outbox-${anchorId}`);
      const position = exact ?? optimisticAlias;
      if (position !== undefined) index = position + 1;
    }
    if (index === undefined && entry.optimisticAfterSeq !== undefined) {
      seqPositions ??= entries.flatMap((candidate, position) =>
        candidate.seq === undefined ? [] : [{ seq: candidate.seq, position }],
      );
      let low = 0;
      let high = seqPositions.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (seqPositions[middle]!.seq <= entry.optimisticAfterSeq)
          low = middle + 1;
        else high = middle;
      }
      index = low === 0 ? 0 : seqPositions[low - 1]!.position + 1;
    }
    index ??= entries.length;
    const bucket = buckets.get(index);
    if (bucket) bucket.push(entry);
    else buckets.set(index, [entry]);
  }

  const merged: TranscriptEntry[] = [];
  for (let index = 0; index <= entries.length; index++) {
    const pending = buckets.get(index);
    if (pending) merged.push(...pending);
    if (index < entries.length) merged.push(entries[index]!);
  }
  return merged;
}

/** Last-write-wins by id, but never let a delayed frame overwrite a newer
 * changeSeq. V2 output is always in seq order; legacy keeps arrival order. */
export function mergeTranscriptEntries(
  previous: TranscriptEntry[],
  incoming: TranscriptEntry[],
  v2 = false,
): TranscriptEntry[] {
  if (!incoming.length) return previous;
  const indexById = new Map(previous.map((entry, index) => [entry.id, index]));
  const next = [...previous];
  for (const entry of incoming) {
    const index = indexById.get(entry.id);
    if (index === undefined) {
      indexById.set(entry.id, next.length);
      next.push(entry);
      continue;
    }
    const current = next[index];
    if (
      current.changeSeq !== undefined &&
      entry.changeSeq !== undefined &&
      entry.changeSeq < current.changeSeq
    ) {
      continue;
    }
    next[index] = entry;
  }
  return v2 ? orderTranscriptEntries(next) : next;
}

const normalizedLegacyVoiceEntries = new WeakMap<
  TranscriptEntry,
  TranscriptEntry
>();

/** Voice actions written before linked tool entries were introduced stored the
 * input in `content` and omitted toolUseId on both rows. Normalize that durable
 * legacy shape so the shared transcript renderer can pair and disclose it. */
export function normalizeLegacyVoiceToolEntries(
  entries: TranscriptEntry[],
): TranscriptEntry[] {
  return entries.map((entry) => {
    const cached = normalizedLegacyVoiceEntries.get(entry);
    if (cached) return cached;
    if (entry.type === "tool_use" && entry.id.startsWith("voice-tu-")) {
      let toolInput = entry.toolInput;
      if (toolInput === undefined) {
        try {
          toolInput = JSON.parse(entry.content);
        } catch {
          toolInput = entry.content;
        }
      }
      if (entry.toolUseId && entry.toolInput !== undefined) return entry;
      const normalized = {
        ...entry,
        toolUseId: entry.toolUseId ?? entry.id,
        toolInput,
      };
      normalizedLegacyVoiceEntries.set(entry, normalized);
      return normalized;
    }
    if (entry.type === "tool_result" && entry.id.startsWith("voice-tr-")) {
      if (entry.toolUseId) return entry;
      const normalized = {
        ...entry,
        toolUseId: `voice-tu-${entry.id.slice("voice-tr-".length)}`,
      };
      normalizedLegacyVoiceEntries.set(entry, normalized);
      return normalized;
    }
    return entry;
  });
}

/**
 * Read an in-flight message (a queue receipt / steer, which has never been
 * near the server) the way the transcript entry it is about to become will be
 * read: sentinels and "[Name] " prefixes stripped, sender and notice resolved.
 *
 * Same classifier as the durable path, so a message in the queue and the same
 * message a second later in the transcript can't disagree about what it is.
 */
export function classifyQueuedContent(
  content?: string,
  user?: string,
): TranscriptEntry {
  const attributed = user ? `[${user}] ${content ?? ""}` : (content ?? "");
  return classifyEntry({
    id: "",
    type: "user",
    content: attributed,
    timestamp: "",
  });
}

export type InFlightContentSummary = {
  messages: number;
  reviews: number;
  workerReports: number;
  sessionMessages: number;
};

/** Group in-flight rows by what the person sees, independently of whether the
 * transport currently owns them as queued or steered receipts. Agent traffic
 * must stay agent traffic while it waits instead of becoming a human steer. */
export function summarizeInFlightContent(
  entries: TranscriptEntry[],
): InFlightContentSummary {
  const summary: InFlightContentSummary = {
    messages: 0,
    reviews: 0,
    workerReports: 0,
    sessionMessages: 0,
  };
  for (const entry of entries) {
    switch (entry.notice?.kind) {
      case "review-handoff":
        summary.reviews++;
        break;
      case "worker-report":
        summary.workerReports++;
        break;
      case "session-notice":
        summary.sessionMessages++;
        break;
      default:
        summary.messages++;
    }
  }
  return summary;
}

/** Model-routing messages can briefly arrive from an older server during a
 * rolling deploy. They drive turns but never belong in the composer queue. */
export function isClientVisibleQueuedContent(
  content?: string,
  user?: string,
): boolean {
  return (
    user !== "auto-continue" &&
    classifyQueuedContent(content, user).notice?.kind !== "workflow"
  );
}

/**
 * Who to credit on a queue chip: a teammate who sent into this session, or a
 * notice's label when that label isn't the whole body.
 *
 * Never the viewer's own name. Every queue item carries a `user` (delivery
 * attribution and edit permission), so without this the person who typed the
 * message reads their own name back on it. The transcript bubble suppresses
 * it the same way.
 */
export function queueAttribution(
  classified: TranscriptEntry,
  currentUser: string,
): string | null {
  const label =
    classified.sender ??
    (classified.notice?.body ? classified.notice.title : null);
  if (!label) return null;
  return personKey(label) === personKey(currentUser) ? null : label;
}
