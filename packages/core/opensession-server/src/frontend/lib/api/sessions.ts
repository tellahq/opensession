import { ApiError, BASE, request } from "./request";
import type { SessionNote, TranscriptEntry, UnifiedSession } from "../types";
import { resolveAnonymousUserPath } from "../auth-ready";
import { preparePromptImages } from "../images";

/**
 * One slice of the session list.
 *
 * `query` scopes it server-side: the app polls `?archived=exclude` for the
 * live list and fetches `?archived=only&slim=1` separately for the archived
 * index, because archived sessions are ~46% of the payload and none of the
 * cold start needs them. Each slice carries its own ETag, so the archived one
 * settles into a 304 while the live one keeps changing.
 */
export async function fetchSessionsSnapshot(
  opts: { etag?: string | null; signal?: AbortSignal; query?: string } = {},
): Promise<{
  text: string | null;
  etag: string | null;
  notModified: boolean;
}> {
  const path = await resolveAnonymousUserPath(`/sessions${opts.query || ""}`);
  const res = await fetch(`${BASE}${path}`, {
    signal: opts.signal,
    headers: opts.etag ? { "If-None-Match": opts.etag } : undefined,
  });
  if (res.status === 304) {
    return {
      text: null,
      etag: res.headers.get("ETag") || opts.etag || null,
      notModified: true,
    };
  }
  if (!res.ok)
    throw new ApiError(`Failed to fetch sessions: ${res.status}`, res.status);
  return {
    text: await res.text(),
    etag: res.headers.get("ETag"),
    notModified: false,
  };
}

/** Fetch the slim archived history for one workspace, newest activity first. */
export async function fetchWorkspaceArchivedSessions(
  workspaceId: string,
  signal?: AbortSignal,
): Promise<UnifiedSession[]> {
  const snapshot = await fetchSessionsSnapshot({
    signal,
    query: `?archived=only&slim=1&workspace=${encodeURIComponent(workspaceId)}`,
  });
  return snapshot.text ? JSON.parse(snapshot.text) : [];
}

/**
 * One session, in the shape the list would have given it.
 *
 * The list no longer carries archived sessions, and a session someone else
 * archives leaves it mid-visit — so opening one needs a source of its own.
 * Returns null when the server doesn't know the id (a deleted session, a stale
 * link), which the caller shows as "not found" rather than an error.
 */
export async function fetchSession(
  sessionId: string,
  opts: { signal?: AbortSignal } = {},
): Promise<UnifiedSession | null> {
  const res = await fetch(`${BASE}/sessions/${encodeURIComponent(sessionId)}`, {
    signal: opts.signal,
  });
  if (res.status === 404) return null;
  if (!res.ok)
    throw new ApiError(`Failed to load session: ${res.status}`, res.status);
  return res.json();
}

export interface PromptDelivery {
  status: "steered" | "queued" | "started" | "handled";
  message: string;
  deliveryId?: string;
  clientId?: string;
  duplicate?: boolean;
}

/** REST transport for the durable web outbox. `clientId` makes retries idempotent. */
export async function deliverSessionPrompt(
  sessionId: string,
  body: {
    content: string;
    images?: string[];
    files?: unknown[];
    pastedTexts?: string[];
    effort?: string;
    fastMode?: boolean;
    busyMode?: "queue" | "steer";
    contextSessions?: string[];
    user?: string;
    clientId: string;
  },
): Promise<PromptDelivery> {
  const images = await preparePromptImages(body.images);
  const requestBody = { ...body };
  if (images) requestBody.images = images;
  return request<PromptDelivery>(
    `/sessions/${encodeURIComponent(sessionId)}/prompt`,
    {
      method: "POST",
      body: requestBody,
      label: "Failed to deliver prompt",
    },
  );
}

// ── Session assets (scratch folder previewed in the Assets tab) ─────────────

export interface SessionAssetFile {
  path: string;
  size: number;
  mtime: string;
  description?: string;
}

export async function fetchSessionAssets(
  sessionId: string,
): Promise<{ dir: string; files: SessionAssetFile[] }> {
  return request(`/sessions/${encodeURIComponent(sessionId)}/assets`, {
    label: "Failed to load assets",
  });
}

/** Direct URL of one asset (iframe/img/video src). Path-based so relative
 *  references inside a previewed HTML asset resolve to sibling assets. */
export function sessionAssetRawUrl(sessionId: string, path: string): string {
  const rel = path.split("/").map(encodeURIComponent).join("/");
  return `${BASE}/sessions/${encodeURIComponent(sessionId)}/assets/raw/${rel}`;
}

/** The URL a preview loads: the raw route, with the file's mtime along for the
 *  ride so an iframe or an <img> re-fetches when an agent rewrites the same
 *  path (iterating on one artifact is the normal flow). A file the listing
 *  hasn't caught up with yet carries no mtime and simply isn't busted. */
export function sessionAssetPreviewUrl(
  sessionId: string,
  file: SessionAssetFile,
): string {
  const raw = sessionAssetRawUrl(sessionId, file.path);
  return file.mtime ? `${raw}?v=${encodeURIComponent(file.mtime)}` : raw;
}

/** The same file, as an attachment rather than something the browser renders. */
export function sessionAssetDownloadUrl(
  sessionId: string,
  file: SessionAssetFile,
): string {
  const url = sessionAssetPreviewUrl(sessionId, file);
  return `${url}${url.includes("?") ? "&" : "?"}download=1`;
}

export async function deleteSessionAssetApi(
  sessionId: string,
  path: string,
): Promise<void> {
  await request(`/sessions/${encodeURIComponent(sessionId)}/assets/delete`, {
    method: "POST",
    body: { path },
    label: "Failed to delete asset",
  });
}

export interface TranscriptMatch {
  id: string;
  snippet: string;
}

/** Full-text search across session transcripts (⌘K "search in conversations"). */
export async function searchTranscripts(
  q: string,
  signal?: AbortSignal,
): Promise<TranscriptMatch[]> {
  const data = await request<{ matches?: TranscriptMatch[] }>(
    `/sessions/search?q=${encodeURIComponent(q)}`,
    { signal, label: "Transcript search failed" },
  );
  return data?.matches ?? [];
}

export async function fetchTranscript(
  sessionId: string,
  tail?: number,
): Promise<TranscriptEntry[]> {
  return request<TranscriptEntry[]>(
    `/sessions/${encodeURIComponent(sessionId)}/transcript${
      tail ? `?tail=${tail}` : ""
    }`,
    { label: "Failed to fetch transcript" },
  );
}

export interface SubagentTranscript {
  meta: {
    agentId: string;
    agentType?: string;
    model?: string;
    description?: string;
    toolUseId?: string;
    spawnDepth?: number;
  };
  entries: import("../types").TranscriptEntry[];
  sessionRunning: boolean;
}

export async function fetchSubagent(
  sessionId: string,
  agentId: string,
): Promise<SubagentTranscript> {
  return request<SubagentTranscript>(
    `/sessions/${encodeURIComponent(sessionId)}/subagent/${encodeURIComponent(agentId)}`,
    { label: "Failed to fetch sub-agent" },
  );
}

/** One sub-agent a session spawned directly (pi task-tool child or
 *  Claude-SDK Task agent) — mirrors the server's SessionSubagentSnapshot
 *  (pi-subagents.ts). Feeds the Agents tab's sub-agents card. */
export interface SessionSubagentSnapshot {
  /** Drill-in key for fetchSubagent; absent while a spawn is still pending. */
  id?: string;
  /** The spawning Task call's tool_use id — links this snapshot to its
   *  transcript row so the UI can offer the drill-in mid-run. */
  toolUseId?: string;
  agentType?: string;
  label: string;
  status: "pending" | "running" | "done" | "error";
  /** Epoch ms. */
  startedAt?: number;
  endedAt?: number;
  model?: string;
  tokensOut?: number;
  source: "pi" | "sdk";
}

export async function fetchSessionSubagents(sessionId: string): Promise<{
  subagents: SessionSubagentSnapshot[];
  sessionRunning: boolean;
}> {
  return request(`/sessions/${encodeURIComponent(sessionId)}/subagents`, {
    label: "Failed to fetch sub-agents",
  });
}

/** A single "@"-mention suggestion. `insert` is what lands in the textarea. */
export interface FileMention {
  /** Repo-relative path or the display name of a referenced object. */
  display: string;
  /** Text inserted after the "@": path, `repo:path`, or a typed stable id. */
  insert: string;
  /** Repo label, set only when more than one repo is searched (cross-repo). */
  repo?: string;
  /** Entry type; absent means a file. */
  kind?: "workspace" | "session" | "skill" | "dir" | "person" | "tool";
  /** Subtitle for non-file entries (e.g. a session's branch, a skill's description). */
  sub?: string;
}

/**
 * File suggestions for "@"-mention autocomplete in the composer. Searches the
 * session's primary checkout plus any attached repos when `sessionId` is given;
 * otherwise the given `repo`'s checkout (used by the New-session prompt, which
 * has no session yet), falling back to the default repo.
 */
export async function fetchFileMentions(
  query: string,
  sessionId?: string,
  repo?: string,
): Promise<FileMention[]> {
  const params = new URLSearchParams({ q: query });
  if (sessionId) params.set("session", sessionId);
  else if (repo) params.set("repo", repo);
  try {
    const data = await request<{ files?: FileMention[] }>(
      `/files?${params.toString()}`,
    );
    return (data.files ?? []).filter(
      (item) => item.kind === undefined || item.kind === "dir",
    );
  } catch (error) {
    console.warn("fetchFileMentions failed:", error);
    return [];
  }
}

/** People-independent rows for the inline @ palette. Kept separate from the
 * repository search so tools and recent sessions never wait for git. */
export async function fetchMentionSuggestions(
  query: string,
  sessionId?: string,
  user?: string,
  mcpServers?: string[],
): Promise<FileMention[]> {
  const params = new URLSearchParams({ q: query });
  if (sessionId) params.set("session", sessionId);
  if (user) params.set("user", user);
  for (const server of mcpServers || []) params.append("mcp", server);
  try {
    const data = await request<{ items?: FileMention[] }>(
      `/mention-suggestions?${params.toString()}`,
    );
    return data.items ?? [];
  } catch (error) {
    console.warn("fetchMentionPalette failed:", error);
    return [];
  }
}

/**
 * Skill/command suggestions for the "/" trigger in the composer. Lists what a
 * Claude run in the session's checkout would see (user + project skills and
 * commands); `repo` is the fallback for composers with no session yet.
 */
export async function fetchSkillMentions(
  query: string,
  sessionId?: string,
  repo?: string,
): Promise<FileMention[]> {
  const params = new URLSearchParams({ q: query });
  if (sessionId) params.set("session", sessionId);
  else if (repo) params.set("repo", repo);
  try {
    const data = await request<{
      skills?: Array<{ name: string; description: string; source: string }>;
    }>(`/skills?${params.toString()}`);
    return (data?.skills ?? []).map((s) => ({
      display: s.name,
      insert: s.name,
      kind: "skill" as const,
      sub: s.description,
    }));
  } catch (e) {
    console.warn("fetchSkillMentions failed:", e);
    return [];
  }
}

/**
 * Promote an ask session to code: create a worktree and attach it (also
 * materializes the workspace's worktree if it doesn't own one yet). Returns the
 * new branch + worktree dir.
 */
export async function promoteSessionApi(
  sessionId: string,
  opts?: { branch?: string; repo?: string },
): Promise<{ branch: string; worktreeDir: string }> {
  return request<{ branch: string; worktreeDir: string }>(
    `/sessions/${encodeURIComponent(sessionId)}/promote`,
    { method: "POST", body: opts || {} },
  );
}

/** Move a shared-checkout session into its own isolated branch. */
export async function moveSessionToBranchApi(
  sessionId: string,
): Promise<{ branch: string; worktreeDir: string; copiedFiles: number }> {
  return request<{ branch: string; worktreeDir: string; copiedFiles: number }>(
    `/sessions/${encodeURIComponent(sessionId)}/move-to-branch`,
    { method: "POST" },
  );
}

type NewSessionRequest = {
  user: string;
  mode?: "share" | "stack" | "ask";
  clientSessionId?: string;
  duplicate?: true;
};

/** Create an idle sibling tab. The first prompt starts its engine run. */
export async function newSessionApi(
  sourceId: string,
  user: string,
  mode?: "share" | "stack" | "ask",
  clientSessionId?: string,
  duplicate = false,
): Promise<{ id: string; session: UnifiedSession | null }> {
  const requestBody: NewSessionRequest = { user };
  if (mode) requestBody.mode = mode;
  if (clientSessionId) requestBody.clientSessionId = clientSessionId;
  if (duplicate) requestBody.duplicate = true;
  const body = await request<{ id: string; session?: UnifiedSession }>(
    `/sessions/${encodeURIComponent(sourceId)}/new-session`,
    {
      method: "POST",
      body: requestBody,
    },
  );
  return { id: body.id, session: body.session || null };
}

export async function deleteSessionApi(
  sessionId: string,
  cleanWorktree: boolean,
): Promise<void> {
  const params = cleanWorktree ? "?worktree=true" : "";
  await request<void>(`/sessions/${encodeURIComponent(sessionId)}${params}`, {
    method: "DELETE",
    label: "Failed to delete",
  });
}

/** Returns `stoppedRun: true` when archiving gracefully stopped an in-flight,
 * process-owned turn (so callers can surface a "stopped the running turn"
 * notice). Always false on unarchive and for idle/external sessions. */
export async function archiveSessionApi(
  sessionId: string,
  archived: boolean,
): Promise<{ stoppedRun: boolean }> {
  const res = await request<{ ok?: boolean; stoppedRun?: boolean } | null>(
    `/sessions/${encodeURIComponent(sessionId)}/archive`,
    {
      method: "POST",
      body: { archived },
      label: "Failed to update archive state",
    },
  );
  return { stoppedRun: !!res?.stoppedRun };
}

/** Set a manual display title for a session; empty string clears the rename. */
export async function renameSessionApi(
  sessionId: string,
  title: string,
): Promise<void> {
  await request<void>(`/sessions/${encodeURIComponent(sessionId)}/title`, {
    method: "PUT",
    body: { title },
    label: "Failed to rename session",
  });
}

/**
 * Pin a session into a sidebar lane (needsinput/inprogress/review/merged/pending),
 * or pass null to clear the override back to the derived lane.
 */
export async function setSessionStatusApi(
  sessionId: string,
  status: "needsinput" | "inprogress" | "review" | "merged" | "pending" | null,
): Promise<void> {
  await request<void>(`/sessions/${encodeURIComponent(sessionId)}/status`, {
    method: "PUT",
    body: { status },
    label: "Failed to change session status",
  });
}

/**
 * Ask a teammate to review this session (surfaces it in a "Needs review" band
 * at the top of their sidebar + pushes a notification); null clears the request.
 */
export async function setSessionReviewerApi(
  sessionId: string,
  reviewer: string | null,
  by: string,
): Promise<void> {
  await request<void>(`/sessions/${encodeURIComponent(sessionId)}/review`, {
    method: "PUT",
    body: { reviewer, by },
    label: "Failed to set reviewer",
  });
}

/** Mark the session's review request accepted (reviewer signed off) or reopen it. */
export async function acceptReviewApi(
  sessionId: string,
  accept: boolean,
  by: string,
): Promise<void> {
  await request<void>(`/sessions/${encodeURIComponent(sessionId)}/review`, {
    method: "PUT",
    body: { accept, by },
    label: "Failed to update review",
  });
}

/** Team notes on a session (agent-invisible; src/server/session-notes.ts). */
export async function fetchSessionNotesApi(
  sessionId: string,
): Promise<SessionNote[]> {
  const data = await request<{ notes?: SessionNote[] }>(
    `/sessions/${encodeURIComponent(sessionId)}/notes`,
    { label: "Failed to load notes" },
  );
  return data?.notes || [];
}

/** Post a team note. The server broadcasts it back, so callers don't echo it
 *  locally — every viewer (including this one) renders the stored record. */
export async function postSessionNoteApi(
  sessionId: string,
  text: string,
  user: string,
  images?: string[],
): Promise<SessionNote> {
  const data = await request<{ note: SessionNote }>(
    `/sessions/${encodeURIComponent(sessionId)}/notes`,
    {
      method: "POST",
      body: { text, user, images },
      label: "Failed to add note",
    },
  );
  return data.note;
}

/** Edit a note. Author-only; the server rejects anyone else with a 403. */
export async function editSessionNoteApi(
  sessionId: string,
  noteId: string,
  text: string,
  user: string,
): Promise<SessionNote> {
  const data = await request<{ note: SessionNote }>(
    `/sessions/${encodeURIComponent(sessionId)}/notes/${encodeURIComponent(noteId)}`,
    { method: "PATCH", body: { text, user }, label: "Failed to edit note" },
  );
  return data.note;
}

/** Delete a note. Author-only, same as editing. */
export async function deleteSessionNoteApi(
  sessionId: string,
  noteId: string,
  user: string,
): Promise<void> {
  await request<void>(
    `/sessions/${encodeURIComponent(sessionId)}/notes/${encodeURIComponent(noteId)}?user=${encodeURIComponent(user)}`,
    { method: "DELETE", label: "Failed to delete note" },
  );
}
