/**
 * Archive a PR's own GitHub sessions (`bks-ghpr-<pr>-review`, `-mention`,
 * `-autofix`, ...) once the PR closes, merged or not, and bring them back when
 * it reopens or a new run starts in one of them.
 *
 * Session ids are deterministic (bksIdFor), so the close path reads each
 * candidate by id from the session-list index; it never lists sessions or
 * opens per-session databases. The bounded backfill pages the same index by id
 * prefix and asks GitHub about at most a few PRs per pass.
 */
import { configuredRepos, defaultRepo, type Repo } from "../../server/config";
import { audit } from "../../server/audit";
import { prKey } from "./constants";
import { bksIdFor, type GithubRunKind } from "./run";
import type { UnifiedSession } from "../../server/types";
import type { ArchiveReason } from "../../server/archive";

export const PR_SESSION_PREFIX = "bks-ghpr-";

/** The kinds keyed by a PR number. `issue` sessions are keyed by an ISSUE
 * number and outlive any PR they open, so they are never archived here. */
export const PR_SESSION_KINDS = [
  "review",
  "autofix",
  "simplify",
  "mention",
  "adversarial",
  "followup",
] as const satisfies readonly GithubRunKind[];

/** Every session id a PR's behaviors can own. */
export function prSessionIds(
  prNumber: number,
  ghRepo?: string,
  repos?: Record<string, Repo>,
): string[] {
  return PR_SESSION_KINDS.map((kind) =>
    bksIdFor(prNumber, kind, ghRepo, repos),
  );
}

/** Invert bksIdFor for a PR-keyed session id. Null for issue sessions, ids
 * from repositories no longer configured, and anything unparseable. */
export function parsePrSessionId(
  id: string,
  repos: Record<string, Repo> = configuredRepos(),
): { prNumber: number; ghRepo: string } | null {
  if (!id.startsWith(PR_SESSION_PREFIX)) return null;
  const rest = id.slice(PR_SESSION_PREFIX.length);
  const kind = PR_SESSION_KINDS.find((k) => rest.endsWith(`-${k}`));
  if (!kind) return null;
  const key = rest.slice(0, -(kind.length + 1));
  const match = /^(?:(.+)-)?(\d+)$/.exec(key);
  if (!match) return null;
  const prNumber = Number(match[2]);
  const ghRepo = match[1] ? repos[match[1]]?.ghRepo : defaultRepo(repos).ghRepo;
  if (!ghRepo || !Number.isSafeInteger(prNumber)) return null;
  // Round-trip so a repo id that only looks like a prefix never matches.
  return prKey(prNumber, ghRepo, repos) === key ? { prNumber, ghRepo } : null;
}

// ── Per-PR serialization ─────────────────────────────────────────────────

const prQueues = new Map<string, Promise<unknown>>();

/**
 * Run `fn` after every earlier archive operation on the same PR settles.
 * Close, reopen, a run's unarchive and the backfill each await indexed reads
 * before they write, so unserialized they can interleave: a reopen could read
 * the reason before close wrote `auto`, finish first, and leave a reopened
 * PR's sessions archived. Callers enqueue synchronously, in event order.
 */
export function withPrArchiveLock<T>(
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = prQueues.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => {});
  prQueues.set(key, tail);
  void tail.then(() => {
    if (prQueues.get(key) === tail) prQueues.delete(key);
  });
  return run;
}

function prLockKey(
  prNumber: number,
  ghRepo: string,
  repos?: Record<string, Repo>,
): string {
  return prKey(prNumber, ghRepo, repos);
}

export interface PrSessionArchiveDeps {
  /** One indexed row by id, runtime-enriched (isRunning is current). */
  readSession(id: string): Promise<UnifiedSession | null>;
  isArchivedId(id: string): boolean;
  archiveReason(id: string): ArchiveReason | null;
  /** True while any engine or journaled run owns this session. */
  hasInFlightRun(session: UnifiedSession): boolean;
  /** True while a review or code loop holds the PR's in-memory lock. */
  prLocked(prNumber: number, ghRepo: string): boolean;
  archive(session: UnifiedSession): Promise<void>;
  unarchive(session: UnifiedSession): Promise<boolean>;
  repos(): Record<string, Repo>;
}

async function defaultDeps(): Promise<PrSessionArchiveDeps> {
  const [archive, store, cache, journal, state, projection, unarchive] =
    await Promise.all([
      import("../../server/archive"),
      import("../../server/session-list-store"),
      import("../../server/session-cache"),
      import("../../server/run-journal"),
      import("./state"),
      import("../../server/session-projection-executor"),
      import("../../server/session-unarchive"),
    ]);
  return {
    async readSession(id) {
      const row = await store.indexedSession(id);
      return row ? (cache.enrichSessionRuntime([{ ...row }])[0] ?? null) : null;
    },
    isArchivedId: archive.isArchivedId,
    archiveReason: archive.getArchiveReason,
    hasInFlightRun: (s) =>
      !!s.isRunning ||
      journal.hasActiveRunFor(s.id, s.claudeSessionId, s.codexThreadId),
    prLocked: (prNumber, ghRepo) =>
      state.isLockHeld("review", prNumber, ghRepo) ||
      state.isLockHeld("code", prNumber, ghRepo),
    async archive(session) {
      await projection.executeArchiveOverrideProjection(session.id, () =>
        archive.setArchived(session.id, true, "auto"),
      );
      await cache.publishSessionChange(session.id);
      const members = session.workspaceId
        ? await store.indexedWorkspaceMembers(session.workspaceId)
        : [session];
      await archive.unpinArchivedSessions([session], members);
    },
    unarchive: (session) => unarchive.unarchiveForHumanTurn(session),
    repos: configuredRepos,
  };
}

/**
 * Archive the closed PR's sessions with reason `auto`. Skips sessions already
 * archived (a manual archive keeps its reason) and any with an in-flight run;
 * a PR whose review or code lock is held is skipped whole. The backfill sweep
 * retries what was skipped. Returns the archived ids.
 */
export function archiveClosedPrSessions(
  prNumber: number,
  ghRepo: string,
  deps?: PrSessionArchiveDeps,
): Promise<string[]> {
  return withPrArchiveLock(prLockKey(prNumber, ghRepo, deps?.repos()), () =>
    archiveClosedPrSessionsNow(prNumber, ghRepo, deps),
  );
}

async function archiveClosedPrSessionsNow(
  prNumber: number,
  ghRepo: string,
  deps?: PrSessionArchiveDeps,
): Promise<string[]> {
  const d = deps ?? (await defaultDeps());
  if (d.prLocked(prNumber, ghRepo)) return [];
  const archived: string[] = [];
  for (const id of prSessionIds(prNumber, ghRepo, d.repos())) {
    const session = await d.readSession(id);
    if (!session || session.archived || d.isArchivedId(id)) continue;
    if (d.hasInFlightRun(session)) continue;
    await d.archive(session);
    archived.push(id);
  }
  if (archived.length) {
    console.log(
      `[github] PR #${prNumber} closed → archived ${archived.join(", ")}`,
    );
    audit({
      msg: "github_pr_sessions_archived",
      pr_number: prNumber,
      repo: ghRepo,
      session_ids: archived,
    });
  }
  return archived;
}

/** On reopen, restore only the sessions this module archived (reason `auto`).
 * A person's manual archive stays. Returns the restored ids. */
export function restoreReopenedPrSessions(
  prNumber: number,
  ghRepo: string,
  deps?: PrSessionArchiveDeps,
): Promise<string[]> {
  return withPrArchiveLock(prLockKey(prNumber, ghRepo, deps?.repos()), () =>
    restoreReopenedPrSessionsNow(prNumber, ghRepo, deps),
  );
}

async function restoreReopenedPrSessionsNow(
  prNumber: number,
  ghRepo: string,
  deps?: PrSessionArchiveDeps,
): Promise<string[]> {
  const d = deps ?? (await defaultDeps());
  const restored: string[] = [];
  for (const id of prSessionIds(prNumber, ghRepo, d.repos())) {
    if (d.archiveReason(id) !== "auto") continue;
    const session = await d.readSession(id);
    if (session && (await d.unarchive(session))) restored.push(id);
  }
  if (restored.length)
    console.log(
      `[github] PR #${prNumber} reopened → unarchived ${restored.join(", ")}`,
    );
  return restored;
}

/** A new run in a GitHub session brings it back, whatever archived it: the
 * run's output and links would otherwise land in a hidden session. */
export function unarchiveGithubRunSession(
  bksId: string,
  deps?: PrSessionArchiveDeps,
): Promise<boolean> {
  const pr = parsePrSessionId(bksId, deps?.repos() ?? configuredRepos());
  return withPrArchiveLock(
    pr ? prLockKey(pr.prNumber, pr.ghRepo, deps?.repos()) : bksId,
    async () => {
      const d = deps ?? (await defaultDeps());
      if (!d.isArchivedId(bksId)) return false;
      const session = (await d.readSession(bksId)) ?? {
        id: bksId,
        archived: true,
      };
      return d.unarchive(session as UnifiedSession);
    },
  );
}

// ── Backfill ─────────────────────────────────────────────────────────────

/** Live session rows fetched from the index per pass. */
export const SWEEP_PAGE_SIZE = 50;
/** GitHub lookups per pass; one REST call each. */
export const SWEEP_MAX_LOOKUPS = 10;

export interface ClosedPrSweepDeps extends PrSessionArchiveDeps {
  /** Live rows by id prefix after `afterId`; null when the index has no coverage. */
  listLive(afterId: string, limit: number): Promise<UnifiedSession[] | null>;
  /** "open" | "closed", or null when GitHub could not answer. */
  prState(prNumber: number, ghRepo: string): Promise<"open" | "closed" | null>;
  rateLimited(ghRepo: string): Promise<boolean>;
}

export interface ClosedPrSweepResult {
  /** Resume point for the next pass; "" restarts from the first id. */
  cursor: string;
  lookups: number;
  archived: string[];
}

/**
 * One bounded backfill pass for sessions left active by PRs that closed
 * before close-time archiving existed (or whose close was skipped because a
 * run was in flight). Reads one page of live `bks-ghpr-*` rows from the index,
 * checks at most SWEEP_MAX_LOOKUPS distinct PRs on GitHub, and archives the
 * closed ones. Stops early, keeping its cursor, on a rate limit or an
 * unreadable PR, so the next pass resumes there. `knownOpen` holds `prKey`s
 * this cycle already saw open, which cost no lookup.
 */
export async function sweepClosedPrSessions(
  cursor: string,
  deps: ClosedPrSweepDeps,
  knownOpen: ReadonlySet<string> = new Set(),
): Promise<ClosedPrSweepResult> {
  const page = await deps.listLive(cursor, SWEEP_PAGE_SIZE);
  if (page === null) return { cursor, lookups: 0, archived: [] };
  const repos = deps.repos();
  const seen = new Map<string, "open" | "closed">();
  const archived: string[] = [];
  let lookups = 0;
  let next = cursor;
  for (const session of page) {
    const parsed = parsePrSessionId(session.id, repos);
    if (parsed) {
      const key = prKey(parsed.prNumber, parsed.ghRepo, repos);
      let state = seen.get(key) ?? (knownOpen.has(key) ? "open" : undefined);
      if (!state) {
        if (lookups >= SWEEP_MAX_LOOKUPS) break;
        if (await deps.rateLimited(parsed.ghRepo)) break;
        lookups++;
        const fetched = await deps
          .prState(parsed.prNumber, parsed.ghRepo)
          .catch(() => null);
        if (!fetched) break;
        state = fetched;
        seen.set(key, state);
        if (state === "closed")
          archived.push(
            ...(await archiveClosedPrSessions(
              parsed.prNumber,
              parsed.ghRepo,
              deps,
            )),
          );
      }
    }
    next = session.id;
  }
  // A short page that was fully processed is the end of the family: wrap.
  const finished = page.length < SWEEP_PAGE_SIZE && next === page.at(-1)?.id;
  return {
    cursor: finished || page.length === 0 ? "" : next,
    lookups,
    archived,
  };
}

export function closedPrSweepEnabled(): boolean {
  return process.env.OPENSESSION_PR_SESSION_ARCHIVE_SWEEP !== "0";
}

async function defaultSweepDeps(): Promise<ClosedPrSweepDeps> {
  const [base, store, rest, limit] = await Promise.all([
    defaultDeps(),
    import("../../server/session-list-store"),
    import("./github-rest"),
    import("../../server/github-limit"),
  ]);
  return {
    ...base,
    listLive: (afterId, n) =>
      store.indexedLiveSessionsByIdPrefix(PR_SESSION_PREFIX, afterId, n),
    async prState(prNumber, ghRepo) {
      const issue = await rest.getIssue(prNumber, ghRepo);
      return issue?.isPullRequest ? issue.state : null;
    },
    rateLimited: (ghRepo) => limit.ghRateLimited("rest", { repo: ghRepo }),
  };
}

/** One pass from the process-wide cursor. Called by the reconcile sweep. */
export async function runClosedPrSessionSweep(
  knownOpen?: ReadonlySet<string>,
): Promise<void> {
  if (!closedPrSweepEnabled()) return;
  const g = globalThis as { __githubClosedPrSweepCursor?: string };
  const result = await sweepClosedPrSessions(
    g.__githubClosedPrSweepCursor ?? "",
    await defaultSweepDeps(),
    knownOpen,
  );
  g.__githubClosedPrSweepCursor = result.cursor;
}
