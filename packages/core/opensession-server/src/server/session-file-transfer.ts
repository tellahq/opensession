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
import { workspaceExecFor, type WorkspaceExecSession } from "./sandbox";

export type SessionFileSource = "workspace" | "assets";
type SessionFileWorkspace = WorkspaceExecSession & { id: string };

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

export interface PublishSessionFileInput {
  session: SessionFileWorkspace;
  sourcePath: string;
  destination: string;
  description?: string;
}

type MaybePromise<T> = T | Promise<T>;

interface TransferDeps {
  readAsset?: (sessionId: string, rel: string) => MaybePromise<Buffer>;
  readWorkspace?: (
    session: SessionFileWorkspace,
    rel: string,
  ) => Promise<Buffer>;
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
    /[\0\r\n]/.test(rel) ||
    rel.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(
      "file path must be a non-empty relative path without traversal",
    );
  }
  return rel;
}

async function readWorkspaceFile(
  session: SessionFileWorkspace,
  rel: string,
): Promise<Buffer> {
  if (!session.worktreeDir)
    throw new Error("the sending session has no workspace");
  const exec = await workspaceExecFor(session, session.worktreeDir);
  const resolved = await exec(["realpath", "--", ".", rel]);
  const [resolvedRoot, source, ...extra] = resolved.stdout.trim().split("\n");
  if (resolved.exitCode !== 0 || !resolvedRoot || !source || extra.length)
    throw new Error(`no readable workspace file at ${rel}`);
  const root = resolvedRoot.replace(/\/$/, "");
  if (!root || (source !== root && !source.startsWith(`${root}/`)))
    throw new Error(`workspace file escapes the session workspace: ${rel}`);

  // Read the canonical path, not the user-supplied path. Besides rejecting a
  // symlink that already points out of the workspace, this keeps a later
  // symlink swap from changing what stat and base64 inspect.
  let size = await exec(["stat", "-c", "%s", "--", source]);
  if (size.exitCode !== 0) size = await exec(["stat", "-f", "%z", source]);
  if (size.exitCode !== 0)
    throw new Error(`no readable workspace file at ${rel}`);
  const bytes = Number(size.stdout.trim());
  if (!Number.isSafeInteger(bytes) || bytes < 0)
    throw new Error(`could not determine the size of ${rel}`);
  if (bytes > MAX_WRITE_BYTES)
    throw new Error(
      `file is too large to send (${bytes} bytes > ${MAX_WRITE_BYTES})`,
    );
  // macOS base64 uses -i for its input file; GNU base64 reads the same argv as
  // "ignore garbage, then this input file". Buffer's base64 decoder accepts
  // the optional line wrapping from either implementation.
  const encoded = await exec(["base64", "-i", source]);
  if (encoded.exitCode !== 0)
    throw new Error(`could not read workspace file ${rel}`);
  const data = Buffer.from(encoded.stdout, "base64");
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

interface CopyToSessionAssetsInput {
  fromSession: SessionFileWorkspace;
  toSessionId: string;
  source: SessionFileSource;
  sourcePath: string;
  destination: (sourcePath: string) => string;
  description: (sourcePath: string) => string;
}

async function copyToSessionAssets(
  input: CopyToSessionAssetsInput,
  deps: TransferDeps,
): Promise<TransferSessionFileResult> {
  const sourcePath = safeTransferPath(input.sourcePath);
  const data =
    input.source === "assets"
      ? await (deps.readAsset || readSessionAsset)(
          input.fromSession.id,
          sourcePath,
        )
      : await (deps.readWorkspace || readWorkspaceFile)(
          input.fromSession,
          sourcePath,
        );
  const destination = safeTransferPath(input.destination(sourcePath));
  const written = await (deps.write || writeAsset)(
    input.toSessionId,
    destination,
    data,
    input.description(sourcePath),
  );
  return { path: written.path, size: written.size, source: input.source };
}

export async function publishSessionFile(
  input: PublishSessionFileInput,
  deps: Pick<TransferDeps, "readWorkspace" | "write"> = {},
): Promise<TransferSessionFileResult> {
  return copyToSessionAssets(
    {
      fromSession: input.session,
      toSessionId: input.session.id,
      source: "workspace",
      sourcePath: input.sourcePath,
      destination: () => input.destination,
      description: (sourcePath) =>
        input.description ||
        `Published from session ${input.session.id} (workspace:${sourcePath})`,
    },
    deps,
  );
}

export async function transferSessionFile(
  input: TransferSessionFileInput,
  deps: TransferDeps = {},
): Promise<TransferSessionFileResult> {
  if (input.fromSession.id === input.toSession.id)
    throw new Error("source and destination sessions must be different");
  const source = input.source || "workspace";
  return copyToSessionAssets(
    {
      fromSession: input.fromSession,
      toSessionId: input.toSession.id,
      source,
      sourcePath: input.path,
      destination: (sourcePath) =>
        input.destination ||
        `inbox/${input.fromSession.id}/${basename(sourcePath) || "attachment"}`,
      description: (sourcePath) =>
        input.description ||
        `Sent from session ${input.fromSession.id} (${source}:${sourcePath})`,
    },
    deps,
  );
}
