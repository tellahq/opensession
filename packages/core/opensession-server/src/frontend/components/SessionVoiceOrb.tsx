import { useEffect, useRef } from "react";
import { cn } from "../ui/cn";
import {
  startSessionVoiceOrb,
  type SessionVoiceOrbLevelsRef,
} from "../lib/session-voice-orb";

/**
 * The luminous orb for a session voice call. The microphone deforms and lights
 * its rim, the speaker brightens its core; both read live levels from `levels`
 * every frame. During startup, a neutral pulse indicates connection progress;
 * once connected, speech drives its reactions. Size it
 * from the outside (`size-10`, `size-14`); it fills its box.
 *
 * Decorative by default: the status text beside it already says what the call
 * is doing. Pass `label` when the orb stands alone and should be announced.
 */
export function SessionVoiceOrb({
  levels,
  active,
  connecting = false,
  className,
  label,
}: {
  /** Stable ref the parent's audio analysis writes 0..1 levels into. */
  levels: SessionVoiceOrbLevelsRef;
  /** Whether a call is live. Off, the orb settles into a quiet resting sphere. */
  active: boolean;
  /** A neutral startup pulse, separate from microphone and playback activity. */
  connecting?: boolean;
  className?: string;
  /** Accessible name; omitted, the orb is hidden from assistive tech. */
  label?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    return startSessionVoiceOrb(canvas, levels, { active, connecting });
  }, [levels, active, connecting]);

  return (
    <div
      className={cn("relative size-12 shrink-0", className)}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <canvas
        ref={canvasRef}
        className="pointer-events-none absolute -inset-1/4 size-[150%]"
      />
    </div>
  );
}
