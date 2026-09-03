import { z } from "zod";
import { ApiError, BASE, request } from "./request";

const apiErrorResponseSchema = z
  .object({ error: z.string().optional() })
  .nullable();

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

export interface PreviewStatus {
  hasPortsConf: boolean;
  webappPort: number | null;
  running: boolean;
  starting: boolean;
  previewUrl: string | null;
  /** Whether the repo has any bring-up mechanism (committed
   *  .agents/start.sh, configured previewCommand, or a built-in
   *  fallback). Absent on servers that predate the field — treat as true. */
  bootable?: boolean;
  services: PreviewService[];
  /** Skill-backed starters declared in .agents/portals.json. */
  portalRecipes?: PreviewPortalRecipe[];
  /** Whose preview this is — shown on the interstitial so a reused tab can
   *  never masquerade as another session's wait. */
  sessionTitle?: string | null;
  sessionBranch?: string | null;
}

export async function fetchPreview(sessionId: string): Promise<PreviewStatus> {
  return request<PreviewStatus>(
    `/sessions/${encodeURIComponent(sessionId)}/preview`,
    { label: "Failed to fetch preview" },
  );
}

export async function startPreviewApi(
  sessionId: string,
): Promise<PreviewStatus> {
  return request<PreviewStatus>(
    `/sessions/${encodeURIComponent(sessionId)}/preview/start`,
    { method: "POST", label: "Failed to start preview" },
  );
}

export async function stopPreviewApi(
  sessionId: string,
): Promise<PreviewStatus> {
  return request<PreviewStatus>(
    `/sessions/${encodeURIComponent(sessionId)}/preview/stop`,
    { method: "POST", label: "Failed to stop preview" },
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

/** Screenshot the session's running preview; resolves to a data: URL (PNG). */
export async function capturePreviewShot(sessionId: string): Promise<string> {
  const res = await fetch(
    `${BASE}/sessions/${encodeURIComponent(sessionId)}/preview/screenshot`,
    { method: "POST" },
  );
  if (!res.ok) {
    const parsed = apiErrorResponseSchema.safeParse(
      await res.json().catch(() => null),
    );
    const body = parsed.success ? parsed.data : null;
    throw new ApiError(
      body?.error || `Screenshot failed: ${res.status}`,
      res.status,
    );
  }
  const blob = await res.blob();
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Failed to read screenshot"));
    reader.readAsDataURL(blob);
  });
}

// ── Warm preview templates (Settings → Warm previews) ──

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

// ── Preview pool (Settings → Preview pool: warm pre-booted dev servers) ──

export interface PreviewPoolEntry {
  repoId: string;
  config: {
    enabled: boolean;
    backend: "docker" | "daytona" | "microvm";
    running: number;
    paused: number;
    cpus: number;
    memory: string;
    goldenIntervalHours: number;
    devAuthBypass: boolean;
    claimIdleMinutes: number;
  };
  golden: { sha: string; builtAt: string; lastError?: string } | null;
  goldenBuilding: boolean;
  containers: {
    name: string;
    state: "warming" | "ready" | "paused" | "claimed";
    hostPort: number;
    sessionWorktree?: string;
    claimedAt?: string;
  }[];
}

export async function fetchPreviewPool(): Promise<{
  repos: PreviewPoolEntry[];
}> {
  return request("/preview-pool", { label: "Failed to fetch preview pool" });
}

export async function updatePreviewPool(
  repoId: string,
  patch: Partial<PreviewPoolEntry["config"]>,
): Promise<{ repos: PreviewPoolEntry[] }> {
  return request(`/preview-pool/${encodeURIComponent(repoId)}`, {
    method: "PUT",
    body: patch,
  });
}

export async function refreshPreviewPoolGolden(
  repoId: string,
): Promise<{ repos: PreviewPoolEntry[] }> {
  return request(`/preview-pool/${encodeURIComponent(repoId)}/refresh`, {
    method: "POST",
  });
}
