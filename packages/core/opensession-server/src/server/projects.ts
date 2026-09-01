/**
 * Projects — the top level of the product model: a source of work that owns a
 * band in the sidebar and whose contents resolve to workspaces.
 *
 *   Project > Workspace > Session
 *
 * Two kinds, and the only difference is where the work comes from:
 *
 *   - `repo`  a registered git checkout (config `repos`, worktree.ts REPOS).
 *             Its workspaces are branches you create by working.
 *   - `feed`  an external system reached through an MCP server or integration
 *             (feeds.ts — Plain tickets, videos, …). Its workspaces are
 *             adopted as items arrive.
 *
 * This module is the union view over the two registries. It deliberately owns
 * no storage: a repo project is config, a feed project is a feed descriptor,
 * and inventing a third store would just give them a way to disagree. Consumers
 * that genuinely need one kind (worktree creation, feed polling) keep talking
 * to the specific registry; this is for everything that treats them alike —
 * the sidebar's band list, the Projects settings page, the API.
 *
 * See CONCEPTS.md for the model this implements.
 */

import { configuredRepos, defaultRepo } from "./config";
import { listFeedDescriptors } from "./feeds";

export type ProjectKind = "repo" | "feed";

export interface Project {
  /** Repo id or feed id. Unique within its kind; see `key` for a global id. */
  id: string;
  kind: ProjectKind;
  /** Globally unique across kinds: `repo:<id>` / `feed:<id>`. */
  key: string;
  /** Display name for the band header and settings row. */
  label: string;
  /** One-line description, when the registry carries one. */
  description?: string;
  /** Brand tile background (feeds); repos fall back to their icon/avatar. */
  tileBg?: string;
  /** Repo-only: `owner/name` on GitHub, the default branch, shared-checkout. */
  repo?: {
    ghRepo: string;
    defaultBranch: string;
    sharedCheckout: boolean;
    isDefault: boolean;
  };
  /** Feed-only: the ExternalRef kind its items stamp, and whether it was
   *  declared as config (editable in the UI) rather than by a code plugin. */
  feed?: {
    refKind: string;
    fromConfig: boolean;
    /** MCP servers sessions in this project's workspaces are scoped to. */
    mcpServers?: string[];
  };
}

export function projectKey(kind: ProjectKind, id: string): string {
  return `${kind}:${id}`;
}

/** Every registered repository, as projects. */
function repoProjects(): Project[] {
  const fallback = defaultRepo();
  return Object.values(configuredRepos()).map((r) => ({
    id: r.id,
    kind: "repo" as const,
    key: projectKey("repo", r.id),
    label: r.label || r.id,
    ...(r.description ? { description: r.description } : {}),
    repo: {
      ghRepo: r.ghRepo,
      defaultBranch: r.defaultBranch,
      sharedCheckout: !!r.sharedCheckout,
      isDefault: r.id === fallback.id,
    },
  }));
}

/** Every registered feed, as projects. Feeds register lazily, so callers that
 *  want the full set should ensure registration first (see feeds.ts). */
function feedProjects(): Project[] {
  return listFeedDescriptors().map((f) => ({
    id: f.id,
    kind: "feed" as const,
    key: projectKey("feed", f.id),
    label: f.title || f.id,
    ...(f.tileBg ? { tileBg: f.tileBg } : {}),
    feed: {
      refKind: f.refKind,
      fromConfig: !!f.fromConfig,
      ...(f.mcpServers?.length ? { mcpServers: f.mcpServers } : {}),
    },
  }));
}

/**
 * All projects, repos first (they are the ones you cut branches in), each kind
 * in its registry's own order so the sidebar and settings agree.
 */
export function listProjects(): Project[] {
  return [...repoProjects(), ...feedProjects()];
}

export function getProject(kind: ProjectKind, id: string): Project | null {
  return listProjects().find((p) => p.kind === kind && p.id === id) ?? null;
}
