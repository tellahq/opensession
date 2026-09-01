import { mergeStylexProps } from "../ui/cn";
import { utilityClassName } from "../ui/cn";
import React, { useEffect, useState } from "react";
import { cn } from "../ui/cn";
import * as stylex from "@stylexjs/stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
  absolute: {
    position: "absolute",
  },
  inset0: {
    inset: "0",
  },
  sizeFull: {
    width: "100%",
    height: "100%",
  },
  roundedInherit: {
    borderRadius: "inherit",
    cornerShape: "var(--cs)",
  },
  CornerShapeInherit: {
    cornerShape: "inherit",
  },
  objectCover: {
    objectFit: "cover",
  },
});

/**
 * GitHub logins for the team, keyed by lowercased first name — the shape of
 * web user-picker names, presence viewers and `startedBy`, and also the first
 * token of full names coming from chat integrations. lib/people.ts populates
 * the map from the server directory (GET /api/people).
 */
const GITHUB_LOGIN: Record<string, string> = {};

/**
 * Uploaded profile pictures, same keying as the login map above. A person who
 * has set one is drawn with it everywhere instead of their GitHub avatar
 * (server: user-profiles.ts, published on GET /api/people).
 */
const PROFILE_IMAGE: Record<string, string> = {};

/** Merge directory-fetched logins into the map (lib/people.ts). */
export function registerGithubLogins(entries: Record<string, string>) {
  Object.assign(GITHUB_LOGIN, entries);
}

/** Merge directory-fetched pictures into the map (lib/people.ts). Replaces
 *  rather than merges per key, so clearing a picture clears the tile. */
export function registerProfileImages(entries: Record<string, string>) {
  for (const key of Object.keys(PROFILE_IMAGE)) delete PROFILE_IMAGE[key];
  Object.assign(PROFILE_IMAGE, entries);
}

export function githubLoginFor(name?: string | null): string | null {
  if (!name) return null;
  const first = name.trim().split(/\s+/)[0]?.toLowerCase();
  return (first && GITHUB_LOGIN[first]) || null;
}

export function profileImageFor(name?: string | null): string | null {
  if (!name) return null;
  const first = name.trim().split(/\s+/)[0]?.toLowerCase();
  return (first && PROFILE_IMAGE[first]) || null;
}

/**
 * Squircle user picture: their uploaded profile picture, else their GitHub
 * avatar, else their initial (the agent persona, Anonymous, or an image that
 * fails to load). `children` render on top of the squircle — the presence
 * facepile uses that for its count badge.
 *
 * `login` overrides the directory lookup for callers that already hold the
 * GitHub login — the members roster edits the identity table itself, so its
 * rows must picture the login being typed rather than the one /api/people
 * last published. `image` does the same for the uploaded picture, which is
 * what lets the profile page preview a new one before it is saved.
 */
export function UserAvatar({
  name,
  login: loginProp,
  image: imageProp,
  size = 24,
  edge = true,
  glow = false,
  className,
  title,
  style,
  children,
}: {
  name: string;
  login?: string | null;
  /** Uploaded picture URL. Overrides the directory lookup. */
  image?: string | null;
  size?: number;
  /** Draw the hairline around a photo. Off where the picture is one glyph in
   *  a row of chrome and an edge reads as a second box. */
  edge?: boolean;
  /** Add the lifted glow used by prominent setup tiles. */
  glow?: boolean;
  className?: string;
  title?: string;
  style?: React.CSSProperties;
  children?: React.ReactNode;
}) {
  const login = loginProp?.trim() || githubLoginFor(name);
  // An uploaded picture is the person's own choice, so it outranks the
  // GitHub avatar, which is only ever a stand-in for one.
  const uploaded = imageProp?.trim() || profileImageFor(name);
  const src =
    uploaded ||
    (login ? `https://github.com/${login}.png?size=${size * 2}` : "");
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  const picture = !!src && !failed;
  return (
    <span
      className={cn(
        // The hairline separates a photo from the surface behind it. The
        // initial fallback is already its own flat tile, so it takes no
        // edge — the variable stays defined (transparent) because callers
        // compose it into a larger box-shadow (TeamPresence's pile ring).
        picture && edge
          ? "[--avatar-edge:inset_0_0_0_1px_color-mix(in_srgb,var(--text)_14%,transparent)]"
          : "[--avatar-edge:0_0_0_0_transparent]",
        utilityClassName(
          "relative inline-flex shrink-0 items-center justify-center",
        ),
        utilityClassName(
          "rounded-avatar bg-active font-bold text-dim shadow-[var(--avatar-edge)] select-none",
        ),
        className,
      )}
      style={{
        width: size,
        height: size,
        fontSize: Math.max(9, Math.round(size * 0.46)),
        boxShadow: glow
          ? "var(--avatar-edge), 0 1px 2px rgba(0, 0, 0, 0.08), 0 5px 14px -6px color-mix(in srgb, var(--accent) 42%, transparent)"
          : undefined,
        ...style,
      }}
      title={title}
    >
      {picture ? (
        <img
          src={src}
          alt={name}
          // `corner-shape` is not inherited, and base.css squircles
          // anything carrying a `rounded-*` class — so a photo inside a
          // frame a caller made round (`rounded-full`, which opts out)
          // took the radius but kept the squircle, and only the frame's
          // clip hid it. Inheriting the shape as well as the radius is
          // what makes the picture the frame's shape, always.
          {...mergeStylexProps(
            "shadow-[var(--avatar-edge)]",
            sx.absolute,
            sx.inset0,
            sx.sizeFull,
            sx.roundedInherit,
            sx.CornerShapeInherit,
            sx.objectCover,
          )}
          loading="lazy"
          draggable={false}
          onError={() => setFailed(true)}
        />
      ) : (
        name.charAt(0).toUpperCase()
      )}
      {children}
    </span>
  );
}
