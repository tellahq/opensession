/**
 * Per-repo tile appearance: the chosen color, and the icon behind
 * /repo-icon/<id>.png.
 *
 * A repo with no icon of its own wears a colored letter (see
 * repo-tile-colors.ts). This is how that gets overridden by hand from
 * Settings → Setup: pick one of the palette colors, or give the repo real art.
 *
 * Art comes from one of two places: GitHub — a repo has no avatar of its own
 * there, so what's available is its OWNER's — or a PNG someone uploads. The
 * GitHub one used to be the automatic fallback for every repo, which is
 * exactly what made every repo in one org wear the same tile; as a per-repo
 * choice it's fine, because someone decided this repo should be the one
 * wearing it.
 *
 * Fetched art is stored in the instance state dir rather than the checkout:
 * it's instance configuration, and a worktree is not ours to write into.
 */

import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "fs";
import { configuredRepos } from "./config";
import {
  persistRawConfig,
  rawConfig,
  repoSectionForMutation,
  withConfigMutationLock,
} from "./config-mutation";
import { stateDir } from "./paths";
import { trimIconMargin } from "./png-trim";
import { REPO_TILE_COLORS, currentTileColor } from "./repo-tile-colors";

/** Where fetched icons live: ~/.opensession-repo-icons/<id>.png. */
export function repoIconPath(id: string): string {
  return `${stateDir("repo-icons")}/${id}.png`;
}

/** A stored icon's mtime, for cache-busting the tile after a change. */
export function repoIconRevision(iconPath: string | undefined): number | null {
  if (!iconPath || !existsSync(iconPath)) return null;
  try {
    return Math.floor(statSync(iconPath).mtimeMs);
  } catch {
    return null;
  }
}

export class RepoAppearanceError extends Error {}

/** Only palette colors: a free-form hex would let a tile fight the UI. */
function validColor(color: string): boolean {
  return REPO_TILE_COLORS.includes(color.toLowerCase());
}

/** The GitHub account whose avatar this repo can wear, if it has one. */
export function repoAvatarOwner(id: string): string | undefined {
  return configuredRepos()[id]?.ghRepo?.split("/")[0] || undefined;
}

/**
 * The owner's avatar bytes, tile-shaped. Also serves the picker's preview:
 * showing the actual picture as one of the choices beats a button that only
 * promises one, and it comes from here rather than github.com directly so the
 * browser needs no reach the server doesn't already have.
 */
export async function fetchOwnerAvatar(owner: string): Promise<Uint8Array> {
  const res = await fetch(
    `https://github.com/${encodeURIComponent(owner)}.png?size=256`,
    { redirect: "follow", signal: AbortSignal.timeout(10_000) },
  );
  if (!res.ok) {
    throw new RepoAppearanceError(
      `GitHub returned ${res.status} for ${owner}'s avatar`,
    );
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (!bytes.length) {
    throw new RepoAppearanceError(`${owner}'s avatar came back empty`);
  }
  // Avatars are uploaded art with whatever padding their author chose —
  // an org mark can sit on 62% of its canvas. Crop it now so the stored file
  // is already tile-shaped.
  return trimIconMargin(bytes) ?? bytes;
}

export interface RepoAppearancePatch {
  /** A palette color, or null to go back to the assigned one. */
  color?: string | null;
  /** "github" fetches the owner's avatar; null drops the icon. */
  icon?: "github" | null;
}

export interface RepoAppearance {
  color: string | null;
  hasIcon: boolean;
  iconRev: number | null;
  /** Which of the picker's icon choices produced the art in use. */
  iconSource: "github" | "upload" | null;
}

/**
 * Write the config half of a change and report what the repo ended up with,
 * so the caller doesn't have to re-read the config to answer the request.
 * `icon` is the path to point at, null to clear, undefined to leave alone.
 */
function persistAppearance(
  id: string,
  edits: {
    color?: string | null;
    icon?: string | null;
    iconSource?: "github" | "upload";
  },
): Promise<RepoAppearance> {
  return withConfigMutationLock(async () => {
    const config = rawConfig();
    const section = repoSectionForMutation(config, id);
    if (!section) throw new RepoAppearanceError(`Unknown repository: ${id}`);

    if (edits.color !== undefined) {
      if (edits.color === null) delete section.color;
      else section.color = edits.color.toLowerCase();
    }
    if (edits.icon !== undefined) {
      // Clearing only drops what we manage. A repo pointed at art inside
      // its own checkout keeps it — that's a config choice, not ours to
      // undo from a settings toggle.
      if (edits.icon === null) {
        delete section.icon;
        delete section.iconSource;
      } else {
        section.icon = edits.icon;
        if (edits.iconSource) section.iconSource = edits.iconSource;
        else delete section.iconSource;
      }
    }
    persistRawConfig(config);

    const now = configuredRepos()[id];
    const resolved = resolveRepoIcon(now?.icon, now?.repo);
    const stored = now?.color as string | undefined;
    return {
      // Through currentTileColor for the same reason the repo list is: a
      // color picked before the palette was brightened reads as its
      // replacement rather than as the old muted tone.
      color: stored ? currentTileColor(stored) : null,
      hasIcon: !!resolved,
      iconRev: repoIconRevision(resolved),
      iconSource: resolved
        ? ((now?.iconSource as "github" | "upload" | undefined) ?? null)
        : null,
    };
  });
}

/**
 * Apply a patch and persist it. Returns what the repo ended up with, so the
 * caller doesn't have to re-read the config to answer the request.
 */
export async function updateRepoAppearance(
  id: string,
  patch: RepoAppearancePatch,
): Promise<RepoAppearance> {
  const repo = configuredRepos()[id];
  if (!repo) throw new RepoAppearanceError(`Unknown repository: ${id}`);
  if (patch.color != null && !validColor(patch.color)) {
    throw new RepoAppearanceError("Color must be one of the tile colors");
  }

  // The network fetch happens BEFORE the config lock: it's the slow, failable
  // half, and a failed download shouldn't hold every other config write.
  let fetched: Uint8Array | null = null;
  if (patch.icon === "github") {
    const owner = repoAvatarOwner(id);
    if (!owner) {
      throw new RepoAppearanceError(
        `${id} has no GitHub repository configured to take an avatar from`,
      );
    }
    fetched = await fetchOwnerAvatar(owner);
  }

  const iconPath = repoIconPath(id);
  if (fetched) {
    mkdirSync(stateDir("repo-icons"), { recursive: true });
    writeFileSync(iconPath, fetched);
  } else if (patch.icon === null && existsSync(iconPath)) {
    rmSync(iconPath, { force: true });
  }

  return persistAppearance(id, {
    color: patch.color,
    icon:
      patch.icon === undefined
        ? undefined
        : patch.icon === null
          ? null
          : iconPath,
    ...(patch.icon === "github" ? { iconSource: "github" as const } : {}),
  });
}

/** Uploaded icons are small art, not photographs — 4 MB is already generous. */
const MAX_ICON_BYTES = 4 * 1024 * 1024;

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

/**
 * Store art someone uploaded as this repo's icon.
 *
 * PNG only, and deliberately so: the tile route serves one content type, and
 * nothing here decodes anything else (png-trim.ts is dependency-free on
 * purpose). The browser does the converting — it can already decode whatever
 * the person picked, so the picker re-encodes through a canvas before sending.
 */
export async function uploadRepoIcon(
  id: string,
  bytes: Uint8Array,
): Promise<RepoAppearance> {
  if (!configuredRepos()[id]) {
    throw new RepoAppearanceError(`Unknown repository: ${id}`);
  }
  if (!bytes.length) throw new RepoAppearanceError("The upload was empty");
  if (bytes.length > MAX_ICON_BYTES) {
    throw new RepoAppearanceError(
      "That image is too large — icons cap at 4 MB",
    );
  }
  if (PNG_SIGNATURE.some((byte, i) => bytes[i] !== byte)) {
    throw new RepoAppearanceError("An uploaded icon has to be a PNG");
  }
  const iconPath = repoIconPath(id);
  mkdirSync(stateDir("repo-icons"), { recursive: true });
  writeFileSync(iconPath, trimIconMargin(bytes) ?? bytes);
  return persistAppearance(id, { icon: iconPath, iconSource: "upload" });
}

/** A repo's icon as an absolute path, or undefined when it has none. */
export function resolveRepoIcon(
  icon: string | undefined,
  checkout: string | undefined,
): string | undefined {
  if (!icon) return undefined;
  const path = icon.startsWith("/") ? icon : `${checkout}/${icon}`;
  return existsSync(path) ? path : undefined;
}
