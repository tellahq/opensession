/**
 * Local file requests: the agent asks the person watching a session for files
 * from their own computer, and waits while they pick and upload them.
 *
 * The agent never names a path on that computer. It states a purpose, the
 * session shows a card, and the person chooses files in their own file picker
 * (in the Mac app, the native macOS panel). The upload is the same chunked,
 * resumable path the composer uses (chunked-uploads.ts), so multi-gigabyte
 * video works. Nothing on the person's machine is reachable otherwise: there
 * is no background service, no pairing, and no way to list or read a folder.
 *
 * Same shape as slack-compose.ts: one pending request per session, held in
 * memory, broadcast to every viewer, resolved by whoever answers first. A
 * restart drops the request and the waiting tool call with it.
 */
import { mkdir, realpath, rename, stat } from "node:fs/promises";
import { basename } from "node:path";
import { broadcastToSession } from "./ws-hub";
import { sanitizeAttachmentName } from "./prompt-attachments";
import { MAX_FILE_UPLOAD_BYTES, UPLOADS_DIR } from "./uploads";

export interface LocalFilesRequest {
  id: string;
  purpose: string;
  hint?: string;
  multiple: boolean;
  requestedAt: number;
  expiresAt: number;
}

export type LocalFile = { name: string; path: string; size: number };
export type LocalFilesResult =
  | { status: "provided"; files: LocalFile[] }
  | { status: "declined" }
  | { status: "expired" };

type Pending = {
  request: LocalFilesRequest;
  resolve: (result: LocalFilesResult) => void;
  timer: ReturnType<typeof setTimeout>;
  /** Set while the answer's files are being moved, so a second answer from
   *  another viewer cannot race it. */
  answering: boolean;
};

/** Long enough to find a file and upload several gigabytes. */
export const LOCAL_FILES_REQUEST_TTL_MS = 30 * 60 * 1000;
const MAX_FILES = 20;

const g = globalThis as { __pendingLocalFileRequests?: Map<string, Pending> };
const pending: Map<string, Pending> = (g.__pendingLocalFileRequests ??=
  new Map());

function printable(value: unknown, max: number): string {
  return typeof value === "string"
    ? value
        .replace(/[\x00-\x1f\x7f‪-‮⁦-⁩]/g, " ")
        .trim()
        .slice(0, max)
    : "";
}

function announce(sessionId: string, request: LocalFilesRequest | null) {
  broadcastToSession(sessionId, {
    type: "local_files_request",
    sessionId,
    fileRequest: request,
  });
}

function settle(
  sessionId: string,
  entry: Pending,
  result: LocalFilesResult,
): void {
  if (pending.get(sessionId) !== entry) return;
  pending.delete(sessionId);
  clearTimeout(entry.timer);
  entry.resolve(result);
  broadcastToSession(sessionId, {
    type: "local_files_request_resolved",
    sessionId,
    requestId: entry.request.id,
    status: result.status,
    ...(result.status === "provided"
      ? { files: result.files.map(({ name, size }) => ({ name, size })) }
      : {}),
  });
}

/** Open a request and wait for the person to answer it. */
export function requestLocalFiles(
  sessionId: string,
  input: { purpose?: unknown; hint?: unknown; multiple?: unknown },
  signal?: AbortSignal,
  ttlMs = LOCAL_FILES_REQUEST_TTL_MS,
): Promise<LocalFilesResult> {
  if (pending.has(sessionId))
    throw new Error("this session already has an open file request");
  const purpose = printable(input.purpose, 240);
  if (!purpose) throw new Error("say what the files are for");
  const hint = printable(input.hint, 240);
  const now = Date.now();
  const request: LocalFilesRequest = {
    id: crypto.randomUUID(),
    purpose,
    ...(hint ? { hint } : {}),
    multiple: input.multiple !== false,
    requestedAt: now,
    expiresAt: now + ttlMs,
  };
  return new Promise((resolve) => {
    const entry: Pending = {
      request,
      answering: false,
      resolve: (result) => {
        signal?.removeEventListener("abort", onAbort);
        resolve(result);
      },
      timer: setTimeout(
        () => settle(sessionId, entry, { status: "expired" }),
        ttlMs,
      ),
    };
    const onAbort = () => settle(sessionId, entry, { status: "declined" });
    pending.set(sessionId, entry);
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
    announce(sessionId, request);
  });
}

export function pendingLocalFilesRequest(
  sessionId: string,
): LocalFilesRequest | null {
  const entry = pending.get(sessionId);
  return entry && !entry.answering ? entry.request : null;
}

export class LocalFilesAnswerError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/**
 * Answer with files already uploaded to the staged uploads dir. They are
 * moved into this session's uploads folder, so the paths the agent gets are
 * its own and nothing else can hand the same file to another session.
 */
export async function answerLocalFilesRequest(
  sessionId: string,
  requestId: string,
  files: unknown,
  uploadsDir = UPLOADS_DIR,
): Promise<LocalFile[]> {
  const entry = pending.get(sessionId);
  if (!entry || entry.request.id !== requestId || entry.answering)
    throw new LocalFilesAnswerError("This request is no longer open", 409);
  if (
    !Array.isArray(files) ||
    !files.length ||
    files.length > (entry.request.multiple ? MAX_FILES : 1)
  )
    throw new LocalFilesAnswerError("Choose the files to send");
  entry.answering = true;
  try {
    const stagedRoot = await realpath(`${uploadsDir}/staged`);
    const sources: { name: string; source: string; size: number }[] = [];
    for (const file of files) {
      const name = printable(file?.name, 255);
      const path = typeof file?.path === "string" ? file.path : "";
      const source = await realpath(path).catch(() => "");
      const info = source ? await stat(source).catch(() => null) : null;
      if (
        !source.startsWith(`${stagedRoot}/`) ||
        !info?.isFile() ||
        !info.size ||
        info.size > MAX_FILE_UPLOAD_BYTES
      )
        throw new LocalFilesAnswerError(
          `${name || "A file"} is not an uploaded file`,
        );
      sources.push({ name: name || basename(source), source, size: info.size });
    }
    const dir = `${uploadsDir}/${sanitizeAttachmentName(sessionId)}/requested/${requestId}`;
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const provided: LocalFile[] = [];
    const used = new Set<string>();
    for (const { name, source, size } of sources) {
      const clean = sanitizeAttachmentName(name);
      let target = clean;
      for (let i = 2; used.has(target); i++) target = `${i}-${clean}`;
      used.add(target);
      await rename(source, `${dir}/${target}`);
      provided.push({ name, path: `${dir}/${target}`, size });
    }
    settle(sessionId, entry, { status: "provided", files: provided });
    return provided;
  } catch (error) {
    entry.answering = false;
    throw error;
  }
}

export function declineLocalFilesRequest(
  sessionId: string,
  requestId: string,
): boolean {
  const entry = pending.get(sessionId);
  if (!entry || entry.request.id !== requestId || entry.answering) return false;
  settle(sessionId, entry, { status: "declined" });
  return true;
}
