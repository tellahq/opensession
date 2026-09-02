import React, { useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { SessionWalkthrough } from "../lib/types";
import { renderMarkdown } from "../lib/markdown";
import { relativeTime } from "../lib/api";
import {
  WALKTHROUGH_LABEL_CLASS,
  WALKTHROUGH_LABEL_TEXT,
  WALKTHROUGH_LABEL_TONE,
} from "../lib/walkthrough-label";
import { walkthroughLede } from "../lib/walkthrough-lede";
import { cn } from "../ui/cn";
import { ease } from "../ui/motion";
import { IconChevronDown, IconPlay, IconPlayRectangle } from "./icons";
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
 * it. A tight shadow under the hairline is what lifts it off the picture, now
 * that the tile's corner no longer holds it in place.
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
 * before/after screenshot pairs + writeup. Rendered at the top of the PR info
 * column in the Review tab (`panel`), and inline in the session where the agent
 * published it (`session`) — the video plays right there instead of only living
 * behind a tab. Both are the inline counterpart of the link-only section
 * mirrored into the GitHub PR description.
 *
 * In the session it stays in the transcript's reading column and expands only
 * downward. In the Review tab the card IS the content of the column, so it
 * stays open.
 */
export function WalkthroughCard({
  walkthrough,
  variant = "panel",
}: {
  walkthrough: SessionWalkthrough;
  variant?: "panel" | "session";
}) {
  const session = variant === "session";
  const [expanded, setExpanded] = useState(!session);
  // Natural ratio of any folded tile whose picture the tile shape would crop
  // too much of (see tileBox). Learned on load; media the tile already suits
  // never lands here, so it never re-renders.
  const [ownRatio, setOwnRatio] = useState<Record<string, number>>({});
  const reduceMotion = useReducedMotion();
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
    let stillCount = 0;
    (walkthrough.shots || []).forEach((shot, i) => {
      for (const side of ["before", "after"] as const) {
        const path = shot[side];
        if (!path) continue;
        at.set(`${i}:${side}`, items.length);
        stillCount += 1;
        items.push({
          kind: "image",
          src: mediaUrl(path),
          walkthroughLabel: side,
          sessionTitle: shot.caption,
        });
      }
    });
    return { items, at, stillCount };
  })();

  // What the card holds, for the folded header — the one thing a reader needs
  // to decide whether to open it. Open, they can see that for themselves, so
  // the slot goes back to saying when it was published.
  const contentsLabel =
    [
      walkthrough.video ? "Demo" : "",
      gallery.stillCount
        ? `${gallery.stillCount} still${gallery.stillCount === 1 ? "" : "s"}`
        : "",
    ]
      .filter(Boolean)
      .join(" · ") || (walkthrough.summary ? "Writeup" : "");
  // What the folded card says above its pictures, so a reader learns what
  // changed without opening it (see walkthroughLede).
  const lede = walkthroughLede(walkthrough.summary);
  const open = (key: string, target: HTMLElement) =>
    openLightbox(gallery.items, gallery.at.get(key) ?? 0, target);

  // How big a folded tile gets, set by how many there are. A thumbnail of a UI
  // is a picture of small things, so a tile only answers "what changed" once
  // it is big enough to read — and a card with one or two pieces of media has
  // the whole card to give them. There it stops being a strip at all: the
  // tiles divide the card's width, which is both the largest they can be and
  // the only size that never cuts the second one off. Past that the card has
  // more than it can show at once, so the tiles go back to a scrolling strip
  // at a fixed size, stepping down as the count goes up. The phone keeps the
  // small tile throughout — the card is narrow enough there that a wide one
  // shows a picture and a half.
  const fill = gallery.items.length <= 2;
  const tile =
    gallery.items.length <= 4 ? "w-40 desktop:w-64" : "w-40 desktop:w-56";

  // What a folded tile does with a picture that is not the shape of the tile.
  // Cropping to 16/10 is honest for a landscape screenshot and useless for a
  // phone one: cropped that way it is a status bar and a header, and at the
  // fill size it is that sliver blown up to the width of the card. So a tile
  // crops only while it still shows three quarters of the picture, which it
  // does from 1.2 (a portrait shot) to 2.13 (a wide strip of UI); outside
  // that the media keeps its own ratio and is shown whole.
  const TILE_RATIO = 16 / 10;
  const noteRatio = (key: string, w: number, h: number) => {
    if (!w || !h) return;
    const ratio = w / h;
    const shown = ratio < TILE_RATIO ? ratio / TILE_RATIO : TILE_RATIO / ratio;
    if (shown >= 0.75) return;
    setOwnRatio((prev) => (prev[key] ? prev : { ...prev, [key]: ratio }));
  };
  // A tall tile is sized off a height, which is what keeps it at the scale of
  // its neighbours instead of running the card; a wide one keeps the width it
  // was given and is simply shorter. The height goes through a variable so the
  // width can be derived from it in the same declaration: `aspect-ratio` with
  // `width: auto` resolves against the caption whenever the caption is the
  // wider of the two, which lands the picture in a letterboxed tile.
  const isTall = (key: string) => (ownRatio[key] ?? TILE_RATIO) < TILE_RATIO;
  const tileBox = (key: string) => {
    const ratio = ownRatio[key];
    if (!ratio) return { className: "aspect-[16/10] w-full", style: undefined };
    if (!isTall(key))
      return {
        className: "w-full",
        style: { aspectRatio: String(ratio) },
      };
    return {
      className: cn(
        "max-w-full",
        fill
          ? "[--tile-h:320px] desktop:[--tile-h:384px]"
          : "[--tile-h:100px] desktop:[--tile-h:160px]",
      ),
      style: {
        height: "var(--tile-h)",
        width: `calc(var(--tile-h) * ${ratio})`,
      },
    };
  };

  return (
    <div
      className={cn(
        // White in light mode, with only a close edge shadow. The walkthrough
        // should read as finished proof, not a panel floating over the transcript.
        "rounded-xl border border-line/60 bg-surface p-4 smooth-shadow-xs",
        // In the session the card is a transcript block like any other, so it
        // takes the same centered reading column the turns and footers use
        // (mx-auto + --session-col) instead of spanning the whole pane. It
        // trails more space than it leads: unlike the neighbouring blocks
        // it ends in media, which otherwise butts straight into the next
        // message.
        session && "mx-auto mb-6 mt-2 w-full max-w-[var(--session-col)]",
        !session && "mb-4",
      )}
    >
      {session ? (
        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded(!expanded)}
            // Keep the fold's 14px title and 20px chevron. The play-in-screen
            // glyph mirrors the native app without adding another icon tile.
            // The row is the height of its own contents, like the turn fold
            // it sits among — a 40px row spent 20 of them holding the title
            // away from a card edge that already has padding of its own, so
            // the header read as a band and the folded card as a panel.
            // The hover is the turn fold's: a half-strength wash, which on a
            // row this wide is the difference between saying "this is live"
            // and lighting a slab the size of the card. The chevron takes
            // the rest of it, at its own scale — the whole row folds, but
            // the chevron is what a reader is aiming at.
            className="group -m-1 flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-control border-0 bg-transparent p-1 text-left font-sans text-item-title leading-5 text-dim outline-none transition-colors hover:bg-hover/40 focus-visible:shadow-[0_0_0_3px_var(--accent-soft)]"
          >
            {/* The walkthrough's own icon leads the line, so the row is
					    named before it is operated; the chevron trails at the far
					    edge, where it reads as this card's disclosure rather than
					    as another indent level in the transcript. */}
            <IconPlayRectangle size={20} className="flex-shrink-0 text-faint" />
            <span className="flex-shrink-0 font-semibold text-fg">
              Walkthrough
            </span>
            <span className="ml-auto max-w-40 flex-shrink truncate text-label leading-4 text-faint phone:max-w-24">
              {expanded
                ? walkthrough.publishedAt
                  ? relativeTime(walkthrough.publishedAt)
                  : ""
                : contentsLabel}
            </span>
            <span
              className={cn(
                "grid size-5 flex-shrink-0 place-items-center leading-none text-faint transition-[transform,color] duration-150 group-hover:text-dim",
                !expanded && "-rotate-90",
              )}
            >
              <IconChevronDown size={20} className="block" />
            </span>
          </button>
        </div>
      ) : (
        <div className="mb-2 flex items-center gap-1.5">
          <IconPlayRectangle size={20} className="text-faint" />
          <span className="text-xs font-semibold text-dim">Walkthrough</span>
        </div>
      )}

      {!expanded &&
        lede && (
          // The writeup's first line, above the strip. Folded, the card used
          // to be a row of thumbnails with nothing saying what they were of,
          // so seeing what changed meant opening every walkthrough in the
          // transcript. Three lines is what the paragraph usually is; the
          // rest of the writeup stays behind the fold, which is what the
          // fold is for.
          <p className="m-0 mt-2 line-clamp-3 text-supporting leading-5 text-dim [overflow-wrap:anywhere] [text-wrap:pretty]">
            {lede}
          </p>
        )}

      {!expanded &&
        gallery.items.length > 0 && (
          // The folded card's media. One or two pieces of it share the card's
          // width and there is nothing to scroll; more than that keeps the
          // scrolling strip, where the demo and every still are one size —
          // flexing each comparison group independently made an unpaired image
          // twice as wide as either side of a pair. Tight within a pair and
          // loose between them keeps the relationship without changing scale.
          // The strip runs to the card's edges rather than stopping at its
          // padding — a tile cut off by the padding looks like a rendering bug,
          // one that runs under the edge reads as "there is more this way".
          <div
            className={cn(
              "mt-2",
              !fill &&
                "-mx-4 overflow-x-auto px-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
            )}
          >
            <div className={cn("flex items-start gap-4", !fill && "w-max")}>
              {walkthrough.video && (
                <figure
                  className={cn(
                    "m-0",
                    isTall("video")
                      ? "shrink-0"
                      : fill
                        ? "min-w-0 flex-1"
                        : cn("shrink-0", tile),
                  )}
                >
                  <button
                    type="button"
                    className={cn(
                      "relative block cursor-zoom-in overflow-hidden rounded-md border border-line bg-black p-0 outline-none focus-visible:shadow-[0_0_0_3px_var(--accent-soft)]",
                      tileBox("video").className,
                    )}
                    style={tileBox("video").style}
                    aria-label="Open demo in media viewer"
                    onClick={(event) => open("video", event.currentTarget)}
                  >
                    <video
                      className={cn(
                        "h-full w-full",
                        ownRatio.video ? "object-contain" : "object-cover",
                      )}
                      src={`${mediaUrl(walkthrough.video)}#t=0.1`}
                      preload="metadata"
                      muted
                      tabIndex={-1}
                      onLoadedMetadata={(event) =>
                        noteRatio(
                          "video",
                          event.currentTarget.videoWidth,
                          event.currentTarget.videoHeight,
                        )
                      }
                    />
                    <span className="absolute inset-0 grid place-items-center bg-black/25 text-white">
                      <IconPlay size={18} className="ml-0.5" />
                    </span>
                    {/* After the scrim, so the pill keeps its own contrast
									    rather than sitting under a wash of black. */}
                    <span
                      className={cn(SHOT_LABEL, WALKTHROUGH_LABEL_TONE.demo)}
                    >
                      {WALKTHROUGH_LABEL_TEXT.demo}
                    </span>
                  </button>
                </figure>
              )}
              {(walkthrough.shots || []).map((shot, i) => (
                <div
                  className={cn(
                    "flex gap-1",
                    fill &&
                      !(isTall(`${i}:before`) || isTall(`${i}:after`)) &&
                      "min-w-0 flex-1",
                    (!fill || isTall(`${i}:before`) || isTall(`${i}:after`)) &&
                      "shrink-0",
                  )}
                  key={i}
                >
                  {(["before", "after"] as const).map(
                    (side) =>
                      shot[side] && (
                        <figure
                          // One tile size for the demo and every still,
                          // wider where there is room for it: a thumbnail
                          // of a UI is a picture of small things, and two
                          // 160px tiles of the same screen are hard to
                          // tell apart — which makes the folded strip
                          // decorative rather than the answer to "what
                          // changed". How wide is `fill`/`tile`, above.
                          className={cn(
                            "m-0",
                            isTall(`${i}:${side}`)
                              ? "shrink-0"
                              : fill
                                ? "min-w-0 flex-1"
                                : cn("shrink-0", tile),
                          )}
                          key={side}
                        >
                          <button
                            type="button"
                            // A landscape tile is sized by width, and takes
                            // no height cap on top of the ratio: that would
                            // silently letterbox the wide sizes. A narrow
                            // one is sized by height instead (tileBox).
                            className={cn(
                              "relative block cursor-zoom-in overflow-hidden rounded-md border border-line bg-transparent p-0 outline-none focus-visible:shadow-[0_0_0_3px_var(--accent-soft)]",
                              tileBox(`${i}:${side}`).className,
                            )}
                            style={tileBox(`${i}:${side}`).style}
                            onClick={(e) =>
                              open(`${i}:${side}`, e.currentTarget)
                            }
                          >
                            {/* The alt names the button. An aria-label here
													    would replace the caption with six identical
													    "Open before image preview"s. */}
                            <img
                              className={cn(
                                "h-full w-full",
                                ownRatio[`${i}:${side}`]
                                  ? "object-contain"
                                  : "object-cover object-top",
                              )}
                              src={mediaUrl(shot[side]!)}
                              alt={`${shot.caption || "Change"} · ${side}`}
                              loading="lazy"
                              onLoad={(event) =>
                                noteRatio(
                                  `${i}:${side}`,
                                  event.currentTarget.naturalWidth,
                                  event.currentTarget.naturalHeight,
                                )
                              }
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
              ))}
            </div>
          </div>
        )}

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            key="walkthrough-body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={
              reduceMotion
                ? { duration: 0 }
                : {
                    // Height carries the spatial change. A critically damped
                    // spring makes a quick reversal continue from the live size
                    // instead of restarting a fixed tween. Opacity lands sooner
                    // so the content feels attached to the opening surface.
                    height: { type: "spring", duration: 0.36, bounce: 0 },
                    opacity: { type: "tween", duration: 0.2, ease },
                  }
            }
            className={session ? "overflow-hidden" : undefined}
          >
            {/* No rule under the header: the card is already one surface,
						    and open, the header and the writeup read as parts of it.
						    The gap does the separating. */}
            <div className={cn("space-y-5", session ? "mt-4" : "mt-3")}>
              <section className="px-0.5">
                <h3 className="m-0 mb-1.5 text-meta font-semibold leading-4 text-faint">
                  Summary
                </h3>
                <MarkdownBody
                  html={summaryHtml}
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
                    className={cn(
                      "w-full rounded-md bg-black shadow-[0_0_0_1px_var(--border)]",
                      session && "max-h-[60vh] object-contain",
                    )}
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
                        paired
                          ? "grid-cols-2 phone:grid-cols-1"
                          : "grid-cols-1",
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
                                // UI ends nowhere on a white card. The folded
                                // tiles and the demo video above carry the same
                                // one, so open is where it was missing.
                                className="relative flex w-full cursor-zoom-in items-start justify-center overflow-hidden rounded-md border border-line bg-surface p-0 text-left outline-none transition-[filter] hover:brightness-[0.98] focus-visible:shadow-[inset_0_0_0_3px_var(--accent-soft)]"
                                onClick={(event) =>
                                  open(`${i}:${side}`, event.currentTarget)
                                }
                              >
                                <img
                                  className={cn(
                                    "block object-contain object-top",
                                    // A cap on HEIGHT costs a PORTRAIT shot its
                                    // width too: a phone screenshot is about
                                    // twice as tall as it is wide, so every
                                    // point off the ceiling takes half a point
                                    // off the picture. At 256px one rendered
                                    // ~120px across — a column of grey. 384
                                    // still leaves the pair, the writeup above
                                    // it and the next block in view.
                                    session ? "max-h-96 max-w-full" : "w-full",
                                  )}
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
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
