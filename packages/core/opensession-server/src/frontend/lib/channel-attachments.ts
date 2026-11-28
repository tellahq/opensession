// Files waiting in a Channels composer until the message that shares them.

/** Slack shares at most ten files in one message. */
export const MAX_ATTACHMENTS = 10;

export interface ComposerAttachment {
  file: File;
  /** A preview URL, for an image. */
  url?: string;
}

export interface AttachResult {
  attachments: ComposerAttachment[];
  /** Why some files stayed out, in a sentence. */
  rejected?: string;
}

/** `current` with `files` added: images get a preview, files over `maxBytes`
 *  and those past the tenth stay out, and `rejected` says why in a
 *  sentence. */
export function addAttachments(
  current: readonly ComposerAttachment[],
  files: readonly File[],
  maxBytes: number,
  preview: (file: File) => string = (file) => URL.createObjectURL(file),
): AttachResult {
  const next = [...current];
  const tooBig: string[] = [];
  let overflow = false;
  for (const file of files) {
    if (file.size > maxBytes) {
      tooBig.push(file.name);
      continue;
    }
    if (next.length >= MAX_ATTACHMENTS) {
      overflow = true;
      continue;
    }
    next.push(
      file.type.startsWith("image/") ? { file, url: preview(file) } : { file },
    );
  }
  const rejected = tooBig.length
    ? `${tooBig.length === 1 ? `${tooBig[0]} is` : `${tooBig.length} files are`} too large (${Math.round(maxBytes / 1024 / 1024)} MB max)`
    : overflow
      ? `You can attach up to ${MAX_ATTACHMENTS} files`
      : undefined;
  return rejected ? { attachments: next, rejected } : { attachments: next };
}
