import React from "react";
import type { Route } from "../lib/app-route";
import type { useAppRoute } from "../hooks/useAppRoute";
import { resolveWorkspaceApi } from "../lib/api";
import { repoLabel } from "../lib/repo-label";
import { EmptyState, LoadingState } from "../ui/state";
import type {
  UnifiedSession,
  WSClientMessage,
  WSServerMessage,
} from "../lib/types";
import { PrPanel } from "./PrPanel";
import { PhoneTopBarAction } from "../ui/top-bar";
import { IconChevronLeft } from "./icons";

interface Props {
  onBack?: () => void;
  repo: string;
  branch: string;
  sessions: UnifiedSession[];
  onOpenSession: (id: string) => void;
  /** Open the PR's workspace home so a new session can start there. */
  onStartSession?: () => void;
  /** Open another PR in the review panel (stack map layer links). */
  onOpenPr?: (repo: string, branch: string) => void;
  send?: (msg: WSClientMessage) => void;
  addHandler?: (handler: (msg: WSServerMessage) => void) => () => void;
}

/**
 * Review-canvas adapter for PRs opened from the sidebar queue. A primary-branch
 * session uses the normal session APIs; an unclaimed PR uses the repo+branch
 * preview APIs, but both render the exact same review surface.
 */
export function PrQueuePreview({
  onBack,
  repo,
  branch,
  sessions,
  onOpenSession,
  onStartSession,
  onOpenPr,
  send,
  addHandler,
}: Props) {
  const session =
    [...sessions]
      .filter((item) => item.repo === repo && item.branch === branch)
      .sort((a, b) =>
        (b.lastActivity || "").localeCompare(a.lastActivity || ""),
      )[0] || null;

  return (
    <div className="h-full min-h-0 bg-surface phone:pt-[env(safe-area-inset-top,0px)]">
      <PrPanel
        onOpenPr={onOpenPr}
        sessionId={session?.id || ""}
        previewTarget={session ? undefined : { repo, branch }}
        send={send}
        addHandler={addHandler}
        sessions={sessions}
        onStartSession={onStartSession}
        onOpenSession={session ? () => onOpenSession(session.id) : undefined}
        walkthrough={session?.walkthrough}
        phoneNavigation={
          onBack ? (
            <PhoneTopBarAction
              onClick={onBack}
              aria-label="Back"
              icon={<IconChevronLeft size={22} />}
            />
          ) : undefined
        }
      />
    </div>
  );
}

/** Resolves the route's loading state and owns navigation out of a queue preview. */
export function PrRoutePreview({
  route,
  missing,
  navigate,
  refreshWorkspaces,
  ...previewProps
}: Pick<Props, "onBack" | "sessions" | "send" | "addHandler"> & {
  route: Extract<Route, { view: "pr" }>;
  missing: boolean;
  navigate: ReturnType<typeof useAppRoute>["navigate"];
  refreshWorkspaces: () => Promise<void>;
}) {
  if (route.branch === undefined) {
    // Number-only links wait for the app's workspace resolver before previewing.
    return missing ? (
      <EmptyState>{`${repoLabel(route.repo)} has no pull request #${route.number}.`}</EmptyState>
    ) : (
      <LoadingState>{`Opening #${route.number}…`}</LoadingState>
    );
  }
  return (
    <PrQueuePreview
      {...previewProps}
      key={`${route.repo}:${route.branch}`}
      repo={route.repo}
      branch={route.branch}
      onOpenSession={(id) => navigate({ view: "session", id })}
      onOpenPr={(repo, branch) => navigate({ view: "pr", repo, branch })}
      onStartSession={() =>
        void (async () => {
          // The workspace home starts a new session on this PR's branch.
          const { workspaceId } = await resolveWorkspaceApi({
            pr: { repo: route.repo, branch: route.branch },
          });
          await refreshWorkspaces();
          navigate({ view: "workspace", id: workspaceId });
        })().catch((error) => console.error(error))
      }
    />
  );
}
