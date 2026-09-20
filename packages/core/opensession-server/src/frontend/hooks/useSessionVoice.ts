import { useEffect, useState, useSyncExternalStore } from "react";
import { sessionVoice } from "../lib/session-voice-runtime";
import type { TranscriptEntry } from "../lib/types";

/** A view onto the app-owned call. Unmounting or losing focus only moves its
 * controls to the global panel; neither event hangs up the conversation. */
export function useSessionVoice({
  sessionId,
  title,
  enabled,
  busy,
  entries,
}: {
  sessionId: string;
  title: string;
  enabled: boolean;
  busy: boolean;
  entries: TranscriptEntry[];
}) {
  const call = useSyncExternalStore(
    sessionVoice.subscribe,
    sessionVoice.getSnapshot,
  );
  const [view] = useState(() => Symbol("voice-view"));
  useEffect(() => {
    sessionVoice.setView(view, sessionId, enabled);
    return () => sessionVoice.removeView(view);
  }, [view, sessionId, enabled]);
  const ownsCall = call.sessionId === sessionId;
  function toggle() {
    if (ownsCall && call.active) sessionVoice.stop();
    else if (enabled) sessionVoice.start({ sessionId, title, entries, busy });
  }
  return {
    state: ownsCall ? call.state : ("idle" as const),
    active: ownsCall && call.active,
    error: ownsCall ? call.error : null,
    levels: sessionVoice.levels,
    toggle,
    togglePause: sessionVoice.togglePause,
    dismissError: sessionVoice.dismissError,
  };
}
