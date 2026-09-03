import type { SWRConfiguration } from "swr";

/**
 * Shared defaults for read-only API resources. SWR keeps the last successful
 * value by key, paints it immediately on remount, then revalidates it.
 * Periodic resources opt into their own refresh interval at the call site.
 */
export const API_SWR_OPTIONS = {
  shouldRetryOnError: false,
  revalidateOnFocus: true,
  revalidateOnReconnect: true,
} satisfies SWRConfiguration;

/**
 * Do not pass `compare: undefined` through to SWR. Its configuration merge
 * treats that as an explicit override of the default comparator, then calls
 * it during the external-store snapshot check.
 */
export function apiResourceSWRConfig<Data>(
  refreshInterval: number,
  compare?: SWRConfiguration<Data>["compare"],
): SWRConfiguration<Data> {
  const config: SWRConfiguration<Data> = {
    ...API_SWR_OPTIONS,
    refreshInterval,
  };
  if (compare !== undefined) config.compare = compare;
  return config;
}

// Keep resource identities in one place so separate surfaces share both the
// cached value and an in-flight revalidation instead of merely looking alike.
export const apiSWRKey = {
  session: (sessionId: string) => ["api", "session", sessionId] as const,
  workspaceOverview: (workspaceKey: string) =>
    ["api", "workspace-overview", workspaceKey] as const,
  sessionDiff: (sessionId: string) =>
    ["api", "session-diff", sessionId] as const,
  sessionPr: (sessionId: string, repo?: string, branch?: string) =>
    ["api", "session-pr", sessionId, repo || "", branch || ""] as const,
  sessionPrDiff: (sessionId: string, repo?: string, branch?: string) =>
    ["api", "session-pr-diff", sessionId, repo || "", branch || ""] as const,
  sessionGit: (sessionId: string, repo?: string) =>
    ["api", "session-git", sessionId, repo || ""] as const,
  sessionAssets: (sessionId: string) =>
    ["api", "session-assets", sessionId] as const,
  previewPr: (repo: string, branch: string) =>
    ["api", "preview-pr", repo, branch] as const,
  previewPrDiff: (repo: string, branch: string) =>
    ["api", "preview-pr-diff", repo, branch] as const,
};
