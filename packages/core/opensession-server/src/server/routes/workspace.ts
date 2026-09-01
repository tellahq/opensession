/**
 * Worktrees, file/skill autocomplete, repo registry, workspaces, sibling sessions, promote-to-code, and attach/switch/detach repos.
 *
 * Extracted verbatim from the opensession.ts fetch chain. Every handler
 * returns a Response for a matched route or undefined to fall through to the
 * next handler (see routes/index.ts for the dispatch order).
 */

import { requestUser, type RouteContext } from "./context";
import { handleSessionsRoutes } from "./sessions";
import { searchRepoEntries } from "../file-index";
import {
  RepoAppearanceError,
  fetchOwnerAvatar,
  repoAvatarOwner,
  repoIconRevision,
  resolveRepoIcon,
  updateRepoAppearance,
  uploadRepoIcon,
  type RepoAppearancePatch,
} from "../repo-appearance";
import { assignRepoTileColors } from "../repo-tile-colors";
import { runSessionPrompt } from "../run-session";
import { type Sandbox, hasRemoteWorkspace, workspaceExecFor } from "../sandbox";
import {
  isRemoteSandboxProvider,
  resolveRequestedSandbox,
} from "../sandbox/config";
import { resolveInteractiveSandbox } from "../sandbox/defaults";
import {
  SESSIONS_DIR,
  findSessionAsync,
  getCachedSessionsAsync,
  getSessionListSnapshotAsync,
  invalidateSessionsCache,
  peekCachedSessions,
  touchNativeSession,
  updateSessionFile,
} from "../session-cache";
import {
  attachRepo,
  switchPrimaryRepo,
  workspaceOwningWorktree,
} from "../session-repos";
import { getOpenPrs, getTranscriptPath } from "../sessions";
import { duplicateSessionTranscript } from "../session-duplicate";
import {
  configuredIdentity,
  configuredRepos,
  defaultRepo,
  newSessionRepoDefault,
} from "../config";
import {
  persistRawConfig,
  rawConfig,
  withConfigMutationLock,
} from "../config-mutation";
import { searchSkills } from "../skills";
import { handleSlashCommand } from "../slash-commands";
import { sanitizeBranchSlug } from "../suggest-branch";
import { type NativeSessionFile, type StackedOn } from "../types";
import {
  DEFAULT_WORKSPACE_MODEL_SETTINGS,
  type Workspace,
  type WorkspaceDraft,
  type WorkspaceModelSettings,
  createWorkspace,
  deleteWorkspace,
  getWorkspace,
  listWorkspaces,
  updateWorkspace,
  workspaceListVersion,
} from "../workspaces";
import {
  resolveExternalWorkspace,
  resolvePlainWorkspace,
  resolvePrWorkspace,
  workspaceBacksOpenPr,
} from "../workspace-resolve";
import { resolveModel } from "../models";
import {
  REPOS,
  createWorktree,
  createWorktreeForExistingBranch,
  ensureScratchDir,
  getRepo,
  isSharedCheckoutDir,
  listWorktrees,
  repoForPath,
  resolveUniqueBranch,
  sessionRepoId,
  worktreeHasWork,
  worktreeHeadBranch,
} from "../worktree";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { isClientSessionId, isNativeSessionId, newSessionId } from "../paths";
import { isReusableEmptySession } from "../empty-session";
import { githubMutationCredential } from "./github-credential";
import { conditionalJsonResponse } from "../http-json";
import { indexedActiveWorkspaceIds } from "../session-list-store";

/**
 * Validate a `draft` field from a workspace create/patch body. `null` (clear)
 * passes through as-is; an invalid shape returns `undefined` so the caller
 * can 400. `updatedAt` is the client's stamp when it parses as a date, else
 * the server's own clock. A client draft doesn't have to carry one.
 */
function parseWorkspaceDraft(
  input: unknown,
): WorkspaceDraft | null | undefined {
  if (input === null) return null;
  if (!input || typeof input !== "object") return undefined;
  const body = input as Record<string, unknown>;
  if (typeof body.text !== "string") return undefined;
  if (body.by !== undefined && typeof body.by !== "string") return undefined;
  if (body.autoName !== undefined && typeof body.autoName !== "boolean")
    return undefined;
  const updatedAt =
    typeof body.updatedAt === "string" &&
    !Number.isNaN(Date.parse(body.updatedAt))
      ? body.updatedAt
      : new Date().toISOString();
  return {
    text: body.text,
    updatedAt,
    ...(body.by !== undefined ? { by: body.by as string } : {}),
    ...(body.autoName !== undefined
      ? { autoName: body.autoName as boolean }
      : {}),
  };
}

export async function deleteWorkspaceMemberSessions(
  ctx: RouteContext,
  sessionIds: readonly string[],
  handleSessionRoute: typeof handleSessionsRoutes = handleSessionsRoutes,
): Promise<Response | undefined> {
  for (const sessionId of sessionIds) {
    const sessionPath = `/api/sessions/${encodeURIComponent(sessionId)}`;
    const sessionUrl = new URL(ctx.url);
    sessionUrl.pathname = sessionPath;
    sessionUrl.search = "";
    const response = await handleSessionRoute({
      ...ctx,
      req: new Request(sessionUrl, { method: "DELETE" }),
      url: sessionUrl,
      path: sessionPath,
    });
    if (response && !response.ok && response.status !== 404) return response;
  }
}

function findNativeSessionForFileMentions(
  sessionId: string | null,
): NativeSessionFile | undefined {
  if (
    !(sessionId && isNativeSessionId(sessionId)) ||
    !/^[a-z0-9-]+$/i.test(sessionId)
  )
    return undefined;
  try {
    const session = JSON.parse(
      readFileSync(`${SESSIONS_DIR}/${sessionId}.json`, "utf8"),
    ) as NativeSessionFile;
    return session.id === sessionId ? session : undefined;
  } catch {
    return undefined;
  }
}

export async function handleWorkspaceRoutes(
  ctx: RouteContext,
): Promise<Response | undefined> {
  const { req, url, path, publicPrefix } = ctx;

  // List worktrees (optionally for a specific repo)
  if (path === "/api/worktrees" && req.method === "GET") {
    return Response.json(
      await listWorktrees(url.searchParams.get("repo") || undefined),
    );
  }

  // File/folder-mention autocomplete ("@" in the composer). Searches the
  // session's primary worktree plus any attached repos (cross-repo sessions),
  // falling back to the default repo for new-session composers with no session
  // yet. Each hit carries `insert` (what lands in the textarea: a bare path for
  // the primary repo, `<repo>:path` for an attached one — folders with a
  // trailing slash) and a `repo` label when more than one repo is in play.
  if (path === "/api/files" && req.method === "GET") {
    const q = url.searchParams.get("q") || "";
    const sessionId = url.searchParams.get("session");
    const repos: Array<{ repo: string; dir: string; primary: boolean }> = [];
    // Open Session sessions have an owned JSON file, so read their small record
    // directly instead of refreshing the entire cross-source session catalog.
    const session =
      findNativeSessionForFileMentions(sessionId) ??
      (sessionId ? await findSessionAsync(sessionId) : undefined);
    // Volume-mode sandbox workspaces have no host dir — the primary
    // repo's `git ls-files` runs through the sandbox exec below.
    if (
      session?.worktreeDir &&
      (existsSync(session.worktreeDir) || hasRemoteWorkspace(session))
    ) {
      repos.push({
        repo:
          session.repo ||
          (session.mode === "scratch"
            ? defaultRepo().id
            : repoForPath(session.worktreeDir).id),
        dir: session.worktreeDir,
        primary: true,
      });
      for (const r of session.attachedRepos || []) {
        if (existsSync(r.dir))
          repos.push({ repo: r.repo, dir: r.dir, primary: false });
      }
    }
    if (!repos.length) {
      // Sessions with a repo but no worktree (session-only, the Desk) search
      // their repo's main checkout rather than the global default.
      const proj = getRepo(
        url.searchParams.get("repo") || session?.repo || undefined,
      );
      repos.push({ repo: proj.id, dir: proj.repo, primary: true });
    }
    // Sandbox exec only for the session's own workspace (never for the
    // main-checkout fallback, which isn't mounted in the container).
    const primaryExec =
      session && repos[0]?.primary && repos[0].dir === session.worktreeDir
        ? await workspaceExecFor(session, repos[0].dir)
        : undefined;
    const multi = repos.length > 1;
    const perRepo = multi ? Math.max(6, Math.floor(20 / repos.length)) : 20;
    const out: Array<{
      display: string;
      insert: string;
      repo?: string;
      kind?: "dir";
    }> = [];
    const results = await Promise.all(
      repos.map(async (r) => {
        try {
          return await searchRepoEntries(
            r.dir,
            q,
            perRepo,
            r.primary ? primaryExec : undefined,
          );
        } catch {
          return [];
        }
      }),
    );
    for (const [index, entries] of results.entries()) {
      const r = repos[index];
      for (const f of entries) {
        // Folders insert with a trailing slash so the prompt text
        // (and the agent reading it) can tell them from files.
        const rel = f.dir ? `${f.path}/` : f.path;
        out.push({
          display: f.path,
          insert: r.primary ? rel : `${r.repo}:${rel}`,
          repo: multi ? r.repo : undefined,
          ...(f.dir ? { kind: "dir" as const } : {}),
        });
      }
    }
    // "@"-mentions also surface other sessions (inserted as
    // @session:<id>) so a prompt can reference them by name — e.g.
    // "keep monitoring @session:… and @session:…". Matched on
    // title/branch/id once 2+ chars are typed (a bare "@" stays
    // files-only), newest activity first, after file hits.
    const ql = q.toLowerCase();
    const sessionHits =
      ql.length >= 2
        ? peekCachedSessions()
            .filter((s) => !s.archived && s.id !== sessionId)
            .filter(
              (s) =>
                (s.title || "").toLowerCase().includes(ql) ||
                (s.branch || "").toLowerCase().includes(ql) ||
                s.id.toLowerCase().includes(ql),
            )
            .sort((a, b) =>
              (b.lastActivity || "").localeCompare(a.lastActivity || ""),
            )
            .slice(0, 5)
            .map((s) => ({
              display: s.title || s.branch || s.id,
              insert: `session:${s.id}`,
              kind: "session" as const,
              sub: s.branch || s.source,
            }))
        : [];
    // Teammates too (inserted as @<FirstName>) — so a prompt can reference
    // people ("ask @John about GPUs"); the humans tools resolve the name.
    const people =
      ql.length >= 1
        ? configuredIdentity()
            .team.filter(
              (m) =>
                m.name.toLowerCase().includes(ql) ||
                (m.aliases || []).some((a) => a.includes(ql)),
            )
            .slice(0, 4)
            .map((m) => ({
              display: m.name,
              insert: m.name.split(" ")[0],
              kind: "person" as const,
              sub: "teammate",
            }))
        : [];
    return Response.json({
      files: [
        ...out.slice(0, 24 - sessionHits.length - people.length),
        ...sessionHits,
        ...people,
      ],
    });
  }

  // Skill/command autocomplete ("/" at the start of the composer). Lists
  // what a Claude run in the session's primary checkout would see: user
  // skills+commands (~/.claude) plus the checkout's project ones. Same
  // session/repo resolution as /api/files, primary repo only (project
  // skills load from the run's cwd, so attached repos don't apply).
  if (path === "/api/skills" && req.method === "GET") {
    const q = url.searchParams.get("q") || "";
    const sessionId = url.searchParams.get("session");
    const session = sessionId ? await findSessionAsync(sessionId) : undefined;
    let dir: string | undefined =
      session?.worktreeDir && existsSync(session.worktreeDir)
        ? session.worktreeDir
        : undefined;
    if (!dir) {
      const proj = getRepo(url.searchParams.get("repo") || undefined);
      if (existsSync(proj.repo)) dir = proj.repo;
    }
    // Open Session's own slash commands (/compact, /model, /goal, …) only
    // work on existing opensession sessions — handleSlashCommand runs in
    // the prompt path, not on new-session opening prompts.
    const includeBuiltins = session?.source === "opensession";
    return Response.json({
      skills: searchSkills(dir, q, undefined, includeBuiltins),
    });
  }

  // Repos available to attach / start a session against.
  if (path === "/api/repos" && req.method === "GET") {
    // `color` is the repo's fallback tile: a color chosen for it, else one
    // assigned across the whole set so no two registered repos wear the
    // same one — which is what lets a tile stand in for a repo where
    // there's no room to name it. Clients hash their own for anything not
    // listed here.
    const chosen = Object.fromEntries(
      Object.values(REPOS)
        .filter((p) => p.color)
        .map((p) => [p.id, p.color as string]),
    );
    const ids = Object.keys(REPOS);
    const colors = assignRepoTileColors(ids, chosen);
    // What each repo would wear with its own choice dropped — the picker
    // shows that as its "Automatic" tile, so choosing it is a picture
    // rather than a promise. Everyone else's choice still stands, which is
    // what makes it the real answer and not an approximation.
    const autoColor = (id: string): string => {
      if (!chosen[id]) return colors[id];
      const { [id]: _dropped, ...rest } = chosen;
      return assignRepoTileColors(ids, rest)[id];
    };
    return Response.json({
      repos: Object.values(REPOS).map((p) => {
        const icon = resolveRepoIcon(p.icon, p.repo);
        return {
          id: p.id,
          label: p.label,
          description: p.description,
          ghRepo: p.ghRepo,
          defaultBranch: p.defaultBranch,
          sharedCheckout: !!p.sharedCheckout,
          default: !!p.default,
          color: colors[p.id],
          /** Whether that color was chosen rather than assigned. */
          colorChosen: !!p.color,
          /** What it would wear on automatic — the same when nothing
           *  was chosen for it. */
          autoColor: autoColor(p.id),
          /** Whether the tile paints art instead of the letter. */
          hasIcon: !!icon,
          /** Which picker choice that art came from, when we stored it. */
          iconSource: icon ? (p.iconSource ?? null) : null,
          /** Bumped when that art changes, so tiles don't stay cached. */
          iconRev: repoIconRevision(icon),
        };
      }),
      // What the New-session picker starts on for users with no personal
      // preference of their own. Rides this fetch because it is the same
      // thing the picker is already loading.
      newSessionRepo: newSessionRepoDefault(),
    });
  }

  // Where new sessions start for everyone without a preference of their own.
  if (path === "/api/repos/new-session-default" && req.method === "PUT") {
    const body = await req.json().catch(() => null);
    const value = typeof body?.repo === "string" ? body.repo.trim() : "";
    if (value && !(value in configuredRepos())) {
      return Response.json(
        { error: `Unknown repository: ${value}` },
        { status: 400 },
      );
    }
    await withConfigMutationLock(async () => {
      const config = rawConfig();
      // "" clears the setting rather than storing an empty choice, so the
      // key's absence keeps meaning "fall back" everywhere that reads it.
      if (value) config.newSessionRepo = value;
      else delete config.newSessionRepo;
      persistRawConfig(config);
    });
    return Response.json({ newSessionRepo: newSessionRepoDefault() });
  }

  // The owner's GitHub avatar, so the tile picker can OFFER the picture
  // rather than a button promising one. Proxied rather than linked straight
  // at github.com: the browser then needs no reach the server doesn't
  // already have, and the bytes are the same ones applying it would store.
  const avatar = path.match(/^\/api\/repos\/([\w.-]+)\/github-avatar$/);
  if (avatar && req.method === "GET") {
    const owner = repoAvatarOwner(avatar[1]);
    // No GitHub repo, no avatar — the picker hides the choice on a 404.
    if (!owner) return new Response("Not found", { status: 404 });
    try {
      const bytes = await fetchOwnerAvatar(owner);
      return new Response(bytes.slice().buffer as ArrayBuffer, {
        headers: {
          "Content-Type": "image/png",
          // An avatar changes about never, and this is a preview: an
          // hour of cache saves a GitHub round trip per popover open.
          "Cache-Control": "private, max-age=3600",
        },
      });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  }

  // Art someone uploaded for the tile. Raw PNG bytes rather than multipart:
  // the picker re-encodes whatever file was chosen through a canvas, so what
  // arrives is always one already-square PNG.
  const iconUpload = path.match(/^\/api\/repos\/([\w.-]+)\/icon$/);
  if (iconUpload && req.method === "POST") {
    try {
      const bytes = new Uint8Array(await req.arrayBuffer());
      return Response.json(await uploadRepoIcon(iconUpload[1], bytes));
    } catch (e) {
      return Response.json(
        {
          error:
            e instanceof RepoAppearanceError
              ? e.message
              : "Couldn’t store that icon",
        },
        { status: e instanceof RepoAppearanceError ? 400 : 500 },
      );
    }
  }

  // Tile appearance: pick one of the palette colors, or give the repo real
  // art (its owner's GitHub avatar). Both are instance config, so this is a
  // config write, not a per-person preference.
  const appearance = path.match(/^\/api\/repos\/([\w.-]+)\/appearance$/);
  if (appearance && req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as RepoAppearancePatch;
    try {
      return Response.json(await updateRepoAppearance(appearance[1], body));
    } catch (e) {
      if (e instanceof RepoAppearanceError) {
        return Response.json({ error: e.message }, { status: 400 });
      }
      // A GitHub fetch that times out or dies mid-download isn't the
      // caller's fault — say so with a status they can retry on.
      return Response.json(
        { error: e instanceof Error ? e.message : "Couldn’t update the tile" },
        { status: 502 },
      );
    }
  }

  // ── Workspaces (containers that group sessions) ──
  // A workspace is just metadata; membership lives on each session's `workspaceId`.
  if (path === "/api/workspaces" && req.method === "GET") {
    // The defaults ride once at the top level; a workspace row carries
    // modelSettings only when someone saved their own copy. Stamping the
    // defaults on every row multiplied the payload by the workspace count.
    let workspaces = listWorkspaces();
    const activeOnly = url.searchParams.get("active") === "1";
    if (activeOnly) {
      const indexedIds = indexedActiveWorkspaceIds();
      const activeWorkspaceIds = new Set(
        indexedIds ??
          (await getCachedSessionsAsync("exclude"))
            .map((session) => session.workspaceId)
            .filter((id): id is string => typeof id === "string" && !!id),
      );
      const openPrs = getOpenPrs();
      workspaces = workspaces.filter(
        (workspace) =>
          activeWorkspaceIds.has(workspace.id) ||
          !!workspace.draft ||
          workspaceBacksOpenPr(workspace, openPrs, defaultRepo().id),
      );
    }
    return conditionalJsonResponse(
      req,
      {
        workspaces,
        defaultModelSettings: DEFAULT_WORKSPACE_MODEL_SETTINGS,
      },
      {
        cache: {
          key: activeOnly ? "workspaces-list-active" : "workspaces-list-all",
          // Active membership can change without workspace metadata changing.
          version: activeOnly
            ? `${workspaceListVersion()}:${workspaces.map((workspace) => workspace.id).join(",")}`
            : workspaceListVersion(),
        },
      },
    );
  }

  if (path === "/api/workspaces" && req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as {
      name?: string;
      repo?: string;
      color?: string;
      user?: string;
      draft?: unknown;
    };
    if (!body.name || !body.name.trim())
      return Response.json({ error: "name required" }, { status: 400 });
    if (body.repo === "auto")
      return Response.json(
        { error: "Choose a repository before creating the workspace" },
        { status: 400 },
      );
    let draft: WorkspaceDraft | undefined;
    if (body.draft !== undefined) {
      const parsed = parseWorkspaceDraft(body.draft);
      if (parsed === undefined)
        return Response.json({ error: "invalid draft" }, { status: 400 });
      if (parsed !== null) draft = parsed;
    }
    const workspace = createWorkspace({
      name: body.name,
      repo: body.repo,
      color: body.color,
      createdBy: requestUser(ctx, body.user) || "Anonymous",
      ...(draft ? { draft } : {}),
    });
    return Response.json({ workspace });
  }

  // Resolve-or-create the ONE workspace for a PR or a Plain support ticket
  // (adopt-don't-duplicate — see workspace-resolve.ts). Sidebar PR/ticket
  // rows call this on click and then navigate to the workspace; the `name`
  // hint (ticket title) avoids a Plain API round-trip.
  if (path === "/api/workspaces/resolve" && req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as {
      pr?: { repo?: string; number?: number; branch?: string; title?: string };
      plainThreadId?: string;
      /** Generic feed-item linkage (the feeds design). */
      externalRef?: {
        kind?: string;
        id?: string;
        url?: string;
        title?: string;
      };
      name?: string;
      user?: string;
    };
    const createdBy = requestUser(ctx, body.user) || "Anonymous";
    if (body.externalRef?.kind && body.externalRef?.id) {
      const { workspace, created } = resolveExternalWorkspace({
        ref: {
          kind: body.externalRef.kind,
          id: body.externalRef.id,
          ...(body.externalRef.url ? { url: body.externalRef.url } : {}),
          title: body.name || body.externalRef.title,
        },
        createdBy,
      });
      return Response.json({ workspaceId: workspace.id, created });
    }
    if (body.plainThreadId) {
      const { workspace, created } = resolvePlainWorkspace({
        threadId: body.plainThreadId,
        title: body.name,
        createdBy,
      });
      return Response.json({ workspaceId: workspace.id, created });
    }
    if (body.pr?.repo && (body.pr.number !== undefined || body.pr.branch)) {
      const resolved = await resolvePrWorkspace({
        repoId: body.pr.repo,
        number: body.pr.number,
        branch: body.pr.branch,
        title: body.pr.title,
        createdBy,
      });
      if (!resolved)
        return Response.json({ error: "PR not found" }, { status: 404 });
      return Response.json({
        workspaceId: resolved.workspace.id,
        created: resolved.created,
        // Which PR was asked for, normalized — the workspace can carry
        // several, and the caller opens the review on this one.
        ...(resolved.pr ? { pr: resolved.pr } : {}),
      });
    }
    return Response.json(
      { error: "pr, plainThreadId or externalRef required" },
      { status: 400 },
    );
  }

  const workspaceMatch = path.match(/^\/api\/workspaces\/(.+)$/);
  if (workspaceMatch && req.method === "PATCH") {
    const id = decodeURIComponent(workspaceMatch[1]);
    const body = (await req.json().catch(() => ({}))) as {
      name?: string;
      repo?: string;
      color?: string;
      order?: number;
      modelSettings?: WorkspaceModelSettings;
      draft?: unknown;
    };
    if (body.repo === "auto")
      return Response.json(
        { error: "Choose a repository before updating the workspace" },
        { status: 400 },
      );
    const { draft: rawDraft, ...rest } = body;
    let draft: WorkspaceDraft | null | undefined;
    if (rawDraft !== undefined) {
      const parsed = parseWorkspaceDraft(rawDraft);
      if (parsed === undefined)
        return Response.json({ error: "invalid draft" }, { status: 400 });
      draft = parsed;
    }
    const workspace = updateWorkspace(id, {
      ...rest,
      ...(rawDraft !== undefined ? { draft } : {}),
    });
    if (!workspace)
      return Response.json({ error: "Workspace not found" }, { status: 404 });
    return Response.json({ workspace });
  }

  if (workspaceMatch && req.method === "DELETE") {
    const id = decodeURIComponent(workspaceMatch[1]);
    if (!getWorkspace(id)) return Response.json({ ok: false });

    // A workspace owns its sessions. Delete each through the normal session route
    // so running agents, transcripts, sandboxes, and tombstones receive the same
    // cleanup as an individual session deletion. Worktree cleanup stays opt-in.
    const members = (await getSessionListSnapshotAsync()).filter(
      (session) => session.workspaceId === id,
    );
    const failure = await deleteWorkspaceMemberSessions(
      ctx,
      members.map((member) => member.id),
    );
    if (failure) return failure;

    // Deleting the last non-PR session may already remove the workspace.
    const ok = deleteWorkspace(id) || !getWorkspace(id);
    return Response.json({ ok });
  }

  // Start a new sibling session: an empty session that shares the source session's
  // worktree, branch, repo, and project. It has no engine session yet — its
  // first prompt starts a fresh run (see runSessionPrompt). Powers the tab
  // strip's + button ("new session in this project").
  //
  // Workspace membership is adopt-don't-duplicate: when a session/create lands
  // on a worktree an existing workspace already owns, it joins that
  // workspace — a second workspace over the same worktree is always the
  // "clicked + and got a whole new workspace" bug. Main checkouts are
  // excluded (shared by every backstage/ask session, so ownership is
  // meaningless there); see workspaceOwningWorktree.
  const newSessionMatch = path.match(/^\/api\/sessions\/(.+)\/new-session$/);
  if (newSessionMatch && req.method === "POST") {
    const sourceId = decodeURIComponent(newSessionMatch[1]);
    const src = await findSessionAsync(sourceId);
    if (!src)
      return Response.json({ error: "Session not found" }, { status: 404 });
    const body = (await req.json().catch(() => ({}))) as {
      user?: string;
      mode?: "share" | "stack" | "ask";
      /** Client-minted id lets the tab render before this request finishes. */
      clientSessionId?: unknown;
      /** Sandbox opt-in: true = config default provider, or an explicit
       *  provider id (including "modal" / "lambda-microvm" — must be configured).
       *  Recorded on the session file; the first prompt launches it. */
      sandbox?: boolean | string;
      /** Model the sibling's runs should use (picker id). Validated against
       *  the sandbox capability matrix and stamped on the session; unset =
       *  the default model, like every other create. */
      model?: string;
      /** Copy the source chat into this idle sibling. */
      duplicate?: boolean;
    };
    // share (default): reuse the workspace's worktree/branch (parallel sessions,
    // one branch). stack: a new worktree branched off it (stacked PRs). ask:
    // no worktree, read-only on main. Empty session — first prompt starts the run.
    const worktreeMode = body.mode || "share";
    // Volume-mode sandbox workspaces live inside ONE session's container —
    // share/stack siblings would either mint a divergent second clone at
    // the same path or ENOENT on the host. Not supported yet.
    if (hasRemoteWorkspace(src) && worktreeMode !== "ask")
      return Response.json(
        {
          error:
            "This session's workspace lives inside its sandbox volume — sibling sessions aren't supported for volume-mode sandboxes yet (open an Ask session instead)",
        },
        { status: 400 },
      );
    const requestedId = body.clientSessionId;
    if (requestedId !== undefined && !isClientSessionId(requestedId))
      return Response.json(
        { error: "Invalid session create id" },
        { status: 400 },
      );
    const bksId = requestedId || newSessionId();
    const existing = await findSessionAsync(bksId);
    if (existing) return Response.json({ id: bksId, session: existing });
    // One reusable empty tab per workspace. This server-side check closes the
    // multi-window race that hiding the + in one browser cannot prevent.
    const reusable = body.duplicate
      ? undefined
      : src.workspaceId
        ? (await getCachedSessionsAsync("exclude")).find(
            (session) =>
              session.workspaceId === src.workspaceId &&
              isReusableEmptySession(session),
          )
        : isReusableEmptySession(src)
          ? src
          : undefined;
    if (reusable) return Response.json({ id: reusable.id, session: reusable });
    let branch = src.branch || "";
    let worktreeDir = src.worktreeDir || "";
    let mode: "ask" | "code" | "scratch" = src.mode || "code";
    let repoId = src.repo;
    let stackedOn: StackedOn | undefined;
    // Scratch siblings stay scratch: same repo-less scratch dir (shared
    // downloads), no branch/repo — and the repoForPath probes below must
    // not run on a scratch dir (they'd throw).
    const srcScratch = src.mode === "scratch";
    // A shared checkout (main or ask) recorded on the source isn't a real
    // workspace worktree — legacy ask/review sessions point at the main
    // checkout, and copying it hands the sibling whatever branch happens to
    // be parked in that live tree (bks-019f97ec, 2026-07-25: a "+" session in a
    // PR workspace landed on the main checkout's parked branch instead of
    // the PR's). Treat it as bare so share siblings resolve through the
    // workspace below. Shared-checkout repos (opensession) are exempt — their
    // code sessions live on the main checkout by design.
    if (
      !srcScratch &&
      worktreeMode === "share" &&
      isSharedCheckoutDir(worktreeDir) &&
      !repoForPath(worktreeDir).sharedCheckout
    ) {
      branch = "";
      worktreeDir = "";
    }
    if (srcScratch && worktreeMode !== "ask") {
      branch = "";
      mode = "scratch";
      repoId = undefined;
    } else if (worktreeMode === "ask") {
      branch = "";
      mode = "ask";
      // An ask sibling of a repo-less source stays repo-less. Left bare it
      // would resolve its cwd at prompt time through
      // ensureAskCheckout(undefined), i.e. the DEFAULT repo's ask
      // checkout — a session reading a repo nobody asked about. Derived
      // from the path, so a legacy session that records no repo but does
      // sit in a real checkout still gets a repo-scoped ask sibling.
      repoId = sessionRepoId(src);
      worktreeDir = repoId ? "" : ensureScratchDir(src.workspaceId || bksId);
    } else if (worktreeMode === "stack" && src.branch && src.repo) {
      const repo = getRepo(src.repo);
      if (!repo.sharedCheckout) {
        branch = `${src.branch}-stack-${bksId.slice(4, 10)}`;
        worktreeDir = await createWorktree(branch, repo.id, {
          base: src.branch,
          gitEnv: githubMutationCredential(ctx)?.env,
        });
        mode = "code";
        // Remember the layer underneath so this session's PR bases on it and
        // the pair can be linked into a GitHub stack (see pr-stack.ts).
        stackedOn = {
          repo: repo.id,
          branch: src.branch,
          ...(src.source === "opensession" ? { sessionId: src.id } : {}),
        };
      }
    } else if (worktreeMode === "share" && !worktreeDir && src.workspaceId) {
      // Same workspace ⇒ same worktree: even when the source session has no
      // worktree of its own (e.g. + from an ask tab), a share sibling
      // joins the workspace's owned worktree instead of starting bare.
      const ws = getWorkspace(src.workspaceId);
      if (ws?.worktreeDir && existsSync(ws.worktreeDir)) {
        branch = ws.branch || "";
        worktreeDir = ws.worktreeDir;
        mode = "code";
        repoId = repoForPath(ws.worktreeDir).id;
      } else if (ws?.branch && !getRepo(ws.repo).sharedCheckout) {
        // A workspace minted session-less from a PR/ticket knows its branch
        // but owns no worktree yet: materialize one on that existing
        // branch so the sibling lands on the PR's code (mirrors
        // create_session's fromPr path), and stamp it as the workspace's
        // owned worktree for later siblings.
        branch = ws.branch;
        worktreeDir = await createWorktreeForExistingBranch(
          ws.branch,
          ws.repo,
          githubMutationCredential(ctx)?.env,
        );
        mode = "code";
        repoId = getRepo(ws.repo).id;
        updateWorkspace(ws.id, { worktreeDir });
      }
    }
    // A workspace-less source gets healed here: adopt the workspace that
    // already owns its worktree when there is one (a fresh workspace over
    // an owned worktree is the "clicked + and got a whole new workspace"
    // bug), else wrap the SOURCE in a fresh workspace and put the sibling
    // in it too, so the pair actually links up in the tab strip and
    // sidebar. Read-only sources (slack/linear files) can join an adopted
    // workspace but can't be stamped themselves.
    // The Desk is the exception to the healing: it is deliberately
    // workspace-less for life (session-workspace.ts), so a sibling spun off
    // from it gets its own workspace and the Desk stays out of the sidebar.
    let workspaceId = src.workspaceId || null;
    if (!workspaceId && !src.desk) {
      const owned = workspaceOwningWorktree(src.worktreeDir);
      if (owned) {
        workspaceId = owned.id;
        if (src.source === "opensession")
          touchNativeSession(src.id, { workspaceId: owned.id });
      } else if (src.source === "opensession") {
        const ws = createWorkspace({
          name: src.title || src.branch || "Workspace",
          repo: src.repo,
          createdBy:
            requestUser(ctx, body.user) || src.startedBy || "Anonymous",
          ...(src.branch ? { branch: src.branch } : {}),
          ...(src.worktreeDir ? { worktreeDir: src.worktreeDir } : {}),
        });
        touchNativeSession(src.id, { workspaceId: ws.id });
        workspaceId = ws.id;
      }
    }
    // Sandbox opt-in: boolean true = config default provider; a string
    // must name a configured provider. A sibling session's first prompt
    // launches the sandbox through the normal prompt path. The requested
    // model (unset = the default) is checked against the capability matrix
    // so an unsupported model × environment combo fails at create, matching
    // the WS create paths.
    const siblingModel = body.model
      ? resolveModel(String(body.model))?.id
      : undefined;
    const sandboxResolved = resolveInteractiveSandbox(
      body.sandbox,
      requestUser(ctx, body.user),
      repoId,
      siblingModel,
    );
    if (!sandboxResolved.ok)
      return Response.json({ error: sandboxResolved.error }, { status: 400 });
    // A sibling in a ticket-linked session/workspace stays linked to the ticket
    // (conversation tab + ticket→session mapping follow the workspace).
    const plainThreadId =
      src.plainThreadId ||
      (workspaceId ? getWorkspace(workspaceId)?.plainThreadId : undefined);
    // Feed-item linkage follows the workspace the same way (Video tab +
    // sidebar feed-row → session join — the feeds design).
    const siblingRefs =
      src.externalRefs ||
      (workspaceId ? getWorkspace(workspaceId)?.externalRefs : undefined);
    const data: NativeSessionFile = {
      id: bksId,
      ...(body.duplicate ? { duplicatedFromSessionId: src.id } : {}),
      claudeSessionId: "",
      branch,
      worktreeDir,
      ...(repoId ? { repo: repoId } : {}),
      ...(stackedOn ? { stackedOn } : {}),
      ...(workspaceId ? { workspaceId: workspaceId } : {}),
      ...(plainThreadId ? { plainThreadId } : {}),
      ...(siblingRefs?.length ? { externalRefs: siblingRefs } : {}),
      // Siblings keep the source session's MCP scoping (least privilege —
      // a sibling of a scoped session must not regain every server).
      ...(src.mcpServers?.length ? { mcpServers: src.mcpServers } : {}),
      createdBy: requestUser(ctx, body.user) || "Anonymous",
      createdAt: new Date().toISOString(),
      lastActivity: new Date().toISOString(),
      title: body.duplicate ? src.title : "New session",
      mode,
      // Stamp the validated model so the sibling actually runs what the
      // sandbox check vetted (validating one model and running another
      // would make the create-gate meaningless).
      ...(siblingModel ? { model: siblingModel } : {}),
      ...(sandboxResolved.provider
        ? {
            sandbox: {
              provider: sandboxResolved.provider,
              // Remote providers are always volume-style (no host mounts).
              ...(isRemoteSandboxProvider(sandboxResolved.provider)
                ? { workspace: "volume" as const }
                : {}),
            },
          }
        : {}),
    };
    await updateSessionFile(bksId, () => data);
    if (body.duplicate) await duplicateSessionTranscript(src, bksId);
    // Also return the full unified session so the client can drop it into
    // its session list and render the new session instantly, instead of
    // flashing a loading screen until the next sessions poll lands.
    return Response.json({
      id: bksId,
      session: (await findSessionAsync(bksId)) ?? null,
    });
  }

  // Promote an ask session to code. Three shapes, because "ask" says nothing
  // about where the session is actually parked:
  //   - it already owns a real worktree (a review spin-off shares its
  //     parent's tree so it can read the diff) ⇒ ADOPT that tree. Cutting a
  //     second worktree would move the session off the very branch it's about.
  //   - shared-checkout repo (opensession) ⇒ no worktree exists for either
  //     mode; code sessions edit the live checkout, so only `mode` changes.
  //   - parked on a repo's pinned ask checkout ⇒ cut a worktree, the
  //     original behavior. That moves the cwd, so the ask transcript is
  //     copied into the new cwd's project dir to keep engine resume working.
  const promoteMatch = path.match(/^\/api\/sessions\/(.+)\/promote$/);
  if (promoteMatch && req.method === "POST") {
    const sessionId = decodeURIComponent(promoteMatch[1]);
    const session = await findSessionAsync(sessionId);
    if (!session)
      return Response.json({ error: "Session not found" }, { status: 404 });
    if (session.source !== "opensession")
      return Response.json(
        { error: "Only opensession sessions can be promoted" },
        { status: 400 },
      );
    const body = (await req.json().catch(() => ({}))) as {
      branch?: string;
      repo?: string;
    };
    // An owned tree is one no other mode shares: not a repo's main
    // checkout, not its pinned ask checkout (isSharedCheckoutDir covers
    // both). An explicit `repo`/`branch` in the body is a deliberate
    // "put it somewhere else", so it opts out of adopting.
    const current = session.worktreeDir || "";
    const adopt =
      !body.repo &&
      !body.branch &&
      Boolean(current) &&
      !isSharedCheckoutDir(current) &&
      existsSync(current);
    const repo = adopt
      ? repoForPath(current)
      : getRepo(body.repo || session.repo);
    let branch: string;
    let worktreeDir: string;
    if (adopt) {
      branch = session.branch || worktreeHeadBranch(current) || "";
      worktreeDir = current;
    } else if (repo.sharedCheckout) {
      // Nothing to create: mode is the whole difference here.
      branch = "";
      worktreeDir = repo.repo;
    } else {
      // Promotion already has a generated session title. Reusing it avoids a
      // second model turn just to name the branch, which used to hold this
      // request for seconds when the naming model's account pool was busy.
      const generated =
        sanitizeBranchSlug(session.title || "") ||
        `session-${sessionId.slice(4, 10)}`;
      branch = body.branch
        ? body.branch.trim()
        : await resolveUniqueBranch(generated, repo.id);
      const oldCwd = current || repo.repo;
      worktreeDir = await createWorktree(branch, repo.id, {
        gitEnv: githubMutationCredential(ctx)?.env,
      });
      // Best-effort: copy the ask rollout into the new worktree's hash dir
      // so SDK resume (keyed by cwd) finds the prior conversation.
      try {
        if (session.claudeSessionId) {
          const from = getTranscriptPath(oldCwd, session.claudeSessionId);
          const to = getTranscriptPath(worktreeDir, session.claudeSessionId);
          if (existsSync(from) && !existsSync(to)) {
            mkdirSync(to.slice(0, to.lastIndexOf("/")), { recursive: true });
            copyFileSync(from, to);
          }
        }
      } catch (e) {
        console.warn(`[promote] transcript copy failed for ${sessionId}:`, e);
      }
    }
    await touchNativeSession(sessionId, {
      mode: "code",
      branch,
      worktreeDir,
      repo: repo.id,
      repoLess: false,
    });
    // Materialize the workspace's worktree if it doesn't own one yet. A
    // shared checkout is owned by nobody, so it never becomes a
    // workspace's tree (that's what keeps every opensession session from
    // collapsing into one workspace — see session-workspace.ts).
    if (
      session.workspaceId &&
      worktreeDir &&
      !isSharedCheckoutDir(worktreeDir)
    ) {
      const ws = getWorkspace(session.workspaceId);
      if (ws && !ws.worktreeDir)
        updateWorkspace(ws.id, { worktreeDir, branch });
    }
    return Response.json({ ok: true, branch, worktreeDir });
  }

  // Move a session in/out of a workspace. `{ workspaceId: null }` detaches.
  const setWorkspaceMatch = path.match(/^\/api\/sessions\/(.+)\/workspace$/);
  if (setWorkspaceMatch && req.method === "POST") {
    const sessionId = decodeURIComponent(setWorkspaceMatch[1]);
    const session = await findSessionAsync(sessionId);
    if (!session)
      return Response.json({ error: "Session not found" }, { status: 404 });
    const body = (await req.json().catch(() => ({}))) as {
      workspaceId?: string | null;
    };
    const workspaceId = body.workspaceId ?? null;
    if (workspaceId && !getWorkspace(workspaceId))
      return Response.json({ error: "Workspace not found" }, { status: 404 });
    touchNativeSession(sessionId, { workspaceId });
    return Response.json({ ok: true, workspaceId });
  }

  // Attach a secondary repo to a session (cross-repo work): creates/reuses an
  // isolated worktree and records it on the session.
  const attachMatch = path.match(/^\/api\/sessions\/(.+)\/attach-repo$/);
  if (attachMatch && req.method === "POST") {
    const sessionId = decodeURIComponent(attachMatch[1]);
    const body = (await req.json().catch(() => ({}))) as {
      repo?: string;
      branch?: string;
    };
    if (!body.repo)
      return Response.json({ error: "repo required" }, { status: 400 });
    try {
      const { attached, all } = await attachRepo(
        sessionId,
        body.repo,
        body.branch,
        githubMutationCredential(ctx)?.env,
      );
      return Response.json({ ok: true, attached, attachedRepos: all });
    } catch (e: any) {
      return Response.json({ error: e.message || String(e) }, { status: 400 });
    }
  }

  // Is this session fresh enough to switch its primary repo? Drives the
  // clean-only, silent switcher in the RepoBar — no work means no footgun.
  const switchableMatch = path.match(
    /^\/api\/sessions\/(.+)\/repo-switchable$/,
  );
  if (switchableMatch && req.method === "GET") {
    const sessionId = decodeURIComponent(switchableMatch[1]);
    const session = await findSessionAsync(sessionId);
    if (!session)
      return Response.json({ error: "Session not found" }, { status: 404 });
    // `switchable`: this session type can switch its primary repo at all
    // (ask sessions read the shared checkout — nothing to switch).
    // `hasWork`: it already has commits/edits, so the UI confirms before
    // switching (the work stays in the old worktree, not carried over).
    // Scratch sessions are repo-less — nothing to switch either.
    const switchable = session.mode !== "ask" && session.mode !== "scratch";
    const hasWork =
      switchable &&
      !!session.worktreeDir &&
      !!session.branch &&
      (await worktreeHasWork(
        session.worktreeDir,
        session.branch,
        session.repo,
      ));
    return Response.json({ switchable, hasWork });
  }

  // Switch the session's PRIMARY repo (wrong repo picked at creation).
  // Rejects with 400 if the session has work unless `force` is set; the
  // old worktree is left on disk either way, so work is never destroyed.
  const switchMatch = path.match(
    /^\/api\/sessions\/(.+)\/switch-primary-repo$/,
  );
  if (switchMatch && req.method === "POST") {
    const sessionId = decodeURIComponent(switchMatch[1]);
    const body = (await req.json().catch(() => ({}))) as {
      repo?: string;
      force?: boolean;
    };
    if (!body.repo)
      return Response.json({ error: "repo required" }, { status: 400 });
    try {
      const result = await switchPrimaryRepo(
        sessionId,
        body.repo,
        !!body.force,
        githubMutationCredential(ctx)?.env,
      );
      return Response.json({ ok: true, ...result });
    } catch (e: any) {
      return Response.json({ error: e.message || String(e) }, { status: 400 });
    }
  }

  // Detach a secondary repo (drops it from the session; leaves the worktree on
  // disk so unmerged work isn't lost — clean it up via the worktrees sweep).
  // POST, not DELETE, so it isn't swallowed by the generic DELETE /sessions/:id.
  const detachMatch = path.match(/^\/api\/sessions\/(.+)\/detach-repo$/);
  if (detachMatch && req.method === "POST") {
    const sessionId = decodeURIComponent(detachMatch[1]);
    const body = (await req.json().catch(() => ({}))) as {
      repo?: string;
    };
    const session = await findSessionAsync(sessionId);
    if (!session)
      return Response.json({ error: "Session not found" }, { status: 404 });
    const all = (session.attachedRepos || []).filter(
      (r) => r.repo !== body.repo,
    );
    touchNativeSession(sessionId, { attachedRepos: all });
    return Response.json({ ok: true, attachedRepos: all });
  }

  return undefined;
}
