import { sendPushToUser, type PushPayload } from "./push";
import { getOpenPrs, refreshPrCache, type OpenPrEntry } from "./sessions";
import { personKeyToDisplayName } from "./shared/user-mappings";
import { configuredRepos } from "./config";

const POLL_MS = 60_000;
const INTERNAL_MIRROR_TTL_MS = 10 * 60_000;

const internalMirrors = new Map<string, number>();

function mirrorKey(ghRepo: string, branch: string, reviewer: string): string {
  return `${ghRepo}\0${branch}\0${reviewer.toLowerCase()}`;
}

/** Record an internal Reviewer-picker assignment before it is mirrored to
 * GitHub. The GitHub watcher consumes this marker so that mirror creates no
 * second push; direct assignments made on GitHub have no marker and do push. */
export function markPrReviewNotified(
  ghRepo: string,
  branch: string,
  reviewer: string,
): void {
  internalMirrors.set(mirrorKey(ghRepo, branch, reviewer), Date.now());
}

function consumeInternalMirror(pr: OpenPrEntry, reviewer: string): boolean {
  const ghRepo = configuredRepos()[pr.repo]?.ghRepo || pr.repo;
  const key = mirrorKey(ghRepo, pr.branch, reviewer);
  const markedAt = internalMirrors.get(key);
  internalMirrors.delete(key);
  if (markedAt === undefined) return false;
  return Date.now() - markedAt < INTERNAL_MIRROR_TTL_MS;
}

interface PrReviewNotificationDeps {
  refresh: () => Promise<Set<string>>;
  getPrs: () => OpenPrEntry[];
  resolveUser: (personKey: string) => string | null;
  shouldSuppress?: (pr: OpenPrEntry, reviewer: string) => boolean;
  sendPush: (user: string, payload: PushPayload) => Promise<void>;
}

const defaultDeps: PrReviewNotificationDeps = {
  refresh: refreshPrCache,
  getPrs: getOpenPrs,
  resolveUser: personKeyToDisplayName,
  shouldSuppress: consumeInternalMirror,
  sendPush: sendPushToUser,
};

function assignmentKey(pr: OpenPrEntry, reviewer: string): string {
  return `${pr.number}\0${reviewer.toLowerCase()}`;
}

export function createPrReviewNotifier(
  deps: PrReviewNotificationDeps = defaultDeps,
) {
  const previousByRepo = new Map<string, Set<string>>();
  let pollPromise: Promise<void> | null = null;

  const pollOnce = (): Promise<void> => {
    if (pollPromise) return pollPromise;
    pollPromise = (async () => {
      const freshRepos = await deps.refresh();
      const currentByRepo = new Map<string, Set<string>>();
      for (const repo of freshRepos) currentByRepo.set(repo, new Set());

      const assignments: Array<{ pr: OpenPrEntry; reviewer: string }> = [];
      for (const pr of deps.getPrs()) {
        const current = currentByRepo.get(pr.repo);
        if (!current) continue;
        for (const reviewer of pr.reviewRequested) {
          current.add(assignmentKey(pr, reviewer));
          assignments.push({ pr, reviewer });
        }
      }

      const previous = new Map(previousByRepo);
      // Advance state before any network sends. A failed push is best-effort and
      // must not retry every minute; a real remove -> re-request still alerts.
      for (const [repo, assignments] of currentByRepo) {
        previousByRepo.set(repo, assignments);
      }

      const sends: Promise<void>[] = [];
      for (const { pr, reviewer } of assignments) {
        const old = previous.get(pr.repo);
        if (!old || old.has(assignmentKey(pr, reviewer))) continue;
        if (deps.shouldSuppress?.(pr, reviewer)) continue;
        const user = deps.resolveUser(reviewer);
        if (!user) continue;
        sends.push(
          deps.sendPush(user, {
            title: "GitHub review requested",
            body: `${pr.title} by ${pr.author} (#${pr.number})`.slice(0, 180),
            url: `/pr/${encodeURIComponent(pr.repo)}/${encodeURIComponent(pr.branch)}`,
          }),
        );
      }
      await Promise.allSettled(sends);
    })().finally(() => {
      pollPromise = null;
    });
    return pollPromise;
  };

  return {
    pollOnce,
    start(): () => void {
      void pollOnce();
      const timer = setInterval(() => void pollOnce(), POLL_MS);
      return () => clearInterval(timer);
    },
  };
}

let stopTicker: (() => void) | null = null;

/** Start once from opensession.ts's __opensessionBooted block. */
export function startPrReviewNotificationTicker(): void {
  if (stopTicker) return;
  stopTicker = createPrReviewNotifier().start();
}
