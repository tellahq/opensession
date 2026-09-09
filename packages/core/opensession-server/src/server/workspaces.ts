/**
 * Workspaces — containers that group sessions. A session carries a `workspaceId`
 * pointing here; every session belongs to exactly one workspace.
 *
 * NOT a project. A *project* is the level above: a source of work with its own
 * sidebar band — a registered git repo (worktree.ts REPOS) or a feed (feeds.ts,
 * e.g. Plain). A project holds many workspaces; repo-less scratch workspaces sit
 * outside those project bands. A workspace holds many sessions.
 * The full model is in CONCEPTS.md.
 *
 * A workspace can *optionally own a worktree* (repo + branch + worktreeDir,
 * plus attached repos): new sessions created in the workspace inherit that
 * worktree by default (share mode), or branch a new stacked worktree off it.
 * A workspace with no `worktreeDir` is "ask-style" / not yet materialized.
 *
 * The session still stores its own branch/worktreeDir (the source of truth for the
 * runner cwd); the workspace's worktree fields are the template a new share-mode
 * session copies, and the flag for "does this workspace own a worktree yet".
 *
 * Storage: one document per workspace in the session kernel's central
 * application catalog (catalog-documents.ts, namespace `workspaces`, key =
 * workspace id, ids `ws-<uuid>`). Every authoritative read and every write is
 * an awaited kernel RPC; nothing here touches the filesystem on the gateway
 * thread. The legacy `~/.opensession-workspaces/<id>.json` files are imported
 * once at boot (importApplicationCatalog) and kept as an async export for
 * operator tools; this module never reads them.
 *
 * Alongside the catalog this module keeps a memory projection of every
 * workspace, warmed by warmWorkspacesAsync and maintained by the writers
 * below (the gateway is the catalog's only runtime writer for this
 * namespace). The projection serves the sync readers that cannot await, the
 * list route, and the find* helpers; peekWorkspace/workspaceName say so in
 * their names. getWorkspace is the authoritative read.
 * Team-internal, no auth.
 */

import { rm } from "fs/promises";
import { randomUUID } from "crypto";
import { catalogDocuments } from "./catalog-documents";
import { canonicalRepoId, defaultRepo } from "./config";
import { stateDir } from "./paths";
import type { AttachedRepo, ExternalRef } from "./types";
import type { SessionEffort } from "./models";

/** Resolved per call so a test that swaps the kernel store (or the state
 *  root the facade routes by) is honored by the next operation. */
function store() {
  return catalogDocuments("workspaces");
}

/** A workspace-owned model combination. The lead owns the conversation; the
 * supporting models are available to it as focused worker sessions. */
export interface WorkspaceModelPreset {
  id: string;
  label: string;
  /** Picker section, so workspaces can make their own families. */
  group?: string;
  instructions?: string;
  lead: { model: string; effort?: SessionEffort };
  supporting?: Array<{ model: string; effort?: SessionEffort; role?: string }>;
}

export interface WorkspaceModelSettings {
  presets?: WorkspaceModelPreset[];
}

/** A composer, not a document store. Mirrors MAX_DRAFT_LENGTH in drafts.ts. */
const MAX_DRAFT_LENGTH = 32_000;

/** An unsent composer prompt parked on a workspace before any session exists. */
export interface WorkspaceDraft {
  text: string;
  /** ISO time of the keystroke this text came from (client clock). */
  updatedAt: string;
  by?: string;
  /** While truthy, applying a draft update also renames the workspace to the
   *  draft's first line (see updateWorkspace); a manual rename sets this false
   *  and stops the follow for life. */
  autoName?: boolean;
}

/** Seeded into every new workspace. These are ordinary presets, not runtime
 * feature flags: removing one removes it, and new combinations use this shape. */
export const DEFAULT_WORKSPACE_MODEL_SETTINGS: WorkspaceModelSettings = {
  presets: [
    {
      id: "dial-ultra",
      label: "Dial · Ultra",
      group: "dial",
      lead: { model: "pi/anthropic/claude-fable-5-1", effort: "high" },
      supporting: [
        {
          model: "pi/openai/gpt-5.6-sol",
          effort: "xhigh",
          role: "Read-only oracle",
        },
      ],
      instructions:
        "Use the oracle for a second opinion on hard plans, architecture decisions, and significant reviews. Integrate its advice yourself.",
    },
    {
      id: "dial-high",
      label: "Dial · High",
      group: "dial",
      lead: { model: "pi/openai/gpt-5.6-sol", effort: "xhigh" },
      supporting: [
        {
          model: "pi/anthropic/claude-fable-5-1",
          effort: "high",
          role: "Read-only oracle",
        },
      ],
      instructions:
        "Use the oracle for a second opinion on hard plans, architecture decisions, and significant reviews. Integrate its advice yourself.",
    },
    {
      id: "dial-medium",
      label: "Dial · Medium",
      group: "dial",
      lead: { model: "pi/openai/gpt-5.6-sol", effort: "high" },
      supporting: [
        {
          model: "pi/openai/gpt-5.6-sol",
          effort: "xhigh",
          role: "Read-only oracle",
        },
      ],
      instructions:
        "Use the oracle for a second opinion when extra scrutiny helps.",
    },
    {
      id: "dial-low",
      label: "Dial · Low",
      group: "dial",
      lead: { model: "pi/openai/gpt-5.6-luna", effort: "high" },
      supporting: [
        {
          model: "pi/openai/gpt-5.6-sol",
          effort: "xhigh",
          role: "Read-only oracle",
        },
      ],
      instructions: "Use the oracle only when the task needs a second opinion.",
    },
    {
      id: "opus-fable",
      label: "Opus 5 + Fable oracle",
      group: "custom",
      lead: { model: "pi/anthropic/claude-opus-5", effort: "xhigh" },
      supporting: [
        {
          model: "pi/anthropic/claude-fable-5-1",
          effort: "high",
          role: "Read-only oracle",
        },
      ],
      instructions:
        "Use the oracle for a second opinion on hard plans, architecture decisions, and significant reviews. Integrate its advice yourself.",
    },
    {
      id: "ultracode",
      label: "Ultracode",
      group: "custom",
      lead: { model: "pi/anthropic/claude-fable-5-1", effort: "xhigh" },
      instructions:
        "Plan a workflow for every substantive task instead of working through it turn by turn. Fan the work out with run_workflow, have a separate agent verify each finding, and read the result back with workflow_status. Route the judgement steps (verification, ranking, synthesis) to claude-fable-5-1 and leave mechanical extraction on the default worker model. Keep quick questions and single edits in the conversation.",
    },
    {
      id: "orchestrator-fable",
      label: "Orchestrator · Fable 5.1",
      group: "orchestrator",
      lead: { model: "pi/anthropic/claude-fable-5-1", effort: "high" },
      supporting: [
        {
          model: "pi/anthropic/claude-sonnet-5",
          effort: "medium",
          role: "Implementation worker",
        },
        {
          model: "pi/anthropic/claude-haiku-4-5",
          effort: "high",
          role: "Fast worker",
        },
      ],
      instructions:
        "Plan, review, and integrate. Delegate focused implementation work to supporting workers with self-contained briefs, then verify their results.",
    },
    {
      id: "orchestrator-fable-sol",
      label: "Orchestrator · Fable + Astra",
      group: "orchestrator",
      lead: { model: "pi/anthropic/claude-fable-5-1", effort: "high" },
      supporting: [
        {
          model: "pi/openai/gpt-6-astra",
          effort: "high",
          role: "Implementation worker",
        },
      ],
      instructions:
        "Use Fable to plan, review, and integrate. Delegate focused implementation work to Astra with self-contained briefs, then verify its results.",
    },
    {
      id: "orchestrator-sol",
      label: "Orchestrator · Sol",
      group: "orchestrator",
      lead: { model: "pi/openai/gpt-5.6-sol", effort: "xhigh" },
      supporting: [
        {
          model: "pi/openai/gpt-5.6-terra",
          effort: "medium",
          role: "Implementation worker",
        },
        { model: "pi/openai/gpt-5.6-luna", effort: "low", role: "Fast worker" },
      ],
      instructions:
        "Plan, review, and integrate. Delegate focused implementation work to supporting workers with self-contained briefs, then verify their results.",
    },
  ],
};

function copyModelSettings(
  settings: WorkspaceModelSettings,
): WorkspaceModelSettings {
  return JSON.parse(JSON.stringify(settings)) as WorkspaceModelSettings;
}

/** A workspace without its own modelSettings inherits the current defaults.
 *  Nothing materializes defaults into workspace files or list payloads; a
 *  workspace stores modelSettings only once someone saves an edit. */
export function workspaceModelSettings(
  workspace?: Workspace | null,
): WorkspaceModelSettings {
  return (
    workspace?.modelSettings ||
    copyModelSettings(DEFAULT_WORKSPACE_MODEL_SETTINGS)
  );
}

export interface Workspace {
  id: string;
  name: string;
  /** Default repo for new sessions created in this workspace (repo id). */
  repo?: string;
  /** Optional swatch key for the sidebar dot (see tab-colors). */
  color?: string;
  createdBy: string;
  createdAt: string;
  /** Manual sort order in the sidebar; lower = higher. Defaults to createdAt. */
  order?: number;
  /**
   * Stable dedupe key for auto-created workspaces (e.g. `ghpr-1234` for a PR).
   * Lets a caller find-or-create idempotently. Absent for user-made workspaces.
   */
  key?: string;
  /** For PR-backed workspaces: the PR number this workspace groups. */
  prNumber?: number;
  /** For support-ticket workspaces: the Plain thread this workspace is attached to. */
  plainThreadId?: string;
  /** Generic feed-item linkage (videos, …) — the feeds design. */
  externalRefs?: ExternalRef[];
  /**
   * The workspace's default branch. Present when the workspace owns a worktree
   * (share-mode sessions inherit it; stacked sessions branch off it) or for PR-backed
   * workspaces (the head branch the member sessions share).
   */
  branch?: string;
  /**
   * The shared worktree new share-mode sessions inherit. Absent = the workspace does
   * not own a worktree yet (ask-style / unmaterialized).
   */
  worktreeDir?: string;
  /** Secondary repos attached at the workspace level; new sessions copy these. */
  attachedRepos?: AttachedRepo[];
  /** Workspace-specific model families and combinations. */
  modelSettings?: WorkspaceModelSettings;
  /**
   * An unsent composer prompt parked here before any session exists. Absent
   * = no draft. Never backfilled onto a workspace record (same rule as
   * modelSettings above: stamping this on every row would multiply the list
   * payload by the workspace count).
   */
  draft?: WorkspaceDraft;
}

/** Reject ids that could name a foreign catalog key or escape the scratch
 *  directory; workspace ids are server-minted. */
function safeId(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(id);
}

/**
 * A workspace as read from the catalog, with its repo ids resolved through any
 * rename (canonicalRepoId). A document keeps whatever id was registered when
 * it was written, and every client groups by that id: 633 of the workspaces on
 * this instance say `backstage`, which drew the repo a second sidebar band of
 * its own. Reading through this is what keeps one repo one band, and the
 * document itself is rewritten with the current id the next time it is saved.
 *
 * Every caller hands it a freshly parsed object, so it normalizes in place.
 */
function fromStore(p: Workspace): Workspace {
  // "auto" was briefly persisted by the retired repository picker. Treat it
  // as the registered default until the next save rewrites the repaired id.
  if (p.repo === "auto") p.repo = defaultRepo().id;
  else if (p.repo) p.repo = canonicalRepoId(p.repo);
  for (const r of p.attachedRepos || []) r.repo = canonicalRepoId(r.repo);
  return p;
}

/** A catalog value that is a workspace record, normalized; else null. */
function parseWorkspace(value: unknown): Workspace | null {
  if (!value || typeof value !== "object") return null;
  const p = value as Workspace;
  if (typeof p.id !== "string" || typeof p.name !== "string") return null;
  return fromStore(p);
}

function byOrder(a: Workspace, b: Workspace): number {
  return (
    (a.order ?? (Date.parse(a.createdAt) || 0)) -
      (b.order ?? (Date.parse(b.createdAt) || 0)) ||
    a.name.localeCompare(b.name)
  );
}

// ── Memory projection ──────────────────────────────────────────────────────
//
// `docs` is null until the first warm finishes. Writers land in `docs` once
// it is warm; while it is cold they land in `overlay` (null = deleted), which
// the sync readers consult and which the warm applies on top of its page
// read, so a write racing the warm cannot be resurrected by a stale page.
// `generation` bumps on every change and keys the derived sorted list, the
// name map, and the list route's conditional-response version.

let docs: Map<string, Workspace> | null = null;
let overlay = new Map<string, Workspace | null>();
let warming: Promise<void> | null = null;
let generation = 0;
let sortedCache: { generation: number; list: Workspace[] } | null = null;
let namesCache: { generation: number; names: Map<string, string> } | null =
  null;

function project(id: string, workspace: Workspace | null): void {
  generation++;
  if (!docs) {
    overlay.set(id, workspace);
    return;
  }
  if (workspace) docs.set(id, workspace);
  else docs.delete(id);
}

/** What the projection currently holds for `id`: the warm map, else the
 *  writes made while cold. */
function projected(id: string): Workspace | null {
  return (docs ? docs.get(id) : overlay.get(id)) ?? null;
}

/**
 * Build the projection from the catalog without holding the event loop.
 * Idempotent and coalescing: concurrent callers share one page walk. The
 * session list stamps each row with its workspace's name from this
 * projection, and the boot sequence warms it before the list is first built.
 */
export async function warmWorkspacesAsync(): Promise<void> {
  if (docs) return;
  if (!warming) {
    warming = (async () => {
      const rows = await store().list();
      const next = new Map<string, Workspace>();
      for (const row of rows) {
        const workspace = parseWorkspace(row.value);
        if (workspace) next.set(workspace.id, workspace);
      }
      for (const [id, workspace] of overlay) {
        if (workspace) next.set(id, workspace);
        else next.delete(id);
      }
      docs = next;
      overlay = new Map();
      generation++;
    })().finally(() => {
      warming = null;
    });
  }
  await warming;
}

/** Drop the projection so the next read rebuilds it from the catalog. Tests
 *  swap the kernel store per case; the projection would otherwise answer for
 *  the previous one. */
export function __resetWorkspaceProjectionForTest(): void {
  docs = null;
  overlay = new Map();
  warming = null;
  sortedCache = null;
  namesCache = null;
  generation++;
}

async function projection(): Promise<Map<string, Workspace>> {
  if (!docs) await warmWorkspacesAsync();
  return docs!;
}

function sorted(all: Map<string, Workspace>): Workspace[] {
  if (sortedCache?.generation !== generation)
    sortedCache = { generation, list: [...all.values()].sort(byOrder) };
  return sortedCache.list;
}

/**
 * Every workspace, sorted for the sidebar. No defaults backfill here: stamping
 * the ~3KB default modelSettings on every row multiplied the list payload by
 * the workspace count (13 MB on this instance). Absent modelSettings means
 * "inherit the defaults": resolve through workspaceModelSettings() at the
 * point of use.
 */
export async function listWorkspaces(): Promise<Workspace[]> {
  return sorted(await projection()).slice();
}

/** Stable version for conditional workspace-list responses. */
export function workspaceListVersion(): string {
  return `workspaces:${generation}`;
}

/**
 * Read-only name projection for bulk consumers, memory only. Until
 * warmWorkspacesAsync has run once it holds only this process's own writes;
 * the list path warms it first.
 */
export function workspaceNameSnapshot(): ReadonlyMap<string, string> {
  if (namesCache?.generation !== generation) {
    const names = new Map<string, string>();
    for (const [id, workspace] of docs ?? overlay)
      if (workspace) names.set(id, workspace.name);
    namesCache = { generation, names };
  }
  return namesCache.names;
}

/** The workspace's display name from the memory projection, or null when
 *  there is no such workspace (or the projection has not seen it yet). */
export function workspaceName(id: string): string | null {
  if (!safeId(id)) return null;
  return projected(id)?.name ?? null;
}

/**
 * A workspace from the memory projection, or null. For the sync readers that
 * cannot await (the session-list assembly, model preset resolution, the
 * mention note): no I/O, and only this process's own writes until the
 * projection is warm. Everything that can await reads getWorkspace instead.
 */
export function peekWorkspace(id: string): Workspace | null {
  if (!safeId(id)) return null;
  return projected(id);
}

/** The authoritative read: one catalog lookup, never the projection. */
export async function getWorkspace(id: string): Promise<Workspace | null> {
  if (!safeId(id)) return null;
  const workspace = parseWorkspace(await store().get(id));
  // Keep the projection honest for a document that changed under it (an
  // operator import or repair). Compared by content: the gateway's own
  // writes already landed, and a read must not churn the list version.
  const seen = projected(id);
  if (
    (seen !== null || workspace !== null) &&
    JSON.stringify(seen) !== JSON.stringify(workspace)
  )
    project(id, workspace);
  return workspace;
}

/** The one write path for a whole record, so the projection stays current. */
async function saveWorkspace(workspace: Workspace): Promise<Workspace> {
  await store().set(workspace.id, workspace);
  project(workspace.id, workspace);
  return workspace;
}

const missing = Symbol("workspace missing");
/** Thrown out of a mutate that chose not to write, carrying the record. */
class Unchanged {
  constructor(readonly current: Workspace) {}
}

/**
 * Read-modify-write through the catalog's compare-and-set, so two gateway
 * generations (or two racing callers here) never clobber each other's patch.
 * `mutate` returns the next record, or the current one to leave the document
 * alone. Resolves null when the workspace does not exist.
 */
async function mutateWorkspace(
  id: string,
  mutate: (current: Workspace) => Workspace,
): Promise<Workspace | null> {
  if (!safeId(id)) return null;
  try {
    const next = await store().update<Workspace>(id, (value) => {
      const current = parseWorkspace(value);
      if (!current) throw missing;
      const result = mutate(current);
      if (result === current) throw new Unchanged(current);
      return result;
    });
    if (!next) return null;
    project(id, next);
    return next;
  } catch (error) {
    if (error === missing) return null;
    if (error instanceof Unchanged) return error.current;
    throw error;
  }
}

export async function createWorkspace(input: {
  name: string;
  repo?: string;
  color?: string;
  createdBy: string;
  key?: string;
  prNumber?: number;
  plainThreadId?: string;
  externalRefs?: ExternalRef[];
  branch?: string;
  worktreeDir?: string;
  attachedRepos?: AttachedRepo[];
  draft?: WorkspaceDraft;
  /** Reuse a caller-supplied id (e.g. migration wrapping an orphan session). */
  id?: string;
  createdAt?: string;
}): Promise<Workspace> {
  const workspace: Workspace = {
    id: input.id || `ws-${randomUUID()}`,
    name:
      (input.name || "Untitled workspace").trim().slice(0, 120) ||
      "Untitled workspace",
    repo: input.repo === "auto" ? defaultRepo().id : input.repo,
    color: input.color,
    createdBy: input.createdBy || "Anonymous",
    createdAt: input.createdAt || new Date().toISOString(),
    ...(input.key ? { key: input.key } : {}),
    ...(input.prNumber !== undefined ? { prNumber: input.prNumber } : {}),
    ...(input.plainThreadId ? { plainThreadId: input.plainThreadId } : {}),
    ...(input.externalRefs && input.externalRefs.length
      ? { externalRefs: input.externalRefs }
      : {}),
    ...(input.branch ? { branch: input.branch } : {}),
    ...(input.worktreeDir ? { worktreeDir: input.worktreeDir } : {}),
    ...(input.attachedRepos && input.attachedRepos.length
      ? { attachedRepos: input.attachedRepos }
      : {}),
    ...(input.draft
      ? {
          draft: {
            ...input.draft,
            text: input.draft.text.slice(0, MAX_DRAFT_LENGTH),
          },
        }
      : {}),
  };
  if (!safeId(workspace.id))
    throw new Error(`Invalid workspace id: ${workspace.id}`);
  return saveWorkspace(workspace);
}

/**
 * The workspace that owns `worktreeDir`, or null. When duplicates exist (older
 * create paths minted a second workspace over an already-owned worktree), the
 * oldest wins — it's the one the user thinks of as "the" workspace. Callers
 * must not pass a repo's main checkout: those are legitimately shared by many
 * workspaces (every opensession session, every ask session), so "ownership" is
 * meaningless there.
 */
export async function findWorkspaceByWorktree(
  worktreeDir: string,
): Promise<Workspace | null> {
  if (!worktreeDir) return null;
  const owners = (await listWorkspaces()).filter(
    (w) => w.worktreeDir === worktreeDir,
  );
  if (owners.length < 2) return owners[0] || null;
  return owners.sort(
    (a, b) => (Date.parse(a.createdAt) || 0) - (Date.parse(b.createdAt) || 0),
  )[0];
}

/** Find a workspace by its stable dedupe key, or null. */
export async function findWorkspaceByKey(
  key: string,
): Promise<Workspace | null> {
  if (!key) return null;
  return (await listWorkspaces()).find((p) => p.key === key) || null;
}

/**
 * The workspace already carrying `repo` + `branch`, or null. Same
 * adopt-don't-duplicate role as findWorkspaceByWorktree, one level up: the
 * Slack/Linear loops and PR automations each run the SAME branch in their own
 * worktree, so worktree ownership alone can't unite them (the split that left
 * a slack session and its PR's review session in two sidebar workspaces).
 * Callers must not pass a repo's default branch — every shared-checkout
 * session carries it, and those deliberately keep one workspace each.
 * Preference among duplicates: a key-stamped workspace (PR/ticket provenance,
 * the one resolution converges on) over unkeyed, then oldest.
 */
export async function findWorkspaceByBranch(
  repo: string,
  branch: string,
): Promise<Workspace | null> {
  if (!repo || !branch) return null;
  // Workspaces minted before repo stamping (and sweep-minted ones around
  // repo-less slack sessions) carry no repo field; they mean the default repo.
  const fallback = defaultRepo().id;
  const owners = (await listWorkspaces()).filter(
    (w) => w.branch === branch && (w.repo || fallback) === repo,
  );
  if (owners.length < 2) return owners[0] || null;
  return owners.sort(
    (a, b) =>
      Number(!!b.key) - Number(!!a.key) ||
      (Date.parse(a.createdAt) || 0) - (Date.parse(b.createdAt) || 0),
  )[0];
}

/**
 * Idempotently resolve the workspace for a stable key, creating it on first use.
 * Used to auto-group related sessions (e.g. every autofix/review/simplify session for
 * one PR) under a single workspace.
 */
export async function findOrCreateWorkspaceByKey(
  key: string,
  input: {
    name: string;
    repo?: string;
    color?: string;
    createdBy: string;
    prNumber?: number;
    plainThreadId?: string;
    branch?: string;
  },
): Promise<Workspace> {
  return (
    (await findWorkspaceByKey(key)) ||
    (await createWorkspace({ ...input, key }))
  );
}

/**
 * Stamp identity fields (dedupe key + PR/ticket linkage) onto an adopted
 * workspace. Deliberately separate from updateWorkspace so identity stays
 * unreachable through the HTTP PATCH route (which forwards its body into
 * updateWorkspace). Refuses to re-key an already-keyed workspace — the key is
 * permanent provenance; resolution falls back to session matching for any
 * additional PRs a workspace accrues.
 */
export function stampWorkspaceIdentity(
  id: string,
  patch: {
    key?: string;
    prNumber?: number;
    branch?: string;
    repo?: string;
    plainThreadId?: string;
    externalRef?: ExternalRef;
  },
): Promise<Workspace | null> {
  return mutateWorkspace(id, (cur) => {
    if (cur.key && patch.key && cur.key !== patch.key) return cur;
    // The adopted workspace may have been minted by a session in ANOTHER repo:
    // a session working in repo A can open a PR in repo B through an attached
    // repo, and that is how a workspace ended up filed under `opensession` while
    // its branch and PR belonged to another repo. A repo that disagrees with
    // the branch beside it is worse than none: sessionPrBranch refuses to
    // inherit a branch across repos, the sidebar cannot match the PR row to the
    // workspace, and a new session here resolves the branch in the wrong repo.
    // Only when the workspace has not materialized a worktree of its own, which
    // is the point where its repo stops being a guess.
    const adoptRepo =
      patch.repo && !cur.branch && !cur.worktreeDir && cur.repo !== patch.repo;
    // A PR workspace materialized by its review checkout carries the derived
    // `<head>-os-review` branch; the PR resolve names the real head, so take it.
    const repairBranch =
      !!patch.branch && cur.branch === `${patch.branch}-os-review`;
    // externalRefs accrue (a workspace can carry several linked objects, like
    // PRs) — only the dedupe key is refused once present.
    const addRef =
      patch.externalRef &&
      !(cur.externalRefs || []).some(
        (r) =>
          r.kind === patch.externalRef!.kind && r.id === patch.externalRef!.id,
      )
        ? [...(cur.externalRefs || []), patch.externalRef]
        : null;
    return {
      ...cur,
      ...(patch.key && !cur.key ? { key: patch.key } : {}),
      ...(patch.prNumber !== undefined && cur.prNumber === undefined
        ? { prNumber: patch.prNumber }
        : {}),
      ...(patch.branch && (!cur.branch || repairBranch)
        ? { branch: patch.branch }
        : {}),
      ...(adoptRepo ? { repo: patch.repo } : {}),
      ...(patch.plainThreadId && !cur.plainThreadId
        ? { plainThreadId: patch.plainThreadId }
        : {}),
      ...(addRef ? { externalRefs: addRef } : {}),
    };
  });
}

/**
 * Merge a partial patch into a workspace. Returns the updated record, or null.
 *
 * `draft` has its own semantics, mirroring upsertDraft in drafts.ts:
 * - `null` removes the field.
 * - An object applies only when there's no current draft, or its `updatedAt`
 *   is >= the stored one (ISO strings compare lexically). An older write is
 *   refused so a stale client can't clobber newer typing.
 * - While the applying draft's `autoName` is truthy, and the current draft
 *   (if any) hasn't been demoted to `autoName: false`, the workspace is also
 *   renamed to the draft text's first non-empty line (trimmed, sliced to 80
 *   chars; the name is left alone if that line is blank).
 * - An explicit `patch.name` (manual rename) always wins, and, when a draft
 *   exists, permanently demotes it to `autoName: false`, stopping the follow
 *   for life.
 */
export function updateWorkspace(
  id: string,
  patch: Partial<
    Pick<
      Workspace,
      | "name"
      | "repo"
      | "color"
      | "order"
      | "branch"
      | "worktreeDir"
      | "attachedRepos"
      | "modelSettings"
    >
  > & { draft?: WorkspaceDraft | null },
): Promise<Workspace | null> {
  return mutateWorkspace(id, (cur) => {
    const manualRename = patch.name !== undefined;

    let nextDraft: WorkspaceDraft | undefined = cur.draft;
    let draftApplied: WorkspaceDraft | undefined;
    if (patch.draft === null) {
      nextDraft = undefined;
    } else if (patch.draft !== undefined) {
      if (!cur.draft || patch.draft.updatedAt >= cur.draft.updatedAt) {
        nextDraft = {
          ...patch.draft,
          text: patch.draft.text.slice(0, MAX_DRAFT_LENGTH),
        };
        draftApplied = nextDraft;
      }
    }

    // A manual rename stops the auto-name follow permanently, whatever draft
    // this patch ends up carrying.
    if (manualRename && nextDraft)
      nextDraft = { ...nextDraft, autoName: false };

    // Name-follow: a freshly-applied draft update renames the workspace to its
    // first non-empty line, but only while autoName is truthy and hasn't
    // already been demoted, and never alongside an explicit rename, which
    // always wins and just demoted the follow above.
    let followedName: string | undefined;
    if (
      !manualRename &&
      draftApplied &&
      patch.draft &&
      patch.draft.autoName &&
      (!cur.draft || cur.draft.autoName !== false)
    ) {
      const firstLine =
        draftApplied.text
          .split("\n")
          .find((l) => l.trim())
          ?.trim() ?? "";
      if (firstLine) followedName = firstLine.slice(0, 80);
    }

    return {
      ...cur,
      ...(patch.name !== undefined
        ? { name: patch.name.trim().slice(0, 120) || cur.name }
        : {}),
      ...(followedName ? { name: followedName } : {}),
      ...(patch.repo !== undefined
        ? { repo: patch.repo === "auto" ? defaultRepo().id : patch.repo }
        : {}),
      ...(patch.color !== undefined ? { color: patch.color } : {}),
      ...(patch.order !== undefined ? { order: patch.order } : {}),
      ...(patch.branch !== undefined ? { branch: patch.branch } : {}),
      ...(patch.worktreeDir !== undefined
        ? { worktreeDir: patch.worktreeDir }
        : {}),
      ...(patch.attachedRepos !== undefined
        ? { attachedRepos: patch.attachedRepos }
        : {}),
      ...(patch.modelSettings !== undefined
        ? { modelSettings: patch.modelSettings }
        : {}),
      draft: nextDraft,
    };
  });
}

/**
 * Re-point a workspace at a different worktree — the repo-switch case, where the
 * workspace was minted around a checkout its only session has since left. Unlike
 * updateWorkspace, an omitted branch/worktreeDir CLEARS the field rather than
 * leaving it: switching into a shared-checkout repo leaves no per-session worktree
 * for a sibling session to inherit, and a stale one would send it to the abandoned
 * checkout. Identity (key, prNumber, ticket/feed refs) is untouched.
 */
export function restampWorkspaceWorktree(
  id: string,
  next: { repo: string; branch?: string; worktreeDir?: string },
): Promise<Workspace | null> {
  return mutateWorkspace(id, (cur) => {
    const { branch: _b, worktreeDir: _w, ...rest } = cur;
    return {
      ...rest,
      repo: next.repo,
      ...(next.branch ? { branch: next.branch } : {}),
      ...(next.worktreeDir ? { worktreeDir: next.worktreeDir } : {}),
    };
  });
}

/**
 * Remove a workspace's record. The caller must handle member sessions first
 * so none retain a reference to a workspace that no longer exists.
 */
export async function deleteWorkspace(id: string): Promise<boolean> {
  if (!safeId(id)) return false;
  const existed = await store().delete(id);
  if (!existed) return false;
  project(id, null);
  // A deleted workspace's scratch dir (scratch-mode sessions — see
  // worktree.ts ensureScratchDir) goes with it; safeId() already rules
  // out anything path-escaping.
  try {
    await rm(`${stateDir("scratch")}/${id}`, { recursive: true, force: true });
  } catch {}
  return true;
}
