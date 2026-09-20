import { Button } from "../ui/button";
import { Tooltip } from "../ui/tooltip";
import { IconPause, IconPlay } from "./icons";
import type { SessionVoiceState } from "../lib/session-voice-client";

export function SessionVoicePauseButton({
  state,
  onToggle,
}: {
  state: SessionVoiceState;
  onToggle: () => void;
}) {
  const paused = state === "paused";
  return (
    <Tooltip
      label={
        paused
          ? "Resume microphone and replies"
          : "Pause microphone and replies"
      }
    >
      <Button
        variant="ghost"
        size="sm"
        className="size-11 shrink-0"
        icon={paused ? <IconPlay size={22} /> : <IconPause size={22} />}
        aria-label={paused ? "Resume voice call" : "Pause voice call"}
        disabled={state === "connecting"}
        onClick={onToggle}
      />
    </Tooltip>
  );
}
