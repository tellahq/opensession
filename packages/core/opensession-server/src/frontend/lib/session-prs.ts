import type { SessionPrRef, UnifiedSession } from "./types";
import { mainSession } from "./landing-session";

export interface ProjectedSessionPr extends SessionPrRef {
  /** Primary-only fields retained on the legacy flat session shape. */
  mergeable?: string;
  updatedAt?: string;
  author?: string;
}

function flatPrimaryPr(
  session: UnifiedSession,
): ProjectedSessionPr | undefined {
  if (session.prNumber === undefined && !session.prUrl) return undefined;

  return {
    repo: session.repo || "repository",
    branch: session.branch || "",
    source: "primary",
    url: session.prUrl,
    state: session.prState,
    number: session.prNumber,
    title: session.prTitle,
    isDraft: session.prIsDraft,
    reviewDecision: session.prReviewDecision,
    mergeable: session.prMergeable,
    checks: session.prChecks,
    additions: session.prAdditions,
    deletions: session.prDeletions,
    updatedAt: session.prUpdatedAt,
    author: session.prAuthor,
  };
}

function mergePrimaryPr(
  legacy: ProjectedSessionPr,
  ref: SessionPrRef,
): ProjectedSessionPr {
  return {
    ...legacy,
    ...ref,
    source: "primary",
    url: ref.url ?? legacy.url,
    state: ref.state ?? legacy.state,
    number: ref.number ?? legacy.number,
    title: ref.title ?? legacy.title,
    isDraft: ref.isDraft ?? legacy.isDraft,
    reviewDecision: ref.reviewDecision ?? legacy.reviewDecision,
    checks: ref.checks ?? legacy.checks,
    additions: ref.additions ?? legacy.additions,
    deletions: ref.deletions ?? legacy.deletions,
  };
}

/**
 * One authoritative frontend projection of a session's PRs. New `prs[]` data
 * wins; legacy flat fields only fill missing primary values or older sessions
 * that have no primary entry in the list.
 */
export function sessionPrRefs(session: UnifiedSession): ProjectedSessionPr[] {
  const refs = session.prs || [];
  const legacy = flatPrimaryPr(session);
  if (!legacy) return refs;

  let foundPrimary = false;
  const projected = refs.map((ref) => {
    const primary =
      ref.source === "primary" ||
      (!!legacy.url && ref.url === legacy.url) ||
      (ref.repo === legacy.repo && ref.branch === legacy.branch);
    if (!primary) return ref;
    foundPrimary = true;
    return mergePrimaryPr(legacy, ref);
  });
  return foundPrimary ? projected : [legacy, ...projected];
}

function githubPrIdentity(
  value: string | undefined,
): { repo: string; number: number } | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value.trim());
    if (url.hostname.toLowerCase() !== "github.com") return undefined;
    const match = url.pathname.match(
      /^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/|$)/i,
    );
    if (!match?.[2] || !match[3]) return undefined;
    return { repo: match[2].toLowerCase(), number: Number(match[3]) };
  } catch {
    return undefined;
  }
}

function canonicalPrUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value.trim());
    const github =
      url.hostname.toLowerCase() === "github.com"
        ? url.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/|$)/i)
        : null;
    if (github) {
      return `https://github.com/${github[1]?.toLowerCase()}/${github[2]?.toLowerCase()}/pull/${github[3]}`;
    }
    url.hash = "";
    url.search = "";
    url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString().toLowerCase();
  } catch {
    return undefined;
  }
}

/** Match pasted PR links even when GitHub adds a tab, query, or trailing slash. */
export function prLinksMatch(
  query: string,
  candidate: string | undefined,
): boolean {
  const target = canonicalPrUrl(query);
  return target !== undefined && target === canonicalPrUrl(candidate);
}

/** Does a pasted PR link belong to any PR associated with this session? */
export function sessionUsesPrLink(
  session: UnifiedSession,
  query: string,
): boolean {
  const urls = [
    ...sessionPrRefs(session).map((pr) => pr.url),
    ...(session.linkedPrs || []).map((pr) => pr.url),
  ];
  if (urls.some((url) => prLinksMatch(query, url))) return true;

  const target = githubPrIdentity(query);
  if (!target) return false;
  const refs = [...sessionPrRefs(session), ...(session.linkedPrs || [])];
  return refs.some(
    (ref) =>
      ref.repo?.toLowerCase() === target.repo && ref.number === target.number,
  );
}

/**
 * A PR-backed workspace can contain the human implementation chat plus review
 * automations. A link search represents that workspace once, using the same
 * main-session choice as normal workspace navigation.
 */
export function collapsePrLinkSessions(
  sessions: UnifiedSession[],
): UnifiedSession[] {
  const byWorkspace = new Map<string, UnifiedSession[]>();
  for (const session of sessions) {
    if (!session.workspaceId) continue;
    const group = byWorkspace.get(session.workspaceId) || [];
    group.push(session);
    byWorkspace.set(session.workspaceId, group);
  }

  const emitted = new Set<string>();
  return sessions.flatMap((session) => {
    const workspaceId = session.workspaceId;
    if (!workspaceId) return [session];
    if (emitted.has(workspaceId)) return [];
    emitted.add(workspaceId);
    const oldestFirst = [...(byWorkspace.get(workspaceId) || [session])].sort(
      (a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""),
    );
    return [mainSession(oldestFirst) || session];
  });
}

/** Bare attached branches are targets, not PRs; every explicit PR still counts. */
function pullRequests(session: UnifiedSession) {
  return sessionPrRefs(session).filter(
    (ref) =>
      ref.source !== "attached" ||
      ref.number != null ||
      ref.url != null ||
      ref.state != null,
  );
}

/**
 * Pick the PR that owns the normal single-PR surface. A branch-derived PR is
 * always primary; when there is no such PR, a sole linked/discovered PR fills
 * that role instead of rendering as a one-item multi-PR stack.
 */
export interface SessionPrPresentation {
  primary?: SessionPrRef;
  additional: SessionPrRef[];
}

export function sessionPrPresentation(
  prs?: SessionPrRef[],
): SessionPrPresentation {
  const actual = (prs || []).filter((ref) => ref.number != null);
  const primary = actual.find((ref) => ref.source === "primary");
  if (primary)
    return {
      primary,
      additional: actual.filter((ref) => ref !== primary),
    };
  if (actual.length === 1) return { primary: actual[0], additional: [] };
  return { additional: actual };
}

/**
 * Does this session carry a given PR — on its own branch, through an attached
 * repo, by link, or by discovery? The client-side mirror of the server's
 * `sessionMatchesPr` (workspace-resolve.ts).
 *
 * A workspace holds many sessions and many PRs, but the review canvas only
 * offers the PRs of the session it renders — so opening "that PR" means
 * landing on a session that has it, not on whichever session the workspace
 * normally opens with.
 */
export function sessionCarriesPr(
  session: UnifiedSession,
  pr: { repo: string; branch?: string; number?: number },
): boolean {
  const same = (ref: {
    repo?: string;
    branch?: string | null;
    number?: number;
  }) =>
    ref.repo === pr.repo &&
    ((!!pr.branch && ref.branch === pr.branch) ||
      (pr.number !== undefined && ref.number === pr.number));
  return (
    same({
      repo: session.repo,
      branch: session.branch,
      number: session.prNumber,
    }) ||
    sessionPrRefs(session).some(same) ||
    (session.linkedPrs || []).some(same) ||
    (session.attachedRepos || []).some((r) =>
      same({ repo: r.repo, branch: r.branch }),
    )
  );
}

/**
 * Does this session have a PR at all? Counts the singular branch-derived fields
 * as well as the `prs` list, so a session whose PR sits on a branch it doesn't
 * own (a discovered one) counts too — those still have a diff to review.
 */
export function sessionHasPr(session: UnifiedSession): boolean {
  return pullRequests(session).length > 0;
}

/** Whether session metadata identifies an actual PR, rather than only a branch
 * state that can also be present for work shipping directly to main. */
export function sessionHasConnectedPr(session: UnifiedSession): boolean {
  return [...sessionPrRefs(session), ...(session.linkedPrs || [])].some(
    (ref) => ref.number != null || Boolean(ref.url),
  );
}

/** A multi-PR session has landed once every actual PR is terminal and one merged. */
export function sessionPrMerged(session: UnifiedSession): boolean {
  const refs = pullRequests(session);
  if (refs.length === 0) return session.prState === "MERGED";
  return (
    refs.every((ref) => ref.state === "MERGED" || ref.state === "CLOSED") &&
    refs.some((ref) => ref.state === "MERGED")
  );
}

/** A multi-PR session is reviewed once no actual PR is still awaiting review. */
export function sessionPrApproved(session: UnifiedSession): boolean {
  const refs = pullRequests(session);
  if (refs.length === 0) return session.prReviewDecision === "APPROVED";
  return refs.every(
    (ref) =>
      ref.state === "MERGED" ||
      ref.state === "CLOSED" ||
      ref.reviewDecision === "APPROVED",
  );
}
