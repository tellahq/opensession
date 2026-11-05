import React from "react";
import type { SessionWalkthrough } from "../lib/types";
import { renderMarkdown } from "../lib/markdown";
import {
  WALKTHROUGH_LABEL_CLASS,
  WALKTHROUGH_LABEL_TEXT,
  WALKTHROUGH_LABEL_TONE,
} from "../lib/walkthrough-label";
import { cn } from "../ui/cn";
import { IconPlayRectangle } from "./icons";
import { MarkdownBody, useMarkdownRepo } from "./MarkdownBody";
import { openLightbox, type LightboxItem } from "../lib/media-lightbox";

/** Stream server-side media (staged under the uploads dir) through the
 *  existing scoped media route — same URL shape MessageBubble uses. */
const mediaUrl = (path: string) => `/media?path=${encodeURIComponent(path)}`;

/**
 * The Before/After label: the app's own status pill, resting in the tile's top
 * left. Panel surface, a --red-soft/--green-soft tint, --red/--green ink and a
 * hairline — the same parts every other pill in the product is made of, so it
 * reads as a caption the app put on the picture rather than as a sticker.
 *
 * Because it is opaque it reads on a white screenshot and on a dark one alike,
 * so it can simply follow the app theme instead of sampling the image under
 * it. A tight shadow under the hairline is what lifts it off the picture.
 *
 * `rounded-[999px]`, not `rounded-full`: base.css grants squircle corners to
 * every `rounded-*` except that one spelling, and a pill is where the squircle
 * belongs.
 *
 * The tint is a gradient because it has to sit ON the panel fill: --red-soft
 * is translucent ink, and painted straight onto the picture it is the wash
 * that let a white screenshot through in the first place.
 */
const SHOT_LABEL = cn(
  WALKTHROUGH_LABEL_CLASS,
  "pointer-events-none absolute left-2 top-2",
);

/**
 * The agent-published walkthrough (opensession-walkthrough): demo video +
 * before/after screenshot pairs + writeup, at the top of the PR info column in
 * the Review tab. It is the inline counterpart of the link-only section
 * mirrored into the GitHub PR description. The session transcript does not
 * repeat it: there the agent's own before/after comparison already shows the
 * same stills.
 */
export function WalkthroughCard({
  walkthrough,
}: {
  walkthrough: SessionWalkthrough;
}) {
  const repo = useMarkdownRepo();
  const summaryHtml = renderMarkdown(walkthrough.summary, { repo });
  // Every piece of media in the card, in render order, so clicking one opens
  // the shared lightbox (Escape/arrows/pinch-zoom/download) browsing
  // demo→before→after across all the pairs.
  const gallery = (() => {
    const items: LightboxItem[] = [];
    const at = new Map<string, number>();
    if (walkthrough.video) {
      at.set("video", items.length);
      items.push({
        kind: "video",
        src: mediaUrl(walkthrough.video),
        walkthroughLabel: "demo",
        sessionTitle: walkthrough.videoTitle,
      });
    }
    (walkthrough.shots || []).forEach((shot, i) => {
      for (const side of ["before", "after"] as const) {
        const path = shot[side];
        if (!path) continue;
        at.set(`${i}:${side}`, items.length);
        items.push({
          kind: "image",
          src: mediaUrl(path),
          walkthroughLabel: side,
          sessionTitle: shot.caption,
        });
      }
    });
    return { items, at };
  })();

  const open = (key: string, target: HTMLElement) =>
    openLightbox(gallery.items, gallery.at.get(key) ?? 0, target);

  return (
    <div className="mb-4 rounded-xl border border-line/60 bg-surface p-4 smooth-shadow-xs">
      <div className="mb-2 flex items-center gap-1.5">
        <IconPlayRectangle size={20} className="text-faint" />
        <span className="text-xs font-semibold text-dim">Walkthrough</span>
      </div>

      {/* No rule under the header: the card is already one surface, and
          the gap does the separating. */}
      <div className="mt-3 space-y-5">
        <section className="px-0.5">
          <h3 className="m-0 mb-1.5 text-meta font-semibold leading-4 text-faint">
            Summary
          </h3>
          <MarkdownBody
            html={summaryHtml}
            markdown={{ repo }}
            className="markdown max-w-[68ch] text-label leading-5 text-dim [overflow-wrap:anywhere] [text-wrap:pretty]"
          />
        </section>

        {walkthrough.video && (
          <figure className="m-0">
            <figcaption className="mb-2 flex min-h-5 items-center gap-2 px-0.5 text-xs font-medium text-fg">
              <span className="size-1.5 flex-shrink-0 rounded-full bg-blue" />
              <span className="flex-shrink-0">Demo</span>
              {walkthrough.videoTitle && (
                <span className="min-w-0 truncate font-normal text-faint">
                  {walkthrough.videoTitle}
                </span>
              )}
            </figcaption>
            <video
              className="w-full rounded-md bg-black shadow-[0_0_0_1px_var(--border)]"
              src={mediaUrl(walkthrough.video)}
              controls
              preload="metadata"
              title={walkthrough.videoTitle || "Demo video"}
            />
          </figure>
        )}

        {(walkthrough.shots || []).map((shot, i) => {
          const paired = Boolean(shot.before && shot.after);
          return (
            <section key={i}>
              {shot.caption && (
                <h3 className="m-0 px-0.5 pb-2 text-xs font-medium leading-5 text-fg">
                  {shot.caption}
                </h3>
              )}
              <div
                className={cn(
                  "grid gap-2.5",
                  paired ? "grid-cols-2 phone:grid-cols-1" : "grid-cols-1",
                )}
              >
                {(["before", "after"] as const).map(
                  (side) =>
                    shot[side] && (
                      <figure className="m-0 min-w-0" key={side}>
                        <button
                          type="button"
                          // The hairline is the edge of the picture, not a
                          // frame around a section: a screenshot of a white
                          // UI ends nowhere on a white card. The demo video
                          // above carries the same one.
                          className="relative flex w-full cursor-zoom-in items-start justify-center overflow-hidden rounded-md border border-line bg-surface p-0 text-left outline-none transition-[filter] hover:brightness-[0.98] focus-visible:shadow-[inset_0_0_0_3px_var(--accent-soft)]"
                          onClick={(event) =>
                            open(`${i}:${side}`, event.currentTarget)
                          }
                        >
                          <img
                            className="block w-full object-contain object-top"
                            src={mediaUrl(shot[side]!)}
                            alt={`${shot.caption || "change"} · ${side}`}
                            loading="lazy"
                          />
                          <span
                            className={cn(
                              SHOT_LABEL,
                              WALKTHROUGH_LABEL_TONE[side],
                            )}
                          >
                            {WALKTHROUGH_LABEL_TEXT[side]}
                          </span>
                        </button>
                      </figure>
                    ),
                )}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
