import {
  captureClientDataScope,
  isCurrentClientDataScope,
  type ClientDataScope,
} from "./client-data-scope";
import { dropStagingAttachments } from "./attachments";
import { clearDraft, workspaceDraftKey } from "./drafts";

// The workspace an unscoped New-session composer parked its draft on. This
// outlives the palette component so reopening can update/adopt the same draft.
let parkedWorkspace: {
  id: string;
  repo: string;
  scope: ClientDataScope;
} | null = null;

function parkedFor(scope: ClientDataScope | null) {
  return parkedWorkspace &&
    scope === parkedWorkspace.scope &&
    isCurrentClientDataScope(scope)
    ? parkedWorkspace
    : null;
}

/** The previous copy, including across repo changes, for retiring a re-parked draft. */
export function getParkedNewSessionWorkspace(
  scope = captureClientDataScope(),
): Readonly<{
  id: string;
  repo: string;
}> | null {
  const parked = parkedFor(scope);
  return parked ? { id: parked.id, repo: parked.repo } : null;
}

export function getParkedNewSessionWorkspaceId(
  repo: string,
  scope = captureClientDataScope(),
): string | null {
  const parked = parkedFor(scope);
  return parked?.repo === repo ? parked.id : null;
}

export function rememberParkedNewSessionWorkspace(
  id: string,
  repo: string,
  scope = captureClientDataScope(),
): void {
  if (!scope || !isCurrentClientDataScope(scope)) return;
  parkedWorkspace = { id, repo, scope };
}

export function forgetParkedNewSessionWorkspace(
  id: string,
  scope = captureClientDataScope(),
): void {
  if (!scope || !isCurrentClientDataScope(scope)) return;
  // Async draft parking can overlap a newer park. Only release the workspace
  // this operation actually consumed or found missing.
  if (parkedWorkspace?.scope === scope && parkedWorkspace.id === id)
    parkedWorkspace = null;
}

export function consumeNewSessionWorkspaceDraft(
  id: string,
  scope = captureClientDataScope(),
): void {
  if (!scope || !isCurrentClientDataScope(scope)) return;
  const draftKey = workspaceDraftKey(id, scope);
  dropStagingAttachments(draftKey);
  clearDraft(draftKey);
  forgetParkedNewSessionWorkspace(id, scope);
}

export type PendingDraftPark = {
  readonly scope: ClientDataScope | null;
  text: string;
  workspaceId?: string;
  consumed: boolean;
  /** The existing workspace the create adopted. When absent, the create made
   *  another workspace and a late unscoped park can be deleted outright. */
  consumedIntoWorkspaceId?: string;
};

// A dismissed palette can be reopened while its workspace request is still in
// flight. If that prompt starts a session first, the late response must not
// leave a second, stale draft workspace behind.
export const pendingDraftParks = new Set<PendingDraftPark>();

export function consumePendingDraftParks(
  text: string,
  workspaceId: string | undefined,
  consumedIntoWorkspaceId?: string,
  scope = captureClientDataScope(),
) {
  if (!isCurrentClientDataScope(scope)) return;
  for (const operation of pendingDraftParks) {
    if (
      operation.scope === scope &&
      operation.text === text &&
      operation.workspaceId === workspaceId
    ) {
      operation.consumed = true;
      operation.consumedIntoWorkspaceId = consumedIntoWorkspaceId;
    }
  }
}

export function draftParkInFlight(
  text: string,
  workspaceId?: string,
  scope = captureClientDataScope(),
): boolean {
  if (!isCurrentClientDataScope(scope)) return false;
  return [...pendingDraftParks].some(
    (operation) =>
      operation.scope === scope &&
      !operation.consumed &&
      operation.text === text &&
      operation.workspaceId === workspaceId,
  );
}
