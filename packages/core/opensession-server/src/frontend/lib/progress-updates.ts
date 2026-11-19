import type {
  TranscriptEntry,
  TranscriptIndexEntry,
} from "@tellahq/opensession-protocol/session";
import {
  automatedTriggerTitle,
  classifyEntry,
} from "@tellahq/opensession-protocol/notices";
import { agentMessageText } from "./agent-message";
import { formatDuration } from "./time";

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

/** A reply that opens with a status line and goes on in prose ("◷ **Native
 * build**: Running", a blank line, then why): the status, and the prose after
 * it. The status then names the work row above the reply instead of standing
 * as a bold line of its own. */
export function splitLeadStatus(
  entry: TranscriptEntry,
): { update: ProgressUpdate; rest: string } | null {
  if (entry.type !== "assistant" || entry.isReasoning || entry.isError)
    return null;
  const match = /^([^\r\n]+)\r?\n\s*\n([\s\S]*\S[\s\S]*)$/.exec(
    entry.content.trimStart(),
  );
  if (!match) return null;
  const update = parseProgressUpdate({
    ...entry,
    content: match[1]!,
    contentLength: undefined,
    contentClamped: undefined,
    pastedTexts: undefined,
    images: undefined,
    videos: undefined,
    files: undefined,
  });
  return update ? { update, rest: match[2]!.trim() } : null;
}

/** One row per task: every update between two human messages or team notes
 * joins it, whatever its topic, so "CI: Running" then "Deployment: Running"
 * reads as one row that moved on rather than a stale row and a new one. The
 * latest loaded update owns the row, so it sits with the newest work; earlier
 * ones become its history. The full outline keeps unloaded human turns from
 * accidentally joining two different tasks. */
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
  const groups: ProgressGroup[] = [];
  let active: ProgressGroup | null = null;
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
      active = null;
      boundary++;
    }
    while (note < notes.length && notes[note]! <= Date.parse(entry.timestamp)) {
      active = null;
      note++;
    }
    const classified = entry.type === "user" ? classifyEntry(entry) : entry;
    if (
      classified.type === "user" &&
      !classified.turnBoundary &&
      (!classified.notice || classified.notice.kind === "review-handoff")
    )
      active = null;
    // An automated event (a GitHub notice, a worker's report) is a task of
    // its own, so its status starts a fresh row.
    else if (automatedTriggerTitle(entry)) active = null;
    const update = finals.has(entry.id) ? updates.get(entry.id) : null;
    if (!update) continue;
    if (active) {
      active.latest = update;
      active.entries.push(entry);
    } else {
      active = { latest: update, entries: [entry] };
      groups.push(active);
    }
  }
  for (const group of groups) {
    const owner = group.entries.at(-1)!;
    for (const entry of group.entries)
      projection.set(entry.id, entry === owner ? group : null);
  }
  return projection;
}

/** What a status line inside a work fold says. `topic` picks its glyph. */
export interface FoldStatus {
  topic: string;
  text: string;
  done: boolean;
}

const BARE_RUNNING =
  /^(running|in progress|pending|queued|started|starting|waiting|building|deploying|underway)(\.{0,3}|…)$/i;
const BARE_DONE =
  /^(done|passed|green|complete|completed|finished|succeeded|success|successful|ok|(all )?(checks|tests) (passed|green))\.?$/i;
const CHECK_TOPIC = /\b(ci|checks?|tests?|builds?|lint|typecheck|e2e)\b/i;

/** CI, checks, tests and builds: a status a check run's own glyph fits. */
export function isCheckTopic(topic: string): boolean {
  return CHECK_TOPIC.test(topic);
}

/** "Deployment" reads as a noun mid-sentence; "CI" and "PR #12" keep case. */
function topicNoun(topic: string): string {
  return /^[A-Z][a-z]/.test(topic)
    ? topic[0]!.toLowerCase() + topic.slice(1)
    : topic;
}

function outcome(update: ProgressUpdate): string {
  if (!BARE_DONE.test(update.text)) return `${update.topic}: ${update.text}`;
  return `${update.topic} ${CHECK_TOPIC.test(update.topic) ? "passed" : "done"}`;
}

/**
 * A fold reads after the fact, so "CI: Running" from ten minutes ago says the
 * wrong thing. Each wait becomes one step at the point it started: "CI passed
 * · 4m" once a later `✓` with the same topic says how it went, "Waited for CI
 * · 4m" when nothing did, "Waiting for CI" while the fold is live and no
 * later status has moved on from it. Later
 * updates of that topic fold into it (null). Agent wording beyond a bare
 * state word is kept. `updates` has one slot per fold step; `startedAt`
 * reads a step's start time and is only called around a status.
 */
export function foldStatuses(
  updates: ReadonlyArray<ProgressUpdate | null>,
  startedAt: (index: number) => number,
  live: boolean,
): Array<FoldStatus | null | undefined> {
  const out: Array<FoldStatus | null | undefined> = new Array(updates.length);
  for (let i = 0; i < updates.length; i++) {
    const first = updates[i];
    if (!first || out[i] === null) continue;
    const key = first.topic.toLowerCase();
    let last = i;
    let close = first.state === "done" ? i : -1;
    for (let j = i + 1; close < 0 && j < updates.length; j++) {
      const update = updates[j];
      if (!update || update.topic.toLowerCase() !== key) continue;
      out[j] = null;
      last = j;
      if (update.state === "done") close = j;
    }
    const took = (end: number) => {
      const label = formatDuration(startedAt(end) - startedAt(i));
      return label ? ` · ${label}` : "";
    };
    if (close >= 0) {
      out[i] = {
        topic: first.topic,
        text: outcome(updates[close]!) + (close > i ? took(close) : ""),
        done: true,
      };
      continue;
    }
    const latest = updates[last]!;
    const bare = BARE_RUNNING.test(latest.text);
    if (live && !updates.slice(last + 1).some(Boolean)) {
      out[i] = {
        topic: first.topic,
        text: bare
          ? `Waiting for ${topicNoun(first.topic)}`
          : `${latest.topic}: ${latest.text}`,
        done: false,
      };
      continue;
    }
    out[i] = {
      topic: first.topic,
      text:
        (bare
          ? `Waited for ${topicNoun(first.topic)}`
          : `${latest.topic}: ${latest.text}`) +
        (last < updates.length - 1 ? took(last + 1) : ""),
      done: false,
    };
  }
  return out;
}
