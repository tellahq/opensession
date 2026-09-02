/**
 * Staging an attachment outlives the composer that asked for it.
 *
 * Pasting a screenshot is not instant: the file is streamed to disk first
 * (lib/images.ts) and only the short `/media?path=` ref it comes back with is
 * small enough to keep. That upload takes seconds exactly when the app is
 * still loading, because it queues behind the multi-MB session and workspace
 * lists — which is the moment you cannot start the session yet and so the
 * moment you are most likely to paste, close the palette and come back.
 *
 * So the completion writes to the draft store rather than to component state:
 * the store is a module-level map that no unmount can take down, and a
 * composer that is still open mirrors it. Setting state on a component that
 * closed while its upload was in flight is how a pasted screenshot used to
 * disappear for good, with the file sitting staged on the server the whole
 * time.
 *
 * The generation counter is the other half of that trade. Once a draft has
 * been consumed — the session was created, the prompt was parked on a
 * workspace — a completion that lands afterwards must not write the image
 * back and resurrect a draft that is finished.
 */
import { MAX_PROMPT_IMAGES } from "@tellahq/opensession-protocol/session";
import { loadDraft, saveDraft } from "./drafts";
import { splitAttachments, type FileAttachment } from "./images";

/** Why an image past the per-message cap was left out of the draft. */
export function imageCapReason(dropped: number): string {
  return `${dropped} image${dropped === 1 ? "" : "s"} (a message holds up to ${MAX_PROMPT_IMAGES})`;
}

/** Bumped whenever a key's draft is consumed, so in-flight staging for it can
 *  tell that the composer it belongs to has moved on. */
const generations = new Map<string, number>();

/** Files still on their way to disk, for the composer's "Attaching…" row. */
export interface StagingCount {
  images: number;
  files: number;
}

export const NOTHING_STAGING: StagingCount = { images: 0, files: 0 };

export function isStaging(count: StagingCount): boolean {
  return count.images + count.files > 0;
}

/** Split a pick the way `attachToDraft` will, for the pending row's copy. */
export function countStaging(picked: FileList | File[]): StagingCount {
  const all = Array.from(picked);
  const images = all.filter((file) => file.type.startsWith("image/")).length;
  return { images, files: all.length - images };
}

export function addStaging(a: StagingCount, b: StagingCount): StagingCount {
  return { images: a.images + b.images, files: a.files + b.files };
}

export function subtractStaging(
  a: StagingCount,
  b: StagingCount,
): StagingCount {
  return { images: a.images - b.images, files: a.files - b.files };
}

/**
 * What the composer says while files are on their way to disk. Naming the
 * count matters more than it looks: without it a paste during a slow load
 * shows nothing at all, and the second paste is the one that leaves you with
 * two copies of the same screenshot.
 */
export function attachingLabel(count: StagingCount): string | null {
  const total = count.images + count.files;
  if (total < 1) return null;
  const noun = count.files === 0 ? "image" : "file";
  return `Attaching ${total} ${noun}${total === 1 ? "" : "s"}…`;
}

/** Whether a mirror of the stored images is still current, so a composer can
 *  keep its own array (and skip a render) when nothing actually moved. */
export function sameImages(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((src, i) => src === b[i]);
}

export function sameFiles(a: FileAttachment[], b: FileAttachment[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (file, i) =>
        file.name === b[i]?.name &&
        file.path === b[i]?.path &&
        file.dataUrl === b[i]?.dataUrl,
    )
  );
}

export interface AttachResult {
  /** Files that could not be staged, for the caller to surface. */
  rejected: string[];
  /** False when the draft was consumed while these were staging, so nothing
   *  was written and the caller must not adopt them either. */
  applied: boolean;
}

/**
 * Stage `picked` and commit whatever came back to `key`'s draft.
 *
 * The merge reads the store at completion time rather than closing over the
 * array the caller held when the paste happened, so two pastes in flight keep
 * both results instead of the later one winning.
 */
export async function attachToDraft(
  key: string,
  picked: FileList | File[],
  signal?: AbortSignal,
): Promise<AttachResult> {
  const generation = generations.get(key) ?? 0;
  const { images, files, rejected } = await splitAttachments(picked, signal);
  if (signal?.aborted || (generations.get(key) ?? 0) !== generation) {
    return { rejected, applied: false };
  }
  if (images.length || files.length) {
    const stored = loadDraft(key);
    // The server refuses a longer list outright, so stop at the cap here and
    // name what was left out: the store, not the caller's stale array, is
    // what decides how much room a paste still has.
    const room = Math.max(0, MAX_PROMPT_IMAGES - stored.images.length);
    if (images.length > room)
      rejected.push(imageCapReason(images.length - room));
    saveDraft(key, {
      images: [...stored.images, ...images.slice(0, room)],
      files: [...stored.files, ...files],
    });
  }
  return { rejected, applied: true };
}

/** Drop one of the key's staged images, keeping the store authoritative. */
export function removeDraftImage(key: string, index: number): void {
  const stored = loadDraft(key);
  saveDraft(key, { images: stored.images.filter((_, i) => i !== index) });
}

/** Drop one of the key's staged files. */
export function removeDraftFile(key: string, index: number): void {
  const stored = loadDraft(key);
  saveDraft(key, { files: stored.files.filter((_, i) => i !== index) });
}

/**
 * The draft has been consumed: anything still staging for it belongs to a
 * prompt that has already been sent, so drop it instead of writing it back
 * into a draft that should now be empty.
 */
export function dropStagingAttachments(key: string): void {
  generations.set(key, (generations.get(key) ?? 0) + 1);
}
