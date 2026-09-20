import { Button } from "../ui/button";
import { SessionVoiceOrb } from "./SessionVoiceOrb";
import { SessionVoicePauseButton } from "./SessionVoicePauseButton";
import type { SessionVoiceLevels } from "../lib/session-voice-audio";
import {
  SESSION_VOICE_STATUS,
  type SessionVoiceState,
} from "../lib/session-voice-client";

export function SessionVoiceStatus({
  state,
  levels,
  error,
  onTogglePause,
  onDismiss,
}: {
  state: SessionVoiceState;
  levels: SessionVoiceLevels;
  error: string | null;
  onTogglePause: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="px-3 py-2 text-meta text-dim">
      <div className="flex items-center gap-3">
        <SessionVoiceOrb
          levels={levels}
          active={state !== "idle" && state !== "error" && state !== "paused"}
          connecting={state === "connecting"}
          className="size-12"
        />
        <div className="min-w-0 flex-1" role={error ? "alert" : "status"}>
          {error ? (
            <p>{error}</p>
          ) : (
            <>
              <p className="font-medium text-fg">
                {SESSION_VOICE_STATUS[state]}
              </p>
              <p>
                {state === "paused"
                  ? "Microphone and replies muted"
                  : "Voice conversation about this thread"}
              </p>
            </>
          )}
        </div>
        {!error && state !== "idle" && (
          <SessionVoicePauseButton state={state} onToggle={onTogglePause} />
        )}
        {error && (
          <Button
            size="sm"
            variant="ghost"
            className="shrink-0 phone:min-h-11"
            onClick={onDismiss}
          >
            Dismiss
          </Button>
        )}
      </div>
    </div>
  );
}
