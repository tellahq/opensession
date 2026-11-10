import { z } from "zod";

/**
 * Whether a framed page is playing sound. A Browser or Portal page keeps
 * playing after you leave its workspace (see kept-frames.ts), and a frame is
 * cross-origin, so this window cannot hear it. The page says so instead:
 *
 *   parent.postMessage({ type: "opensession:audio", audible: true }, "*")
 *
 * whenever that changes. The Mac app adds a reporter to every page it frames
 * (packages/clients/mac/src/frame-audio.js); in a plain browser a page can
 * send the same message itself. The sidebar wears a speaker on the workspace
 * the sound comes from, and clicking it sends FRAME_AUDIO_PAUSE back.
 */
export const FRAME_AUDIO_MESSAGE = "opensession:audio";

/** Asks a framed page to pause what it is playing. */
export const FRAME_AUDIO_PAUSE = "opensession:pause-audio";

const reportSchema = z.object({
  type: z.literal(FRAME_AUDIO_MESSAGE),
  audible: z.boolean(),
});

/** The page's report, or null when the message is not one from `frame`. */
export function frameAudioReport(
  event: Pick<MessageEvent, "data" | "source">,
  frame: Window | null | undefined,
): boolean | null {
  if (!frame || event.source !== frame) return null;
  const report = reportSchema.safeParse(event.data);
  return report.success ? report.data.audible : null;
}
