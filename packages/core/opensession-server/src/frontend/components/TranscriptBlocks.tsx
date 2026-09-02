import React, { useEffect, useEffectEvent, useRef } from "react";
import type {
  SessionNote,
  SessionWalkthrough,
  TranscriptEntry,
} from "../lib/types";
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
import { NoteBubble } from "./NoteBubble";
import { ToolSection, TurnBlock } from "./TurnBlock";
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
import { WalkthroughCard } from "./WalkthroughCard";
import { walkthroughInsertIndex } from "./walkthrough-placement";
import {
  mergeOptimisticTranscriptEntries,
  normalizeLegacyVoiceToolEntries,
  orderTranscriptEntries,
  type OptimisticTranscriptEntry,
} from "../lib/transcript-state";
import { collectWrittenAssets } from "../lib/open-asset";
import { classifyEntry } from "@tellahq/opensession-protocol/notices";
import { ReviewLoopBlock } from "./ReviewLoopBlock";
import type { ReviewLoopResult } from "../lib/review-loop";
import {
  ShippedChangeComposer,
  type ShippedChangeComposerProps,
} from "./ShippedChangeComposer";
import { SessionContextMessage } from "./SessionContextMessage";
import {
  transcriptRangesContainPayload,
  visibleTranscriptHydrationDemand,
} from "./session-viewer/transcript-hydration";
import { isLegacyReasoningHeading } from "../lib/reasoning-display";
import {
  getThinkingMessagesPref,
  onThinkingMessagesChanged,
  thinkingMessageIsVisible,
  thinkingMessageVisibility,
  type ThinkingMessageVisibility,
} from "../lib/thinking-messages-pref";

type RenderBlock =
  | { kind: "entry"; entry: TranscriptEntry; reasoning?: boolean }
  | { kind: "turn"; items: TranscriptEntry[]; expandWhileRunning: boolean }
  | {
      kind: "footer";
      entry: TranscriptEntry;
      durationMs: number;
      files: TouchedFile[];
      assets: string[];
    }
  | { kind: "walkthrough"; walkthrough: SessionWalkthrough }
  | { kind: "note"; note: SessionNote }
  | {
      kind: "review-loop";
      blocks: RenderBlock[];
      prNumber: number | null;
      rounds: number;
    };

interface Props {
  entries: TranscriptEntry[];
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
  /** Agent-published walkthrough — rendered inline where it was published.
   *  Pass a referentially stable object (see SessionViewer) so the memo holds. */
  walkthrough?: SessionWalkthrough;
  /** Team notes (src/server/session-notes.ts) interleaved into the timeline
   *  by timestamp. Agent-invisible; rendered as NoteBubbles. */
  notes?: SessionNote[];
  slackShare?: ShippedChangeComposerProps & {
    prNumber: number;
  };
  /** The current PR verdict, rendered on the final review loop's own row. */
  reviewResult?: ReviewLoopResult;
  /** Preview/test hook; the session viewer leaves review loops folded. */
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
  /** Resolved once against the full loaded payload, then shared with indexed
   * range renderers so "Latest" means one row across the whole transcript. */
  thinkingVisibility?: ThinkingMessageVisibility;
}

type ReviewBlockRole =
  | { kind: "handoff"; prNumber: number | null }
  | { kind: "user-message" }
  | { kind: "other" };

/** The same classification that chooses MessageBubble's presentation also
 * decides whether a row starts or ends a review phase. Several operational
 * notices have a legacy `type: "user"` wire shape, so the raw type alone
 * cannot distinguish a person's request from status plumbing. */
function reviewBlockRole(block: RenderBlock): ReviewBlockRole {
  if (block.kind !== "entry") return { kind: "other" };
  const entry = classifyEntry(block.entry);
  if (entry.notice?.kind === "review-handoff") {
    const match = entry.notice.title.match(/PR #(\d+)/);
    return { kind: "handoff", prNumber: match ? Number(match[1]) : null };
  }
  return entry.type === "user" && !entry.notice
    ? { kind: "user-message" }
    : { kind: "other" };
}

/** A review handoff and the work it triggers form one quiet phase. Human
 * requests and final model output stay outside; intermediate narration already
 * belongs to the grouped turn work. */
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
    while (i + 1 < blocks.length) {
      const next = blocks[i + 1];
      const nextRole = reviewBlockRole(next);
      // Notes, walkthroughs, and final model output have their own placement and
      // must never vanish inside an automation disclosure.
      if (
        next.kind === "note" ||
        next.kind === "walkthrough" ||
        (next.kind === "entry" && next.entry.type === "assistant")
      )
        break;
      // A normal user message is a new conversation phase. A second review
      // handoff belongs to this loop and starts its next round.
      if (nextRole.kind === "user-message") break;
      i++;
      loop.push(next);
      if (nextRole.kind === "handoff") {
        rounds++;
        prNumber ??= nextRole.prNumber;
      }
    }
    grouped.push({ kind: "review-loop", blocks: loop, prNumber, rounds });
  }
  return grouped;
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
  if (block.kind === "walkthrough") return "walkthrough";
  if (block.kind === "note") return `note:${block.note.id}`;
  if (block.kind === "footer") return `${block.entry.id}:footer`;
  if (block.kind === "review-loop") {
    const first = renderBlockEntries(block)[0];
    return `review-loop:${first?.id ?? index}`;
  }
  return transcriptEntryMountKey(block.entry);
}

function renderBlockAnchor(block: RenderBlock, key: string): string {
  if (block.kind === "turn") return turnScrollAnchor(block.items);
  if (block.kind === "entry") return block.entry.id;
  return key;
}

function transcriptMeasureVersion(entries: TranscriptEntry[]): string[] {
  return entries.map(
    (entry) =>
      `${entry.id}:${entry.changeSeq ?? ""}:${entry.content.length}:${entry.contentLength ?? ""}:${entry.images?.length ?? 0}:${entry.videos?.length ?? 0}:${entry.files?.length ?? 0}:${entry.isError ? 1 : 0}`,
  );
}

function renderBlockEstimate(block: RenderBlock): number {
  if (block.kind === "turn") return 40;
  if (block.kind === "footer") return 32;
  if (block.kind === "review-loop") return 120;
  if (block.kind === "walkthrough") return 320;
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
  const renderedProps: Props = {
    ...props,
    entries,
    thinkingVisibility: thinkingMessageVisibility(entries, thinkingMessages),
  };
  return (
    <>
      {props.sessionId && <SessionContextMessage sessionId={props.sessionId} />}
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
  walkthrough,
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
  thinkingVisibility,
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
    .filter(
      (entry) =>
        thinkingMessageIsVisible(entry, thinkingVisibility) &&
        (entry.turnBoundary || !isRenderlessUserEntry(entry)),
    );
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
  const toolResults = new Map<string, TranscriptEntry>();
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

  const flushTurn = (trailing = false) => {
    if (turn.length === 0) return;
    const last = turn[turn.length - 1];
    // Provider-tagged reasoning is work even when it is the last persisted
    // entry. An ordinary last assistant entry is the only safe final-output
    // candidate, so it always remains outside the fold. As a live turn grows,
    // an earlier candidate moves into work only once a later step proves it was
    // intermediate narration.
    const final = last.type === "assistant" && !last.isReasoning ? last : null;
    const work = final ? turn.slice(0, -1) : turn;
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
    if (final && !(live && trailing)) {
      blocks.push({
        kind: "footer",
        entry: final,
        durationMs:
          new Date(final.timestamp).getTime() -
          new Date(turn[0].timestamp).getTime(),
        files: turnTouchedFiles(turn),
        assets: collectWrittenAssets(turn),
      });
    }
    turn = [];
  };

  for (const entry of renderedEntries) {
    if (entry.type === "tool_result") {
      continue; // rendered inside turn blocks via toolResults
    } else if (entry.type === "assistant" || entry.type === "tool_use") {
      turn.push(entry);
    } else {
      flushTurn();
      // Hidden system-triggered turns exist only to keep the completed output
      // before them out of later work. They are structural, never a blank row.
      if (!entry.turnBoundary) blocks.push({ kind: "entry", entry });
    }
  }
  flushTurn(true);

  if (walkthrough)
    blocks.splice(walkthroughInsertIndex(blocks, walkthrough), 0, {
      kind: "walkthrough",
      walkthrough,
    });

  // Interleave team notes by timestamp: each note lands after the last block
  // whose time is at or before it (footers share their answer's time, so a
  // note never splits an answer from its footer). Notes newer than the whole
  // window append at the end.
  if (notes?.length) {
    const blockTime = (b: RenderBlock): number => {
      if (b.kind === "walkthrough")
        return new Date(b.walkthrough.publishedAt).getTime();
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
  const groupedBlocks = groupReviewLoops(blocks);
  const liveTurnBoundary = groupedBlocks.findLastIndex(
    (block) =>
      block.kind === "entry" &&
      (block.entry.type === "user" || block.entry.type === "system"),
  );
  const lastReviewLoop = groupedBlocks.findLastIndex(
    (block) => block.kind === "review-loop",
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

  const virtualItems: VirtualTranscriptItem[] = groupedBlocks.map(
    (block, i) => {
      const key = renderBlockKey(block, i, turnMountScope);
      const entriesInBlock = renderBlockEntries(block);
      if (block.kind === "review-loop") {
        // Final assistant output deliberately sits outside the review disclosure.
        // It does not make the loop historical while that same turn is live.
        const isLive = Boolean(
          live &&
          !groupedBlocks
            .slice(i + 1)
            .some(
              (candidate) => reviewBlockRole(candidate).kind === "user-message",
            ),
        );
        return {
          key,
          anchorId: renderBlockAnchor(block, key),
          entryIds: entriesInBlock.map((entry) => entry.id),
          arrivalAliases: transcriptArrivalAliases(entriesInBlock),
          measureVersion: transcriptMeasureVersion(entriesInBlock),
          estimateSize: renderBlockEstimate(block),
          content: (
            <ReviewLoopBlock
              prNumber={block.prNumber}
              rounds={block.rounds}
              live={isLive}
              result={
                showReviewResult && i === lastReviewLoop && !isLive
                  ? reviewResult
                  : undefined
              }
              defaultOpen={reviewLoopsOpen}
              onOpenChange={onReviewLoopOpenChange}
            >
              {block.blocks.map((inner, innerIndex) => {
                const innerKey = renderBlockKey(
                  inner,
                  innerIndex,
                  turnMountScope,
                );
                return (
                  <React.Fragment key={innerKey}>
                    {inner.kind === "turn" ? (
                      <ReviewTurnSteps
                        items={inner.items}
                        toolResults={toolResults}
                        live={Boolean(
                          isLive && innerIndex === block.blocks.length - 1,
                        )}
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
                    ) : inner.kind === "entry" &&
                      reviewBlockRole(inner).kind !== "handoff" ? (
                      <MessageBubble
                        entry={inner.entry}
                        enter={
                          optimisticEntryIds.has(inner.entry.id) ||
                          Boolean(
                            isLive &&
                            innerIndex === block.blocks.length - 1 &&
                            inner.entry.type !== "user",
                          )
                        }
                        reasoning={inner.reasoning}
                        pendingDelivery={pendingDeliveryEntryIds.has(
                          inner.entry.id,
                        )}
                        owner={owner}
                        sessionId={sessionId}
                        onEdit={
                          optimisticEntryIds.has(inner.entry.id)
                            ? undefined
                            : onEditMessage
                        }
                      />
                    ) : null}
                  </React.Fragment>
                );
              })}
            </ReviewLoopBlock>
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
      const content =
        block.kind === "turn" ? (
          <TurnBlock
            items={block.items}
            toolResults={toolResults}
            live={isLiveTail}
            expandWhileRunning={block.expandWhileRunning}
            onOpenSubagent={onOpenSubagent}
            sessionId={sessionId}
          />
        ) : block.kind === "walkthrough" ? (
          <WalkthroughCard walkthrough={block.walkthrough} variant="session" />
        ) : block.kind === "note" ? (
          <NoteBubble note={block.note} sessionId={sessionId} />
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
        measureVersion: transcriptMeasureVersion(entriesInBlock),
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
      notes: SessionNote[];
      walkthrough?: SessionWalkthrough;
    }
  | { kind: "entry"; entry: TranscriptEntry; timestampMs: number }
  | { kind: "note"; note: SessionNote; timestampMs: number }
  | {
      kind: "walkthrough";
      walkthrough: SessionWalkthrough;
      timestampMs: number;
    };

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
  const { entries, transcriptIndex = [], notes, walkthrough } = props;
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
  const optimisticIds = new Set(
    (props.optimisticEntries ?? []).map((entry) => entry.id),
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
    if (typeof entry.seq === "number" || indexedIds.has(entry.id)) continue;
    const timestampMs = Date.parse(entry.timestamp) || 0;
    if (optimisticIds.has(entry.id) && rangeAtoms.length > 0) {
      // Keep the prompt in the structural range that was current when it was
      // sent. Wall clocks are deliberately absent here: a browser clock ahead
      // of the server used to place later assistant/tool rows above the prompt.
      const optimistic = entry as OptimisticTranscriptEntry;
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
  if (walkthrough) {
    const publishedEntryId = walkthrough.publishedEntryId;
    const publishedAt = Date.parse(walkthrough.publishedAt) || 0;
    const containing = atoms.find(
      (atom) =>
        atom.kind === "range" &&
        (publishedEntryId
          ? indexedAtomEntryIds(atom).includes(publishedEntryId)
          : publishedAt >= atom.range.startTimestampMs &&
            publishedAt <= atom.timestampMs),
    );
    if (containing?.kind === "range") containing.walkthrough = walkthrough;
    else
      atoms.push({
        kind: "walkthrough",
        walkthrough,
        timestampMs: publishedAt,
      });
  }
  atoms = sortIndexedTimelineAtoms(atoms);
  const timeline = groupIndexedReviewLoops(atoms);
  // Only payload-backed rows occupy scroll space. Unloaded history contributes
  // no estimated placeholders: the scrollable area starts at the loaded tail
  // and grows upward as older ranges hydrate (handleTopApproach below), so
  // every height on screen is a real measurement.
  const renderedTimeline = timeline
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => {
      if (
        item.kind === "entry" &&
        !thinkingMessageIsVisible(item.entry, props.thinkingVisibility)
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
  const items: VirtualTranscriptItem[] = renderedTimeline.map(
    ({ item, index }, position) => {
      const entryIds = indexedItemEntryIds(item);
      const rangeEntries = entryIds.flatMap((id) => {
        const entry = payloadById.get(id);
        return entry ? [entry] : [];
      });
      const optimisticRangeEntries = rangeEntries.filter(
        (entry): entry is OptimisticTranscriptEntry =>
          optimisticIds.has(entry.id),
      );
      const itemEntries = mergeOptimisticTranscriptEntries(
        orderTranscriptEntries(
          rangeEntries.filter((entry) => !optimisticIds.has(entry.id)),
        ),
        optimisticRangeEntries,
      );
      // Keys come from the full-outline position so a row keeps its identity
      // while older siblings hydrate in above it.
      const key = indexedItemKey(item, index);
      const estimateSize = indexedItemEstimate(item);
      const isLast = position === renderedTimeline.length - 1;
      return {
        key,
        anchorId: key,
        entryIds,
        arrivalAliases: transcriptArrivalAliases(
          item.kind === "entry" ? [item.entry] : itemEntries,
        ),
        measureVersion: transcriptMeasureVersion(
          item.kind === "entry" ? [item.entry] : itemEntries,
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
            <NoteBubble note={item.note} sessionId={props.sessionId} />
          ) : item.kind === "walkthrough" ? (
            <WalkthroughCard walkthrough={item.walkthrough} variant="session" />
          ) : item.kind === "entry" ? (
            <LoadedTranscriptBlocks
              {...props}
              onVisibleRangesSettled={undefined}
              entries={[item.entry]}
              transcriptIndex={undefined}
              notes={undefined}
              walkthrough={undefined}
              virtualize={false}
              live={Boolean(props.live && isLast)}
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
              walkthrough={indexedItemWalkthrough(item)}
              virtualize={false}
              turnMountScope={item.kind === "range" ? key : undefined}
              live={Boolean(props.live && isLast)}
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
    if (atom.kind !== "range" || atom.range.headRole !== "review_handoff") {
      grouped.push(atom);
      continue;
    }
    const loop: IndexedTimelineAtom[] = [atom];
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
      timestampMs: atom.timestampMs,
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
): SessionNote[] | undefined {
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

function indexedItemWalkthrough(
  item: IndexedTimelineItem,
): SessionWalkthrough | undefined {
  if (item.kind === "range") return item.walkthrough;
  if (item.kind === "review") {
    for (const atom of item.atoms) {
      if (atom.kind === "walkthrough") return atom.walkthrough;
      if (atom.kind === "range" && atom.walkthrough) return atom.walkthrough;
    }
  }
  return undefined;
}

function indexedItemKey(item: IndexedTimelineItem, index: number): string {
  if (item.kind === "entry") return item.entry.id;
  if (item.kind === "range") return item.range.key;
  if (item.kind === "review")
    return `review-index:${item.ranges[0]?.key ?? index}`;
  if (item.kind === "note") return `note:${item.note.id}`;
  return "walkthrough";
}

function indexedItemEstimate(item: IndexedTimelineItem): number {
  if (item.kind === "range") return item.range.estimateSize;
  if (item.kind === "review") return 48;
  if (item.kind === "note") return 96;
  if (item.kind === "walkthrough") return 320;
  return 48;
}

/** Review work uses the same grouped step rows as a normal turn, without
 * introducing another outer worker disclosure inside the review loop. */
function ReviewTurnSteps({
  items,
  toolResults,
  live,
  owner,
  sessionId,
  onOpenSubagent,
}: {
  items: TranscriptEntry[];
  toolResults: Map<string, TranscriptEntry>;
  live: boolean;
  owner?: string;
  sessionId?: string;
  onOpenSubagent?: (agentId: string, label: string) => void;
}) {
  const sections: Array<
    | { kind: "tools"; items: TranscriptEntry[] }
    | { kind: "message"; entry: TranscriptEntry }
  > = [];
  for (const entry of items) {
    if (entry.type === "tool_use") {
      const last = sections[sections.length - 1];
      if (last?.kind === "tools") last.items.push(entry);
      else sections.push({ kind: "tools", items: [entry] });
    } else {
      sections.push({ kind: "message", entry });
    }
  }

  return sections.map((section) =>
    section.kind === "tools" ? (
      <ToolSection
        key={section.items[0].id}
        items={section.items}
        toolResults={toolResults}
        live={live}
        expandAll={false}
        sessionId={sessionId}
        onOpenSubagent={onOpenSubagent}
      />
    ) : (
      <MessageBubble
        key={section.entry.id}
        entry={section.entry}
        enter={live && section.entry.type !== "user"}
        reasoning={isLegacyReasoningHeading(section.entry.content)}
        owner={owner}
        sessionId={sessionId}
      />
    ),
  );
}
