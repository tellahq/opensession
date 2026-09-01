/**
 * Binary-safe file delivery between agent sessions.
 *
 * A sender may copy a file from its own workspace (including a volume-only
 * sandbox) or its own Assets folder into the recipient's Assets inbox. The
 * server owns the copy boundary: paths are relative, traversal is rejected,
 * size is checked before content is read, and no provider credentials or
 * arbitrary host paths cross sessions.
 */

import { basename } from "node:path";
import { MAX_WRITE_BYTES, readAssetAcross, writeAsset } from "./session-assets";
import { sessionIdsForAsync } from "./session-cache";
import type { SessionSummary } from "./session-control";
import { workspaceExecFor } from "./sandbox";

export type SessionFileSource = "workspace" | "assets";

export interface TransferSessionFileInput {
  fromSession: SessionSummary;
  toSession: SessionSummary;
  path: string;
  source?: SessionFileSource;
  destination?: string;
  description?: string;
}

export interface TransferSessionFileResult {
  path: string;
  size: number;
  source: SessionFileSource;
}

type MaybePromise<T> = T | Promise<T>;

interface TransferDeps {
  readAsset?: (sessionId: string, rel: string) => MaybePromise<Buffer>;
  readWorkspace?: (session: SessionSummary, rel: string) => Promise<Buffer>;
  write?: (
    sessionId: string,
    rel: string,
    data: Buffer,
    description?: string,
  ) => MaybePromise<{ path: string; size: number }>;
}

export function safeTransferPath(path: string): string {
  const rel = String(path || "")
    .trim()
    .replace(/^\.\//, "");
  if (
    !rel ||
    rel.startsWith("/") ||
    rel.includes("\\") ||
    rel.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(
      "file path must be a non-empty relative path without traversal",
    );
  }
  return rel;
}

async function readWorkspaceFile(
  session: SessionSummary,
  rel: string,
): Promise<Buffer> {
  if (!session.worktreeDir)
    throw new Error("the sending session has no workspace");
  const exec = await workspaceExecFor(session, session.worktreeDir);
  const size = await exec(["stat", "-c", "%s", "--", rel]);
  if (size.exitCode !== 0)
    throw new Error(`no readable workspace file at ${rel}`);
  const bytes = Number(size.stdout.trim());
  if (!Number.isSafeInteger(bytes) || bytes < 0)
    throw new Error(`could not determine the size of ${rel}`);
  if (bytes > MAX_WRITE_BYTES)
    throw new Error(
      `file is too large to send (${bytes} bytes > ${MAX_WRITE_BYTES})`,
    );
  const encoded = await exec(["base64", "-w0", "--", rel]);
  if (encoded.exitCode !== 0)
    throw new Error(`could not read workspace file ${rel}`);
  const data = Buffer.from(encoded.stdout.trim(), "base64");
  if (data.byteLength !== bytes)
    throw new Error(`workspace file changed while it was being sent: ${rel}`);
  return data;
}

async function readSessionAsset(
  sessionId: string,
  rel: string,
): Promise<Buffer> {
  const found = await readAssetAcross(await sessionIdsForAsync(sessionId), rel);
  if (!found) throw new Error(`no asset at ${rel}`);
  if (found.data.byteLength > MAX_WRITE_BYTES)
    throw new Error(
      `file is too large to send (${found.data.byteLength} bytes > ${MAX_WRITE_BYTES})`,
    );
  return found.data;
}

export async function transferSessionFile(
  input: TransferSessionFileInput,
  deps: TransferDeps = {},
): Promise<TransferSessionFileResult> {
  if (input.fromSession.id === input.toSession.id)
    throw new Error("source and destination sessions must be different");
  const source = input.source || "workspace";
  const rel = safeTransferPath(input.path);
  const data =
    source === "assets"
      ? await (deps.readAsset || readSessionAsset)(input.fromSession.id, rel)
      : await (deps.readWorkspace || readWorkspaceFile)(input.fromSession, rel);
  const destination = safeTransferPath(
    input.destination ||
      `inbox/${input.fromSession.id}/${basename(rel) || "attachment"}`,
  );
  const description =
    input.description ||
    `Sent from session ${input.fromSession.id} (${source}:${rel})`;
  const written = await (deps.write || writeAsset)(
    input.toSession.id,
    destination,
    data,
    description,
  );
  return { path: written.path, size: written.size, source };
}
