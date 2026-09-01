/**
 * A session worktree's live git surface: diff, discard-file, status, push, pull.
 *
 * Extracted verbatim from the opensession.ts fetch chain. Every handler
 * returns a Response for a matched route or undefined to fall through to the
 * next handler (see routes/index.ts for the dispatch order).
 */

import type { RouteContext } from "./context";
import type { DiffGroupFile } from "../diff-groups";
import {
  type SessionDiff,
  SessionDiffTimeoutError,
  discardSessionFile,
  getSessionDiff,
} from "../git-diff";
import { getGitStatus, gitPull, gitPush } from "../git-status";
import { imageContentType, imageHeaders } from "../image-mime";
import { workspaceExecFor } from "../sandbox";
import { findSessionAsync } from "../session-cache";
import { resolveWorktreeTarget } from "../session-repos";
import { sessionTouchedPaths } from "../session-touched";
import { getRepo, isSharedCheckoutDir, sessionRepoId } from "../worktree";
import { defaultRepo } from "../config";
import { $ } from "bun";
import { existsSync } from "fs";
import { resolve } from "path";
import { githubMutationCredential } from "./github-credential";

function isDiffGroupFile(file: unknown): file is DiffGroupFile {
  if (typeof file !== "object" || file === null) return false;
  const candidate = file as Partial<DiffGroupFile>;
  return (
    typeof candidate.path === "string" &&
    candidate.path.length <= 1000 &&
    typeof candidate.additions === "number" &&
    typeof candidate.deletions === "number"
  );
}

export async function handleSessionGitRoutes(
  ctx: RouteContext,
): Promise<Response | undefined> {
  const { req, url, path, publicPrefix } = ctx;

  // Live git diff for a session's worktree (Changes tab)
  if (path.match(/^\/api\/sessions\/(.+)\/diff$/) && req.method === "GET") {
    const sessionId = decodeURIComponent(
      path.match(/^\/api\/sessions\/(.+)\/diff$/)![1],
    );
    const session = await findSessionAsync(sessionId);
    if (!session)
      return Response.json({ error: "Session not found" }, { status: 404 });

    // One diff per repo in the session: primary worktree + each attached repo.
    // Each carries its repo id so the panel can show a repo switcher and
    // route per-line feedback to the right checkout.
    const repoIds = [
      sessionRepoId(session) ?? defaultRepo().id,
      ...(session.attachedRepos || []).map((r) => r.repo),
    ];

    let repos;
    try {
      repos = await Promise.all(
        repoIds.map(async (repoId, index) => {
          let diff: SessionDiff = {
            branch: null,
            baseRef: null,
            files: [],
            totalAdditions: 0,
            totalDeletions: 0,
            rawPatch: "",
            diffVersion: "",
          };
          // A volume-mode workspace has no host dir but is still reachable:
          // the primary repo's diff runs through the session's sandbox exec
          // instead (workspaceExecFor; host exec when no active sandbox).
          const target = resolveWorktreeTarget(session, repoId);
          if (target?.reachable) {
            try {
              const ownPaths = isSharedCheckoutDir(target.dir)
                ? await sessionTouchedPaths(session, target.dir)
                : undefined;
              diff = await getSessionDiff(
                target.dir,
                target.defaultBranch,
                target.primary
                  ? await workspaceExecFor(session, target.dir)
                  : undefined,
                false,
                undefined,
                ownPaths,
              );
            } catch (error) {
              if (error instanceof SessionDiffTimeoutError) throw error;
            }
          }
          return {
            repo: repoId,
            dir: target?.dir ?? null,
            primary: index === 0,
            diff,
          };
        }),
      );
    } catch (error) {
      return Response.json(
        {
          error:
            error instanceof Error ? error.message : "Failed to read git diff",
        },
        { status: error instanceof SessionDiffTimeoutError ? 504 : 500 },
      );
    }

    return Response.json({ repos });
  }

  // Structural code-flow diff for the selected worktree. Kept separate from
  // the polled line diff: parsing is lazy and only runs when Code flow opens.
  if (
    path.match(/^\/api\/sessions\/(.+)\/code-flow$/) &&
    req.method === "GET"
  ) {
    const sessionId = decodeURIComponent(
      path.match(/^\/api\/sessions\/(.+)\/code-flow$/)![1],
    );
    const session = await findSessionAsync(sessionId);
    if (!session)
      return Response.json({ error: "Session not found" }, { status: 404 });
    try {
      const { sessionCodeFlow } = await import("../code-flow");
      return Response.json(
        await sessionCodeFlow(
          session,
          url.searchParams.get("repo") || undefined,
        ),
      );
    } catch (error) {
      const { codeFlowHttpError } = await import("../code-flow");
      const response = codeFlowHttpError(error);
      return Response.json(
        { error: response.message },
        { status: response.status },
      );
    }
  }

  // AI file categories for the live worktree diff. This mirrors PR grouping,
  // but targets the top-level session Changes tab (including uncommitted edits).
  if (
    path.match(/^\/api\/sessions\/(.+)\/diff-groups$/) &&
    req.method === "POST"
  ) {
    const sessionId = decodeURIComponent(
      path.match(/^\/api\/sessions\/(.+)\/diff-groups$/)![1],
    );
    const session = await findSessionAsync(sessionId);
    if (!session)
      return Response.json({ error: "Session not found" }, { status: 404 });
    const body = (await req.json().catch(() => ({}))) as {
      repo?: string;
      files?: unknown[];
      patch?: string;
    };
    const repoIds = [
      sessionRepoId(session) ?? defaultRepo().id,
      ...(session.attachedRepos || []).map((repo) => repo.repo),
    ];
    if (!body.repo || !repoIds.includes(body.repo))
      return Response.json({ error: "Repo not in session" }, { status: 400 });
    if (!Array.isArray(body.files) || typeof body.patch !== "string")
      return Response.json({ error: "Invalid diff metadata" }, { status: 400 });
    const files = body.files.filter(isDiffGroupFile);
    if (files.length !== body.files.length)
      return Response.json({ error: "Invalid diff metadata" }, { status: 400 });
    const { getDiffFileGroups } = await import("../diff-groups");
    return Response.json({
      groups: await getDiffFileGroups(
        getRepo(body.repo).ghRepo,
        files,
        body.patch,
      ),
    });
  }

  // Discard one file's changes in a session worktree (hover action on a
  // diff row). `{ repo, path, oldPath? }` — resets the file to its
  // base-branch state so it drops out of the Changes diff. Destructive.
  const discardMatch = path.match(/^\/api\/sessions\/(.+)\/discard-file$/);
  if (discardMatch && req.method === "POST") {
    const sessionId = decodeURIComponent(discardMatch[1]);
    const session = await findSessionAsync(sessionId);
    if (!session)
      return Response.json({ error: "Session not found" }, { status: 404 });
    const body = (await req.json().catch(() => ({}))) as {
      repo?: string;
      path?: string;
      oldPath?: string;
    };
    if (!body.path)
      return Response.json({ error: "Missing path" }, { status: 400 });

    // Primary volume-mode workspaces exist only in the sandbox — the
    // resolver counts them as reachable and the discard routes through
    // the session's exec instead of a host dir.
    const target = resolveWorktreeTarget(session, body.repo);
    if (!target?.reachable)
      return Response.json(
        { error: "No worktree for this repo" },
        { status: 400 },
      );

    try {
      await discardSessionFile(
        target.dir,
        target.defaultBranch,
        body.path,
        body.oldPath,
        target.primary
          ? await workspaceExecFor(session, target.dir)
          : undefined,
      );
    } catch (e: any) {
      return Response.json(
        { error: e?.message || "Failed to discard file" },
        { status: 500 },
      );
    }
    return Response.json({ ok: true });
  }

  // Local git state for a session's worktree (status header + Git status
  // rows). `?repo=<project>` targets an attached repo's checkout.
  if (
    path.match(/^\/api\/sessions\/(.+)\/git-status$/) &&
    req.method === "GET"
  ) {
    const sessionId = decodeURIComponent(
      path.match(/^\/api\/sessions\/(.+)\/git-status$/)![1],
    );
    const session = await findSessionAsync(sessionId);
    if (!session)
      return Response.json({ error: "Session not found" }, { status: 404 });
    // Primary volume-mode workspaces have no host dir — status runs
    // through the sandbox exec (host exec when no active sandbox). No
    // checkout at all answers 200 with null; clients read that.
    const target = resolveWorktreeTarget(session, url.searchParams.get("repo"));
    if (!target?.reachable) return Response.json(null);
    // A shared checkout holds every concurrent session's edits, so the raw
    // dirty count belongs to nobody. Scope it to the files this session's own
    // tool calls wrote.
    const ownPaths = isSharedCheckoutDir(target.dir)
      ? await sessionTouchedPaths(session, target.dir)
      : undefined;
    return Response.json(
      await getGitStatus(
        target.dir,
        target.defaultBranch,
        target.primary
          ? await workspaceExecFor(session, target.dir)
          : undefined,
        ownPaths,
      ),
    );
  }

  // An image from a session's worktree, for the Changes tab's diff view —
  // binary files have no textual hunks, so the client renders the picture
  // itself. `?side=new` (default) reads the working tree; `?side=base` shows
  // the pre-change version via `git show <merge-base>:<path>`.
  if (
    path.match(/^\/api\/sessions\/(.+)\/worktree-image$/) &&
    req.method === "GET"
  ) {
    const sessionId = decodeURIComponent(
      path.match(/^\/api\/sessions\/(.+)\/worktree-image$/)![1],
    );
    const session = await findSessionAsync(sessionId);
    if (!session) return new Response("Session not found", { status: 404 });
    const filePath = url.searchParams.get("path") || "";
    const contentType = imageContentType(filePath);
    if (!contentType) return new Response("Not an image path", { status: 400 });
    const target = resolveWorktreeTarget(session, url.searchParams.get("repo"));
    if (!target?.reachable) return new Response("No worktree", { status: 404 });
    const dir = target.dir;
    // Reachable but host-invisible (volume-mode sandbox / runner): image
    // bytes are read straight off the host fs, so say that plainly instead
    // of claiming the session has no worktree.
    if (!existsSync(dir))
      return new Response("Worktree is not readable on the host", {
        status: 400,
      });
    // Keep reads inside the worktree — the path comes from the client.
    const abs = resolve(dir, filePath);
    if (abs !== dir && !abs.startsWith(`${dir}/`))
      return new Response("Bad path", { status: 400 });
    try {
      if (url.searchParams.get("side") === "base") {
        const base = (
          await $`git -C ${dir} merge-base HEAD origin/${target.defaultBranch}`
            .quiet()
            .text()
        ).trim();
        const proc = Bun.spawn(
          ["git", "-C", dir, "show", `${base}:${filePath}`],
          {
            stdout: "pipe",
            stderr: "ignore",
          },
        );
        const bytes = await new Response(proc.stdout).arrayBuffer();
        if ((await proc.exited) !== 0)
          return new Response("Not in base", { status: 404 });
        return new Response(bytes, {
          headers: imageHeaders(contentType, "private, max-age=300"),
        });
      }
      const f = Bun.file(abs);
      if (!(await f.exists()))
        return new Response("Not found", { status: 404 });
      return new Response(f, {
        headers: imageHeaders(contentType, "no-cache"),
      });
    } catch {
      return new Response("Failed to read image", { status: 500 });
    }
  }

  // A text file from a session's worktree, for the Changes tab's in-place
  // editor (@pierre/diffs edit mode needs full file contents, not just hunks).
  // `?side=new` (default) reads the working tree; `?side=base` reads the
  // pre-change version via `git show <merge-base>:<path>`. POST with
  // `{ repo?, path, content }` writes the working-tree file (edit-mode save).
  const worktreeFileMatch = path.match(
    /^\/api\/sessions\/(.+)\/worktree-file$/,
  );
  if (worktreeFileMatch && (req.method === "GET" || req.method === "POST")) {
    const sessionId = decodeURIComponent(worktreeFileMatch[1]);
    const session = await findSessionAsync(sessionId);
    if (!session)
      return Response.json({ error: "Session not found" }, { status: 404 });
    const body =
      req.method === "POST"
        ? ((await req.json().catch(() => ({}))) as {
            repo?: string;
            path?: string;
            content?: string;
          })
        : null;
    const filePath = body
      ? body.path || ""
      : url.searchParams.get("path") || "";
    if (!filePath)
      return Response.json({ error: "Missing path" }, { status: 400 });
    const repoId = body ? body.repo || null : url.searchParams.get("repo");
    const target = resolveWorktreeTarget(session, repoId);
    if (!target?.reachable)
      return Response.json({ error: "No worktree" }, { status: 404 });
    const dir = target.dir;
    // Reachable but host-invisible (volume-mode sandbox / runner): both the
    // read and the edit-mode write go through the host fs, so say that
    // plainly instead of claiming the session has no worktree.
    if (!existsSync(dir))
      return Response.json(
        { error: "Worktree is not readable on the host" },
        { status: 400 },
      );
    // Keep reads/writes inside the worktree — the path comes from the client.
    const abs = resolve(dir, filePath);
    if (abs !== dir && !abs.startsWith(`${dir}/`))
      return Response.json({ error: "Bad path" }, { status: 400 });

    if (req.method === "POST") {
      if (typeof body?.content !== "string")
        return Response.json({ error: "Missing content" }, { status: 400 });
      if (body.content.length > 4_000_000)
        return Response.json({ error: "File too large" }, { status: 413 });
      try {
        await Bun.write(abs, body.content);
      } catch (e: any) {
        return Response.json(
          { error: e?.message || "Failed to write file" },
          { status: 500 },
        );
      }
      return Response.json({ ok: true });
    }

    try {
      if (url.searchParams.get("side") === "base") {
        const base = (
          await $`git -C ${dir} merge-base HEAD origin/${target.defaultBranch}`
            .quiet()
            .text()
        ).trim();
        const proc = Bun.spawn(
          ["git", "-C", dir, "show", `${base}:${filePath}`],
          { stdout: "pipe", stderr: "ignore" },
        );
        const text = await new Response(proc.stdout).text();
        if ((await proc.exited) !== 0) return Response.json({ content: null });
        return Response.json({ content: text });
      }
      const f = Bun.file(abs);
      if (!(await f.exists())) return Response.json({ content: null });
      if (f.size > 4_000_000)
        return Response.json({ error: "File too large" }, { status: 413 });
      return Response.json({ content: await f.text() });
    } catch {
      return Response.json({ error: "Failed to read file" }, { status: 500 });
    }
  }

  // Push the session's branch (sets upstream on first push). Human-triggered
  // from the status header — audited in git-status.ts.
  if (
    path.match(/^\/api\/sessions\/(.+)\/git-push$/) &&
    req.method === "POST"
  ) {
    const sessionId = decodeURIComponent(
      path.match(/^\/api\/sessions\/(.+)\/git-push$/)![1],
    );
    const session = await findSessionAsync(sessionId);
    if (!session)
      return Response.json({ error: "Session not found" }, { status: 404 });
    const body = await req.json().catch(() => ({}));
    const repoId = typeof body?.repo === "string" ? body.repo : null;
    const target = resolveWorktreeTarget(session, repoId);
    if (!target?.reachable)
      return Response.json(
        { error: "Session has no worktree" },
        { status: 400 },
      );
    const result = await gitPush(
      target.dir,
      session.branch || "HEAD",
      target.primary ? await workspaceExecFor(session, target.dir) : undefined,
      githubMutationCredential(ctx)?.env,
    );
    if ("error" in result) return Response.json(result, { status: 502 });
    return Response.json(result);
  }

  // Update the session's checkout — the Pull/Update action in the status
  // header. `body.base` merges origin/<default branch>; otherwise the branch's
  // own upstream is pulled fast-forward-only. Audited in git-status.ts.
  if (
    path.match(/^\/api\/sessions\/(.+)\/git-pull$/) &&
    req.method === "POST"
  ) {
    const sessionId = decodeURIComponent(
      path.match(/^\/api\/sessions\/(.+)\/git-pull$/)![1],
    );
    const session = await findSessionAsync(sessionId);
    if (!session)
      return Response.json({ error: "Session not found" }, { status: 404 });
    const body = await req.json().catch(() => ({}));
    const repoId = typeof body?.repo === "string" ? body.repo : null;
    const target = resolveWorktreeTarget(session, repoId);
    if (!target?.reachable)
      return Response.json(
        { error: "Session has no worktree" },
        { status: 400 },
      );
    // Nobody owns a shared checkout's HEAD. Pulling it from one session can
    // rewrite the live tree under every other session, so fail closed even for
    // an old client that still offers the action.
    if (isSharedCheckoutDir(target.dir))
      return Response.json(
        {
          error:
            "Pull isn't available because this checkout is shared with other sessions.",
        },
        { status: 409 },
      );
    const result = await gitPull(
      target.dir,
      body?.base ? target.defaultBranch : undefined,
      target.primary ? await workspaceExecFor(session, target.dir) : undefined,
      githubMutationCredential(ctx)?.env,
    );
    if ("error" in result) return Response.json(result, { status: 502 });
    return Response.json(result);
  }

  return undefined;
}
