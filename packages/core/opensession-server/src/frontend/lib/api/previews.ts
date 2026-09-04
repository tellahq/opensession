import { request } from "./request";

export interface PreviewService {
  name: string;
  key: string;
  port: number;
  running: boolean;
  pids: number[];
  previewUrl?: string | null;
  description?: string;
  defaultPath?: string;
  state?: "starting" | "awake" | "sleeping" | "waking" | "failed" | "stopped";
  managed?: boolean;
}

export interface PreviewPortalRecipe {
  id: string;
  name: string;
  description?: string;
  command?: string;
  skill?: string;
  serviceKey?: string;
  port?: number;
  readyTimeoutSeconds?: number;
}

/** A session workspace's Portals: the services listening in it plus the
 *  Portals its repository declares in .agents/portals.json. */
export interface PreviewStatus {
  services: PreviewService[];
  portalRecipes?: PreviewPortalRecipe[];
  /** Set while the session's Sandbox cannot be inspected (asleep, waking,
   *  preparing, or needing attention). */
  sandboxLifecycle?:
    | "preparing"
    | "awake"
    | "sleeping"
    | "waking"
    | "needs_attention";
}

export async function fetchPreview(
  sessionId: string,
  signal?: AbortSignal,
): Promise<PreviewStatus> {
  return request<PreviewStatus>(
    `/sessions/${encodeURIComponent(sessionId)}/preview`,
    { label: "Failed to fetch Portals", signal },
  );
}

export async function startPortalRecipeApi(
  sessionId: string,
  recipeId: string,
): Promise<PreviewStatus> {
  return request(
    `/sessions/${encodeURIComponent(sessionId)}/portals/${encodeURIComponent(recipeId)}/start`,
    { method: "POST", label: "Failed to start Portal" },
  );
}

export async function portalActionApi(
  sessionId: string,
  name: string,
  action: "stop" | "restart",
): Promise<PreviewStatus> {
  return request(
    `/sessions/${encodeURIComponent(sessionId)}/portals/${encodeURIComponent(name)}/${action}`,
    { method: "POST", label: `Failed to ${action} Portal` },
  );
}

// ── Warm dependency templates (Settings → Warm previews) ──

export interface WarmTemplateEntry {
  repoId: string;
  enabled: boolean;
  intervalHours: number;
  refreshing: boolean;
  /** Prebuilt dep spares ready for instant adoption by new worktrees. */
  spares: number;
  state: {
    sha?: string;
    refreshedAt?: string;
    lastDurationMs?: number;
    ok?: boolean;
    lastError?: string;
    manifestEntries?: number;
  } | null;
}

export async function fetchWarmTemplates(): Promise<{
  repos: WarmTemplateEntry[];
}> {
  return request("/warm-templates", {
    label: "Failed to fetch warm previews",
  });
}

export async function updateWarmTemplate(
  repoId: string,
  patch: { enabled?: boolean; intervalHours?: number },
): Promise<{ repos: WarmTemplateEntry[] }> {
  return request(`/warm-templates/${encodeURIComponent(repoId)}`, {
    method: "PUT",
    body: patch,
  });
}

export async function refreshWarmTemplateNow(
  repoId: string,
): Promise<{ repos: WarmTemplateEntry[] }> {
  return request(`/warm-templates/${encodeURIComponent(repoId)}/refresh`, {
    method: "POST",
  });
}
