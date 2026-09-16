/**
 * Images and files in a private session.
 *
 * A private session's media would land in the shared uploads path, which has
 * no owner-bound storage or serving yet, so the server rejects every image
 * and file attachment for one (assertPersonalImagesAbsent). The client must
 * therefore refuse a pick, drop, or paste BEFORE anything is staged or
 * uploaded, and must not send media that was staged earlier under a shared
 * repository. Pasted text stays inline as a chip: it is prompt text, not a
 * staged file. Shared sessions keep every attachment behavior.
 *
 * Privacy always comes from the server's own metadata (a session's
 * `personalRepo`, a repository's `accessScope`), never from a name or an id.
 */

import { shouldAttachPastedTextAsFile } from "./pasted-text";
import type { UnifiedSession } from "./types";

/** A private session, by the server-projected access scope on its row (the
 * same field the repository list carries). Never inferred from a name. */
export function isPrivateSession(
  session: Pick<UnifiedSession, "accessScope"> | null | undefined,
): boolean {
  return session?.accessScope?.kind === "personal";
}

/** Why an attach control is off, and what a refused pick, drop, or paste says. */
export const PRIVATE_ATTACHMENTS_UNAVAILABLE =
  "Images and files are unavailable in private sessions.";

/** Shown when media staged for a shared repository is still in the draft
 * after the repository changed to a private one. */
export const PRIVATE_ATTACHMENTS_STAGED =
  "Private sessions can't take images or files. Remove them or choose a shared repository.";

/** Whether a pasted text becomes a staged file. A shared target attaches a
 * paste past the file threshold (lib/pasted-text.ts) so the agent reads it
 * with its tools; a private target has no file channel, so the same paste
 * stays inline as a chip however long it is. Every paste handler that can
 * stage a file must ask this first, so a private long paste is never handed
 * to the attachment intake, which would refuse it and drop the text. */
export function pastedTextBecomesFile(
  privateTarget: boolean,
  text: string,
): boolean {
  return !privateTarget && shouldAttachPastedTextAsFile(text);
}

/** Whether staged media blocks the send: only a private target with at least
 * one image or file. A private target with none, or any shared target, is
 * not blocked here. */
export function privateAttachmentsBlocked(
  privateTarget: boolean,
  counts: { images: number; files: number },
): boolean {
  return privateTarget && counts.images + counts.files > 0;
}
