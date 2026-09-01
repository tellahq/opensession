import type { Dispatch, SetStateAction } from "react";
import { useEffect } from "react";
import type { RepoInfo } from "../lib/api";
import {
  cachedRepos,
  fetchRepos,
  fetchSession,
  REPOS_CHANGED_EVENT,
} from "../lib/api";
import {
  onSessionTitleResolutionRequested,
  retrySessionTitleResolution,
  setKnownPrStates,
  setKnownRepos,
  setResolvedSessionTitles,
  setSessionTitles,
} from "../lib/markdown";
import { registerServiceWorker } from "../lib/push";
import { sessionReferenceTitle } from "../lib/session-title";
import type { UnifiedSession } from "../lib/types";

interface UseAppRegistriesOptions {
  sessions: UnifiedSession[];
  serviceWorker: boolean;
  setRegisteredRepoInfo: Dispatch<SetStateAction<RepoInfo[]>>;
}

export function useAppRegistries({
  sessions,
  serviceWorker,
  setRegisteredRepoInfo,
}: UseAppRegistriesOptions) {
  // Session-reference chips in transcripts (`bks-…`), and the pill the
  // composer projects a draft id into, label themselves from this registry.
  // markdown.ts renders to an HTML string rather than React nodes, so it
  // can't read this from context, so hand it the names we already poll.
  // No-ops unless a name actually changed.
  //
  // Human sessions name the workspace they open, matching the sidebar and
  // viewer header. Worker references are different: their session title says
  // which delegated task the chip opens, while their inherited workspace name
  // would incorrectly repeat the parent session's subject for every worker.
  useEffect(() => {
    setSessionTitles(
      sessions.map(
        (s) =>
          [
            s.id,
            sessionReferenceTitle(s),
            s.isRunning,
            s.title,
            s.aliasIds,
          ] as const,
      ),
    );
    setKnownPrStates(
      sessions.flatMap((session) => [
        ...(session.repo && session.prNumber
          ? [
              {
                repo: session.repo,
                number: session.prNumber,
                state: session.prState,
                isDraft: session.prIsDraft,
                mergeable: session.prMergeable,
                reviewDecision: session.prReviewDecision,
                checks: session.prChecks,
              },
            ]
          : []),
        ...(session.prs ?? []),
      ]),
    );
  }, [sessions]);
  // The live list intentionally omits archived history. Resolve only archived
  // sessions that a visible transcript or draft actually references, rather
  // than restoring the several-thousand-row archived payload to cold start.
  useEffect(
    () =>
      onSessionTitleResolutionRequested((ids) => {
        for (const requestedId of ids) {
          void fetchSession(requestedId)
            .then((session) => {
              setResolvedSessionTitles([
                {
                  requestedId,
                  ...(session
                    ? {
                        id: session.id,
                        title: sessionReferenceTitle(session),
                        tabTitle: session.title,
                        aliases: session.aliasIds,
                        archived: session.archived === true,
                      }
                    : { title: null }),
                },
              ]);
            })
            .catch(() => retrySessionTitleResolution(requestedId));
        }
      }),
    [],
  );
  // Same deal for PR-mention chips (`opensession#128`): markdown.ts only links
  // a qualified mention it can place, so it needs the repos this instance
  // serves — their ids to match on, their GitHub names for the cmd-click
  // escape to github.com. Bare `#5528` mentions don't come through here —
  // those belong to the repo of whatever surface renders them
  // (MarkdownRepoProvider).
  useEffect(() => {
    let live = true;
    const seeded = cachedRepos();
    if (seeded.length) setKnownRepos(seeded);
    const loadRepos = () =>
      fetchRepos()
        .then((repos) => {
          if (live) {
            setKnownRepos(repos);
            setRegisteredRepoInfo(repos);
          }
        })
        .catch(() => {});
    loadRepos();
    window.addEventListener(REPOS_CHANGED_EVENT, loadRepos);
    return () => {
      live = false;
      window.removeEventListener(REPOS_CHANGED_EVENT, loadRepos);
    };
  }, [setRegisteredRepoInfo]);
  // Register the service worker at boot, not just when enabling push: it also
  // caches the app shell (sw.js), so a cold start on a flaky tailnet paints
  // the app instead of white-screening.
  useEffect(() => {
    if (serviceWorker) return registerServiceWorker();
  }, [serviceWorker]);
}
