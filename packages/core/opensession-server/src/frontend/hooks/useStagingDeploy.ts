import { useEffect, useRef } from "react";
import {
  MERGED_DEPLOY_POLL_MS,
  PR_WEBHOOK_FALLBACK_POLL_MS,
} from "../lib/poll";
import { useSessionPrResource } from "./useApiResources";
import { useSessionPendingCreation } from "./useSessionPendingCreation";
import type { PrCheck, UnifiedSession } from "../lib/types";
import { worstPrRef } from "../lib/pr-refs";
import { sessionPrPresentation } from "../lib/session-prs";
import { previewOpenable, stagingHref } from "../lib/preview-url";
import {
  keptFrameKey,
  reloadKeptFrame,
  setKeptPageDeploying,
  viewTabScope,
} from "../lib/kept-frames";
import { checkClass, isDeployment } from "../lib/pr-status-derive";

/**
 * Where the session's PR preview deploy stands. The preview globe and the
 * kept preview pages (through useReloadOnFreshDeploy) both read it, so they
 * agree on when the preview is up to date.
 *
 * - `relevant`: the PR is open, or merged and the link still has somewhere
 *   to go, so the globe is worth showing at all.
 * - `merged`: the PR is merged. Its preview keeps serving the merged change
 *   until production does, then the server hands `staging` over to the
 *   production site (`staging.production`).
 * - `deployPending`: a deploy check is still queued or running.
 * - `building`: a first deploy with nothing behind the alias yet (it 404s).
 * - `rebuilding`: a newer deploy is on its way while the alias keeps serving
 *   the previous one, so the page is possibly one push behind.
 */
export function useStagingDeploy(
  session: UnifiedSession,
  refreshTick?: number,
) {
  // A closed PR's alias serves work that never landed. PR refs are shared
  // across a workspace, so a tab without a PR of its own deliberately targets
  // one of the workspace's refs.
  const presentation = sessionPrPresentation(session.prs);
  const target = presentation.primary ?? worstPrRef(presentation.additional);
  const state = target
    ? (target.state ??
      (target.source === "primary" ? session.prState : undefined))
    : session.prUrl
      ? session.prState
      : undefined;
  const merged = state === "MERGED";
  const relevant = state === "OPEN" || merged;
  const pendingCreation = useSessionPendingCreation();
  const prResource = useSessionPrResource(
    session.id,
    target?.repo || session.repo || undefined,
    target?.branch,
    {
      enabled: relevant && !pendingCreation,
      // A merged PR polls only while its link waits on production: nothing
      // about it changes after that.
      refreshInterval: (latest) =>
        !merged
          ? PR_WEBHOOK_FALLBACK_POLL_MS
          : latest?.staging?.awaitingProduction
            ? MERGED_DEPLOY_POLL_MS
            : 0,
      revision: refreshTick,
    },
  );
  const staging = prResource.data?.staging ?? null;
  // A Vercel preview deploy is queued/running but butler hasn't posted the URL
  // comment yet, or a push started a new one behind a Ready row. A merged PR's
  // checks belong to its last push, long settled into the preview it keeps.
  const deployPending =
    !merged &&
    !!prResource.data?.checks?.some(
      (c: PrCheck) =>
        isDeployment(c) &&
        checkClass(c.status, c.conclusion) === "check-pending",
    );
  // The deploy bot can also flip its own row back to Building on a push; the
  // server's probe still sees the previous deploy serving (`live`), so that is
  // a rebuild too.
  const openable = staging ? previewOpenable(staging) : false;
  const building = !!staging && !openable;
  const rebuilding =
    !merged && openable && (deployPending || staging?.status !== "Ready");
  return { relevant, merged, staging, deployPending, building, rebuilding };
}

/**
 * Keeps the session's kept preview pages (the side panel's Browser tab and the
 * main strip's) honest about a deploy in flight: they say "Deploying" while
 * one is on its way and reload once it goes live, so a page opened on the
 * previous push catches up by itself. Call it once per viewer: the header and
 * summary marks mount several times.
 */
export function useReloadOnFreshDeploy(
  session: UnifiedSession,
  refreshTick?: number,
) {
  const { staging, deployPending, building, rebuilding } = useStagingDeploy(
    session,
    refreshTick,
  );
  const inFlight = building || rebuilding || (!staging && deployPending);
  const url = staging ? stagingHref(staging, session.previewPath) : null;
  const panelKey = keptFrameKey("panel", session.id);
  const stripKey = keptFrameKey("staging", viewTabScope(session));
  useEffect(() => {
    if (!url || !inFlight) return;
    setKeptPageDeploying(url, true);
    return () => setKeptPageDeploying(url, false);
  }, [url, inFlight]);
  // Per page, so switching sessions mid-deploy is not mistaken for a landing.
  const last = useRef({ panelKey, inFlight });
  useEffect(() => {
    const landed =
      last.current.panelKey === panelKey && last.current.inFlight && !inFlight;
    last.current = { panelKey, inFlight };
    if (!landed || !url) return;
    reloadKeptFrame(panelKey, url);
    reloadKeptFrame(stripKey, url);
  }, [inFlight, url, panelKey, stripKey]);
}
