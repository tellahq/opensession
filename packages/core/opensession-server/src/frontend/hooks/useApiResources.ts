import { useEffect, useLayoutEffect, useRef } from "react";
import useSWR, { type SWRConfiguration, type SWRResponse } from "swr";
import {
  fetchDiff,
  fetchGitStatus,
  fetchPr,
  fetchPrDiff,
  fetchSessionAssets,
  type SessionAssetFile,
  type WorkspaceOverview,
} from "../lib/api";
import { apiResourceSWRConfig, apiSWRKey } from "../lib/api-swr";
import type {
  GitStatusInfo,
  PrDetails,
  PrDiffResponse,
  SessionDiffResponse,
} from "../lib/types";
import {
  loadOverview,
  loadSessionOverview,
  type OverviewSessionRef,
} from "../lib/workspace-overview";

export type ApiResourceOptions<Data> = {
  enabled?: boolean;
  refreshInterval?: number;
  /** Revalidate when a webhook, socket event, or parent resource says this
   * read may have changed. The first value is covered by SWR's mount fetch. */
  revision?: string | number | null;
  compare?: SWRConfiguration<Data>["compare"];
};

function useRevisionRevalidation(
  revision: ApiResourceOptions<unknown>["revision"],
  revalidate: () => Promise<unknown>,
) {
  const previous = useRef(revision);
  useEffect(() => {
    if (previous.current === revision) return;
    previous.current = revision;
    void revalidate();
  }, [revision, revalidate]);
}

/** A PR detail is shared by every status surface that names the same target. */
export function useSessionPrResource(
  sessionId: string,
  repo?: string,
  branch?: string,
  options: ApiResourceOptions<PrDetails | null> = {},
): SWRResponse<PrDetails | null> {
  const { enabled = true, refreshInterval = 0, revision, compare } = options;
  const resource = useSWR<PrDetails | null>(
    enabled ? apiSWRKey.sessionPr(sessionId, repo, branch) : null,
    () => fetchPr(sessionId, repo, branch),
    apiResourceSWRConfig(refreshInterval, compare),
  );
  useRevisionRevalidation(revision, resource.mutate);
  return resource;
}

/** The full PR patch is loaded only by surfaces that need to render its files. */
export function useSessionPrDiffResource(
  sessionId: string,
  repo?: string,
  branch?: string,
  options: ApiResourceOptions<PrDiffResponse | null> = {},
): SWRResponse<PrDiffResponse | null> {
  const { enabled = true, refreshInterval = 0, revision, compare } = options;
  const resource = useSWR<PrDiffResponse | null>(
    enabled ? apiSWRKey.sessionPrDiff(sessionId, repo, branch) : null,
    () => fetchPrDiff(sessionId, repo, branch),
    apiResourceSWRConfig(refreshInterval, compare),
  );
  useRevisionRevalidation(revision, resource.mutate);
  return resource;
}

/** Local worktree state shared by the header, summary, and Workspace panel. */
export function useSessionGitResource(
  sessionId: string,
  repo?: string,
  options: ApiResourceOptions<GitStatusInfo | null> = {},
): SWRResponse<GitStatusInfo | null> {
  const { enabled = true, refreshInterval = 0, revision, compare } = options;
  const resource = useSWR<GitStatusInfo | null>(
    enabled ? apiSWRKey.sessionGit(sessionId, repo) : null,
    () => fetchGitStatus(sessionId, repo),
    apiResourceSWRConfig(refreshInterval, compare),
  );
  useRevisionRevalidation(revision, resource.mutate);
  return resource;
}

/** The live worktree patch is one of the largest right-panel responses. */
export function useSessionDiffResource(
  sessionId: string,
  options: ApiResourceOptions<SessionDiffResponse> = {},
): SWRResponse<SessionDiffResponse> {
  const { enabled = true, refreshInterval = 0, revision, compare } = options;
  const resource = useSWR<SessionDiffResponse>(
    enabled ? apiSWRKey.sessionDiff(sessionId) : null,
    async () => {
      const response = await fetchDiff(sessionId);
      if (response.error) throw new Error(response.error);
      return response;
    },
    apiResourceSWRConfig(refreshInterval, compare),
  );
  useRevisionRevalidation(revision, resource.mutate);
  return resource;
}

export function useSessionAssetsResource(
  sessionId: string,
  options: ApiResourceOptions<SessionAssetFile[]> = {},
): SWRResponse<SessionAssetFile[]> {
  const { enabled = true, refreshInterval = 0, revision, compare } = options;
  const resource = useSWR<SessionAssetFile[]>(
    enabled ? apiSWRKey.sessionAssets(sessionId) : null,
    async () => (await fetchSessionAssets(sessionId)).files || [],
    apiResourceSWRConfig(refreshInterval, compare),
  );
  useRevisionRevalidation(revision, resource.mutate);
  return resource;
}

/**
 * Workspace and session hover cards share this resource with the right panel.
 * `loadOverview` keeps its compatibility fallbacks for older servers; SWR owns
 * remount caching and in-flight request deduplication.
 */
export function useSessionOverviewResource(
  session: OverviewSessionRef,
  options: ApiResourceOptions<WorkspaceOverview> = {},
): SWRResponse<WorkspaceOverview> {
  const { enabled = true, refreshInterval = 0, revision, compare } = options;
  const sessionRef = useRef(session);
  useLayoutEffect(() => {
    sessionRef.current = session;
  });
  const cacheKey = `sessions:${session.id}`;
  const resource = useSWR<WorkspaceOverview>(
    enabled ? apiSWRKey.workspaceOverview(cacheKey) : null,
    () => loadSessionOverview(sessionRef.current),
    apiResourceSWRConfig(refreshInterval, compare),
  );
  useRevisionRevalidation(revision, resource.mutate);
  return resource;
}

export function useWorkspaceOverviewResource(
  cacheKey: string,
  workspaceId: string | null,
  sessions: OverviewSessionRef[],
  options: ApiResourceOptions<WorkspaceOverview> = {},
): SWRResponse<WorkspaceOverview> {
  const { enabled = true, refreshInterval = 0, revision, compare } = options;
  const sessionsRef = useRef(sessions);
  useLayoutEffect(() => {
    sessionsRef.current = sessions;
  });
  const resource = useSWR<WorkspaceOverview>(
    enabled ? apiSWRKey.workspaceOverview(cacheKey) : null,
    () => loadOverview(workspaceId, sessionsRef.current),
    apiResourceSWRConfig(refreshInterval, compare),
  );
  useRevisionRevalidation(revision, resource.mutate);
  return resource;
}
