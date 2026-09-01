/**
 * `OPENSESSION_IMAGE:` / `OPENSESSION_VIDEO:` markers in a Slack reply.
 *
 * Agents are told across every surface that printing one of these lines is how
 * they say "look at this" (run-instructions.ts). In the web transcript the
 * marker becomes an inline player; in Slack it used to become the literal
 * string `OPENSESSION_IMAGE: /tmp/shot.png`, which reads as a broken feature
 * and leaves the screenshot on a disk nobody has. So the marker is read out of
 * the text here and the file is uploaded to the thread instead.
 *
 * Only explicit markers upload. A path that merely turns up in the prose is
 * left alone: the transcript can afford to attach it and fold it away, but a
 * Slack upload is a message everyone in the channel gets.
 */

import { statSync } from "fs";
import { basename } from "path";
import {
  extractMediaMarkers,
  stripMediaMarkers,
} from "../../server/transcript-media";
import { MAX_SLACK_UPLOAD_BYTES } from "./slack-api";

export interface SlackMedia {
  path: string;
  kind: "image" | "video";
}

/** A marker we won't upload, with something the thread can say about it. */
export interface SkippedMedia {
  path: string;
  reason: string;
}

export interface SlackMediaSplit {
  /** The reply with the marker lines removed. */
  text: string;
  media: SlackMedia[];
  skipped: SkippedMedia[];
}

/** One reply's worth. A message that wants a filmstrip wants a session, not Slack. */
const MAX_FILES = 10;

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/**
 * Splits a reply into the text to post and the files to upload beside it.
 *
 * Call this on the raw response, before any markdown conversion or length
 * cap: `markdownToSlack` rewrites the underscores in `/tmp/my_final_shot.png`
 * as italics, and a marker past the 3000-character cut would be dropped
 * silently or, worse, truncated into a path that points at nothing.
 */
export function splitSlackMedia(text: string): SlackMediaSplit {
  const markers = extractMediaMarkers(text);
  if (markers.length === 0) return { text, media: [], skipped: [] };

  const media: SlackMedia[] = [];
  const skipped: SkippedMedia[] = [];
  const seen = new Set<string>();
  for (const marker of markers) {
    // The same file marked twice is one upload — an agent that shows a
    // before/after pair often prints the shared frame in both halves.
    if (seen.has(marker.path)) continue;
    seen.add(marker.path);
    if (media.length >= MAX_FILES) {
      skipped.push({
        path: marker.path,
        reason: `over ${MAX_FILES} files in one reply`,
      });
      continue;
    }
    let size: number;
    try {
      const stat = statSync(marker.path);
      if (!stat.isFile()) throw new Error("not a regular file");
      size = stat.size;
    } catch {
      skipped.push({ path: marker.path, reason: "no such file on this host" });
      continue;
    }
    if (size === 0) {
      skipped.push({ path: marker.path, reason: "the file is empty" });
      continue;
    }
    if (size > MAX_SLACK_UPLOAD_BYTES) {
      skipped.push({
        path: marker.path,
        reason: `${mb(size)}, over Slack's ${mb(MAX_SLACK_UPLOAD_BYTES)} upload limit`,
      });
      continue;
    }
    media.push(marker);
  }

  // Stripping a marker off its own line leaves the blank line above and below
  // it, which in Slack is a visible gap in the middle of a paragraph.
  const stripped = stripMediaMarkers(text)
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text: stripped, media, skipped };
}

/** "shot.png and clip.mp4 (no such file on this host)" — for a one-line note. */
export function describeSkippedMedia(skipped: SkippedMedia[]): string {
  return skipped
    .map((item) => `${basename(item.path)} (${item.reason})`)
    .join(", ");
}
