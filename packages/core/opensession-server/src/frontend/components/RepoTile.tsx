import { utilityClassName } from "../ui/cn";
import React from "react";
import { cn } from "../ui/cn";
import { markTileShadow } from "../lib/mark-tile";
import { repoLetter } from "../lib/repo-label";
import {
  hasRepoIcon,
  hasRoundRepoIcon,
  REPO_TILE_INK,
  repoColor,
  repoIconFill,
  repoIconRevision,
} from "../lib/repo-colors";
import * as stylex from "@stylexjs/stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  sizeFull: {
    width: "100%",
    height: "100%",
  },
  objectCover: {
    objectFit: "cover",
  },
  BorderRadiusInherit: {
    borderRadius: "inherit",
    cornerShape: "var(--cs)",
  },
});

// The display-name map lives in lib/repo-label and the tile colors in
// lib/repo-colors, so lib-level formatters can reach both without a component
// import; re-exported here because most callers reach them alongside the tile.
// Both stay keyed on the raw id, so they're stable across a display rename.
export { repoLabel } from "../lib/repo-label";
export { repoColor } from "../lib/repo-colors";

// Bumped when the icons behind /repo-icon/<id>.png are redrawn: the response
// is cacheable, so without a new URL an installed PWA keeps painting the old
// art until its copy expires. 3 dropped the owner/org-avatar fallback, so the
// repos that were wearing their org's mark had to stop asking for it; 4 trims
// the empty margin around every icon, so the copies drawn small have to go; 5
// pads by ink rather than by bounding box, which grows the round ones; 6 drops
// the padding entirely, so an icon reaches the tile's edge the way a lettered
// tile's color does.
const ICON_VERSION = 6;

// A repo's icon tile (sidebar Repo dropdown, session-header breadcrumb, repo
// menus): the server's /repo-icon/<id>.png when the repo was given an icon of
// its own, else a colored letter — the default, and deliberately so, since an
// org's mark is the same picture for every repo it owns. The color is assigned
// per repo across the registered set (lib/repo-colors), so two tiles differ
// even when their letters don't. Every icon arrives drawn to the same
// proportions (see the route), so the tile scales them all identically.
// `size` (px) shrinks it for tight spots like the phone header's model line;
// omitted = the 18px default. Tiles are squircles unless `round` requests a
// circle (e.g. the phone title pill), or the only available artwork is an
// inherently circular GitHub owner avatar. In that case the container follows
// the art instead of drawing empty squircle corners around it.
//
// `className` is merged so a caller can adjust the tile in place instead of
// reaching through `.repo-tile` from an ancestor's stylesheet — the sidebar's
// repo bands wear a 22px tile that way. Note it cannot override what `size`
// sets: those land as INLINE style below, which beats any utility. Geometry a
// caller wants scaled proportionally (radius and letter together) belongs in
// `size`; a caller that needs only some of it passes utilities here.
//
// `repo-tile` itself is now a bare hook, not styling: one ancestor still reaches
// the tile through it — INFO_HERO's `[&_.repo-tile]:shadow-[…]` (the phone
// session-info hero). The phone header used to be a second, but its tile moved
// out of the metadata line and into the title pill's own leading slot, and the
// rule that held it there had been matching nothing since.
const TILE =
  // Settings applies body leading to every descendant, which makes the fallback
  // letter's line box taller than the tile and leaves its cap height visibly
  // high. A direct-child rule wins that page-level override, then flex centers
  // the tight line box without an extra baseline offset.
  utilityClassName(
    "repo-tile inline-flex size-[18px] shrink-0 items-center justify-center overflow-hidden rounded-sm text-meta font-bold [&>span]:!leading-none",
  );

export function RepoTile({
  name,
  size,
  round,
  glow = false,
  className,
}: {
  name: string;
  size?: number;
  round?: boolean;
  glow?: boolean;
  className?: string;
}) {
  // Failure is tracked per name AND icon revision, so a tile retries the img
  // both when it switches repo and when this repo's art changes — a repo
  // given an icon from Settings had already 404'd, and without the revision
  // in the key it would keep painting its letter until a reload.
  const [failedFor, setFailedFor] = React.useState<string | null>(null);
  const rev = repoIconRevision(name);
  const attempt = `${name}:${rev ?? 0}`;
  const usingIcon = hasRepoIcon(name) && failedFor !== attempt;
  const circular = Boolean(round || (usingIcon && hasRoundRepoIcon(name)));
  const style: React.CSSProperties = {};
  if (size) {
    style.width = size;
    style.height = size;
    style.fontSize = Math.round(size * 0.6);
    style.borderRadius = circular
      ? "50%"
      : Math.max(3, Math.round(size * 0.28));
  } else if (circular) {
    style.borderRadius = "50%";
  }
  // The tile's ink, on BOTH variants. legacy.css put `color: #fff` on
  // `.repo-tile` itself, which the image variant inherited too — so it stays
  // on both, from the same module as the fill (the two are chosen together,
  // see REPO_TILE_INK) rather than as a raw colour in a utility.
  style.color = REPO_TILE_INK;
  if (glow) style.boxShadow = markTileShadow(repoColor(name));
  if (usingIcon) {
    return (
      <span
        className={cn(
          TILE,
          circular && utilityClassName("rounded-full"),
          className,
        )}
        style={style}
      >
        {/* The image fills the tile. The parent clips it to the same squircle
				    (or source-matched circle) as its border, so transparent or square
				    artwork cannot sit inside a smaller-looking inner box. No inset on
				    purpose: the route crops every icon to its artwork and adds no
				    margin back (png-trim.ts), so its ink reaches the same frame as a
				    letter tile. `border-radius: inherit` keeps the non-squircle browser
				    fallback aligned with that clipping edge. */}
        <img
          src={`/repo-icon/${encodeURIComponent(name)}.png?v=${ICON_VERSION}${
            rev ? `&r=${rev}` : ""
          }`}
          alt=""
          loading="lazy"
          {...stylex.props(sx.sizeFull, sx.objectCover, sx.BorderRadiusInherit)}
          onError={() => setFailedFor(attempt)}
        />
      </span>
    );
  }
  style.background = repoIconFill(repoColor(name));
  const letter = repoLetter(name);
  return (
    <span
      className={cn(
        TILE,
        circular && utilityClassName("rounded-full"),
        className,
      )}
      style={style}
    >
      <span>{letter}</span>
    </span>
  );
}
