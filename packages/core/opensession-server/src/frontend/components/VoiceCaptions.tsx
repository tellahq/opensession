import React, { useLayoutEffect, useSyncExternalStore } from "react";
import type { VoiceCaptionStore } from "../lib/voice-captions";
import {
  msgBodyStreaming,
  msgBubbleUser,
  msgOwnTurn,
  msgRow,
  msgStreamingRow,
} from "../lib/msg-classes";
import { cn } from "../ui/cn";

/**
 * What the voice call is saying right now. One row per speaker holds the
 * transcript fragments the call has delivered and the server has not yet
 * mirrored (lib/voice-captions.ts): the reply reads as the bubble a text run
 * streams into, your own words as a sent bubble, and each drops out as the
 * durable row lands in its place.
 */
export function VoiceCaptions({
  store,
  onLayout,
}: {
  store: VoiceCaptionStore;
  /** Re-measure the host scroll region after a caption paints. */
  onLayout?: () => void;
}) {
  const snapshot = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getServerSnapshot,
  );
  useLayoutEffect(() => {
    onLayout?.();
  }, [snapshot.revision, onLayout]);
  if (!snapshot.captions.length) return null;
  return (
    <>
      {snapshot.captions.map((caption) =>
        caption.role === "user" ? (
          /* .msg-user stays as a hook: useSessionScroll finds turn
					   boundaries by it, as on the settled row this becomes. */
          <div key="user" className={cn(msgRow, msgOwnTurn, "msg-user")}>
            <div className={msgBubbleUser}>{caption.text}</div>
          </div>
        ) : (
          /* .msg-streaming + .msg-body-assistant stay as hooks: the streaming
					   caret is a ::after on that pair (base-markdown.css). Plain text,
					   not markdown: this is speech. */
          <div key="assistant" className={cn(msgRow, msgStreamingRow)}>
            <div className={msgBodyStreaming}>{caption.text}</div>
          </div>
        ),
      )}
    </>
  );
}
