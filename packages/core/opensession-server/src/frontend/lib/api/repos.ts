import { API_BASE, ApiError, request } from "./request";
import { rememberRepoColors } from "../repo-colors";
import { rememberRepoCount } from "../repo-count";
import {
  cachedNewSessionRepo,
  cachedRepos,
  rememberRepos,
} from "../repo-cache";

export const REPOS_CHANGED_EVENT = "opensession:repos-changed";

export function notifyReposChanged() {
  if (
    typeof window !== "undefined" &&
    typeof window.dispatchEvent === "function"
  )
    window.dispatchEvent(new Event(REPOS_CHANGED_EVENT));
}

export interface RepoInfo {
  id: string;
  label?: string;
  description?: string;
  ghRepo?: string;
  defaultBranch: string;
  sharedCheckout: boolean;
  default?: boolean;
  /** This repo's letter-tile color, assigned across the registered set. */
  color?: string;
  /** Whether that color was chosen for the repo rather than assigned. */
  colorChosen?: boolean;
  /** The color automatic would give it — the same as `color` unless one
   *  was chosen. The picker previews it on its Automatic tile. */
  autoColor?: string;
  /** Whether the tile paints art rather than the letter. */
  hasIcon?: boolean;
  /** Which of the picker's icon choices that art came from. */
  iconSource?: "github" | "upload" | null;
  /** Changes when that art does, so a replaced icon isn't served stale. */
  iconRev?: number | null;
}

export type SharedCheckoutMode = "shared" | "worktree";

export interface WorktreeSettings {
  mode: SharedCheckoutMode;
  repos: Array<{ id: string; label: string }>;
}

export function fetchWorktreeSettings(): Promise<WorktreeSettings> {
  return request("/settings/worktrees", {
    label: "Failed to load worktree settings",
  });
}

export function setSharedCheckoutMode(
  mode: SharedCheckoutMode,
): Promise<WorktreeSettings> {
  return request("/settings/worktrees", {
    method: "PUT",
    body: { mode },
    label: "Failed to save worktree settings",
  });
}

/**
 * Set the workspace's default repository for new sessions — a repo id, or ""
 * to clear it back to the registered fallback. Admin-facing (Settings →
 * Repositories); the per-user preference overrides it.
 */
export async function setNewSessionRepoApi(repo: string): Promise<string> {
  const data = await request<{ newSessionRepo?: string }>(
    "/repos/new-session-default",
    {
      method: "PUT",
      body: { repo },
      label: "Failed to set the default repository",
    },
  );
  workspaceNewSessionRepo = data?.newSessionRepo ?? repo;
  workspaceRepoLive = true;
  // Keep the remembered copy honest, so the palette that opens next doesn't
  // start on the default this call just replaced.
  const known = cachedRepos();
  if (known.length) rememberRepos(known, workspaceNewSessionRepo);
  return workspaceNewSessionRepo;
}

/** Set a repo's tile color, or fetch/clear its icon (Settings → Setup). */
export async function setRepoAppearanceApi(
  id: string,
  patch: { color?: string | null; icon?: "github" | null },
): Promise<{ color: string | null; hasIcon: boolean; iconRev: number | null }> {
  return request(`/repos/${encodeURIComponent(id)}/appearance`, {
    method: "POST",
    body: patch,
    label: "Failed to update the repository tile",
  });
}

/**
 * The owner's GitHub avatar, served by us. 404s when the repo has no GitHub
 * repository configured (or GitHub didn't answer), which is what lets the tile
 * picker show the picture as a choice and simply drop it when there isn't one.
 */
export function repoGithubAvatarUrl(id: string): string {
  return `${API_BASE}/repos/${encodeURIComponent(id)}/github-avatar`;
}

/** Give a repo art of its own. Takes PNG bytes — see the picker's re-encode. */
export async function uploadRepoIconApi(
  id: string,
  png: Blob,
): Promise<{ color: string | null; hasIcon: boolean; iconRev: number | null }> {
  const res = await fetch(`${API_BASE}/repos/${encodeURIComponent(id)}/icon`, {
    method: "POST",
    headers: { "Content-Type": "image/png" },
    body: png,
  });
  const body = (await res.json().catch(() => null)) as {
    error?: string;
    color?: string | null;
    hasIcon?: boolean;
    iconRev?: number | null;
  } | null;
  if (!res.ok) {
    throw new ApiError(
      body?.error || `Failed to upload the icon: ${res.status}`,
      res.status,
    );
  }
  return {
    color: body?.color ?? null,
    hasIcon: !!body?.hasIcon,
    iconRev: body?.iconRev ?? null,
  };
}

const REPO_FETCH_RETRY_DELAYS_MS = [250, 750, 1_500];

/**
 * The workspace's own answer to "which repo does a new session start in?".
 * Captured from the /repos payload rather than returned by
 * fetchRepos, whose RepoInfo[] every caller already destructures; the picker
 * reads it in the same `.then()` that sets the repo list.
 */
let workspaceNewSessionRepo = "";
/** Whether that came from this load rather than from the remembered copy. */
let workspaceRepoLive = false;

/**
 * The workspace default as of the last /repos answer — this load's, or the one
 * remembered from the previous load until it arrives ("" the first time).
 * Once a live answer lands it wins outright, including when it is empty: a
 * default someone cleared must not come back from the cache.
 */
export function configuredNewSessionRepo(): string {
  return workspaceRepoLive ? workspaceNewSessionRepo : cachedNewSessionRepo();
}

/** The repos as of the last load, for a picker that would rather not open empty. */
export { cachedRepos };

/**
 * In flight right now. Several surfaces ask for the list at once (the app
 * shell, the /new palette, whichever picker just opened), and they all want
 * the same answer, so they share one request rather than racing three.
 */
let reposInFlight: Promise<RepoInfo[]> | null = null;

export function fetchRepos(): Promise<RepoInfo[]> {
  if (!reposInFlight) {
    reposInFlight = loadRepos().finally(() => {
      reposInFlight = null;
    });
  }
  return reposInFlight;
}

async function loadRepos(): Promise<RepoInfo[]> {
  for (let attempt = 0; ; attempt++) {
    try {
      const data = await request<{
        repos?: RepoInfo[];
        newSessionRepo?: string;
      }>("/repos", { label: "Failed to load repositories" });
      if (typeof data?.newSessionRepo === "string") {
        workspaceNewSessionRepo = data.newSessionRepo;
        workspaceRepoLive = true;
      }
      // Recorded here rather than at the call sites: every tile reads the
      // assignment, and the tile takes a repo id, not a RepoInfo.
      rememberRepoColors(data?.repos ?? []);
      // The sidebar's default grouping depends on how many projects there
      // are, and has to resolve before this request can answer — so the
      // size of the registered set is cached for the next load.
      rememberRepoCount((data?.repos ?? []).length);
      // Kept for the next load, so the pickers open on this list instead of
      // on a spinner.
      rememberRepos(data?.repos ?? [], workspaceNewSessionRepo);
      return data?.repos ?? [];
    } catch (error) {
      const retryDelay = REPO_FETCH_RETRY_DELAYS_MS[attempt];
      const transient = !(error instanceof ApiError) || error.status >= 500;
      if (!transient || retryDelay === undefined) throw error;
      await new Promise((resolve) => setTimeout(resolve, retryDelay));
    }
  }
}

export async function registerRepoApi(input: {
  url?: string;
  path?: string;
}): Promise<RepoInfo> {
  const repo = await request<RepoInfo>("/repos", {
    method: "POST",
    body: input,
    label: "Failed to add repository",
  });
  notifyReposChanged();
  return repo;
}

export interface AttachedRepo {
  repo: string;
  branch: string;
  dir: string;
}

export async function attachRepoApi(
  sessionId: string,
  repo: string,
  branch?: string,
): Promise<AttachedRepo[]> {
  const body = await request<{ attachedRepos: AttachedRepo[] }>(
    `/sessions/${encodeURIComponent(sessionId)}/attach-repo`,
    { method: "POST", body: { repo, ...(branch ? { branch } : {}) } },
  );
  return body.attachedRepos;
}

export async function detachRepoApi(
  sessionId: string,
  repo: string,
): Promise<AttachedRepo[]> {
  const body = await request<{ attachedRepos: AttachedRepo[] }>(
    `/sessions/${encodeURIComponent(sessionId)}/detach-repo`,
    { method: "POST", body: { repo } },
  );
  return body.attachedRepos;
}

// Can this session switch its primary repo, and does it already have work?
// `switchable` is false only for ask sessions; `hasWork` means the UI should
// confirm first (the current changes stay in the old worktree, not carried over).
export async function fetchRepoSwitchable(
  sessionId: string,
): Promise<{ switchable: boolean; hasWork: boolean }> {
  const body = await request<{ switchable?: boolean; hasWork?: boolean }>(
    `/sessions/${encodeURIComponent(sessionId)}/repo-switchable`,
    { label: "Failed to load repository controls" },
  );
  return { switchable: !!body?.switchable, hasWork: !!body?.hasWork };
}

// Switch the session's PRIMARY repo (wrong repo picked at creation). Returns the
// new primary repo + branch; the next prompt runs from the new worktree. Pass
// force to switch past existing work (it stays in the old worktree on disk).
export async function switchPrimaryRepoApi(
  sessionId: string,
  repo: string,
  force = false,
): Promise<{ repo: string; branch: string; worktreeDir: string }> {
  return request<{ repo: string; branch: string; worktreeDir: string }>(
    `/sessions/${encodeURIComponent(sessionId)}/switch-primary-repo`,
    { method: "POST", body: { repo, force } },
  );
}

export interface WorktreeInfo {
  branch: string;
  path: string;
}

export async function fetchWorktrees(repo?: string): Promise<WorktreeInfo[]> {
  const qs = repo ? `?repo=${encodeURIComponent(repo)}` : "";
  return request<WorktreeInfo[]>(`/worktrees${qs}`, {
    label: "Failed to fetch worktrees",
  });
}
