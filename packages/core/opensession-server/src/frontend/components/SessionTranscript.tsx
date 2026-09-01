import React, { useLayoutEffect, useSyncExternalStore } from "react";
import { renderMarkdown } from "../lib/markdown";
import type { LiveTurnStore } from "../lib/live-turn-store";
import {
  msgBodyStreaming,
  msgReasoningShimmer,
  msgReasoningTitle,
  msgRow,
  msgStreamingRow,
} from "../lib/msg-classes";
import { useOpenAssetPaths } from "../lib/open-asset";
import { cn } from "../ui/cn";
import { TextShimmer } from "../ui/text-shimmer";
import {
  liveReasoningHeading,
  normalizeFragmentedReasoning,
} from "../lib/reasoning-display";
import { MarkdownBody, useMarkdownRepo } from "./MarkdownBody";
import { TranscriptBlocks } from "./TranscriptBlocks";

type TranscriptBlocksProps = React.ComponentProps<typeof TranscriptBlocks>;

type SessionTranscriptProps = Omit<TranscriptBlocksProps, "sessionId"> & {
  sessionId: string;
  liveTurnStore: LiveTurnStore;
  /** Re-measure the host scroll region after transcript geometry commits. */
  onLayout?: () => void;
};

/**
 * The durable transcript and the live assistant tail for any session surface.
 * Full sessions and compact session views use this component so markdown,
 * stream reconciliation, and transcript grouping cannot drift apart.
 */
export const SessionTranscript = function SessionTranscript({
  sessionId,
  liveTurnStore,
  onLayout,
  ...blocks
}: SessionTranscriptProps) {
  return (
    <>
      <TranscriptBlocks {...blocks} sessionId={sessionId} onLayout={onLayout} />
      <StreamingMessage
        store={liveTurnStore}
        sessionId={sessionId}
        onLayout={onLayout}
      />
    </>
  );
};

function StreamingMessage({
  store,
  sessionId,
  onLayout,
}: {
  store: LiveTurnStore;
  sessionId: string;
  onLayout?: () => void;
}) {
  const snapshot = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getServerSnapshot,
  );
  const repo = useMarkdownRepo();
  const assetPaths = useOpenAssetPaths();
  useLayoutEffect(() => {
    onLayout?.();
  }, [snapshot.revision, onLayout]);
  if (!snapshot.text) return null;
  const reasoningHeading = liveReasoningHeading(snapshot.text);
  if (reasoningHeading) {
    return (
      <div className={cn(msgRow, msgStreamingRow, "mb-2")} role="status">
        <TextShimmer className={cn(msgReasoningTitle, msgReasoningShimmer)}>
          {reasoningHeading}
        </TextShimmer>
      </div>
    );
  }

  const displayText = normalizeFragmentedReasoning(snapshot.text);
  const html = renderMarkdown(displayText, { repo, sessionId, assetPaths });
  // Always rendered, never raw source: the server cuts frames at block
  // boundaries, so what arrives here is markdown that stands on its own.
  return (
    /* .msg-streaming + .msg-body-assistant stay as hooks: the streaming caret
		   is a ::after on that pair, and the reduced-motion exception names it. */
    <div className={cn(msgRow, msgStreamingRow)}>
      <MarkdownBody
        className={cn(msgBodyStreaming, "markdown")}
        html={html}
        enhance={false}
      />
    </div>
  );
}
