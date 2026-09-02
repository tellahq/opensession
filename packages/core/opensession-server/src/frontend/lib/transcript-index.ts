import type {
  TranscriptIndexEntry,
  TranscriptIndexRole,
} from "@tellahq/opensession-protocol/session";

export interface TranscriptIndexedRange {
  key: string;
  firstSeq: number;
  lastSeq: number;
  entryIds: string[];
  estimateSize: number;
  startTimestampMs: number;
  endTimestampMs: number;
  headRole: TranscriptIndexRole | null;
  reviewPrNumber: number | null;
  reviewRounds: number;
}

interface RangeAccumulator extends TranscriptIndexedRange {
  assistantCount: number;
  assistantChars: number;
  toolUseCount: number;
  lastTurnRole: "assistant" | "tool_use" | null;
  lastAssistantChars: number;
  boundaryEstimate: number;
}

const isBoundary = (role: TranscriptIndexRole) =>
  role === "user" ||
  role === "notice" ||
  role === "review_handoff" ||
  role === "system";

/** Project a complete content-free outline into stable conversation ranges. */
export function buildTranscriptRanges(
  entries: TranscriptIndexEntry[],
): TranscriptIndexedRange[] {
  const ranges: RangeAccumulator[] = [];
  let current: RangeAccumulator | null = null;
  const finish = () => {
    if (!current) return;
    current.estimateSize = rangeEstimate(current);
    ranges.push(current);
    current = null;
  };

  for (const entry of entries) {
    if (entry.role === "hidden") {
      if (current) current.lastSeq = entry.seq;
      continue;
    }
    if (!current || isBoundary(entry.role)) {
      finish();
      current = {
        key: `range:${entry.id}`,
        firstSeq: entry.seq,
        lastSeq: entry.seq,
        entryIds: [],
        estimateSize: 96,
        startTimestampMs: entry.timestampMs,
        endTimestampMs: entry.timestampMs,
        headRole: isBoundary(entry.role) ? entry.role : null,
        reviewPrNumber: entry.reviewPrNumber ?? null,
        reviewRounds: entry.role === "review_handoff" ? 1 : 0,
        assistantCount: 0,
        assistantChars: 0,
        toolUseCount: 0,
        lastTurnRole: null,
        lastAssistantChars: 0,
        boundaryEstimate: boundaryEstimate(entry),
      };
    }
    current.lastSeq = entry.seq;
    current.endTimestampMs = entry.timestampMs;
    current.entryIds.push(entry.id);
    if (entry.role === "assistant") {
      current.assistantCount++;
      current.assistantChars += entry.contentLength;
      current.lastAssistantChars = entry.contentLength;
      current.lastTurnRole = "assistant";
    } else if (entry.role === "tool_use") {
      current.toolUseCount++;
      current.lastTurnRole = "tool_use";
    }
  }
  finish();
  return ranges;
}

function boundaryEstimate(entry: TranscriptIndexEntry): number {
  if (entry.role === "user") return messageEstimate(entry.contentLength, 88);
  if (entry.role === "review_handoff") return 40;
  if (entry.role === "notice" || entry.role === "system") return 48;
  return 0;
}

function rangeEstimate(range: RangeAccumulator): number {
  if (range.toolUseCount > 0) {
    const final =
      range.lastTurnRole === "assistant"
        ? messageEstimate(range.lastAssistantChars, 96) + 32
        : 0;
    return Math.max(40, range.boundaryEstimate + 40 + final);
  }
  return Math.max(
    48,
    range.boundaryEstimate +
      (range.assistantCount
        ? messageEstimate(range.assistantChars, 96 * range.assistantCount)
        : 0),
  );
}

function messageEstimate(chars: number, floor: number): number {
  return Math.min(720, Math.max(floor, 56 + Math.ceil(chars / 110) * 20));
}

/** Merge a newly committed durable frame into an existing complete outline. */
export function mergeTranscriptIndexEntries(
  current: TranscriptIndexEntry[],
  incoming: TranscriptIndexEntry[],
): TranscriptIndexEntry[] {
  if (!incoming.length) return current;
  const bySeq = new Map(current.map((entry) => [entry.seq, entry]));
  let changed = false;
  for (const entry of incoming) {
    const previous = bySeq.get(entry.seq);
    if (!previous || entry.changeSeq > previous.changeSeq) {
      bySeq.set(entry.seq, entry);
      changed = true;
    }
  }
  return changed ? [...bySeq.values()].sort((a, b) => a.seq - b.seq) : current;
}

/** Structural index row carried implicitly by a durable append payload. */
export function transcriptIndexEntryFromPayload(entry: {
  id: string;
  type: "user" | "assistant" | "tool_use" | "tool_result" | "system";
  content: string;
  timestamp: string;
  seq?: number;
  changeSeq?: number;
  contentLength?: number;
  notice?: { kind?: string; title?: string };
}): TranscriptIndexEntry | null {
  if (entry.seq === undefined || entry.changeSeq === undefined) return null;
  let role: TranscriptIndexRole;
  let reviewPrNumber: number | undefined;
  if (entry.notice?.kind === "review-handoff") {
    role = "review_handoff";
    const match = entry.notice.title?.match(/PR #(\d+)/);
    if (match) reviewPrNumber = Number(match[1]);
  } else if (entry.notice) {
    role = "notice";
  } else if (entry.type === "user") {
    role = "user";
  } else if (entry.type === "assistant") {
    role = "assistant";
  } else if (entry.type === "tool_use") {
    role = "tool_use";
  } else if (entry.type === "tool_result") {
    role = "tool_result";
  } else {
    role = "system";
  }
  const indexedEntry: TranscriptIndexEntry = {
    id: entry.id,
    seq: entry.seq,
    changeSeq: entry.changeSeq,
    timestampMs: Date.parse(entry.timestamp) || 0,
    role,
    contentLength: entry.contentLength ?? entry.content.length,
  };
  if (reviewPrNumber !== undefined) {
    indexedEntry.reviewPrNumber = reviewPrNumber;
  }
  return indexedEntry;
}
