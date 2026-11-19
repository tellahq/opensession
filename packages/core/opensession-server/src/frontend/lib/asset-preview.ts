/**
 * What a scratch asset is, for the two surfaces that show one: the Assets tab
 * and the overlay a transcript chip lifts over the conversation. Both read the
 * kind from here, so they can never disagree about whether a file is a page to
 * frame, a picture to fit, or text to fetch.
 */

import type { SessionAssetFile } from "./api/sessions";

export type AssetPreviewKind =
  | "html"
  | "pdf"
  | "image"
  | "video"
  | "audio"
  | "markdown"
  | "text"
  | "binary";

export function assetPreviewKind(path: string): AssetPreviewKind {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  if (ext === "html" || ext === "htm" || ext === "svg") return "html";
  if (ext === "pdf") return "pdf";
  if (["png", "jpg", "jpeg", "gif", "webp", "ico"].includes(ext))
    return "image";
  if (["mp4", "webm", "mov"].includes(ext)) return "video";
  if (["mp3", "wav"].includes(ext)) return "audio";
  if (ext === "md") return "markdown";
  if (
    [
      "txt",
      "js",
      "mjs",
      "ts",
      "tsx",
      "jsx",
      "css",
      "json",
      "csv",
      "tsv",
      "xml",
      "yaml",
      "yml",
      "log",
      "py",
      "sh",
      "sql",
    ].includes(ext)
  )
    return "text";
  return "binary";
}

/**
 * Does this asset show as a frame rather than as a row?
 *
 * A picture or a recording is only useful once you can see it: a row saying
 * `options/1-push.mp4 · 159.0 KB` is five variants of a demo you have to open
 * one at a time. A page, a report or a data file is the opposite: its name and
 * its description ARE the content, and a thumbnail of one is a grey rectangle.
 */
export function isVisualAsset(path: string): boolean {
  const kind = assetPreviewKind(path);
  return kind === "image" || kind === "video";
}

/** How much of a text asset a preview reads — a generated log can be huge, and
 *  the point of the preview is to see what the agent produced. */
export const ASSET_TEXT_CAP = 256 * 1024;

export function formatAssetSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** A transcript chip can name a file before the folder listing catches up. */
export function assetFileFor(
  path: string,
  files: SessionAssetFile[],
): SessionAssetFile {
  return (
    files.find((file) => file.path === path) || { path, size: 0, mtime: "" }
  );
}

/** Keep an explicit selection while it exists; otherwise prefer the
 * shallowest index.html, the natural entry point of a multi-file artifact. */
export function resolvedAssetPath(
  paths: string[],
  requested: string | null,
): string | null {
  if (requested && paths.includes(requested)) return requested;
  const index = [...paths]
    .filter((path) => /(^|\/)index\.html$/.test(path))
    .sort((a, b) => a.split("/").length - b.split("/").length)[0];
  return index || paths[0] || null;
}

/**
 * The scratch asset a transcript media URL points at, if it is one.
 *
 * An inline player streams through /media?path=<abs>, which says nothing about
 * the file being an artifact — so read the assets root out of the absolute
 * path (~/.opensession/assets/<sessionId>/…, see src/server/session-assets.ts)
 * and confirm the remainder against the folder listing. That second check is
 * what makes this safe and alias-proof: a path that merely looks like an asset
 * never opens one, and a file under a historical session id still matches
 * because the listing merges those folders.
 */
export function assetPathForMediaSrc(
  src: string,
  assetPaths: readonly string[],
): string | null {
  if (!src) return null;
  let mediaPath: string | null;
  try {
    // The base only has to make a relative src parseable; nothing reads it.
    mediaPath = new URL(src, "http://media.invalid").searchParams.get("path");
  } catch {
    return null;
  }
  const rel = mediaPath
    ? /\/(?:\.opensession\/assets|\.opensession-assets)\/[^/]+\/(.+)$/.exec(
        mediaPath,
      )?.[1]
    : null;
  return rel && assetPaths.includes(rel) ? rel : null;
}

/** Move through the flat, path-sorted asset list. The overlay behaves like the
 * transcript lightbox, so reaching either end wraps around. */
export function adjacentAssetPath(
  paths: string[],
  current: string,
  direction: -1 | 1,
): string | null {
  const index = paths.indexOf(current);
  if (index === -1 || paths.length < 2) return null;
  return paths[(index + direction + paths.length) % paths.length] ?? null;
}

export type AssetFolderGroup = {
  /** The folder's path, or null for files at the top of the assets folder. */
  folder: string | null;
  files: SessionAssetFile[];
};

/**
 * The Assets tab's list order: top-level files first, then one group per
 * folder (by full path, so `a/b` follows `a`), each sorted by name. Folders
 * hold a few related files at most, so a caption over each reads better than
 * a collapsible tree.
 */
export function groupAssetsByFolder(
  files: readonly SessionAssetFile[],
): AssetFolderGroup[] {
  const groups = new Map<string, SessionAssetFile[]>();
  for (const file of files) {
    const slash = file.path.lastIndexOf("/");
    const folder = slash === -1 ? "" : file.path.slice(0, slash);
    const group = groups.get(folder);
    if (group) group.push(file);
    else groups.set(folder, [file]);
  }
  const byPath = (a: SessionAssetFile, b: SessionAssetFile) =>
    a.path.localeCompare(b.path, undefined, { numeric: true });
  return [...groups.keys()]
    .sort((a, b) =>
      a === ""
        ? -1
        : b === ""
          ? 1
          : a.localeCompare(b, undefined, { numeric: true }),
    )
    .map((folder) => ({
      folder: folder || null,
      files: [...(groups.get(folder) ?? [])].sort(byPath),
    }));
}
