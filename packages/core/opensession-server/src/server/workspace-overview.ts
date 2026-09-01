/**
 * Workspace overview — the data behind the floating "what is this workspace
 * about" panel in the session viewer (and the sidebar hover card): the opening
 * prompt (the first thing a human typed into the workspace's oldest session)
 * plus the media the workspace PRODUCED — screenshots from tool results,
 * pasted images, recorded videos — across all member sessions. A URL a tool
 * merely mentioned is not that; see `isWorkspaceArtifact`.
 *
 * Media is returned as *references*, not bytes: transcript images are base64
 * data URLs that would balloon the JSON to many MB, so each one becomes a
 * `/api/sessions/<id>/transcript-image/<entryId>/<idx>` URL the
 * browser loads (and caches) lazily. Videos already stream via
 * /media, and http(s) image URLs pass through as-is.
 */

import { existsSync } from "fs";
import { parseTranscriptAsync } from "./jsonl-parser";
import { createRecentCommitMatcher } from "./recent-commits";
import { mergedSessionTranscriptAsync } from "./sessions";
import type { TranscriptEntry, UnifiedSession } from "./types";

/**
 * What the overview needs off a session row. The transcript-locating fields
 * are picked straight off `UnifiedSession` because they are handed to
 * `mergedSessionTranscriptAsync`: a session written since the transcript-v2
 * store landed has no `transcriptPath` at all, and its history is reachable
 * only through the store.
 */
export type OverviewSession = {
  id: string;
  title?: string;
  createdAt?: string;
} & Pick<UnifiedSession, "transcriptPath">;

export interface WorkspaceMediaItem {
  kind: "image" | "video";
  src: string;
  sessionId: string;
  sessionTitle?: string;
  at: string;
}

export interface WorkspaceCommit {
  repo: string;
  sha: string;
  title: string;
  url?: string;
  committedAt: string;
  filesChanged: number;
  additions: number;
  deletions: number;
}

export interface WorkspaceOverview {
  prompt: { content: string; sessionId: string; at: string } | null;
  /** Latest assistant text across all member sessions — the "where things stand"
   *  one-liner for the sidebar hover card. */
  lastMessage: { content: string; sessionId: string; at: string } | null;
  /** Commits attributed to these sessions after they landed on a shared
   *  checkout's default branch. A branch diff can no longer see them then. */
  commits: WorkspaceCommit[];
  media: WorkspaceMediaItem[];
}

/** Newest-first cap — the panel is a glance, not an archive. */
const MEDIA_CAP = 100;

/** First human-typed turn: skip slash commands (/model, /goal) and empty
 *  image-only sends so the panel shows the actual ask. */
function isOpeningPrompt(e: TranscriptEntry): boolean {
  const t = e.content?.trim() || "";
  return e.type === "user" && t.length > 0 && !t.startsWith("/");
}

function imageSrcFor(
  sessionId: string,
  entry: TranscriptEntry,
  idx: number,
  raw: string,
): string {
  // Real bytes need the indirection — inline as a data URL, or held back in
  // the store behind an `os-blob:` marker (docs/transcripts.md §1), which no
  // browser can load. Everything else is already a URL the panel can request.
  if (!raw.startsWith("data:") && !raw.startsWith("os-blob:")) return raw;
  return `/api/sessions/${encodeURIComponent(sessionId)}/transcript-image/${encodeURIComponent(entry.id)}/${idx}`;
}

/**
 * Is this src an artifact OF the workspace, rather than something a tool
 * merely mentioned?
 *
 * The transcript already draws this line — implicit media attaches to an entry
 * but stays folded, and only `featuredMedia` is shown inline — and the panel
 * has to draw it too, because it is the one surface that promotes every
 * attachment to a visible tile. Measured across the whole store on 2026-08-12:
 * of 3,417 remote URLs harvested from tool text, not one had ever been marked
 * featured, while 533 were `example.com` fixtures and 903 were Slack avatars.
 * The rest are largely unloadable for a reader anyway (credentialed Slack and
 * Linear file hosts, expiring signed S3 links), which is what the broken tiles
 * in the panel were.
 *
 * So: bytes we hold, files that still exist, and anything the agent explicitly
 * marked. A genuine media URL from an MCP tool is the deliberate cost — it
 * stays in the transcript, and an `OPENSESSION_IMAGE:`/`OPENSESSION_VIDEO:`
 * marker is how an agent says "show this one".
 */
export function isWorkspaceArtifact(
  src: string,
  featured: Set<string>,
): boolean {
  if (featured.has(src)) return true;
  if (src.startsWith("data:") || src.startsWith("os-blob:")) return true;
  if (src.startsWith("/api/sessions/")) return true;
  const local = src.match(/^(?:\/[a-z-]+)?\/media\?path=([^&]+)$/i);
  if (!local) return false;
  try {
    return existsSync(decodeURIComponent(local[1]));
  } catch {
    return false;
  }
}

export async function buildWorkspaceOverview(
  sessions: OverviewSession[],
): Promise<WorkspaceOverview> {
  const ordered = [...sessions].sort((a, b) =>
    (a.createdAt || "").localeCompare(b.createdAt || ""),
  );

  let prompt: WorkspaceOverview["prompt"] = null;
  let lastMessage: WorkspaceOverview["lastMessage"] = null;
  const media: WorkspaceMediaItem[] = [];
  // The loop already reads every explicit member transcript. Match commits
  // against those entries as they pass instead of launching a fleet-wide actor
  // sweep from this request.
  const commitMatcher = await createRecentCommitMatcher();

  for (const session of ordered) {
    // Async: this loops over EVERY session in the workspace — back-to-back sync
    // parses of fat transcripts wedged the event loop for the whole sweep.
    // Read the way the transcript route does: a v2-store session carries no
    // `transcriptPath` at all, and skipping on that returned an all-null
    // overview for every session written since the store landed.
    const entries = await mergedSessionTranscriptAsync(session);
    if (entries.length === 0) continue;
    commitMatcher.observe(session.id, entries);
    if (!prompt) {
      const first = entries.find(isOpeningPrompt);
      if (first)
        prompt = {
          content: first.content,
          sessionId: session.id,
          at: first.timestamp,
        };
    }
    for (const e of entries) {
      if (
        e.type === "assistant" &&
        (e.content?.trim().length || 0) > 0 &&
        (!lastMessage || e.timestamp > lastMessage.at)
      )
        lastMessage = {
          content: e.content,
          sessionId: session.id,
          at: e.timestamp,
        };
    }
    for (const e of entries) {
      const featured = new Set(e.featuredMedia || []);
      for (let i = 0; i < (e.images?.length || 0); i++) {
        const raw = e.images![i];
        if (!isWorkspaceArtifact(raw, featured)) continue;
        media.push({
          kind: "image",
          src: imageSrcFor(session.id, e, i, raw),
          sessionId: session.id,
          sessionTitle: session.title,
          at: e.timestamp,
        });
      }
      for (const v of e.videos || []) {
        if (!isWorkspaceArtifact(v, featured)) continue;
        media.push({
          kind: "video",
          src: v,
          sessionId: session.id,
          sessionTitle: session.title,
          at: e.timestamp,
        });
      }
    }
  }

  media.sort((a, b) => (b.at || "").localeCompare(a.at || ""));
  const commits = commitMatcher.commits();
  return {
    prompt,
    lastMessage,
    commits: commits.map(
      ({
        repo,
        sha,
        title,
        url,
        committedAt,
        filesChanged,
        additions,
        deletions,
      }) => ({
        repo,
        sha,
        title,
        ...(url ? { url } : {}),
        committedAt,
        filesChanged,
        additions,
        deletions,
      }),
    ),
    media: media.slice(0, MEDIA_CAP),
  };
}

/**
 * Resolve one transcript image back to servable bytes. Returns null when the
 * entry/index doesn't exist, or a redirect target when the image is already a
 * plain URL.
 */
export async function resolveTranscriptImage(
  transcriptPath: string,
  entryId: string,
  idx: number,
): Promise<
  { bytes: ArrayBuffer; contentType: string } | { redirect: string } | null
> {
  const entry = (await parseTranscriptAsync(transcriptPath)).find(
    (e) => e.id === entryId,
  );
  const src = entry?.images?.[idx];
  if (!src) return null;
  if (!src.startsWith("data:")) return { redirect: src };
  const m = src.match(/^data:([^;,]+);base64,(.*)$/s);
  if (!m) return null;
  try {
    const buf = Buffer.from(m[2], "base64");
    return {
      bytes: buf.buffer.slice(
        buf.byteOffset,
        buf.byteOffset + buf.byteLength,
      ) as ArrayBuffer,
      contentType: m[1],
    };
  } catch {
    return null;
  }
}
