/**
 * Client-side workspace overview loading for the shared SWR resource used by
 * the session right panel and sidebar hover cards. The server route is the fast
 * path; transcript-based fallbacks cover servers that have not restarted onto
 * newer overview code (routes do not hot-apply).
 */

import {
  ApiError,
  fetchSessionOverview,
  fetchTranscript,
  fetchWorkspaceOverview,
  type WorkspaceMediaItem,
  type WorkspaceOverview,
} from "./api";
import type { TranscriptEntry } from "./types";

export interface OverviewSessionRef {
  id: string;
  title: string;
  createdAt: string;
  /** When known, picks the freshest session for the lastMessage fallback. */
  lastActivity?: string;
}

function firstPrompt(entries: TranscriptEntry[]): TranscriptEntry | undefined {
  return entries.find((e) => {
    const t = e.content?.trim() || "";
    return e.type === "user" && t.length > 0 && !t.startsWith("/");
  });
}

function lastAssistant(
  entries: TranscriptEntry[],
): TranscriptEntry | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type === "assistant" && (e.content?.trim().length || 0) > 0) return e;
  }
  return undefined;
}

/** Same shape the server endpoint returns, built from raw transcripts (the
 * pre-restart fallback — data URLs render directly). */
export async function buildClientOverview(
  sessions: OverviewSessionRef[],
): Promise<WorkspaceOverview> {
  const transcripts = await Promise.all(
    sessions.map((c) =>
      fetchTranscript(c.id).catch(() => null as TranscriptEntry[] | null),
    ),
  );
  let prompt: WorkspaceOverview["prompt"] = null;
  let lastMessage: WorkspaceOverview["lastMessage"] = null;
  const media: WorkspaceMediaItem[] = [];
  sessions.forEach((session, i) => {
    const entries = transcripts[i];
    if (!entries) return;
    if (!prompt) {
      const first = firstPrompt(entries);
      if (first)
        prompt = {
          content: first.content,
          sessionId: session.id,
          at: first.timestamp,
        };
    }
    const last = lastAssistant(entries);
    if (last && (!lastMessage || last.timestamp > lastMessage.at))
      lastMessage = {
        content: last.content,
        sessionId: session.id,
        at: last.timestamp,
      };
    for (const e of entries) {
      for (const src of e.images || [])
        media.push({
          kind: "image",
          src,
          sessionId: session.id,
          sessionTitle: session.title,
          at: e.timestamp,
        });
      for (const src of e.videos || [])
        media.push({
          kind: "video",
          src,
          sessionId: session.id,
          sessionTitle: session.title,
          at: e.timestamp,
        });
    }
  });
  media.sort((a, b) => (b.at || "").localeCompare(a.at || ""));
  return { prompt, lastMessage, media: media.slice(0, 100) };
}

/**
 * One session's own overview, for its hover card. Its caller uses the same SWR
 * key a one-session workspace row uses, so a chip and that row share the
 * answer. A server that
 * predates the route (they do not hot-apply) falls back to assembling it from
 * the transcript here.
 */
export async function loadSessionOverview(
  session: OverviewSessionRef,
): Promise<WorkspaceOverview> {
  let ov: WorkspaceOverview;
  try {
    ov = await fetchSessionOverview(session.id);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404)
      ov = await buildClientOverview([session]);
    else throw e;
  }
  return ov;
}

/**
 * Load an overview (server route when the row is a real workspace, client
 * assembly otherwise). Two compatibility fallbacks:
 * a 404 means the server predates the route entirely; a response without the
 * lastMessage key means it predates the description. Fill it from the
 * freshest session's transcript so the hover card still shows one.
 */
export async function loadOverview(
  workspaceId: string | null,
  sessions: OverviewSessionRef[],
): Promise<WorkspaceOverview> {
  let ov: WorkspaceOverview;
  if (workspaceId) {
    try {
      ov = await fetchWorkspaceOverview(workspaceId);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404)
        ov = await buildClientOverview(sessions);
      else throw e;
    }
    if (ov.lastMessage === undefined && sessions.length > 0) {
      const newest = [...sessions].sort((a, b) =>
        (a.lastActivity || a.createdAt).localeCompare(
          b.lastActivity || b.createdAt,
        ),
      )[sessions.length - 1];
      try {
        const entries: TranscriptEntry[] = await fetchTranscript(newest.id);
        const last = lastAssistant(entries);
        ov.lastMessage = last
          ? { content: last.content, sessionId: newest.id, at: last.timestamp }
          : null;
      } catch {
        ov.lastMessage = null;
      }
    }
  } else {
    ov = await buildClientOverview(sessions);
  }
  return ov;
}
