/**
 * Everything pull-request: open-PR list, per-session PR details/diff/comment/
 * review/merge/close, PR agent actions, session-less PR previews.
 *
 * Extracted verbatim from the opensession.ts fetch chain. Every handler
 * returns a Response for a matched route or undefined to fall through to the
 * next handler (see routes/index.ts for the dispatch order).
 */

import { requestUser, type RouteContext } from "./context";
import { defaultRepo, personaName } from "../config";
import { hostRepoId, prHostFor } from "../pr-host";
import { cachedPrDetailsForSession, reconcilePrDetails } from "../pr-info";
import { getPrStack, linkPrStack, mergePrStack } from "../pr-stack";
import { findSessionAsync, invalidateSessionsCache } from "../session-cache";
import { getSessionControl } from "../session-control";
import { indexedWorkspaceMemberSessions } from "../session-list-store";
import { projectWorkspacePrRefs } from "../session-pr-target";
import { resolvePrTarget } from "../session-repos";
import {
  getOpenPrs,
  getPrReviewStatus,
  getRecentPrs,
  getRecentPrsForPerson,
  markCachedPrClosed,
  markCachedPrMerged,
  markCachedPrReviewed,
} from "../sessions";
import { githubLoginToPersonKey } from "../shared/user-mappings";
import { getRepo } from "../worktree";
import { existsSync, watch } from "fs";
import {
  githubCredentialRequiredResponse,
  githubMutationCredential,
} from "./github-credential";
import { conditionalJsonResponse } from "../http-json";

function validDiffGroupingInput(body: any): {
  files: Array<{
    path: string;
    additions: number;
    deletions: number;
  }>;
  patch: string;
} | null {
  if (!Array.isArray(body?.files) || typeof body?.patch !== "string")
    return null;
  const files = body.files.filter(
    (file: any) =>
      typeof file?.path === "string" &&
      file.path.length <= 1000 &&
      typeof file.additions === "number" &&
      typeof file.deletions === "number",
  );
  return files.length === body.files.length
    ? { files, patch: body.patch }
    : null;
}

async function prApiResponse(
  load: () => Promise<unknown>,
  fallback?: unknown,
): Promise<Response> {
  try {
    return Response.json(await load());
  } catch (e: any) {
    if (fallback !== undefined) return Response.json(fallback);
    return Response.json(
      {
        error:
          e?.message || "GitHub's pull request API is unavailable right now.",
      },
      { status: 502 },
    );
  }
}

async function loadPrCodeFlow(
  repo: ReturnType<typeof getRepo>,
  branch: string,
  repoId: string,
) {
  const host = prHostFor(repo);
  const [details, diff] = await Promise.all([
    host.getPrDetails(branch, repoId),
    host.getPrDiff(branch, repoId, 1024 * 1024),
  ]);
  if (!details || !diff || (!diff.patch && !diff.skippedFiles)) return null;
  const { prCodeFlow } = await import("../code-flow");
  return prCodeFlow(repo, details, diff);
}

async function findPrSessionAsync(sessionId: string) {
  const session = await findSessionAsync(sessionId);
  if (!session?.workspaceId) return session;
  return projectWorkspacePrRefs(
    session,
    indexedWorkspaceMemberSessions(session.workspaceId),
  );
}

async function codeFlowApiResponse(
  load: () => Promise<unknown>,
): Promise<Response> {
  try {
    return Response.json(await load());
  } catch (error) {
    const { codeFlowHttpError } = await import("../code-flow");
    const response = codeFlowHttpError(error);
    return Response.json(
      { error: response.message },
      { status: response.status },
    );
  }
}

export async function handlePrRoutes(
  ctx: RouteContext,
): Promise<Response | undefined> {
  const { req, url, path, publicPrefix } = ctx;

  // Every open PR in the repo, attributed to teammates via the GitHub
  // identity table — the sidebar's Open PRs section (which must include
  // PRs that have no Open Session session).
  if (path === "/api/open-prs" && req.method === "GET") {
    return conditionalJsonResponse(req, { prs: getOpenPrs() });
  }

  // Resolved review threads shown at the bottom of each file. GitHub's REST
  // pull-request shape omits thread resolution, so this reads the GraphQL
  // reviewThreads connection used by the review agent. The UI keeps these
  // collapsed until someone asks to see the conversation.
  if (path === "/api/pr-review-threads" && req.method === "GET") {
    const number = parseInt(url.searchParams.get("number") || "", 10);
    if (!Number.isFinite(number) || number < 1)
      return Response.json({ error: "number required" }, { status: 400 });
    const repo = getRepo(url.searchParams.get("repo") || undefined);
    if (repo.host && repo.host !== "github")
      return Response.json({ threads: [] });
    const { listReviewThreads } =
      await import("../../agents/github/github-rest");
    return prApiResponse(
      async () => ({
        threads: (await listReviewThreads(number, repo.ghRepo)).filter(
          (thread) => thread.isResolved && thread.path,
        ),
      }),
      { threads: [] },
    );
  }

  // GitHub's per-viewer "Viewed" file state on a PR (the review canvas
  // checkboxes). GET lists the viewer's VIEWED paths; POST marks/unmarks one
  // file. State lives on GitHub (markFileAsViewed), so it round-trips with
  // github.com's own file list. See src/server/pr-viewed.ts.
  if (path === "/api/pr-viewed-files" && req.method === "GET") {
    const repoId = url.searchParams.get("repo");
    const number = parseInt(url.searchParams.get("number") || "", 10);
    if (!Number.isFinite(number))
      return Response.json({ error: "number required" }, { status: 400 });
    const { getPrViewedFiles } = await import("../pr-viewed");
    try {
      return Response.json(
        await getPrViewedFiles(
          ctx,
          requestUser(ctx, url.searchParams.get("user")),
          (repoId ? getRepo(repoId) : defaultRepo()).ghRepo,
          number,
        ),
      );
    } catch (e: any) {
      return Response.json({ error: e?.message || String(e) }, { status: 502 });
    }
  }
  if (path === "/api/pr-viewed-files" && req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as {
      prId?: string;
      path?: string;
      viewed?: boolean;
      user?: string;
    };
    if (!body.prId || !body.path || typeof body.viewed !== "boolean")
      return Response.json(
        { error: "prId, path and viewed required" },
        { status: 400 },
      );
    const { setPrFileViewed } = await import("../pr-viewed");
    try {
      await setPrFileViewed(
        ctx,
        requestUser(ctx, body.user),
        body.prId,
        body.path,
        body.viewed,
      );
      return Response.json({ ok: true });
    } catch (e: any) {
      return Response.json({ error: e?.message || String(e) }, { status: 502 });
    }
  }

  // Recent PRs across the covered repos, including merges made without an
  // Open Session workspace. Powers the root shipped-worktree index.
  if (path === "/api/recent-prs" && req.method === "GET") {
    const person = url.searchParams.get("person");
    let prs = person ? await getRecentPrsForPerson(person) : getRecentPrs();
    const repo = url.searchParams.get("repo");
    const number = Number(url.searchParams.get("number"));
    if (repo) prs = prs.filter((pr) => pr.repo === repo);
    if (Number.isInteger(number) && number > 0)
      prs = prs.filter((pr) => pr.number === number);
    const days = Math.min(
      3650,
      Math.max(0, Number(url.searchParams.get("days")) || 0),
    );
    if (days) {
      const cutoff = Date.now() - days * 86_400_000;
      const older = prs.find((pr) => (Date.parse(pr.updatedAt) || 0) < cutoff);
      prs = prs.filter((pr) => (Date.parse(pr.updatedAt) || 0) >= cutoff);
      // One marker beyond the requested window tells the feed that "Show
      // more" has useful work without sending the whole older history.
      if (older) prs.push(older);
    }
    const limit = Math.min(
      5000,
      Math.max(0, Number(url.searchParams.get("limit")) || 0),
    );
    if (limit) prs = prs.slice(0, limit);
    return conditionalJsonResponse(req, { prs });
  }

  // The same window for repos that ship without pull requests: commits on
  // their default branch, read from the checkout (see recent-commits.ts).
  // `?days=` widens it — the feed asks for more as you page down, and the
  // answer says which window it served so the client knows when it's at the
  // end of what's readable.
  if (path === "/api/recent-commits" && req.method === "GET") {
    const { getRecentCommits, DEFAULT_DAYS } =
      await import("../recent-commits");
    const asked = Number(url.searchParams.get("days"));
    return Response.json(await getRecentCommits(asked || DEFAULT_DAYS));
  }

  // One commit by sha, for the transcript's commit references (the hover card
  // behind `4ed1ef09`). `?repo=` is where the sha was written and is searched
  // first; the answer names the repo it was actually found in. Null when no
  // checkout has it, which is what an unresolvable reference gets.
  if (path === "/api/commit" && req.method === "GET") {
    const { lookupCommit } = await import("../commit-lookup");
    return Response.json(
      await lookupCommit(
        url.searchParams.get("sha") || "",
        url.searchParams.get("repo") || undefined,
      ),
    );
  }

  // PR details for a session's branch (PR tab). `?repo=<project>` targets an
  // attached repo's PR; `?repo=&branch=` a linked PR (which may be another
  // branch of the primary repo); default/primary the session's own branch.
  if (path.match(/^\/api\/sessions\/(.+)\/pr$/) && req.method === "GET") {
    const sessionId = decodeURIComponent(
      path.match(/^\/api\/sessions\/(.+)\/pr$/)![1],
    );
    const session = await findPrSessionAsync(sessionId);
    if (!session)
      return Response.json({ error: "Session not found" }, { status: 404 });
    const target = resolvePrTarget(
      session,
      url.searchParams.get("repo"),
      url.searchParams.get("branch"),
    );
    if (!target) return Response.json(null);
    const host = prHostFor(getRepo(target.repoId));
    const fallback = cachedPrDetailsForSession(
      session,
      target.repoId,
      target.branch,
    );
    // The branch this session stacked on, for the panel's "link this stack"
    // action. Only for the session's OWN branch — an attached or linked PR is
    // not what this session was stacked on top of.
    const primaryTarget = resolvePrTarget(session);
    const stackBase =
      session.stackedOn?.branch &&
      target.repoId === primaryTarget?.repoId &&
      target.branch === primaryTarget.branch
        ? session.stackedOn.branch
        : undefined;
    const withReview = <
      T extends { number: number; headRefOid?: string } | null,
    >(
      details: T,
    ) =>
      details
        ? {
            ...details,
            capabilities: host.capabilities,
            ...(stackBase ? { stackBase } : {}),
            ...getPrReviewStatus(
              details.number,
              target.ghRepo,
              details.headRefOid,
            ),
          }
        : null;
    return prApiResponse(
      async () =>
        withReview(
          reconcilePrDetails(
            await host.getPrDetails(target.branch, target.ghRepo),
            fallback,
          ),
        ),
      withReview(fallback) ?? undefined,
    );
  }

  // PR diff for inline review in the PR tab
  if (path.match(/^\/api\/sessions\/(.+)\/pr-diff$/) && req.method === "GET") {
    const sessionId = decodeURIComponent(
      path.match(/^\/api\/sessions\/(.+)\/pr-diff$/)![1],
    );
    const session = await findPrSessionAsync(sessionId);
    if (!session)
      return Response.json({ error: "Session not found" }, { status: 404 });
    const target = resolvePrTarget(
      session,
      url.searchParams.get("repo"),
      url.searchParams.get("branch"),
    );
    if (!target) return Response.json(null);
    return prApiResponse(() =>
      prHostFor(getRepo(target.repoId)).getPrDiff(target.branch, target.ghRepo),
    );
  }

  // Structural code-flow view for every session-backed PR target (primary,
  // attached, linked, or discovered). Source bytes come from immutable refs.
  if (
    path.match(/^\/api\/sessions\/(.+)\/pr-code-flow$/) &&
    req.method === "GET"
  ) {
    const sessionId = decodeURIComponent(
      path.match(/^\/api\/sessions\/(.+)\/pr-code-flow$/)![1],
    );
    const session = await findPrSessionAsync(sessionId);
    if (!session)
      return Response.json({ error: "Session not found" }, { status: 404 });
    const target = resolvePrTarget(
      session,
      url.searchParams.get("repo"),
      url.searchParams.get("branch"),
    );
    if (!target) return Response.json(null);
    const repo = getRepo(target.repoId);
    return codeFlowApiResponse(() =>
      loadPrCodeFlow(repo, target.branch, target.ghRepo),
    );
  }

  // AI-powered file categories for the PR Changes view. Kept separate from
  // the diff endpoint so loading a review never blocks on model generation.
  if (
    path.match(/^\/api\/sessions\/(.+)\/pr-diff-groups$/) &&
    req.method === "POST"
  ) {
    const sessionId = decodeURIComponent(
      path.match(/^\/api\/sessions\/(.+)\/pr-diff-groups$/)![1],
    );
    const session = await findPrSessionAsync(sessionId);
    if (!session)
      return Response.json({ error: "Session not found" }, { status: 404 });
    const target = resolvePrTarget(
      session,
      url.searchParams.get("repo"),
      url.searchParams.get("branch"),
    );
    if (!target) return Response.json({ groups: null });
    const body = await req.json().catch(() => ({}));
    const { getDiffFileGroups } = await import("../diff-groups");
    const input = validDiffGroupingInput(body);
    if (!input)
      return Response.json({ error: "Invalid diff metadata" }, { status: 400 });
    return Response.json({
      groups: await getDiffFileGroups(target.ghRepo, input.files, input.patch),
    });
  }

  // Link a PR to the session (a follow-up PR, or one in another repo/branch).
  // Body: { url } or { repo, number } or { repo, branch }.
  if (path.match(/^\/api\/sessions\/(.+)\/link-pr$/) && req.method === "POST") {
    const sessionId = decodeURIComponent(
      path.match(/^\/api\/sessions\/(.+)\/link-pr$/)![1],
    );
    const body = await req.json().catch(() => ({}));
    try {
      const { linkPr } = await import("../session-repos");
      const result = await linkPr(sessionId, {
        url: body.url,
        repo: body.repo,
        number: body.number,
        branch: body.branch,
      });
      invalidateSessionsCache(); // session.prs / linkedPrs changed
      return Response.json({ ok: true, ...result });
    } catch (e: any) {
      return Response.json({ error: e.message || String(e) }, { status: 400 });
    }
  }

  // Unlink a PR (drops the link only — the PR itself is untouched). POST, not
  // DELETE, so it isn't swallowed by the generic DELETE /sessions/:id route.
  if (
    path.match(/^\/api\/sessions\/(.+)\/unlink-pr$/) &&
    req.method === "POST"
  ) {
    const sessionId = decodeURIComponent(
      path.match(/^\/api\/sessions\/(.+)\/unlink-pr$/)![1],
    );
    const body = await req.json().catch(() => ({}));
    if (!body.repo || !body.branch)
      return Response.json(
        { error: "repo and branch required" },
        { status: 400 },
      );
    try {
      const { unlinkPr } = await import("../session-repos");
      const all = unlinkPr(sessionId, body.repo, body.branch);
      invalidateSessionsCache();
      return Response.json({ ok: true, all });
    } catch (e: any) {
      return Response.json({ error: e.message || String(e) }, { status: 400 });
    }
  }

  // AI review guide for the PR tab's Guide view — generated on first
  // request per head commit (slow: a one-shot over the whole diff),
  // cached after that. null = no PR / generation failed (UI falls back
  // to the plain diff).
  if (
    path.match(/^\/api\/sessions\/(.+)\/review-guide$/) &&
    req.method === "GET"
  ) {
    const sessionId = decodeURIComponent(
      path.match(/^\/api\/sessions\/(.+)\/review-guide$/)![1],
    );
    const session = await findPrSessionAsync(sessionId);
    if (!session)
      return Response.json({ error: "Session not found" }, { status: 404 });
    const target = resolvePrTarget(
      session,
      url.searchParams.get("repo"),
      url.searchParams.get("branch"),
    );
    if (!target) return Response.json(null);
    const { getReviewGuide } = await import("../../server/review-guide");
    return prApiResponse(() =>
      getReviewGuide(target.branch, getRepo(target.repoId)),
    );
  }

  // An image blob from a repo at a ref, for PR diff views — binary files have
  // no textual hunks, so the client renders the picture itself (head ref for
  // the new side, base ref for the old). Image extensions only; the repo must
  // be registered. Served through gh so private repos work.
  if (path === "/api/pr-image" && req.method === "GET") {
    const filePath = url.searchParams.get("path") || "";
    const ref = url.searchParams.get("ref") || "";
    const { imageContentType, imageHeaders } = await import("../image-mime");
    const contentType = imageContentType(filePath);
    if (!contentType || !ref)
      return new Response("path (an image) and ref required", { status: 400 });
    const repo = getRepo(url.searchParams.get("repo") || undefined);
    const proc = Bun.spawn(
      [
        "gh",
        "api",
        "-H",
        "Accept: application/vnd.github.raw",
        `repos/${repo.ghRepo}/contents/${encodeURIComponent(filePath).replace(/%2F/gi, "/")}?ref=${encodeURIComponent(ref)}`,
      ],
      { stdout: "pipe", stderr: "ignore" },
    );
    const bytes = await new Response(proc.stdout).arrayBuffer();
    if ((await proc.exited) !== 0 || bytes.byteLength === 0)
      return new Response("Not found at that ref", { status: 404 });
    return new Response(bytes, {
      headers: imageHeaders(contentType, "private, max-age=120"),
    });
  }

  // Text file contents at a PR revision. This mirrors pr-image but returns JSON
  // for clipboard actions in the review file menu. The repo must be registered,
  // and gh supplies the private-repo credential server-side.
  if (path === "/api/pr-file" && req.method === "GET") {
    const filePath = url.searchParams.get("path") || "";
    const ref = url.searchParams.get("ref") || "";
    if (!filePath || !ref)
      return Response.json({ error: "path and ref required" }, { status: 400 });
    const repo = getRepo(url.searchParams.get("repo") || undefined);
    const proc = Bun.spawn(
      [
        "gh",
        "api",
        "-H",
        "Accept: application/vnd.github.raw",
        `repos/${repo.ghRepo}/contents/${encodeURIComponent(filePath).replace(/%2F/gi, "/")}?ref=${encodeURIComponent(ref)}`,
      ],
      { stdout: "pipe", stderr: "ignore" },
    );
    const content = await new Response(proc.stdout).text();
    if ((await proc.exited) !== 0)
      return Response.json(
        { error: "File not found at that revision" },
        { status: 404 },
      );
    return Response.json({ content });
  }

  // Session-less PR preview (sidebar PR rows with no session yet): PR details
  // and diff straight from repo+branch — same pr-info helpers as the
  // session routes, minus the session lookup.
  if (path === "/api/pr-preview" && req.method === "GET") {
    const branch = url.searchParams.get("branch") || "";
    if (!branch)
      return Response.json({ error: "branch required" }, { status: 400 });
    const repo = getRepo(url.searchParams.get("repo") || undefined);
    const host = prHostFor(repo);
    return prApiResponse(async () => {
      const details = await host.getPrDetails(branch, hostRepoId(repo));
      return details ? { ...details, capabilities: host.capabilities } : null;
    });
  }
  if (path === "/api/pr-preview-diff" && req.method === "GET") {
    const branch = url.searchParams.get("branch") || "";
    if (!branch)
      return Response.json({ error: "branch required" }, { status: 400 });
    const repo = getRepo(url.searchParams.get("repo") || undefined);
    return prApiResponse(() =>
      prHostFor(repo).getPrDiff(branch, hostRepoId(repo)),
    );
  }
  if (path === "/api/pr-preview-code-flow" && req.method === "GET") {
    const branch = url.searchParams.get("branch") || "";
    if (!branch)
      return Response.json({ error: "branch required" }, { status: 400 });
    const repo = getRepo(url.searchParams.get("repo") || undefined);
    return codeFlowApiResponse(() =>
      loadPrCodeFlow(repo, branch, hostRepoId(repo)),
    );
  }
  if (path === "/api/pr-preview-diff-groups" && req.method === "POST") {
    const repo = getRepo(url.searchParams.get("repo") || undefined);
    const body = await req.json().catch(() => ({}));
    const input = validDiffGroupingInput(body);
    if (!input)
      return Response.json({ error: "Invalid diff metadata" }, { status: 400 });
    const { getDiffFileGroups } = await import("../diff-groups");
    return Response.json({
      groups: await getDiffFileGroups(
        hostRepoId(repo),
        input.files,
        input.patch,
      ),
    });
  }
  // Session-less review guide for the preview's Guide tab — getReviewGuide
  // only needs branch+repo (same generation/cache as the session route).
  if (path === "/api/pr-preview-guide" && req.method === "GET") {
    const branch = url.searchParams.get("branch") || "";
    if (!branch)
      return Response.json({ error: "branch required" }, { status: 400 });
    const repo = getRepo(url.searchParams.get("repo") || undefined);
    const { getReviewGuide } = await import("../../server/review-guide");
    return prApiResponse(() => getReviewGuide(branch, repo));
  }
  if (path === "/api/pr-preview-review" && req.method === "POST") {
    const credential = githubMutationCredential(ctx);
    if (!credential) return githubCredentialRequiredResponse();
    const body = await req.json().catch(() => null);
    const branch = body?.branch?.trim();
    if (!branch)
      return Response.json({ error: "branch required" }, { status: 400 });
    const repo = getRepo(body?.repo || undefined);
    const event =
      body?.event === "APPROVE" || body?.event === "REQUEST_CHANGES"
        ? body.event
        : "COMMENT";
    const comments = Array.isArray(body?.comments) ? body.comments : [];
    if (!comments.length && !body?.summary?.trim() && event !== "APPROVE")
      return Response.json({ error: "Nothing to submit" }, { status: 400 });
    const user = requestUser(ctx, body?.user) || "Someone";
    const summary = body?.summary?.trim();
    const result = await prHostFor(repo).submitPrReview(
      branch,
      {
        event,
        body: summary
          ? `**${user}** via ${personaName()}:\n\n${summary}`
          : `Review by **${user}** via ${personaName()}.`,
        comments: comments
          .filter((c: any) => c?.text?.trim() && c?.path && c?.line)
          .map((c: any) => ({
            path: c.path,
            line: c.line,
            startLine: c.startLine,
            side: c.side,
            startSide: c.startSide,
            body: `**${user}**: ${c.text.trim()}`,
          })),
      },
      hostRepoId(repo),
      credential,
    );
    if ("error" in result) return Response.json(result, { status: 502 });
    const credentialLogin = credential.principal.replace(/^user:/, "");
    const reviewer =
      githubLoginToPersonKey(credentialLogin) ||
      user.trim().split(/\s+/)[0]?.toLowerCase();
    if (reviewer)
      markCachedPrReviewed(hostRepoId(repo), branch, reviewer, event);
    invalidateSessionsCache();
    return Response.json(result);
  }
  if (path === "/api/pr-preview-merge" && req.method === "POST") {
    const credential = githubMutationCredential(ctx);
    if (!credential) return githubCredentialRequiredResponse();
    const body = await req.json().catch(() => ({}));
    const branch = body?.branch?.trim();
    if (!branch)
      return Response.json({ error: "branch required" }, { status: 400 });
    const repo = getRepo(body?.repo || undefined);
    const method =
      body.method === "merge" || body.method === "rebase"
        ? body.method
        : "squash";
    try {
      const result = await prHostFor(repo).mergePr(
        branch,
        { method, deleteBranch: !!body.deleteBranch, force: !!body.force },
        hostRepoId(repo),
        credential,
      );
      if ("error" in result) return Response.json(result, { status: 502 });
      markCachedPrMerged(hostRepoId(repo), branch);
      invalidateSessionsCache();
      return Response.json(result);
    } catch (e: any) {
      return Response.json({ error: e.message || String(e) }, { status: 502 });
    }
  }
  if (path === "/api/pr-preview-close" && req.method === "POST") {
    const credential = githubMutationCredential(ctx);
    if (!credential) return githubCredentialRequiredResponse();
    const body = await req.json().catch(() => ({}));
    const branch = body?.branch?.trim();
    if (!branch)
      return Response.json({ error: "branch required" }, { status: 400 });
    const repo = getRepo(body?.repo || undefined);
    const result = await prHostFor(repo).closePr(
      branch,
      hostRepoId(repo),
      credential,
    );
    if ("error" in result) return Response.json(result, { status: 502 });
    markCachedPrClosed(hostRepoId(repo), result.number);
    invalidateSessionsCache();
    return Response.json(result);
  }

  // Post a comment on the session's PR (inline when path+line present)
  if (
    path.match(/^\/api\/sessions\/(.+)\/pr-comment$/) &&
    req.method === "POST"
  ) {
    const credential = githubMutationCredential(ctx);
    if (!credential) return githubCredentialRequiredResponse();
    const sessionId = decodeURIComponent(
      path.match(/^\/api\/sessions\/(.+)\/pr-comment$/)![1],
    );
    const session = await findPrSessionAsync(sessionId);
    if (!session)
      return Response.json({ error: "Session not found" }, { status: 404 });

    const body = await req.json().catch(() => null);
    if (!body?.text?.trim())
      return Response.json({ error: "Empty comment" }, { status: 400 });
    const target = resolvePrTarget(session, body.repo, body.branch);
    if (!target)
      return Response.json(
        { error: "No branch/PR for that repo" },
        { status: 400 },
      );

    const user = requestUser(ctx, body.user) || "Someone";
    const result = await prHostFor(getRepo(target.repoId)).postPrComment(
      target.branch,
      {
        body: `**${user}** via ${personaName()}:\n\n${body.text.trim()}`,
        path: body.path,
        line: body.line,
        startLine: body.startLine,
        side: body.side,
        startSide: body.startSide,
      },
      target.ghRepo,
      credential,
    );
    if ("error" in result) return Response.json(result, { status: 502 });
    return Response.json(result);
  }

  // Submit a batched review (all pending inline comments + an event) on the PR.
  if (
    path.match(/^\/api\/sessions\/(.+)\/pr-review$/) &&
    req.method === "POST"
  ) {
    const credential = githubMutationCredential(ctx);
    if (!credential) return githubCredentialRequiredResponse();
    const sessionId = decodeURIComponent(
      path.match(/^\/api\/sessions\/(.+)\/pr-review$/)![1],
    );
    const session = await findPrSessionAsync(sessionId);
    if (!session)
      return Response.json({ error: "Session not found" }, { status: 404 });

    const body = await req.json().catch(() => null);
    const target = resolvePrTarget(session, body?.repo, body?.branch);
    if (!target)
      return Response.json(
        { error: "No branch/PR for that repo" },
        { status: 400 },
      );
    const event =
      body?.event === "APPROVE" || body?.event === "REQUEST_CHANGES"
        ? body.event
        : "COMMENT";
    const comments = Array.isArray(body?.comments) ? body.comments : [];
    if (!comments.length && !body?.summary?.trim() && event !== "APPROVE") {
      return Response.json({ error: "Nothing to submit" }, { status: 400 });
    }

    const user = requestUser(ctx, body?.user) || "Someone";
    const summary = body?.summary?.trim();
    const reviewBody = summary
      ? `**${user}** via ${personaName()}:\n\n${summary}`
      : `Review by **${user}** via ${personaName()}.`;
    const result = await prHostFor(getRepo(target.repoId)).submitPrReview(
      target.branch,
      {
        event,
        body: reviewBody,
        comments: comments
          .filter((c: any) => c?.text?.trim() && c?.path && c?.line)
          .map((c: any) => ({
            path: c.path,
            line: c.line,
            startLine: c.startLine,
            side: c.side,
            startSide: c.startSide,
            body: `**${user}**: ${c.text.trim()}`,
          })),
      },
      target.ghRepo,
      credential,
    );
    if ("error" in result) return Response.json(result, { status: 502 });
    const credentialLogin = credential.principal.replace(/^user:/, "");
    const reviewer =
      githubLoginToPersonKey(credentialLogin) ||
      user.trim().split(/\s+/)[0]?.toLowerCase();
    if (reviewer)
      markCachedPrReviewed(target.ghRepo, target.branch, reviewer, event);
    invalidateSessionsCache(); // a review can change reviewDecision in the list
    return Response.json(result);
  }

  // Squash & merge the session's PR — human-triggered from the Reviews view.
  if (
    path.match(/^\/api\/sessions\/(.+)\/pr-merge$/) &&
    req.method === "POST"
  ) {
    const credential = githubMutationCredential(ctx);
    if (!credential) return githubCredentialRequiredResponse();
    const sessionId = decodeURIComponent(
      path.match(/^\/api\/sessions\/(.+)\/pr-merge$/)![1],
    );
    const session = await findPrSessionAsync(sessionId);
    if (!session)
      return Response.json({ error: "Session not found" }, { status: 404 });

    const body = await req.json().catch(() => ({}));
    const target = resolvePrTarget(session, body.repo, body.branch);
    if (!target)
      return Response.json(
        { error: "No branch/PR for that repo" },
        { status: 400 },
      );
    const method =
      body.method === "merge" || body.method === "rebase"
        ? body.method
        : "squash";
    try {
      const result = await prHostFor(getRepo(target.repoId)).mergePr(
        target.branch,
        { method, deleteBranch: !!body.deleteBranch, force: !!body.force },
        target.ghRepo,
        credential,
      );
      if ("error" in result) return Response.json(result, { status: 502 });
      // Patch the bulk PR cache before dropping the sessions cache: the
      // rebuild reads that cache stale-while-revalidate, so without this the
      // row stays green/open until the throttled sweep or a webhook lands.
      markCachedPrMerged(target.ghRepo, target.branch);
      invalidateSessionsCache(); // refresh prState in the sessions list
      return Response.json(result);
    } catch (e: any) {
      return Response.json({ error: e.message || String(e) }, { status: 502 });
    }
  }

  // Register this session's PR and the one it was stacked on as a GitHub stack.
  // The agent is told to do this itself (buildStackNote), but it skips or
  // fails often enough — and the pairing is knowable server-side — that the
  // PR panel offers it as a button.
  if (
    path.match(/^\/api\/sessions\/(.+)\/pr-stack$/) &&
    req.method === "POST"
  ) {
    const credential = githubMutationCredential(ctx);
    if (!credential) return githubCredentialRequiredResponse();
    const sessionId = decodeURIComponent(
      path.match(/^\/api\/sessions\/(.+)\/pr-stack$/)![1],
    );
    const session = await findPrSessionAsync(sessionId);
    if (!session)
      return Response.json({ error: "Session not found" }, { status: 404 });
    const stackedOn = session.stackedOn;
    if (!stackedOn?.branch)
      return Response.json(
        { error: "This session isn't stacked on another branch" },
        { status: 400 },
      );
    if (!session.branch || !session.worktreeDir)
      return Response.json(
        { error: "This session has no branch to stack" },
        { status: 400 },
      );
    // `gh stack link` reads its remote from the working directory and has no
    // --repo flag, so it must run inside the session's own worktree.
    if (!existsSync(session.worktreeDir))
      return Response.json(
        { error: "This session's worktree is gone — nothing to link from" },
        { status: 400 },
      );
    const stackRepo = getRepo(stackedOn.repo || session.repo);
    const ghRepo = stackRepo.ghRepo;
    const host = prHostFor(stackRepo);
    try {
      const [own, base] = await Promise.all([
        host.prMetaForBranch(session.branch, ghRepo, credential),
        host.prMetaForBranch(stackedOn.branch, ghRepo, credential),
      ]);
      // Both layers must already exist as PRs: we pass URLs precisely so
      // that gh never pushes a branch or opens a PR on our behalf.
      if (!base)
        return Response.json(
          {
            error: `No open PR on \`${stackedOn.branch}\` yet — open the base PR first`,
          },
          { status: 400 },
        );
      if (!own)
        return Response.json(
          {
            error: `No PR on \`${session.branch}\` yet — open this session's PR first`,
          },
          { status: 400 },
        );
      const result = await linkPrStack(
        [base.url, own.url],
        session.worktreeDir,
        credential,
      );
      if ("error" in result) return Response.json(result, { status: 502 });
      // Both panels should show the stack on their next poll, not in 5 min.
      host.invalidatePrInfo(ghRepo, session.branch);
      host.invalidatePrInfo(ghRepo, stackedOn.branch);
      return Response.json({ ok: true });
    } catch (e: any) {
      return Response.json({ error: e.message || String(e) }, { status: 502 });
    }
  }

  // Merge every layer of the stack up to and including this session's PR, in
  // one atomic GitHub operation. Distinct from /pr-merge, which takes a single
  // PR and refuses a layer with open layers under it: this is the action that
  // lands such a layer, by taking the ones below it along.
  if (
    path.match(/^\/api\/sessions\/(.+)\/pr-stack-merge$/) &&
    req.method === "POST"
  ) {
    const credential = githubMutationCredential(ctx);
    if (!credential) return githubCredentialRequiredResponse();
    const sessionId = decodeURIComponent(
      path.match(/^\/api\/sessions\/(.+)\/pr-stack-merge$/)![1],
    );
    const session = await findPrSessionAsync(sessionId);
    if (!session)
      return Response.json({ error: "Session not found" }, { status: 404 });

    const body = await req.json().catch(() => ({}));
    const target = resolvePrTarget(session, body.repo, body.branch);
    if (!target)
      return Response.json(
        { error: "No branch/PR for that repo" },
        { status: 400 },
      );
    const repoCfg = getRepo(target.repoId);
    const host = prHostFor(repoCfg);
    if (!host.capabilities.stacks)
      return Response.json(
        { error: "This repo's host has no stacks" },
        { status: 400 },
      );
    // `gh stack merge` reads its remote from the working directory and has no
    // --repo flag, so it must run inside a checkout of the repo.
    if (!session.worktreeDir || !existsSync(session.worktreeDir))
      return Response.json(
        { error: "This session's worktree is gone — nothing to merge from" },
        { status: 400 },
      );
    const method =
      body.method === "merge" || body.method === "rebase"
        ? body.method
        : "squash";
    try {
      const meta = await host.prMetaForBranch(
        target.branch,
        target.ghRepo,
        credential,
      );
      if (!meta)
        return Response.json(
          { error: `No PR on \`${target.branch}\`` },
          { status: 400 },
        );
      // Read the stack before merging: afterwards it's the set of layers we
      // have to un-cache, and it's the only place the branch names live.
      const stack = await getPrStack(target.ghRepo, meta.number, credential);
      if (!stack)
        return Response.json(
          { error: `PR #${meta.number} isn't part of a stack` },
          { status: 400 },
        );
      const merging = stack.layers.filter(
        (l) => l.position <= stack.position && l.state === "OPEN",
      );
      const result = await mergePrStack(
        meta.number,
        session.worktreeDir,
        { method },
        credential,
      );
      if ("error" in result) return Response.json(result, { status: 502 });
      // Patch the bulk PR cache for every layer that just landed, before
      // dropping the sessions cache: the rebuild reads that cache
      // stale-while-revalidate, so without this each layer's session row
      // stays green/open until the throttled sweep or a webhook lands.
      for (const layer of merging) {
        markCachedPrMerged(target.ghRepo, layer.headRefName);
        host.invalidatePrInfo(target.ghRepo, layer.headRefName);
      }
      invalidateSessionsCache();
      return Response.json({
        ok: true,
        merged: merging.map((l) => l.number),
      });
    } catch (e: any) {
      return Response.json({ error: e.message || String(e) }, { status: 502 });
    }
  }

  // Close the session's PR without merging it — human-triggered from Reviews.
  if (
    path.match(/^\/api\/sessions\/(.+)\/pr-close$/) &&
    req.method === "POST"
  ) {
    const credential = githubMutationCredential(ctx);
    if (!credential) return githubCredentialRequiredResponse();
    const sessionId = decodeURIComponent(
      path.match(/^\/api\/sessions\/(.+)\/pr-close$/)![1],
    );
    const session = await findPrSessionAsync(sessionId);
    if (!session)
      return Response.json({ error: "Session not found" }, { status: 404 });

    const body = await req.json().catch(() => ({}));
    const target = resolvePrTarget(session, body.repo, body.branch);
    if (!target)
      return Response.json(
        { error: "No branch/PR for that repo" },
        { status: 400 },
      );
    const result = await prHostFor(getRepo(target.repoId)).closePr(
      target.branch,
      target.ghRepo,
      credential,
    );
    if ("error" in result) return Response.json(result, { status: 502 });
    markCachedPrClosed(target.ghRepo, result.number);
    invalidateSessionsCache();
    return Response.json(result);
  }

  // Fire a GitHub PR agent behavior straight from the info panel — the same
  // actions the opensession-* PR labels / Slack @mentions kick off (review,
  // auto-fix, simplify, adversarial). The agent is repo-scoped, and there
  // must be an open PR for the branch.
  if (
    path.match(/^\/api\/sessions\/(.+)\/pr-action$/) &&
    req.method === "POST"
  ) {
    const sessionId = decodeURIComponent(
      path.match(/^\/api\/sessions\/(.+)\/pr-action$/)![1],
    );
    const session = await findPrSessionAsync(sessionId);
    if (!session)
      return Response.json({ error: "Session not found" }, { status: 404 });

    const body = await req.json().catch(() => null);
    const kind = body?.kind;
    if (
      ![
        "review",
        "autofix",
        "simplify",
        "adversarial",
        "cancel-review",
      ].includes(kind)
    )
      return Response.json({ error: "Unknown action" }, { status: 400 });

    const target = resolvePrTarget(session, body?.repo, body?.branch);
    if (!target)
      return Response.json(
        { error: "No branch/PR for that repo" },
        { status: 400 },
      );
    // Multi-repo: any repo in the config registry can host PR-agent runs.
    const { repoForFullName } = await import("../../agents/github/constants");
    if (!repoForFullName(target.ghRepo))
      return Response.json(
        { error: `The PR agent doesn't know the repo ${target.ghRepo}` },
        { status: 400 },
      );

    let details;
    try {
      details = await prHostFor(getRepo(target.repoId)).getPrDetails(
        target.branch,
        target.ghRepo,
      );
    } catch (e: any) {
      return Response.json(
        {
          error:
            e?.message || "GitHub's pull request API is unavailable right now.",
        },
        { status: 502 },
      );
    }
    if (!details?.number)
      return Response.json(
        { error: "No open PR for this branch yet" },
        { status: 400 },
      );

    if (kind === "cancel-review") {
      const [
        { currentAgentRunToken },
        { bksIdFor },
        { requestActiveRunCancellation },
        { requestTurnCancel },
        { sessionKernel },
      ] = await Promise.all([
        import("../agent-runner"),
        import("../../agents/github/run"),
        import("../../agents/github/state"),
        import("../run-session"),
        import("../session-kernel"),
      ]);
      const bksId = bksIdFor(details.number, "review", target.ghRepo);
      const reviewSession = await findSessionAsync(bksId);
      const requested = requestActiveRunCancellation(
        details.number,
        target.branch,
        "review",
        target.ghRepo,
      );
      const runTarget = sessionKernel(bksId).runStateProjection();
      const targetRunId =
        runTarget.currentRunId ||
        (runTarget.state === "starting" || runTarget.state === "preparing"
          ? currentAgentRunToken(bksId)
          : undefined);
      let stopped = false;
      if (reviewSession && targetRunId) {
        await requestTurnCancel(bksId, reviewSession, {
          cancelId: `pr-review-stop:${runTarget.generation}:${targetRunId}`,
          expectedRunId: targetRunId,
          expectedGeneration: runTarget.generation,
          source: "pr_cancel",
        });
        stopped = true;
      }
      invalidateSessionsCache();
      return Response.json({ ok: true, cancelled: requested || stopped });
    }

    // Auto-fix is code-writing work, not a review pass to post on the PR —
    // so it opens a live session right in this workspace (shares the worktree +
    // branch) and fixes everything there, where you can watch and steer it,
    // instead of firing a headless GitHub-labeled run. The other actions
    // (review / simplify / adversarial) stay headless and post on the PR.
    if (kind === "autofix") {
      const prompt = [
        "/pr-autofix",
        "",
        `Fix everything on PR #${details.number} (“${details.title}”) — branch \`${target.branch}\`.`,
        "Address every reviewer's open feedback and any failing CI, commit and push to the branch,",
        "and reply in each thread you address with honest attribution. Keep going until it's all handled.",
      ].join("\n");
      const { id } = await getSessionControl().createSession({
        prompt,
        repo: target.repoId,
        mode: "code",
        branch: target.branch,
        parentSessionId: session.id,
        agentStarted: true,
        reportBack: false,
        user: requestUser(ctx, body?.user) || "Someone",
      });
      // Hand back the session itself, not just its id: createSession awaits
      // the file write, so the UI can drop the fresh session straight into its
      // list and open the real viewer instead of sitting on a "Starting a
      // new session…" placeholder until the next sessions poll catches up.
      return Response.json({
        ok: true,
        bksId: id,
        openSession: true,
        session: (await findSessionAsync(id)) ?? null,
      });
    }

    const { triggerPrAction } = await import("../../agents/github/trigger");
    const result = await triggerPrAction(
      kind,
      details.number,
      requestUser(ctx, body?.user) || "Someone",
      undefined,
      target.ghRepo,
    );
    return Response.json({
      ok: result.ok,
      message: result.message,
      url: result.url,
      bksId: result.bksId,
      session: result.bksId
        ? ((await findSessionAsync(result.bksId)) ?? null)
        : null,
      ...(result.ok ? {} : { error: result.message }),
    });
  }

  return undefined;
}
