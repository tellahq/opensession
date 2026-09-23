/**
 * Chat attachments, put on disk where the ENGINE runs.
 *
 * A pasted image reaches the model through the vision channel, so it can see
 * a screenshot but, unlike a non-image attachment (uploads.ts stageUploads),
 * it was never told where the bytes live. Asked to commit or convert one,
 * runs went looking for a file, found nothing, and invented a step the person
 * cannot take ("upload it in the Assets tab"). A non-image attachment had the
 * opposite problem: its note named a path on the Open Session host, which a
 * Runner-backed or Sandbox run cannot read.
 *
 * Both are fixed by staging in the process that hosts the engine, never on
 * the server ahead of dispatch. The session scratch dir is the one location
 * every topology shares: agent-runner stamps it on the run and pi exports it
 * as $OPENSESSION_SCRATCH, so a path under it is real wherever the agent's
 * file tools execute. Images arrive with every run (RunAgentOpts.images);
 * file bytes ride the spec only for a host on another machine
 * (RunHostSpec.files), because in-process the host path already works.
 * Staging by content digest is idempotent: a retried, requeued or steered
 * delivery of the same bytes lands on the same file instead of a second copy.
 *
 * Asynchronous throughout: an in-process run (a Slack turn, the web fallback)
 * hosts the engine on the gateway's own event loop, and six screenshots are
 * tens of megabytes to decode, hash and write. The digest goes through
 * crypto.subtle and the writes through fs/promises so none of it stalls
 * HTTP or WebSocket traffic. pi-runner keeps its steer bookkeeping
 * synchronous and serializes the staging in front of the engine enqueue.
 */
import { mkdir, writeFile } from "fs/promises";
import { wrapContext } from "./prompt-context";
import type { ImageInput, PromptFile } from "./run-events";

// Owned here rather than in uploads.ts so the engine-side importer
// (agent-runner, and through it every detached host) stays a leaf: uploads.ts
// reaches the session catalog, whose import graph loops back into the runners.
/** Cap so a single upload can't OOM the process. The HTTP path streams, but
 *  the inline base64/WS path buffers, so keep it modest. */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
export function envBytes(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/**
 * Largest non-image attachment that reaches the agent by path. Those files are
 * streamed to disk in chunks (chunked-uploads.ts) and never held in memory,
 * so the only real limit is disk. Images and the inline base64 path keep
 * MAX_UPLOAD_BYTES, because they are read whole.
 */
export const MAX_FILE_UPLOAD_BYTES = envBytes(
  "OPENSESSION_MAX_FILE_UPLOAD_BYTES",
  20 * 1024 * 1024 * 1024,
);
/**
 * How much attachment payload one turn ships inline to a remote host. The
 * spec travels as one JSON document through the Runner's WebSocket frame or
 * the sandbox driver's file write, so it is capped well under the upload
 * cap; images already ride the same way. Attachments past the cap keep their
 * host-only path and the note says so.
 */
export const MAX_SHIPPED_ATTACHMENT_BYTES = 16 * 1024 * 1024;
export const INLINE_IMAGE_EXTENSIONS: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
};

export type StagedAttachment = { name: string; path: string };
/** Where staged bytes go when the engine's tools act on another machine (a
 *  Sandbox): writes `path` there, keeping a file already present, and
 *  answers whether the file is in place. Absent = this machine's disk. */
export type AttachmentWriter = (
  path: string,
  bytes: Buffer,
) => Promise<boolean>;
/** What a remote host made of the turn's shipped files: the copies it wrote,
 *  and the names it received without bytes (or could not write). */
export type StagedFiles = { staged: StagedAttachment[]; omitted: string[] };

/** Keep a user-supplied filename to a safe basename (no traversal, no exotic chars). */
export function sanitizeAttachmentName(name: string): string {
  const base = (name.split(/[\\/]/).pop() || "file").replace(/^\.+/, "");
  const cleaned = base
    .replace(/[^A-Za-z0-9._ -]/g, "_")
    .trim()
    .slice(0, 120);
  return cleaned || "file";
}

/** Write one attachment exactly once under `<scratch>/attachments`. "wx"
 *  keeps an identical file's bytes and stops two deliveries half-overwriting
 *  each other. Undefined when the bytes could not be written. */
async function stageBytes(
  scratchDir: string,
  fileName: string,
  bytes: Buffer,
  writer?: AttachmentWriter,
): Promise<string | undefined> {
  const dir = `${scratchDir}/attachments`;
  const path = `${dir}/${fileName}`;
  if (writer) return (await writer(path, bytes)) ? path : undefined;
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") {
      console.warn(
        "[prompt-attachments] Could not stage an attachment:",
        error,
      );
      return undefined;
    }
  }
  return path;
}

async function digestOf(bytes: Buffer): Promise<string> {
  // A copy: Buffer's backing store is typed ArrayBufferLike, which subtle
  // rejects; the bytes are bounded and the digest is what's expensive.
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return Buffer.from(digest).toString("hex").slice(0, 16);
}

/** Stage a prompt's images under the session scratch dir. Types without a
 *  known extension are skipped: a run needs a path it can name a format for,
 *  and the vision channel still carries them. */
export async function stagePromptImages(
  scratchDir: string | undefined,
  images?: ImageInput[],
  writer?: AttachmentWriter,
): Promise<StagedAttachment[]> {
  if (!scratchDir || !images?.length) return [];
  const staged: StagedAttachment[] = [];
  for (const [index, image] of images.entries()) {
    const extension = INLINE_IMAGE_EXTENSIONS[image.mediaType];
    if (!extension) continue;
    const bytes = Buffer.from(image.data, "base64");
    if (!bytes.length || bytes.length > MAX_UPLOAD_BYTES) continue;
    const path = await stageBytes(
      scratchDir,
      `image-${await digestOf(bytes)}${extension}`,
      bytes,
      writer,
    );
    if (path) staged.push({ name: `image-${index + 1}${extension}`, path });
  }
  return staged;
}

/** Stage the non-image attachments a remote host received inline. The
 *  digest prefix keeps two different files with the same name apart and
 *  makes a redelivery land on the file already there. A file that arrived
 *  without bytes, or could not be written, is reported by name so the note
 *  can say its host path is not an alternative. */
export async function stagePromptFiles(
  scratchDir: string | undefined,
  files?: PromptFile[],
  writer?: AttachmentWriter,
): Promise<StagedFiles> {
  const result: StagedFiles = { staged: [], omitted: [] };
  if (!files?.length) return result;
  for (const file of files) {
    const name = sanitizeAttachmentName(file.name);
    const shown = file.name || name;
    const bytes =
      file.data === undefined ? undefined : Buffer.from(file.data, "base64");
    const path =
      scratchDir && bytes && bytes.length <= MAX_SHIPPED_ATTACHMENT_BYTES
        ? await stageBytes(
            scratchDir,
            `${await digestOf(bytes)}-${name}`,
            bytes,
            writer,
          )
        : undefined;
    if (path) result.staged.push({ name: shown, path });
    else result.omitted.push(shown);
  }
  return result;
}

/** Fenced, so the transcript keeps only the person's message; appending the
 *  same note twice is a no-op, so a recovered run that re-enters with its
 *  journaled (already noted) prompt does not stack a second copy. */
function withNote(prompt: string, body: string): string {
  const note = wrapContext(body, "uploads-note");
  return prompt.includes(note) ? prompt : `${prompt}\n\n${note}`;
}

function pathLines(staged: StagedAttachment[]): string {
  return staged.map((s) => `- ${s.name}: ${s.path}`).join("\n");
}

/**
 * Tell the agent where the prompt's images live and that a chat attachment is
 * never something the person can move into Assets. The transcript already
 * shows the pictures, so the note is model-only plumbing.
 */
export function withImagesNote(
  prompt: string,
  staged: StagedAttachment[],
): string {
  if (!staged.length) return prompt;
  return withNote(
    prompt,
    `The user attached ${staged.length} image(s) to this message. You can see them inline; ` +
      `the same files are saved on disk, so read or copy them from these paths when you ` +
      `need the file itself (to convert, commit, or publish it):\n${pathLines(staged)}\n` +
      `Chat attachments never appear in the session's Assets tab and the person cannot ` +
      `upload there. If an attachment is missing, ask them to send it again in chat.`,
  );
}

/**
 * A remote host's copy of the turn's file attachments. The plain uploads
 * note above it still names the Open Session host paths, because the
 * transcript UI reads that note to draw the attachment chips; this one tells
 * the model which paths are real from where it runs. Present whenever the
 * server shipped anything, copies or not: a turn whose only attachment was
 * too large still needs the model told that the host path is out of reach.
 */
export function withFilesNote(
  prompt: string,
  { staged, omitted }: StagedFiles,
): string {
  if (!staged.length && !omitted.length) return prompt;
  const copies = staged.length
    ? `Copies of these files are in your scratch dir; read them from these paths ` +
      `instead:\n${pathLines(staged)}\n`
    : "";
  const missing = omitted.length
    ? `These attachments could not be shipped here (too large for one turn) and ` +
      `cannot be read from this machine:\n${omitted.map((n) => `- ${n}`).join("\n")}\n`
    : "";
  return withNote(
    prompt,
    `This run does not execute on the Open Session host, so the attachment paths ` +
      `listed above are not reachable from here. ${copies}${missing}` +
      `Chat attachments never appear in the session's Assets tab and the person ` +
      `cannot upload there; if you need one you cannot read, say so and ask them ` +
      `to send a smaller file or a link in chat.`,
  );
}
