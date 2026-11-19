import React, { useEffect, useEffectEvent, useRef } from "react";
import type { CommentThread, TranscriptEntry } from "../lib/types";
import type { TranscriptIndexEntry } from "@tellahq/opensession-protocol/session";
import {
  buildTranscriptRanges,
  type TranscriptIndexedRange,
} from "../lib/transcript-index";
import {
  transcriptArrivalAliases,
  transcriptEntryMountKey,
  turnMountKey,
  turnScrollAnchor,
} from "../lib/transcript-block-identity";
import { MessageBubble } from "./MessageBubble";
import { formatDuration } from "../lib/time";
import { ProgressStatusLine, ProgressStatusRow } from "./ProgressStatusRow";
import {
  collectProgressUpdates,
  foldStatuses,
  parseProgressUpdate,
  splitLeadStatus,
  type FoldStatus,
  type ProgressGroup,
  type ProgressUpdate,
} from "../lib/progress-updates";
import { agentMessageText } from "../lib/agent-message";
import { NoteBubble } from "./NoteBubble";
import { ToolSection, TurnBlock, useTurnActivityPrefs } from "./TurnBlock";
import {
  turnTouchedFiles,
  TurnFooter,
  TURN_FOOTER_LIFT,
  type TouchedFile,
} from "./TurnFooter";
import {
  VirtualTranscriptList,
  type VirtualTranscriptItem,
} from "./VirtualTranscriptList";
import {
  mergeOptimisticTranscriptEntries,
  normalizeLegacyVoiceToolEntries,
  orderTranscriptEntries,
  type OptimisticTranscriptEntry,
} from "../lib/transcript-state";
import { collectWrittenAssets } from "../lib/open-asset";
import {
  automatedTriggerDetail,
  automatedTriggerTitle,
  classifyEntry,
} from "@tellahq/opensession-protocol/notices";
import {
  CheckBackBlock,
  ReviewLoopBlock,
  WorkFoldBlock,
} from "./ReviewLoopBlock";
import type { ReviewLoopResult } from "../lib/review-loop";
import type { ReviewSettledOutcome } from "@tellahq/opensession-protocol/notices";
import {
  ShippedChangeComposer,
  type ShippedChangeComposerProps,
} from "./ShippedChangeComposer";
import { SessionContextSlot } from "./SessionContextSlot";
import {
  transcriptRangesContainPayload,
  visibleTranscriptHydrationDemand,
} from "./session-viewer/transcript-hydration";
import { isLegacyReasoningHeading } from "../lib/reasoning-display";
import {
  arrangeThinkingMessages,
  getThinkingMessagesPref,
  onThinkingMessagesChanged,
  type ThinkingMessagesPref,
} from "../lib/thinking-messages-pref";

type RenderBlock =
  | {
      kind: "entry";
      entry: TranscriptEntry;
      reasoning?: boolean;
      /** On a status row: the check-back work it reports on, folded under it
       *  instead of drawn as its own "Checked back" row. */
      checkBack?: LoopBlock;
    }
  | {
      kind: "turn";
      items: TranscriptEntry[];
      expandWhileRunning: boolean;
      /** The status line the reply below opened with (liftLeadStatuses). */
      status?: ProgressUpdate;
    }
  | {
      kind: "footer";
      entry: TranscriptEntry;
      /** Null when a "Worked for …" fold above the answer already says it. */
      durationMs: number | null;
      files: TouchedFile[];
      assets: string[];
    }
  | { kind: "note"; note: CommentThread }
  | {
      kind: "review-loop";
      /** A review loop, turns the agent's own waits and scheduled
       *  check-backs started with no person in between, or a whole task that
       *  reported with status lines and then answered (`foldReportedTasks`). */
      variant: "review" | "check-back" | "work";
      /** On a work fold: from the task's first work to its answer. */
      durationMs?: number;
      /** On a work fold an automated event started (its first block): the
       *  event's one-line name, which the row reads instead of "Worked". */
      trigger?: string;
      blocks: RenderBlock[];
      prNumber: number | null;
      /** Review rounds, or check-back turns. */
      rounds: number;
      /** Present once the loop's settle notice has landed inside it. */
      settled: ReviewSettledOutcome | null;
    };

type LoopBlock = Extract<RenderBlock, { kind: "review-loop" }>;

interface Props {
  entries: TranscriptEntry[];
  /** Shared across indexed range renderers so status updates reuse one row. */
  progressUpdates?: ReadonlyMap<string, ProgressGroup | null>;
  /** Just-sent user turns that have not landed durably yet. They participate in
   *  transcript ordering so live tools can never render above their prompt. */
  optimisticEntries?: OptimisticTranscriptEntry[];
  /** Transcript ids accepted as sent but not yet read by the engine. */
  pendingDeliveryIds?: string[];
  /** Whether the conversation is live (last work block shows a spinner / stays open). */
  live?: boolean;
  /** Assistant messages show a "Duplicate from here" action when provided. */
  onFork?: (entryId: string) => void;
  /** Your own sent messages can be reopened in the composer when provided. */
  onEditMessage?: (entry: TranscriptEntry) => void;
  /** Starts a turn that picks the work back up after a run failed. Offered on
   *  the last block only: an older failure has already been moved past, and a
   *  Continue button on it would restart work the session went on to do. */
  onContinue?: () => void;
  /** Called when a Task/Agent block's "Open sub-agent" affordance is clicked. */
  onOpenSubagent?: (agentId: string, label: string) => void;
  /** Session owner (startedBy) — credited on un-attributed user turns. */
  owner?: string;
  /** Lets wire-clamped entries' "Show full message" fetch the full content. */
  sessionId?: string;
  /** Older transcript rows are currently being fetched. */
  historyLoading?: boolean;
  /** Session-level comment threads (team notes; src/server/comment-threads.ts)
   *  interleaved into the timeline by timestamp. Agent-invisible; rendered as
   *  NoteBubbles. */
  notes?: CommentThread[];
  slackShare?: ShippedChangeComposerProps & {
    prNumber: number;
  };
  /** The current PR verdict, rendered on the final review loop's own row. */
  reviewResult?: ReviewLoopResult;
  /** Opens every review and check-back fold, whatever the Steps preference. */
  reviewLoopsOpen?: boolean;
  onReviewLoopOpenChange?: (open: boolean) => void;
  /** Complete content-free outline. When present, ranges hydrate on demand. */
  transcriptIndex?: TranscriptIndexEntry[];
  /** Changes to re-arm top-range demand after index setup or a dropped response. */
  transcriptRangeRetryGeneration?: number;
  onLoadTranscriptRanges?: (ranges: TranscriptIndexedRange[]) => void;
  /** Fired once the opening viewport renders from real payload. */
  onVisibleRangesSettled?: () => void;
  /** Explicit scroll root for transcript surfaces outside SessionViewer. */
  scrollElement?: HTMLDivElement | null;
  /** Whether measurement may maintain the live edge in this frame. */
  shouldMaintainEnd?: () => boolean;
  /** Reaffirm live-edge following after virtual measurements commit. */
  onLayout?: () => void;
  /** Indexed range rows reuse this renderer without nesting a virtualizer. */
  virtualize?: boolean;
  /** Stable outer range identity for the one work turn rendered inside it. */
  turnMountScope?: string;
  /** Which thinking rows each work rail shows; see arrangeThinkingMessages. */
  thinkingMessages?: ThinkingMessagesPref;
  /** Tool results from the whole loaded transcript. An indexed range row only
   *  holds its own entries, and a message sent while a tool ran opens a new
   *  range, so the call and its result can sit in different rows. */
  sharedToolResults?: ReadonlyMap<string, TranscriptEntry>;
}

type ReviewBlockRole =
  | { kind: "handoff"; prNumber: number | null }
  | { kind: "check-back" }
  | { kind: "settled"; outcome: ReviewSettledOutcome }
  | { kind: "user-message" }
  | { kind: "other" };

/** The same classification that chooses MessageBubble's presentation also
 * decides whether a row starts or ends a review phase. Several operational
 * notices have a legacy `type: "user"` wire shape, so the raw type alone
 * cannot distinguish a person's request from status plumbing. */
function reviewBlockRole(block: RenderBlock): ReviewBlockRole {
  if (block.kind !== "entry") return { kind: "other" };
  // A background wait's content-free boundary, or a scheduled check-back:
  // the agent started this turn itself. A nudge to continue only ends the
  // turn above it: what follows is ordinary work with its own answer.
  if (block.entry.turnBoundary)
    return { kind: isNudgeBoundary(block) ? "other" : "check-back" };
  const entry = classifyEntry(block.entry);
  if (entry.notice?.kind === "scheduled-prompt") return { kind: "check-back" };
  if (entry.notice?.kind === "review-handoff") {
    const match = entry.notice.title.match(/PR #(\d+)/);
    return { kind: "handoff", prNumber: match ? Number(match[1]) : null };
  }
  if (entry.notice?.kind === "review-settled") {
    // The protocol tags a passed loop as a neutral done notice and a capped
    // one as a warning; the tone is the outcome's only wire form.
    return {
      kind: "settled",
      outcome: entry.notice.tone === "warn" ? "capped" : "passed",
    };
  }
  return entry.type === "user" && !entry.notice
    ? { kind: "user-message" }
    : { kind: "other" };
}

/** Whether the loop open at `from` goes on: its next round's findings or its
 * closing settle notice arrive before any human message or note. */
function reviewLoopContinues(blocks: RenderBlock[], from: number): boolean {
  for (let j = from; j < blocks.length; j++) {
    const block = blocks[j];
    if (block.kind === "note") return false;
    const role = reviewBlockRole(block);
    if (role.kind === "user-message") return false;
    if (role.kind === "handoff" || role.kind === "settled") return true;
  }
  return false;
}

/** A review handoff and the work it triggers form one quiet phase. Human
 * requests and the loop's final model output stay outside; each round's own
 * report folds in once a later round or the settle notice proves it interim,
 * and intermediate narration already belongs to the grouped turn work. */
function groupReviewLoops(blocks: RenderBlock[]): RenderBlock[] {
  const grouped: RenderBlock[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const first = blocks[i];
    const firstRole = reviewBlockRole(first);
    if (firstRole.kind !== "handoff") {
      grouped.push(first);
      continue;
    }
    const loop: RenderBlock[] = [first];
    let rounds = 1;
    let prNumber = firstRole.prNumber;
    let settled: ReviewSettledOutcome | null = null;
    while (i + 1 < blocks.length) {
      const next = blocks[i + 1];
      const nextRole = reviewBlockRole(next);
      // Notes have their own placement and must never vanish inside an
      // automation disclosure.
      if (next.kind === "note") break;
      // A normal user message is a new conversation phase. A second review
      // handoff belongs to this loop and starts its next round.
      if (nextRole.kind === "user-message") break;
      // A turn's final answer stays outside the fold as the loop's report,
      // unless the loop goes on past it: the next round's findings or the
      // settle notice make that answer an interim report. A settled loop is
      // closed, so its wrap-up always stays outside.
      if (
        next.kind === "entry" &&
        next.entry.type === "assistant" &&
        (settled || !reviewLoopContinues(blocks, i + 2))
      )
        break;
      i++;
      loop.push(next);
      if (nextRole.kind === "handoff") {
        rounds++;
        prNumber ??= nextRole.prNumber;
      } else if (nextRole.kind === "settled") {
        settled = nextRole.outcome;
      }
    }
    grouped.push({
      kind: "review-loop",
      variant: "review",
      blocks: loop,
      prNumber,
      rounds,
      settled,
    });
  }
  return grouped;
}

/** The server told the agent to continue after a turn that had ended. The
 * boundary is structural only: it keeps that turn's answer out of the work
 * below it and never renders. */
function isNudgeBoundary(block: RenderBlock): boolean {
  return (
    block.kind === "entry" &&
    Boolean(block.entry.turnBoundary) &&
    block.entry.turnBoundaryKind === "nudge"
  );
}

/** Whether the check-backs open at `from` go on: another one starts before
 * any human message, review loop or note. */
function checkBacksContinue(blocks: RenderBlock[], from: number): boolean {
  for (let j = from; j < blocks.length; j++) {
    const block = blocks[j]!;
    if (block.kind === "note" || block.kind === "review-loop") return false;
    const role = reviewBlockRole(block).kind;
    if (role === "user-message") return false;
    if (role === "check-back") return true;
  }
  return false;
}

/** Turns the agent started itself (a background wait waking it, or its own
 * scheduled check-back) fold into one quiet row, like a review loop: waiting
 * on CI often means several "still running" turns in a row. The last turn's
 * final answer stays outside as the report; earlier answers fold in once a
 * later check-back proves them interim. Runs after review grouping, so a
 * check-back inside a review loop stays there. */
function groupCheckBacks(
  blocks: RenderBlock[],
  progressUpdates: ReadonlyMap<string, ProgressGroup | null>,
): RenderBlock[] {
  const grouped: RenderBlock[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const first = blocks[i]!;
    if (reviewBlockRole(first).kind !== "check-back") {
      // Outside a fold a nudge boundary has done its work by splitting the
      // turn; inside one, the fold skips it like any other boundary.
      if (!isNudgeBoundary(first)) grouped.push(first);
      continue;
    }
    const loop: RenderBlock[] = [first];
    let rounds = 1;
    while (i + 1 < blocks.length) {
      const next = blocks[i + 1]!;
      if (next.kind === "note" || next.kind === "review-loop") break;
      const role = reviewBlockRole(next).kind;
      if (role === "user-message") break;
      if (
        next.kind === "entry" &&
        next.entry.type === "assistant" &&
        !checkBacksContinue(blocks, i + 2)
      )
        break;
      i++;
      loop.push(next);
      if (role === "check-back") rounds++;
    }
    // A progress-only check-back needs no scheduling notice beside its row.
    // Keep ordinary standalone notices readable when no status follows them.
    if (loop.length === 1) {
      const next = blocks[i + 1];
      const progress =
        next?.kind === "entry" && progressUpdates.has(next.entry.id);
      if (first.kind === "entry" && !first.entry.turnBoundary && !progress)
        grouped.push(first);
      continue;
    }
    grouped.push({
      kind: "review-loop",
      variant: "check-back",
      blocks: loop,
      prNumber: null,
      rounds,
      settled: null,
    });
  }
  return grouped;
}

/** What an automated event said beyond the title its folded row shows:
 *  a failed check as a short link to its run, a report as its text. */
function TriggerDetail({ entry }: { entry: TranscriptEntry }) {
  const lines = automatedTriggerDetail(entry);
  if (lines.length === 0) return null;
  return (
    <div className="mx-auto mb-2 flex w-full max-w-[var(--session-col)] flex-col text-meta leading-5 text-dim">
      {lines.map((line, i) =>
        line.url ? (
          <a
            key={i}
            className="w-fit max-w-full truncate text-dim no-underline hover:text-fg hover:underline"
            href={line.url}
            target="_blank"
            rel="noopener"
          >
            {line.text}
          </a>
        ) : (
          <p key={i} className="whitespace-pre-wrap break-words">
            {line.text}
          </p>
        ),
      )}
    </div>
  );
}

/** A task the agent reported on with status lines, or picked back up on its
 * own (a wait waking it, its scheduled check-back), and then answered reads as
 * one message: "Worked for 7m ›" above its last answer. The statuses,
 * check-backs and earlier answers were interim, and the last answer is the
 * report. Only a settled answer (its footer is down) that nothing self-started
 * follows closes a task, so a running one keeps its live row. Human messages,
 * notes, notices and review loops are never folded in, and check-backs inside
 * a review loop stay with that loop. */
function foldReportedTasks(
  blocks: RenderBlock[],
  progress: ReadonlyMap<string, ProgressGroup | null>,
): RenderBlock[] {
  const folded: RenderBlock[] = [];
  let run: RenderBlock[] = [];
  let inReview = false;
  const isStatus = (block: RenderBlock) =>
    block.kind === "entry" && progress.has(block.entry.id);
  const isCheckBack = (block: RenderBlock) =>
    !inReview && reviewBlockRole(block).kind === "check-back";
  const triggerOf = (block: RenderBlock | undefined) =>
    block?.kind === "entry" ? automatedTriggerTitle(block.entry) : null;
  // A nudge to continue is self-started too, so it never ends the task, but
  // on its own it does not make the answer before it interim.
  const foldable = (block: RenderBlock) =>
    block.kind === "turn" ||
    block.kind === "footer" ||
    isNudgeBoundary(block) ||
    (block.kind === "entry" &&
      (block.entry.type === "assistant" ||
        reviewBlockRole(block).kind === "check-back"));
  // Whether the agent picks the task back up after `from` on its own.
  const pickedBackUp = (from: number) => {
    for (let j = from; j < blocks.length && foldable(blocks[j]!); j++)
      if (isCheckBack(blocks[j]!)) return true;
    return false;
  };
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]!;
    const next = blocks[i + 1];
    const role = reviewBlockRole(block).kind;
    if (role === "handoff") inReview = true;
    else if (role === "settled" || role === "user-message") inReview = false;
    const answer =
      block.kind === "entry" &&
      block.entry.type === "assistant" &&
      !isStatus(block) &&
      next?.kind === "footer" &&
      next.entry.id === block.entry.id;
    // An automated event (a GitHub notice, a worker's report) opens a task
    // of its own: the event, its work and any interim answers fold into one
    // row named by the event, above the answer.
    if (!inReview && triggerOf(block)) {
      folded.push(...run);
      run = [block];
      continue;
    }
    const trigger =
      triggerOf(run[0]) && run.some((inner) => inner.kind === "turn")
        ? triggerOf(run[0])!
        : undefined;
    if (
      answer &&
      (trigger || run.some((inner) => isStatus(inner) || isCheckBack(inner))) &&
      !pickedBackUp(i + 2)
    ) {
      const first = run.flatMap(renderBlockEntries)[0];
      folded.push({
        kind: "review-loop",
        variant: "work",
        trigger,
        blocks: run,
        prNumber: null,
        rounds: 0,
        settled: null,
        durationMs: first
          ? Date.parse(block.entry.timestamp) - Date.parse(first.timestamp)
          : undefined,
      });
      folded.push(block, next);
      run = [];
      i++;
      continue;
    }
    // An automated event handled with nothing left for the person gets a
    // one-line status answer ("✓ **Merge conflicts**: Resolved"). The event
    // and its work then fold under that status row (projectProgressBlocks),
    // so the whole thing is one line.
    if (
      trigger &&
      block.kind === "entry" &&
      progress.get(block.entry.id) &&
      !pickedBackUp(i + 1)
    ) {
      const first = run.flatMap(renderBlockEntries)[0];
      folded.push({
        kind: "review-loop",
        variant: "work",
        trigger,
        // Interim statuses are the row's own history.
        blocks: run.filter((inner) => !isStatus(inner)),
        prNumber: null,
        rounds: 0,
        settled: null,
        durationMs: first
          ? Date.parse(block.entry.timestamp) - Date.parse(first.timestamp)
          : undefined,
      });
      folded.push(block);
      run = [];
      continue;
    }
    if (foldable(block)) {
      run.push(block);
      continue;
    }
    folded.push(...run, block);
    run = [];
  }
  folded.push(...run);
  return folded;
}

/** A reply that opens with a status line ("◷ **Native build**: Running", then
 * prose) hands that line to the work row right above it, "◷ Native build:
 * Running · 35s ›", and keeps only its prose. Without a work row above it the
 * reply is left as written. The footer keeps the original entry, so Copy
 * copies the whole message. */
// Per entry, so a rerender hands TurnBlock and MessageBubble the same status
// and entry objects and their memo comparators can bail.
const leadStatusCache = new WeakMap<
  TranscriptEntry,
  { update: ProgressUpdate; entry: TranscriptEntry } | null
>();

function leadStatusOf(entry: TranscriptEntry) {
  let cached = leadStatusCache.get(entry);
  if (cached === undefined) {
    const split = splitLeadStatus(entry);
    cached = split
      ? { update: split.update, entry: { ...entry, content: split.rest } }
      : null;
    leadStatusCache.set(entry, cached);
  }
  return cached;
}

function liftLeadStatuses(blocks: RenderBlock[]): RenderBlock[] {
  let lifted: RenderBlock[] | null = null;
  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i]!;
    const prev = (lifted ?? blocks)[i - 1]!;
    if (block.kind !== "entry" || block.entry.type !== "assistant") continue;
    if (prev.kind !== "turn" || prev.status) continue;
    const split = leadStatusOf(block.entry);
    if (!split) continue;
    lifted ??= [...blocks];
    lifted[i - 1] = { ...prev, status: split.update };
    lifted[i] = { ...block, entry: split.entry };
  }
  return lifted ?? blocks;
}

/** One status row per task. Status messages leave their folds; the check-back
 * fold that holds or leads straight to the row's latest update folds under
 * that row instead of drawing its own "Checked back" line beside it. Review
 * loops stay intact. */
function projectProgressBlocks(
  blocks: RenderBlock[],
  progress: ReadonlyMap<string, ProgressGroup | null>,
): RenderBlock[] {
  if (!progress.size) return blocks;
  const isProgress = (block: RenderBlock) =>
    block.kind === "entry" && progress.has(block.entry.id);
  const isOwner = (block: RenderBlock) =>
    block.kind === "entry" && Boolean(progress.get(block.entry.id));
  const projected: RenderBlock[] = [];
  let pending: LoopBlock | null = null;
  const flush = () => {
    if (pending) projected.push(pending);
    pending = null;
  };
  for (const [index, block] of blocks.entries()) {
    if (isProgress(block)) {
      if (!isOwner(block) || block.kind !== "entry") continue;
      projected.push(pending ? { ...block, checkBack: pending } : block);
      pending = null;
      continue;
    }
    flush();
    // An automated event's work, answered by a status: that row's work.
    if (
      block.kind === "review-loop" &&
      block.trigger &&
      blocks[index + 1] &&
      isOwner(blocks[index + 1]!)
    ) {
      pending = block;
      continue;
    }
    if (block.kind !== "review-loop" || block.variant === "work") {
      projected.push(block);
      continue;
    }
    const work = block.blocks.filter((inner) => !isProgress(inner));
    // A fold with no status inside is left exactly as it was.
    const hasWork =
      work.length === block.blocks.length ||
      block.variant === "review" ||
      work.some(
        (inner) =>
          inner.kind !== "entry" ||
          (!inner.entry.turnBoundary &&
            reviewBlockRole(inner).kind !== "check-back"),
      );
    const loop: LoopBlock | null = hasWork ? { ...block, blocks: work } : null;
    const owner = block.blocks.find(isOwner);
    if (block.variant === "check-back" && owner?.kind === "entry") {
      projected.push({ ...owner, checkBack: loop ?? undefined });
      continue;
    }
    if (block.variant === "review") {
      if (loop) projected.push(loop);
      if (owner) projected.push(owner);
      continue;
    }
    // A check-back fold right above the row's latest update is that row's work.
    const next = blocks
      .slice(index + 1)
      .find((candidate) => !isProgress(candidate) || isOwner(candidate));
    if (loop && next && isOwner(next)) pending = loop;
    else if (loop) projected.push(loop);
  }
  flush();
  return projected;
}

function mergedNoticePrNumber(entry: TranscriptEntry): number | null {
  if (entry.notice?.kind !== "system") return null;
  // Both merge wordings session-notify.ts has shipped: today's
  // "PR #12 merged by …", and the older "PR #12 “title” was merged into main".
  const match = entry.content.match(/\bPR #(\d+)\b(?:.*\bwas)? merged\b/i);
  return match ? Number(match[1]) : null;
}

/** A blank delivery row renders nothing in MessageBubble, so it cannot be a
 * conversation boundary here. Treating it as one split uninterrupted work
 * into a long stack of meaningless "Worked · 1 step" disclosures. */
function isRenderlessUserEntry(entry: TranscriptEntry): boolean {
  return (
    entry.type === "user" &&
    !entry.notice &&
    !(entry.sender && entry.senderVia) &&
    !entry.content &&
    !entry.images?.length &&
    !entry.videos?.length &&
    !entry.files?.length
  );
}

// How many blocks at the end of the transcript are never windowed. The reader
// lands here on open and stays here while a turn runs, so these keep their real
// content and their real height rather than a measured placeholder.
//
// It counts GROUPED blocks, which is the array actually rendered: a review loop
// swallows the blocks it contains, so measuring the window against the flat
// `blocks` array shrank it by however many rows those loops absorbed. Measured
// on the biggest session in the store (9,689 entries, 3 review loops), the
// trailing window came out as 1 block instead of 24.
const TRAILING_MOUNTED_BLOCKS = 24;

// How much one top approach asks for, as a budget of MISSING ENTRIES rather
// than a count of ranges. Ranges are whole conversation turns and average ~100
// entries each on tool-heavy sessions, so the old 10-ranges-per-tick batch
// fetched on the order of a thousand full payloads every 900ms while the
// reader sat pinned at the top - each batch paying a full merge, regroup and
// prepend for content far beyond the viewport. One server page per tick keeps
// upward travel continuous while each prepend stays cheap; the next approach
// (after the reader climbs through it) asks for more.
const TOP_APPROACH_ENTRY_BUDGET = 200;

function renderBlockEntries(block: RenderBlock): TranscriptEntry[] {
  if (block.kind === "turn") return block.items;
  if (block.kind === "entry" && block.checkBack)
    return [...renderBlockEntries(block.checkBack), block.entry];
  if (block.kind === "entry" || block.kind === "footer") return [block.entry];
  if (block.kind === "review-loop")
    return block.blocks.flatMap(renderBlockEntries);
  return [];
}

function renderBlockKey(
  block: RenderBlock,
  index: number,
  turnMountScope?: string,
): string {
  if (block.kind === "turn") return turnMountKey(block.items, turnMountScope);
  if (block.kind === "note") return `note:${block.note.id}`;
  if (block.kind === "footer") return `${block.entry.id}:footer`;
  // A status row that took in a fold keeps the fold's key, so the row turns
  // into the status in place instead of remounting.
  if (block.kind === "entry" && block.checkBack)
    return renderBlockKey(block.checkBack, index, turnMountScope);
  if (block.kind === "review-loop") {
    const first = renderBlockEntries(block)[0];
    const prefix = block.variant === "review" ? "review-loop" : block.variant;
    return `${prefix}:${first?.id ?? index}`;
  }
  return transcriptEntryMountKey(block.entry);
}

function renderBlockAnchor(block: RenderBlock, key: string): string {
  if (block.kind === "turn") return turnScrollAnchor(block.items);
  if (block.kind === "entry") return block.entry.id;
  return key;
}

function transcriptMeasureVersion(
  entries: TranscriptEntry[],
  progress?: ReadonlyMap<string, ProgressGroup | null>,
): string[] {
  return entries.flatMap((entry) => {
    const group = progress?.get(entry.id);
    // Hydrating an earlier owner can hide this range's row without changing
    // its stored payload. Measure that removal in the same commit as arrival.
    if (group === null) return [`${entry.id}:progress-hidden`];
    return (group?.entries ?? [entry]).map(
      (item) =>
        `${item.id}:${item.changeSeq ?? ""}:${item.content.length}:${item.contentLength ?? ""}:${item.images?.length ?? 0}:${item.videos?.length ?? 0}:${item.files?.length ?? 0}:${item.isError ? 1 : 0}`,
    );
  });
}

function renderBlockEstimate(block: RenderBlock): number {
  if (block.kind === "turn") return 40;
  if (block.kind === "footer") return 32;
  if (block.kind === "review-loop") return 120;
  if (block.kind === "note") return 96;
  if (block.kind === "entry" && block.entry.type === "system") return 48;
  if (block.kind === "entry" && block.entry.type === "user") return 88;
  return 160;
}

/**
 * Groups a flat transcript into per-turn work folds and message bubbles, then
 * renders them. Tool calls and intermediate assistant narration share one
 * TurnBlock; the turn's final assistant output always stays outside the fold.
 * Shared by the main session view and the sub-agent sidebar so both render
 * identically.
 */
// Memoized: the transcript is expensive to render (markdown parsing + code
// highlighting across every bubble/work block), and unrelated SessionViewer
// re-renders — most notably toggling the workspace panel on/off — would
// otherwise re-render the whole thing synchronously and stall the interaction.
// The React Compiler keeps callbacks and entries identity-stable across
// renders, so this bails out entirely on a panel toggle.
export const TranscriptBlocks = function TranscriptBlocks(props: Props) {
  const entries = props.optimisticEntries?.length
    ? mergeOptimisticTranscriptEntries(props.entries, props.optimisticEntries)
    : props.entries;
  const [thinkingMessages, setThinkingMessages] = React.useState(
    getThinkingMessagesPref,
  );
  useEffect(
    () =>
      onThinkingMessagesChanged(() =>
        setThinkingMessages(getThinkingMessagesPref()),
      ),
    [],
  );
  const progressUpdates = collectProgressUpdates(
    entries,
    props.transcriptIndex,
    props.notes?.map((note) => note.ts),
  );
  const renderedProps: Props = {
    ...props,
    entries,
    thinkingMessages,
    progressUpdates,
  };
  return (
    <>
      {props.sessionId && (
        <SessionContextSlot
          sessionId={props.sessionId}
          historyLoading={props.historyLoading}
        />
      )}
      {props.transcriptIndex ? (
        <IndexedTranscriptBlocks {...renderedProps} />
      ) : (
        <LoadedTranscriptBlocks {...renderedProps} />
      )}
    </>
  );
};

const LoadedTranscriptBlocks = function LoadedTranscriptBlocks({
  entries,
  live,
  onFork,
  onEditMessage,
  onContinue,
  onOpenSubagent,
  owner,
  sessionId,
  notes,
  slackShare,
  reviewResult,
  reviewLoopsOpen,
  onReviewLoopOpenChange,
  optimisticEntries,
  pendingDeliveryIds,
  virtualize = true,
  turnMountScope,
  onVisibleRangesSettled,
  scrollElement,
  shouldMaintainEnd,
  onLayout,
  thinkingMessages = getThinkingMessagesPref(),
  sharedToolResults,
  progressUpdates = new Map(),
}: Props) {
  // Top level only (nested per-range instances pass virtualize={false} and are
  // suppressed): without an outline every block renders real content, so the
  // first commit already IS the settled state.
  const settledRef = useRef(false);
  useEffect(() => {
    if (!virtualize || settledRef.current) return;
    settledRef.current = true;
    onVisibleRangesSettled?.();
  }, [virtualize, onVisibleRangesSettled]);
  const optimisticEntryIds = new Set(
    (optimisticEntries ?? []).map((entry) => entry.id),
  );
  const pendingDeliveryEntryIds = new Set(pendingDeliveryIds ?? []);
  const renderedEntries = normalizeLegacyVoiceToolEntries(entries)
    .map(classifyEntry)
    .filter((entry) => entry.turnBoundary || !isRenderlessUserEntry(entry));
  const shareAfterEntryIds = new Set<string>();
  if (slackShare) {
    for (let i = 0; i < renderedEntries.length; i++) {
      if (mergedNoticePrNumber(renderedEntries[i]) !== slackShare.prNumber)
        continue;
      let targetId = renderedEntries[i].id;
      for (let j = i + 1; j < renderedEntries.length; j++) {
        const candidate = renderedEntries[j];
        if (candidate.type === "user" || candidate.type === "system") break;
        if (candidate.type === "assistant") targetId = candidate.id;
      }
      shareAfterEntryIds.add(targetId);
    }
  }
  // Build tool_use → tool_result map
  const toolResults = new Map<string, TranscriptEntry>(sharedToolResults);
  for (const e of renderedEntries) {
    if (e.type === "tool_result" && e.toolUseId)
      toolResults.set(e.toolUseId, e);
  }

  const blocks: RenderBlock[] = [];
  // The current assistant turn: consecutive assistant/tool_use entries between
  // user/system boundaries. Everything except the final ordinary assistant
  // entry is work; keeping it in one block prevents narration from splitting a
  // run into a ladder of one-step disclosures.
  let turn: TranscriptEntry[] = [];
  // The current turn began at a message sent while the agent was working.
  let turnAnswersSteer = false;

  const flushTurn = (trailing = false) => {
    if (turn.length === 0) return;
    // A message sent mid-turn reaches the model between steps, so its answer
    // is followed by more work and would otherwise fold away as narration.
    // Keep that first reply beside the message it answers.
    const reply = turnAnswersSteer
      ? turn.findIndex(
          (entry) => entry.type === "assistant" && !entry.isReasoning,
        )
      : -1;
    turnAnswersSteer = false;
    if (reply >= 0 && reply < turn.length - 1) {
      const before = arrangeThinkingMessages(
        turn.slice(0, reply),
        thinkingMessages,
        false,
      );
      if (before.length > 0) {
        blocks.push({
          kind: "turn",
          items: before,
          expandWhileRunning: before.some(
            (entry) => entry.type === "assistant",
          ),
        });
      }
      blocks.push({ kind: "entry", entry: turn[reply]! });
      flushWork(turn.slice(reply + 1), turn[0]!, trailing);
    } else {
      flushWork(turn, turn[0]!, trailing);
    }
    turn = [];
  };

  const flushWork = (
    turn: TranscriptEntry[],
    start: TranscriptEntry,
    trailing: boolean,
  ) => {
    const last = turn[turn.length - 1]!;
    // Provider-tagged reasoning is work even when it is the last persisted
    // entry. An ordinary last assistant entry is the only safe final-output
    // candidate, so it always remains outside the fold. As a live turn grows,
    // an earlier candidate moves into work only once a later step proves it was
    // intermediate narration.
    const final = last.type === "assistant" && !last.isReasoning ? last : null;
    // Thinking is laid out per rail: a status at the tail of the live turn, or
    // the full trace in place. See arrangeThinkingMessages.
    const work = arrangeThinkingMessages(
      final ? turn.slice(0, -1) : turn,
      thinkingMessages,
      Boolean(live) && trailing,
    );
    if (work.length > 0) {
      blocks.push({
        kind: "turn",
        items: work,
        expandWhileRunning: work.some((entry) => entry.type === "assistant"),
      });
    }
    if (final) blocks.push({ kind: "entry", entry: final });
    // Quiet actions under the settled answer, the files the turn wrote, and
    // scratch files that have no other direct route from the transcript.
    if (final && !(live && trailing) && !progressUpdates.has(final.id)) {
      blocks.push({
        kind: "footer",
        entry: final,
        // The fold above the answer reads "Worked for 25m"; a "25m" under the
        // answer said it twice (or, once foldReportedTasks widens the fold to
        // the whole task, gave a second, smaller number).
        durationMs:
          work.length > 0
            ? null
            : new Date(final.timestamp).getTime() -
              new Date(start.timestamp).getTime(),
        files: turnTouchedFiles(turn),
        assets: collectWrittenAssets(turn),
      });
    }
  };

  for (const [index, entry] of renderedEntries.entries()) {
    if (entry.type === "tool_result") {
      continue; // rendered inside turn blocks via toolResults
    } else if (
      isWorkEntry(entry) ||
      compactsMidTurn(turn, renderedEntries, index, Boolean(live))
    ) {
      turn.push(entry);
    } else {
      const steer =
        entry.type === "user" &&
        !entry.turnBoundary &&
        sentMidTurn(turn, renderedEntries[index + 1]);
      flushTurn();
      turnAnswersSteer = steer;
      // Hidden system-triggered turns keep the completed output before them
      // out of later work and start a check-back fold. They are structural,
      // never a blank row: groupCheckBacks absorbs or drops every one.
      blocks.push({ kind: "entry", entry });
    }
  }
  flushTurn(true);

  // Interleave team notes by timestamp: each note lands after the last block
  // whose time is at or before it (footers share their answer's time, so a
  // note never splits an answer from its footer). Notes newer than the whole
  // window append at the end.
  if (notes?.length) {
    const blockTime = (b: RenderBlock): number => {
      if (b.kind === "note") return b.note.ts;
      if (b.kind === "review-loop") {
        const last = b.blocks[b.blocks.length - 1];
        return last ? blockTime(last) : 0;
      }
      const entry = b.kind === "turn" ? b.items[b.items.length - 1] : b.entry;
      return entry ? new Date(entry.timestamp).getTime() : 0;
    };
    const sorted = [...notes].sort((a, b) => a.ts - b.ts);
    let at = 0;
    for (const note of sorted) {
      while (at < blocks.length && blockTime(blocks[at]!) <= note.ts) at++;
      blocks.splice(at, 0, { kind: "note", note });
      at++;
    }
  }
  const groupedBlocks = liftLeadStatuses(
    projectProgressBlocks(
      groupCheckBacks(
        groupReviewLoops(foldReportedTasks(blocks, progressUpdates)),
        progressUpdates,
      ),
      progressUpdates,
    ),
  );
  const isConversationBoundary = (block: RenderBlock) =>
    block.kind === "entry" &&
    (block.entry.type === "user" || block.entry.type === "system");
  // Messages sent while a tool runs land below it, but that turn is still the
  // one working: it keeps its Working header and its running step.
  const runningWork = live
    ? runningWorkIndex(groupedBlocks, isConversationBoundary, (block) =>
        Boolean(
          block.kind === "turn" && hasRunningToolCall(block.items, toolResults),
        ),
      )
    : -1;
  // Work before a settled answer (its footer) or a fold of turns the agent
  // started itself belongs to a finished turn, even with no message between.
  const liveTurnBoundary = (
    runningWork >= 0 ? groupedBlocks.slice(0, runningWork) : groupedBlocks
  ).findLastIndex(
    (block) =>
      isConversationBoundary(block) ||
      block.kind === "footer" ||
      block.kind === "review-loop",
  );
  const lastReviewLoop = groupedBlocks.findLastIndex(
    (block) => block.kind === "review-loop" && block.variant === "review",
  );
  // A later human turn makes the old verdict stale in spirit even before GitHub
  // has observed a new push. Operational notices and recaps do not: they are
  // allowed to follow the result without hiding it.
  const showReviewResult =
    !!reviewResult &&
    lastReviewLoop >= 0 &&
    !groupedBlocks
      .slice(lastReviewLoop + 1)
      .some((block) => reviewBlockRole(block).kind === "user-message");

  const renderLoopChildren = (block: LoopBlock, isLive: boolean) => {
    const statuses = loopFoldStatuses(block.blocks, progressUpdates, isLive);
    return block.blocks.map((inner, innerIndex) => {
      const innerKey = renderBlockKey(inner, innerIndex, turnMountScope);
      const status =
        inner.kind === "entry" ? statuses.get(inner.entry.id) : undefined;
      return (
        <React.Fragment key={innerKey}>
          {inner.kind === "turn" ? (
            <ReviewTurnSteps
              items={inner.items}
              statuses={statuses}
              toolResults={toolResults}
              live={Boolean(isLive && innerIndex === block.blocks.length - 1)}
              owner={owner}
              sessionId={sessionId}
              onOpenSubagent={onOpenSubagent}
            />
          ) : inner.kind === "footer" ? (
            <TurnFooter
              className={TURN_FOOTER_LIFT}
              entry={inner.entry}
              durationMs={inner.durationMs}
              files={inner.files}
              assets={inner.assets}
              onFork={onFork}
            />
          ) : status !== undefined ? (
            status && <ProgressStatusLine status={status} />
          ) : block.trigger && innerIndex === 0 && inner.kind === "entry" ? (
            // The row already names the event; open, the fold adds only what
            // it said beyond that, a short line each.
            <TriggerDetail entry={inner.entry} />
          ) : inner.kind === "entry" &&
            !inner.entry.turnBoundary &&
            reviewBlockRole(inner).kind !== "handoff" ? (
            <MessageBubble
              entry={inner.entry}
              toolResult={
                inner.entry.toolUseId
                  ? toolResults.get(inner.entry.toolUseId)
                  : undefined
              }
              enter={
                optimisticEntryIds.has(inner.entry.id) ||
                Boolean(
                  isLive &&
                  innerIndex === block.blocks.length - 1 &&
                  inner.entry.type !== "user",
                )
              }
              reasoning={inner.reasoning}
              pendingDelivery={pendingDeliveryEntryIds.has(inner.entry.id)}
              owner={owner}
              sessionId={sessionId}
              onEdit={
                optimisticEntryIds.has(inner.entry.id)
                  ? undefined
                  : onEditMessage
              }
              optimistic={optimisticEntryIds.has(inner.entry.id)}
            />
          ) : null}
        </React.Fragment>
      );
    });
  };

  // A fold is live until a person speaks after it.
  const isLoopLive = (i: number) =>
    Boolean(
      live &&
      !groupedBlocks
        .slice(i + 1)
        .some(
          (candidate) => reviewBlockRole(candidate).kind === "user-message",
        ),
    );
  // A check-back fold is running only while it is the live tail: its own
  // final answer and footer may follow, nothing else.
  const isCheckBackTail = (i: number) =>
    groupedBlocks
      .slice(i + 1)
      .every(
        (candidate) =>
          candidate.kind === "footer" ||
          (candidate.kind === "entry" && candidate.entry.type === "assistant"),
      );

  // A turn's closing hairline divides its work from what follows. A footer
  // is the turn's own summary row, not something to divide from.
  const lastContentBlock = groupedBlocks.findLastIndex(
    (block) => block.kind !== "footer",
  );

  const virtualItems: VirtualTranscriptItem[] = groupedBlocks.map(
    (block, i) => {
      const key = renderBlockKey(block, i, turnMountScope);
      const entriesInBlock = renderBlockEntries(block);
      if (block.kind === "review-loop") {
        // Final assistant output deliberately sits outside the review disclosure.
        // It does not make the loop historical while that same turn is live.
        const isLive = block.variant !== "work" && isLoopLive(i);
        const checkBackIsTail = isCheckBackTail(i);
        const loopChildren = renderLoopChildren(block, isLive);
        return {
          key,
          anchorId: renderBlockAnchor(block, key),
          entryIds: entriesInBlock.map((entry) => entry.id),
          arrivalAliases: transcriptArrivalAliases(entriesInBlock),
          measureVersion: transcriptMeasureVersion(
            entriesInBlock,
            progressUpdates,
          ),
          estimateSize: renderBlockEstimate(block),
          content:
            block.variant === "work" ? (
              <WorkFoldBlock
                durationMs={block.durationMs}
                trigger={block.trigger}
                defaultOpen={reviewLoopsOpen}
                onOpenChange={onReviewLoopOpenChange}
              >
                {loopChildren}
              </WorkFoldBlock>
            ) : block.variant === "review" ? (
              <ReviewLoopBlock
                prNumber={block.prNumber}
                rounds={block.rounds}
                settled={block.settled}
                live={isLive}
                result={
                  showReviewResult && i === lastReviewLoop && !isLive
                    ? reviewResult
                    : undefined
                }
                defaultOpen={reviewLoopsOpen}
                onOpenChange={onReviewLoopOpenChange}
              >
                {loopChildren}
              </ReviewLoopBlock>
            ) : (
              <CheckBackBlock
                rounds={block.rounds}
                live={isLive && checkBackIsTail}
                defaultOpen={reviewLoopsOpen}
                onOpenChange={onReviewLoopOpenChange}
              >
                {loopChildren}
              </CheckBackBlock>
            ),
        };
      }

      // A live turn may contain several tool folds now that every model message
      // splits them. Every tool run after the latest conversation boundary is
      // part of that same active turn, not only the final fold.
      const isLiveTail =
        Boolean(live) &&
        (i === groupedBlocks.length - 1 ||
          (block.kind === "turn" && i > liveTurnBoundary));
      const progress =
        block.kind === "entry"
          ? progressUpdates.get(block.entry.id)
          : undefined;
      const checkBack = block.kind === "entry" ? block.checkBack : undefined;
      const content = progress ? (
        <ProgressStatusRow
          group={progress}
          live={
            checkBack?.variant === "check-back" &&
            isLoopLive(i) &&
            isCheckBackTail(i)
          }
          meta={
            checkBack?.trigger && checkBack.durationMs !== undefined
              ? (formatDuration(checkBack.durationMs) ?? undefined)
              : undefined
          }
          defaultOpen={reviewLoopsOpen}
          onOpenChange={onReviewLoopOpenChange}
        >
          {checkBack &&
            renderLoopChildren(
              checkBack,
              checkBack.variant === "check-back" && isLoopLive(i),
            )}
        </ProgressStatusRow>
      ) : block.kind === "turn" ? (
        <TurnBlock
          items={block.items}
          toolResults={toolResults}
          live={isLiveTail}
          expandWhileRunning={block.expandWhileRunning}
          onOpenSubagent={onOpenSubagent}
          sessionId={sessionId}
          last={i === lastContentBlock}
          status={block.status}
        />
      ) : block.kind === "note" ? (
        <NoteBubble thread={block.note} sessionId={sessionId} />
      ) : block.kind === "footer" ? (
        <TurnFooter
          entry={block.entry}
          durationMs={block.durationMs}
          files={block.files}
          assets={block.assets}
          onFork={onFork}
        />
      ) : (
        <MessageBubble
          entry={block.entry}
          toolResult={
            block.entry.toolUseId
              ? toolResults.get(block.entry.toolUseId)
              : undefined
          }
          enter={
            optimisticEntryIds.has(block.entry.id) ||
            Boolean(isLiveTail && block.entry.type !== "user")
          }
          reasoning={block.reasoning}
          pendingDelivery={pendingDeliveryEntryIds.has(block.entry.id)}
          owner={owner}
          sessionId={sessionId}
          onEdit={
            optimisticEntryIds.has(block.entry.id) ? undefined : onEditMessage
          }
          optimistic={optimisticEntryIds.has(block.entry.id)}
          onContinue={i === groupedBlocks.length - 1 ? onContinue : undefined}
        />
      );
      const showShareAction =
        block.kind === "entry" && shareAfterEntryIds.has(block.entry.id);
      return {
        key,
        anchorId: renderBlockAnchor(block, key),
        entryIds: entriesInBlock.map((entry) => entry.id),
        arrivalAliases: transcriptArrivalAliases(entriesInBlock),
        measureVersion: transcriptMeasureVersion(
          entriesInBlock,
          progressUpdates,
        ),
        estimateSize: renderBlockEstimate(block),
        // A footer overlaps the answer above it, so its margin belongs to the
        // measured wrapper rather than inside the contained row.
        className: block.kind === "footer" ? TURN_FOOTER_LIFT : undefined,
        content: (
          <>
            {content}
            {showShareAction && slackShare && (
              <ShippedChangeComposer {...slackShare} />
            )}
          </>
        ),
      };
    },
  );

  return (
    <VirtualTranscriptList
      items={virtualItems}
      trailingMounted={TRAILING_MOUNTED_BLOCKS}
      enabled={virtualize}
      sizeCacheKey={sessionId}
      scrollElement={scrollElement}
      shouldMaintainEnd={shouldMaintainEnd}
      onLayout={onLayout}
    />
  );
};

type IndexedTimelineAtom =
  | {
      kind: "range";
      range: TranscriptIndexedRange;
      /** Live turn entries that have not received durable seq values yet. */
      continuationEntryIds: string[];
      timestampMs: number;
      notes: CommentThread[];
    }
  | { kind: "entry"; entry: TranscriptEntry; timestampMs: number }
  | { kind: "note"; note: CommentThread; timestampMs: number };

type IndexedTimelineItem =
  | IndexedTimelineAtom
  | {
      kind: "review";
      atoms: IndexedTimelineAtom[];
      ranges: TranscriptIndexedRange[];
      rounds: number;
      prNumber: number | null;
      timestampMs: number;
    };

function IndexedTranscriptBlocks(props: Props) {
  const { entries, transcriptIndex = [], notes } = props;
  const [openedReviewKeys, setOpenedReviewKeys] = React.useState(
    () => new Set<string>(),
  );
  const setReviewOpen = (key: string, open: boolean) => {
    setOpenedReviewKeys((current) => {
      const next = new Set(current);
      if (open) next.add(key);
      else next.delete(key);
      return next;
    });
  };
  const ranges = buildTranscriptRanges(transcriptIndex);
  const payloadById = new Map(entries.map((entry) => [entry.id, entry]));
  const indexedIds = new Set(ranges.flatMap((range) => range.entryIds));
  const optimisticById = new Map(
    (props.optimisticEntries ?? []).map((entry) => [entry.id, entry]),
  );
  let atoms: IndexedTimelineAtom[] = ranges.map((range) => ({
    kind: "range",
    range,
    continuationEntryIds: [],
    timestampMs: range.endTimestampMs,
    notes: [],
  }));
  const rangeAtoms = atoms.filter(
    (atom): atom is Extract<IndexedTimelineAtom, { kind: "range" }> =>
      atom.kind === "range",
  );
  const tailRangeAtom = rangeAtoms[rangeAtoms.length - 1];
  for (const entry of entries) {
    if (entry.seq !== undefined || indexedIds.has(entry.id)) continue;
    const timestampMs = Date.parse(entry.timestamp) || 0;
    const optimistic = optimisticById.get(entry.id);
    if (optimistic && rangeAtoms.length > 0) {
      // Keep the prompt in the structural range that was current when it was
      // sent. Wall clocks are deliberately absent here: a browser clock ahead
      // of the server used to place later assistant/tool rows above the prompt.
      const anchorId = optimistic.optimisticAfterEntryId;
      const anchorSeq = optimistic.optimisticAfterSeq;
      const rangeAtom =
        (anchorId !== undefined && anchorId !== null
          ? rangeAtoms.find(
              (atom) =>
                atom.range.entryIds.includes(anchorId) ||
                atom.range.entryIds.includes(`outbox-${anchorId}`),
            )
          : undefined) ??
        (anchorSeq !== undefined
          ? rangeAtoms.findLast((atom) => atom.range.firstSeq <= anchorSeq)
          : undefined) ??
        rangeAtoms[rangeAtoms.length - 1]!;
      rangeAtom.continuationEntryIds.push(entry.id);
      rangeAtom.timestampMs = Math.max(rangeAtom.timestampMs, timestampMs);
      continue;
    }
    // Live turn frames arrive before their durable sequence numbers. They are
    // causally after the loaded tail regardless of wall-clock timestamps or
    // synthetic decorations (for example a model switch) between them. Attach
    // them directly instead of timestamp-sorting them as standalone rows: that
    // sort could transiently put assistant output above its optimistic prompt
    // when the browser clock ran ahead of the server.
    if (tailRangeAtom && isTurnContinuationEntry(entry)) {
      tailRangeAtom.continuationEntryIds.push(entry.id);
      tailRangeAtom.timestampMs = Math.max(
        tailRangeAtom.timestampMs,
        timestampMs,
      );
      continue;
    }
    atoms.push({
      kind: "entry",
      entry,
      timestampMs,
    });
  }
  for (const note of notes ?? []) {
    const containing = atoms.find(
      (atom) =>
        atom.kind === "range" &&
        note.ts >= atom.range.startTimestampMs &&
        note.ts <= atom.timestampMs,
    );
    if (containing?.kind === "range") containing.notes.push(note);
    else atoms.push({ kind: "note", note, timestampMs: note.ts });
  }
  atoms = sortIndexedTimelineAtoms(atoms);
  const timeline = groupIndexedReviewLoops(atoms);
  // Only payload-backed rows occupy scroll space. Unloaded history contributes
  // no estimated placeholders: the scrollable area starts at the loaded tail
  // and grows upward as older ranges hydrate (handleTopApproach below), so
  // every height on screen is a real measurement.
  const renderedTimeline = timeline
    .map((item, index) => ({ item, index }))
    .filter(({ item, index }) => {
      // A loose thinking atom renders as a one-row rail of its own. Skip it
      // when arrangement would leave that rail empty, so it never occupies an
      // empty measured row.
      if (
        item.kind === "entry" &&
        item.entry.isReasoning &&
        arrangeThinkingMessages(
          [item.entry],
          props.thinkingMessages ?? getThinkingMessagesPref(),
          Boolean(props.live) && index === timeline.length - 1,
        ).length === 0
      ) {
        return false;
      }
      const itemRanges = indexedItemRanges(item);
      return (
        itemRanges.length === 0 ||
        transcriptRangesContainPayload(itemRanges, (id) => payloadById.has(id))
      );
    });
  // Nothing to window (an empty or fully-absent outline): the curtain lifts
  // instead of waiting for a demand pass that will never run. Recheck when the
  // full outline replaces the bounded init even if both happen to be empty: the
  // parent deliberately rejects the init's earlier, unproven ready signal.
  const settleEmptyTimeline = useEffectEvent(() => {
    props.onVisibleRangesSettled?.();
  });
  useEffect(() => {
    if (renderedTimeline.length === 0) settleEmptyTimeline();
  }, [renderedTimeline.length, transcriptIndex]);
  // Latest outline position of the mounted RANGE window's head row, read by
  // handleTopApproach below. Standalone decorations (for example a model
  // switch placed before the loaded tail by timestamp) must not become the
  // demand head or they strand every indexed range after them. A content-free
  // opening has no range head yet, so demand starts from the outline tail.
  const firstRenderedRange = renderedTimeline.find(({ item }) =>
    transcriptRangesContainPayload(indexedItemRanges(item), (id) =>
      payloadById.has(id),
    ),
  );
  const firstRenderedRangeKey = firstRenderedRange
    ? indexedItemKey(firstRenderedRange.item, firstRenderedRange.index)
    : null;
  // Fired when the reader nears the top of the mounted window: collect the
  // next batch of missing ranges walking backwards from the window's head.
  // Start AT the head because the bounded opening payload can begin partway
  // through a structural range. Hydrating the missing rows prepends real
  // content; VirtualTranscriptList holds the reader's place while the area
  // above grows. SessionViewer owns in-flight/completed deduplication so a
  // timed-out request remains retryable here.
  const handleTopApproach = () => {
    const onLoad = props.onLoadTranscriptRanges;
    if (!onLoad) return false;
    let head = firstRenderedRangeKey
      ? timeline.findIndex(
          (item, index) =>
            indexedItemKey(item, index) === firstRenderedRangeKey,
        )
      : timeline.length - 1;
    if (head === -1) head = timeline.length - 1;
    const wanted: TranscriptIndexedRange[] = [];
    let missingTotal = 0;
    for (
      let i = head;
      i >= 0 && missingTotal < TOP_APPROACH_ENTRY_BUDGET;
      i--
    ) {
      const item = timeline[i];
      if (!item) break;
      for (const range of indexedItemRanges(item)) {
        let missing = 0;
        for (const id of range.entryIds) if (!payloadById.has(id)) missing++;
        if (missing > 0) {
          wanted.push(range);
          missingTotal += missing;
        }
      }
    }
    if (!wanted.length) return false;
    onLoad(wanted.reverse());
    return true;
  };
  // VirtualTranscriptList re-evaluates generation changes through its own
  // viewport-proximity gate. It chains responses only while the rendered
  // transcript is too short to scroll, then returns to explicit reader intent.
  const hydrationOutline = timeline.map((item, index) => ({
    key: indexedItemKey(item, index),
    ranges: indexedItemRanges(item),
  }));
  const sharedToolResults = new Map<string, TranscriptEntry>();
  for (const entry of entries) {
    if (entry.type === "tool_result" && entry.toolUseId)
      sharedToolResults.set(entry.toolUseId, entry);
  }
  const itemPayload = (item: IndexedTimelineItem) =>
    indexedItemEntryIds(item).flatMap((id) => {
      const entry = payloadById.get(id) ?? optimisticById.get(id);
      return entry ? [entry] : [];
    });
  // A message sent while a tool runs opens its own range below the call, so
  // the range still running that call stays live along with the tail.
  const runningItem = props.live
    ? runningWorkIndex(
        renderedTimeline,
        ({ item }) =>
          itemPayload(item).every(
            (entry) => entry.type === "user" || entry.type === "system",
          ),
        ({ item }) => hasRunningToolCall(itemPayload(item), sharedToolResults),
      )
    : -1;
  const items: VirtualTranscriptItem[] = renderedTimeline.map(
    ({ item, index }, position) => {
      const entryIds = indexedItemEntryIds(item);
      const rangeEntries = entryIds.flatMap((id) => {
        const entry = payloadById.get(id);
        return entry ? [entry] : [];
      });
      const optimisticRangeEntries = rangeEntries.flatMap((entry) => {
        const optimistic = optimisticById.get(entry.id);
        return optimistic ? [optimistic] : [];
      });
      const itemEntries = mergeOptimisticTranscriptEntries(
        orderTranscriptEntries(
          rangeEntries.filter((entry) => !optimisticById.has(entry.id)),
        ),
        optimisticRangeEntries,
      );
      // Keys come from the full-outline position so a row keeps its identity
      // while older siblings hydrate in above it.
      const key = indexedItemKey(item, index);
      const estimateSize = indexedItemEstimate(item);
      const isLast = position === renderedTimeline.length - 1;
      const isRunning = position === runningItem;
      return {
        key,
        anchorId: key,
        entryIds,
        arrivalAliases: transcriptArrivalAliases(
          item.kind === "entry" ? [item.entry] : itemEntries,
        ),
        measureVersion: transcriptMeasureVersion(
          item.kind === "entry" ? [item.entry] : itemEntries,
          props.progressUpdates,
        ),
        // A transcript_range may add several payload slices to this existing
        // outline row. That is history becoming available, not a live arrival:
        // it must not slide settled work or runner notices below it. Loose
        // entries are the live/optimistic atoms outside those durable ranges.
        animateArrival: item.kind === "entry",
        estimateSize,
        measure: true,
        content:
          item.kind === "note" ? (
            <NoteBubble thread={item.note} sessionId={props.sessionId} />
          ) : item.kind === "entry" ? (
            <LoadedTranscriptBlocks
              {...props}
              onVisibleRangesSettled={undefined}
              entries={[item.entry]}
              transcriptIndex={undefined}
              notes={undefined}
              virtualize={false}
              live={Boolean(props.live && (isLast || isRunning))}
              sharedToolResults={sharedToolResults}
              onContinue={isLast ? props.onContinue : undefined}
            />
          ) : (
            // Ranges and review groups always render from real payload now;
            // unloaded ones were dropped by the renderedTimeline filter and
            // grow in when their hydration lands.
            <LoadedTranscriptBlocks
              {...props}
              entries={itemEntries}
              transcriptIndex={undefined}
              notes={indexedItemNotes(item)}
              virtualize={false}
              turnMountScope={item.kind === "range" ? key : undefined}
              live={Boolean(props.live && (isLast || isRunning))}
              sharedToolResults={sharedToolResults}
              reviewLoopsOpen={
                item.kind === "review" && openedReviewKeys.has(key)
                  ? true
                  : props.reviewLoopsOpen
              }
              onReviewLoopOpenChange={
                item.kind === "review"
                  ? (open) => setReviewOpen(key, open)
                  : undefined
              }
              onContinue={isLast ? props.onContinue : undefined}
            />
          ),
      };
    },
  );

  return (
    <VirtualTranscriptList
      items={items}
      trailingMounted={TRAILING_MOUNTED_BLOCKS}
      sizeCacheKey={props.sessionId}
      scrollElement={props.scrollElement}
      shouldMaintainEnd={props.shouldMaintainEnd}
      onLayout={props.onLayout}
      onTopApproach={handleTopApproach}
      topApproachGeneration={props.transcriptRangeRetryGeneration}
      onVisibleItems={(visible) => {
        const wanted = visibleTranscriptHydrationDemand(
          hydrationOutline,
          new Set(visible.map((item) => item.key)),
          (entryId) => payloadById.has(entryId),
        );
        if (wanted === null) return;
        if (wanted.length > 0) {
          props.onLoadTranscriptRanges?.(wanted);
          return;
        }
        props.onVisibleRangesSettled?.();
      }}
    />
  );
}

/** A step of the agent's own work: what a turn's fold is made of. */
function isWorkEntry(entry: TranscriptEntry): boolean {
  return (
    agentMessageText(entry) !== null ||
    entry.type === "assistant" ||
    entry.type === "tool_use"
  );
}

/**
 * Whether the entry at `index` is a context compaction in the middle of a
 * turn. The engine compacts between steps and carries on with the same work,
 * so the notice belongs inside the fold, where it happened. Ending the turn
 * there made one run read as two, each timed from its own half, the first
 * with no answer under it. A compaction after the turn's answer, before the
 * next message, still stands between turns.
 */
export function compactsMidTurn(
  turn: readonly TranscriptEntry[],
  entries: readonly TranscriptEntry[],
  index: number,
  live: boolean,
): boolean {
  if (entries[index]?.notice?.kind !== "compaction") return false;
  const last = turn[turn.length - 1];
  if (!last) return false;
  for (let i = index + 1; i < entries.length; i++) {
    const next = entries[i]!;
    if (next.type !== "tool_result") return isWorkEntry(next);
  }
  // Nothing after it yet. A running turn is still working through it, unless
  // it already ended on what may be its answer.
  return live && (last.type !== "assistant" || Boolean(last.isReasoning));
}

/**
 * Whether a user message was sent while the agent was still working. A
 * message admitted mid-turn is written before the step it waited behind: it
 * follows a tool call or reasoning rather than a final answer, or the result
 * of the tool that was running lands right after it. The second test is the
 * one an indexed range can make, since the range starts at the message.
 */
export function sentMidTurn(
  previousTurn: readonly TranscriptEntry[],
  next: TranscriptEntry | undefined,
): boolean {
  if (next?.type === "tool_result") return true;
  const last = previousTurn[previousTurn.length - 1];
  if (!last) return false;
  return last.type !== "assistant" || Boolean(last.isReasoning);
}

/**
 * The item still running a tool call beneath messages sent while it ran, or
 * -1. Those messages wait for the call to finish, so they say nothing about
 * the turn above them being over. Only called while the session is live: an
 * interrupted call is closed with a result, so an unanswered call in a live
 * session is the one running.
 */
export function runningWorkIndex<T>(
  items: readonly T[],
  isMessage: (item: T) => boolean,
  isRunning: (item: T) => boolean,
): number {
  let i = items.length - 1;
  while (i >= 0 && isMessage(items[i]!)) i--;
  return i >= 0 && i < items.length - 1 && isRunning(items[i]!) ? i : -1;
}

function hasRunningToolCall(
  entries: readonly TranscriptEntry[],
  toolResults: ReadonlyMap<string, TranscriptEntry>,
): boolean {
  return entries.some(
    (entry) =>
      entry.type === "tool_use" &&
      Boolean(entry.toolUseId) &&
      !toolResults.has(entry.toolUseId!),
  );
}

function isTurnContinuationEntry(entry: TranscriptEntry): boolean {
  return (
    entry.type === "assistant" ||
    entry.type === "tool_use" ||
    entry.type === "tool_result"
  );
}

/**
 * Conversation ranges are ordered by the immutable seq spine, exactly like the
 * entries inside them. Only decorations that have no seq are placed by time.
 *
 * A range's timestamp is its LAST row, so a message that arrives mid-turn opens
 * a range stamped earlier than the turn still emitting tool rows above it. That
 * makes range timestamps non-monotonic for as long as the new message has no
 * work under it yet, and sorting the whole timeline by them hoists the newer
 * message above the older turn until the next durable row lands.
 */
function sortIndexedTimelineAtoms(
  atoms: IndexedTimelineAtom[],
): IndexedTimelineAtom[] {
  const byTime = (a: IndexedTimelineAtom, b: IndexedTimelineAtom) =>
    a.timestampMs - b.timestampMs;
  const spine = atoms
    .filter(
      (atom): atom is Extract<IndexedTimelineAtom, { kind: "range" }> =>
        atom.kind === "range",
    )
    .sort((a, b) => a.range.firstSeq - b.range.firstSeq);
  if (!spine.length) return [...atoms].sort(byTime);
  const result: IndexedTimelineAtom[] = [...spine];
  for (const atom of atoms
    .filter((atom) => atom.kind !== "range")
    .sort(byTime)) {
    const index = result.findIndex(
      (candidate) => candidate.timestampMs > atom.timestampMs,
    );
    result.splice(index === -1 ? result.length : index, 0, atom);
  }
  return result;
}

function groupIndexedReviewLoops(
  atoms: IndexedTimelineAtom[],
): IndexedTimelineItem[] {
  const grouped: IndexedTimelineItem[] = [];
  for (let index = 0; index < atoms.length; index++) {
    const atom = atoms[index]!;
    // Review handoffs and the agent's own check-backs both open one group up
    // to the next human message; the nested renderer folds each kind.
    if (
      atom.kind !== "range" ||
      (atom.range.headRole !== "review_handoff" &&
        atom.range.headRole !== "check_back")
    ) {
      grouped.push(atom);
      continue;
    }
    // A check-back continues the request above it: that request's range
    // joins the group, so a task that ends in an answer can fold its first
    // work and its check-backs into one row (`foldReportedTasks`).
    const request = grouped.at(-1);
    const head =
      atom.range.headRole === "check_back" &&
      request?.kind === "range" &&
      request.range.headRole === "user"
        ? grouped.pop()!
        : null;
    const loop: IndexedTimelineAtom[] =
      head?.kind === "range" ? [head, atom] : [atom];
    let rounds = atom.range.reviewRounds;
    let prNumber = atom.range.reviewPrNumber;
    while (index + 1 < atoms.length) {
      const next = atoms[index + 1]!;
      if (next.kind === "range" && next.range.headRole === "user") break;
      index++;
      loop.push(next);
      if (next.kind === "range" && next.range.headRole === "review_handoff") {
        rounds += next.range.reviewRounds;
        prNumber ??= next.range.reviewPrNumber;
      }
    }
    grouped.push({
      kind: "review",
      atoms: loop,
      ranges: loop.flatMap((item) =>
        item.kind === "range" ? [item.range] : [],
      ),
      rounds,
      prNumber,
      timestampMs: loop[0]!.timestampMs,
    });
  }
  return grouped;
}

function indexedItemRanges(
  item: IndexedTimelineItem,
): TranscriptIndexedRange[] {
  if (item.kind === "range") return [item.range];
  if (item.kind === "review") return item.ranges;
  return [];
}

function indexedAtomEntryIds(atom: IndexedTimelineAtom): string[] {
  if (atom.kind === "entry") return [atom.entry.id];
  if (atom.kind === "range")
    return [...atom.range.entryIds, ...atom.continuationEntryIds];
  return [];
}

function indexedItemEntryIds(item: IndexedTimelineItem): string[] {
  if (item.kind === "review") return item.atoms.flatMap(indexedAtomEntryIds);
  return indexedAtomEntryIds(item);
}

function indexedItemNotes(
  item: IndexedTimelineItem,
): CommentThread[] | undefined {
  if (item.kind === "range") return item.notes.length ? item.notes : undefined;
  if (item.kind === "review") {
    const notes = item.atoms.flatMap((atom) =>
      atom.kind === "range"
        ? atom.notes
        : atom.kind === "note"
          ? [atom.note]
          : [],
    );
    return notes.length ? notes : undefined;
  }
  return undefined;
}

function indexedItemKey(item: IndexedTimelineItem, index: number): string {
  if (item.kind === "entry") return item.entry.id;
  if (item.kind === "range") return item.range.key;
  if (item.kind === "review")
    return `review-index:${item.ranges[0]?.key ?? index}`;
  return `note:${item.note.id}`;
}

function indexedItemEstimate(item: IndexedTimelineItem): number {
  if (item.kind === "range") return item.range.estimateSize;
  if (item.kind === "review") return 48;
  if (item.kind === "note") return 96;
  return 48;
}

/** Review work uses the same grouped step rows as a normal turn, without
 * introducing another outer worker disclosure inside the review loop. */
/**
 * Every status a loop's fold shows, by entry id. A turn's own narration
 * counts too: the "✓ CI: All checks passed" an agent posts mid-turn closes
 * the wait it reports on, where it used to stand as a full message bubble.
 */
function loopFoldStatuses(
  blocks: RenderBlock[],
  progressUpdates: ReadonlyMap<string, ProgressGroup | null>,
  live: boolean,
): Map<string, FoldStatus | null> {
  const steps: Array<{
    id: string;
    at: string;
    update: ProgressUpdate | null;
  }> = [];
  for (const inner of blocks) {
    if (inner.kind === "turn") {
      for (const entry of inner.items)
        steps.push({
          id: entry.id,
          at: entry.timestamp,
          update:
            entry.type === "assistant" ? parseProgressUpdate(entry) : null,
        });
      continue;
    }
    const first = renderBlockEntries(inner)[0];
    steps.push({
      id: first?.id ?? "",
      at: first?.timestamp ?? "",
      update:
        inner.kind === "entry" && progressUpdates.has(inner.entry.id)
          ? parseProgressUpdate(inner.entry)
          : null,
    });
  }
  const byId = new Map<string, FoldStatus | null>();
  // Most folds carry no status at all. Do not parse their timestamps.
  if (!steps.some((step) => step.update)) return byId;
  foldStatuses(
    steps.map((step) => step.update),
    (index) => Date.parse(steps[index]!.at),
    live,
  ).forEach((status, index) => {
    if (status !== undefined) byId.set(steps[index]!.id, status);
  });
  return byId;
}

function ReviewTurnSteps({
  items,
  statuses,
  toolResults,
  live,
  owner,
  sessionId,
  onOpenSubagent,
}: {
  items: TranscriptEntry[];
  /** The fold's status steps (`loopFoldStatuses`); null hides one. */
  statuses: ReadonlyMap<string, FoldStatus | null>;
  toolResults: Map<string, TranscriptEntry>;
  live: boolean;
  owner?: string;
  sessionId?: string;
  onOpenSubagent?: (agentId: string, label: string) => void;
}) {
  // The loop is the work fold here, so only the Tool calls preference is left
  // to answer: open renders every call in place, as in an ordinary turn.
  const { tools } = useTurnActivityPrefs();
  const sections: Array<
    | { kind: "tools"; items: TranscriptEntry[] }
    | { kind: "message"; entry: TranscriptEntry }
    | { kind: "status"; id: string; status: FoldStatus }
  > = [];
  for (const entry of items) {
    const status = statuses.get(entry.id);
    if (status !== undefined) {
      // A folded update leaves no gap: the calls either side join one run.
      if (status) sections.push({ kind: "status", id: entry.id, status });
    } else if (entry.type === "tool_use" && agentMessageText(entry) === null) {
      const last = sections[sections.length - 1];
      if (last?.kind === "tools") last.items.push(entry);
      else sections.push({ kind: "tools", items: [entry] });
    } else {
      sections.push({ kind: "message", entry });
    }
  }

  return sections.map((section) =>
    section.kind === "status" ? (
      <ProgressStatusLine key={section.id} status={section.status} />
    ) : section.kind === "tools" ? (
      <ToolSection
        key={section.items[0].id}
        items={section.items}
        toolResults={toolResults}
        live={live}
        expandAll={tools === "open"}
        sessionId={sessionId}
        onOpenSubagent={onOpenSubagent}
      />
    ) : (
      <MessageBubble
        key={section.entry.id}
        entry={section.entry}
        toolResult={
          section.entry.toolUseId
            ? toolResults.get(section.entry.toolUseId)
            : undefined
        }
        enter={live && section.entry.type !== "user"}
        reasoning={isLegacyReasoningHeading(section.entry.content)}
        owner={owner}
        sessionId={sessionId}
      />
    ),
  );
}
