import { request } from "./request";
import type { ExternalRef, Workspace } from "../types";

/** One media item in the workspace-overview panel. Image srcs are lazy-load
 * refs served by /sessions/:id/transcript-image; videos stream from
 * <base>/media. */
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
  /** Latest assistant text across the workspace's sessions. Optional because a
   *  server that hasn't restarted onto the new overview code omits the key. */
  lastMessage?: { content: string; sessionId: string; at: string } | null;
  /** Commits attributed to this workspace. Optional for older servers. */
  commits?: WorkspaceCommit[];
  media: WorkspaceMediaItem[];
}

/** Opening prompt + all media across a workspace's sessions (the floating
 * preview panel in the session viewer). */
export async function fetchWorkspaceOverview(
  wsId: string,
): Promise<WorkspaceOverview> {
  return request<WorkspaceOverview>(
    `/workspaces/${encodeURIComponent(wsId)}/overview`,
    { label: "Failed to fetch workspace overview" },
  );
}

/** The same overview for a single session, which is what its hover card shows.
 *  It lives beside the workspace one because it returns the same shape; the
 *  difference is only whose story it tells. */
export async function fetchSessionOverview(
  sessionId: string,
): Promise<WorkspaceOverview> {
  return request<WorkspaceOverview>(
    `/sessions/${encodeURIComponent(sessionId)}/overview`,
    { label: "Failed to fetch session overview" },
  );
}

// ── Workspaces (containers that group sessions) ──

let defaultModelSettings: Workspace["modelSettings"] | undefined;
let workspaceSnapshot = "";
let stableWorkspaces: Workspace[] | null = null;

/** The instance-wide default model settings, captured from the last workspaces
 *  fetch. A workspace without its own modelSettings inherits these. */
export function defaultWorkspaceModelSettings():
  | Workspace["modelSettings"]
  | undefined {
  return defaultModelSettings;
}

export async function fetchWorkspaces(options?: {
  onError?: (cause: unknown) => void;
}): Promise<Workspace[]> {
  try {
    const data = await request<{
      workspaces?: Workspace[];
      defaultModelSettings?: Workspace["modelSettings"];
    }>("/workspaces?active=1");
    if (data?.defaultModelSettings)
      defaultModelSettings = data.defaultModelSettings;
    const next = data?.workspaces ?? [];
    // Workspace invalidations can overlap or repeat (PR attachment, focus,
    // settings broadcasts). Preserve the array identity for an unchanged
    // response so workspace-list state can bail instead of reconciling every
    // route and sidebar row after parsing the same 500+ KB payload again.
    const snapshot = JSON.stringify({
      workspaces: next,
      defaultModelSettings: data?.defaultModelSettings,
    });
    if (stableWorkspaces && snapshot === workspaceSnapshot)
      return stableWorkspaces;
    workspaceSnapshot = snapshot;
    stableWorkspaces = next;
    return next;
  } catch (cause: unknown) {
    options?.onError?.(cause);
    console.warn("fetchWorkspaces failed:", cause);
    return [];
  }
}

export async function createWorkspaceApi(input: {
  name: string;
  repo?: string;
  draft?: Workspace["draft"];
}): Promise<Workspace> {
  const body = await request<{ workspace: Workspace }>("/workspaces", {
    method: "POST",
    body: input,
    label: "Failed to create the workspace",
  });
  return body.workspace;
}

export async function updateWorkspaceApi(
  id: string,
  patch: {
    name?: string;
    repo?: string;
    /** null clears the swatch color. */
    color?: string | null;
    order?: number;
    modelSettings?: Workspace["modelSettings"];
    /** null clears the draft. */
    draft?: Workspace["draft"] | null;
  },
): Promise<Workspace> {
  const body = await request<{ workspace: Workspace }>(
    `/workspaces/${encodeURIComponent(id)}`,
    { method: "PATCH", body: patch },
  );
  return body.workspace;
}

export async function deleteWorkspaceApi(id: string): Promise<void> {
  await request<void>(`/workspaces/${encodeURIComponent(id)}`, {
    method: "DELETE",
    label: "Failed to delete workspace",
  });
}

/**
 * Start (or reuse) a triage session for a Plain thread — runs the "Plain
 * ticket triage" automation. Slow (~15-60s) when it has to boot a fresh run.
 */
export interface ResolvedWorkspace {
  workspaceId: string;
  created: boolean;
  /**
   * For a PR target: which PR was resolved, with the branch filled in from
   * the server's PR caches. The workspace holds every PR its sessions
   * opened, so this is what says which one to foreground.
   */
  pr?: { repo: string; number?: number; branch?: string };
}

/**
 * Resolve-or-create the ONE workspace for a PR or a Plain support ticket
 * (adopt-don't-duplicate — server-side workspace-resolve.ts). Sidebar PR and
 * Support rows call this on click, then navigate into the workspace.
 */
export async function resolveWorkspaceApi(
  target:
    | { pr: { repo: string; number?: number; branch?: string; title?: string } }
    | { plainThreadId: string; name?: string }
    | { externalRef: ExternalRef; name?: string },
  user?: string,
): Promise<ResolvedWorkspace> {
  return request<ResolvedWorkspace>("/workspaces/resolve", {
    method: "POST",
    body: { ...target, ...(user ? { user } : {}) },
    label: "Failed to resolve the workspace",
  });
}
