/**
 * The ship surface of one session, as the Changes tab, the no-PR Review bar
 * and the session header read it: the effective ship mode, the buttons to
 * offer, and what has shipped directly so far. Built from the session record,
 * its workspace and the repository config; no git calls, so it is cheap to
 * refetch whenever the session's git state changes.
 */

import {
  buildShipButtons,
  type ResolvedShipMode,
  type ShipButton,
  type ShipCheckout,
} from "./ship-mode";
import { sessionShipMode } from "./session-repos";
import { getWorkspace } from "./workspaces";
import { canonicalPath, getRepo, sessionRepoId } from "./worktree";
import type { DirectShip, UnifiedSession } from "./types";

/** Ships returned to the client; older ones stay on the session file. */
const SHIPS_SHOWN = 5;

export type SessionShipInfo =
  | { available: false }
  | ({
      available: true;
      repo: string;
      /** The default branch a direct ship lands on. */
      target: string;
      checkout: ShipCheckout;
      openPr?: { number: number; url?: string };
      buttons: ShipButton[];
      ships: DirectShip[];
      /** The repository archives a workspace once its ship is confirmed. */
      archiveShipped: boolean;
    } & ResolvedShipMode);

export async function sessionShipInfo(
  session: UnifiedSession,
): Promise<SessionShipInfo> {
  if (session.mode !== "code" || !session.worktreeDir || session.desk)
    return { available: false };
  const repoId = sessionRepoId(session);
  if (!repoId) return { available: false };
  let repo;
  try {
    repo = getRepo(repoId);
  } catch {
    return { available: false };
  }
  const checkout: ShipCheckout =
    canonicalPath(session.worktreeDir) === canonicalPath(repo.repo)
      ? "shared"
      : "worktree";
  // A session that predates its workspace's choice still ships the way the
  // workspace was created to.
  const workspaceShipMode =
    !session.shipMode && session.workspaceId
      ? (await getWorkspace(session.workspaceId).catch(() => null))?.shipMode
      : undefined;
  const resolved = sessionShipMode(
    { ...session, shipMode: session.shipMode ?? workspaceShipMode },
    repo,
  );
  const open = session.prs?.find(
    (pr) =>
      pr.repo === repo.id &&
      pr.branch === session.branch &&
      !!pr.number &&
      pr.state !== "MERGED" &&
      pr.state !== "CLOSED",
  );
  const openPr = open?.number
    ? { number: open.number, ...(open.url ? { url: open.url } : {}) }
    : undefined;
  // A shared checkout pushes the default branch by hand whatever the
  // configured mode, so it always reads as direct.
  const effective: ResolvedShipMode =
    checkout === "shared" ? { ...resolved, mode: "direct" } : resolved;
  return {
    available: true,
    repo: repo.id,
    target: repo.defaultBranch,
    checkout,
    ...effective,
    ...(openPr ? { openPr } : {}),
    buttons: buildShipButtons({
      repo,
      mode: effective.mode,
      checkout,
      openPr,
      custom: repo.shipActions,
    }),
    ships: (session.directShips || []).slice(-SHIPS_SHOWN),
    archiveShipped: !!repo.archiveShipped,
  };
}
