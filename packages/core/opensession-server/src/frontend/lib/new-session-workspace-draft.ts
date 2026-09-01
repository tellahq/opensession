import { dropStagingAttachments } from "./attachments";
import { clearDraft, workspaceDraftKey } from "./drafts";

// The workspace an unscoped New-session composer parked its draft on. This
// outlives the palette component so reopening can update/adopt the same draft.
let parkedWorkspaceId: string | null = null;

export function getParkedNewSessionWorkspaceId(): string | null {
  return parkedWorkspaceId;
}

export function rememberParkedNewSessionWorkspace(id: string): void {
  parkedWorkspaceId = id;
}

export function forgetParkedNewSessionWorkspace(id: string): void {
  // Async draft parking can overlap a newer park. Only release the workspace
  // this operation actually consumed or found missing.
  if (parkedWorkspaceId === id) parkedWorkspaceId = null;
}

export function consumeNewSessionWorkspaceDraft(id: string): void {
  const draftKey = workspaceDraftKey(id);
  dropStagingAttachments(draftKey);
  clearDraft(draftKey);
  forgetParkedNewSessionWorkspace(id);
}
