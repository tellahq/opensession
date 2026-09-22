import { dropStagingAttachments } from "./attachments";
import { clearDraft, workspaceDraftKey } from "./drafts";

// The workspace an unscoped New-session composer parked its draft on. This
// outlives the palette component so reopening can update/adopt the same draft.
let parkedWorkspace: { id: string; repo: string } | null = null;

export function getParkedNewSessionWorkspaceId(repo: string): string | null {
  return parkedWorkspace?.repo === repo ? parkedWorkspace.id : null;
}

export function rememberParkedNewSessionWorkspace(
  id: string,
  repo: string,
): void {
  parkedWorkspace = { id, repo };
}

export function forgetParkedNewSessionWorkspace(id: string): void {
  // Async draft parking can overlap a newer park. Only release the workspace
  // this operation actually consumed or found missing.
  if (parkedWorkspace?.id === id) parkedWorkspace = null;
}

export function consumeNewSessionWorkspaceDraft(id: string): void {
  const draftKey = workspaceDraftKey(id);
  dropStagingAttachments(draftKey);
  clearDraft(draftKey);
  forgetParkedNewSessionWorkspace(id);
}
