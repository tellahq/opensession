import { useEffect, useSyncExternalStore } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useWebSocket } from "../hooks/useWebSocket";
import { sessionVoice } from "../lib/session-voice-runtime";
import { SESSION_VOICE_STATUS } from "../lib/session-voice-client";
import { getCurrentUser, useCurrentUser } from "./UserPicker";
import { SessionVoiceOrb } from "./SessionVoiceOrb";
import { SessionVoicePauseButton } from "./SessionVoicePauseButton";
import { Button } from "../ui/button";
import { composerChipMotion } from "../ui/motion";
import { IconCall, IconChevronRight } from "./icons";

/** A dedicated, presence-free watch. The routed viewer's unwatch cannot retire
 * this subscription when the user navigates to a different session. */
function SessionVoiceWatch({ sessionId }: { sessionId: string }) {
  const { connected, send, addHandler } = useWebSocket(false);
  useEffect(() => {
    if (!connected) return;
    const unsubscribe = addHandler(sessionVoice.receive);
    send({
      type: "watch",
      sessionId,
      user: getCurrentUser(),
      supportsSeq: true,
      supportsChangeSeq: true,
    });
    return () => {
      unsubscribe();
      send({ type: "unwatch", sessionId });
    };
  }, [sessionId, connected, send, addHandler]);
  return null;
}

/** Mounted once at the app root, not beneath a session route. */
export function SessionVoiceHost({
  onOpenSession,
}: {
  onOpenSession: (id: string) => void;
}) {
  const call = useSyncExternalStore(
    sessionVoice.subscribe,
    sessionVoice.getSnapshot,
  );
  const user = useCurrentUser();
  useEffect(() => () => sessionVoice.stop(), [user]);
  const showPanel = !call.sourceVisible && (call.active || !!call.error);
  return (
    <>
      {call.active && call.sessionId && (
        <SessionVoiceWatch key={call.sessionId} sessionId={call.sessionId} />
      )}
      <AnimatePresence>
        {showPanel && (
          <motion.aside
            {...composerChipMotion}
            exit={{ opacity: 0 }}
            className="fixed z-[90] flex items-center gap-2 rounded-2xl bg-panel/95 p-3 backdrop-blur-xl smooth-shadow-lg desktop:right-6 desktop:bottom-24 desktop:w-96 phone:inset-x-3 phone:bottom-[calc(env(safe-area-inset-bottom)+96px)]"
            aria-label="Voice conversation"
          >
            <SessionVoiceOrb
              levels={sessionVoice.levels}
              active={call.active && call.state !== "paused"}
              connecting={call.state === "connecting"}
              className="size-16"
            />
            <div className="min-w-0 flex-1">
              <p className="text-meta font-medium text-dim" role="status">
                {SESSION_VOICE_STATUS[call.state]}
              </p>
              {call.error ? (
                <p className="mt-1 text-meta text-dim" role="alert">
                  {call.error}
                </p>
              ) : null}
              <Button
                variant="ghost"
                size="sm"
                className="-ml-2.5 max-w-full gap-1 text-fg phone:min-h-11"
                aria-label="Return to thread"
                title={call.title}
                onClick={() => call.sessionId && onOpenSession(call.sessionId)}
              >
                <span className="min-w-0 truncate">{call.title}</span>
                <IconChevronRight size={16} className="shrink-0 text-faint" />
              </Button>
            </div>
            {call.active && (
              <SessionVoicePauseButton
                state={call.state}
                onToggle={sessionVoice.togglePause}
              />
            )}
            {call.active ? (
              <Button
                variant="danger"
                size="sm"
                icon={<IconCall size={22} />}
                className="size-11 shrink-0 text-red hover:text-red"
                aria-label="End voice call"
                title="End voice call"
                onClick={sessionVoice.stop}
              />
            ) : (
              <Button
                variant="ghost"
                size="sm"
                className="phone:min-h-11"
                onClick={sessionVoice.dismissError}
              >
                Dismiss
              </Button>
            )}
          </motion.aside>
        )}
      </AnimatePresence>
    </>
  );
}
