/**
 * Source acquisition and bounded execution for the vendored calldiff engine.
 * The analyzer receives frozen source bytes and never invokes package managers,
 * project code, or calldiff's CLI. Both Changes and Review use this module so
 * host worktrees, remote sandboxes, GitHub and code.storage stay consistent.
 */
import { createHash, randomUUID } from "node:crypto";
import { workerEntry } from "../runner-host/exe";
import { constants } from "node:fs";
import { open, readlink, realpath, stat as fileStat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { UnifiedSession } from "./types";
import type { Repo } from "./config";
import { getSessionDiff, parsePatchFiles, type DiffFile } from "./git-diff";
import type { PrDetails, PrDiffData } from "./pr-info";
import { workspaceExecFor, type WorkspaceExec } from "./sandbox/workspace-exec";
import { sessionTouchedPaths } from "./session-touched";
import { resolveSessionRepoContext } from "./session-repos";
import { getRepo, isSharedCheckoutDir } from "./worktree";
import { supportsCodeFlow } from "./vendor/calldiff/extract";
import type {
  CodeFlowAnalysisInput,
  CodeFlowResult,
  CodeFlowSourcePair,
} from "./code-flow-analyzer";

export type { CodeFlowResult } from "./code-flow-analyzer";

export function codeFlowHttpError(error: unknown): {
  message: string;
  status: number;
} {
  const message = error instanceof Error ? error.message : "";
  if (message === "Repo not in session") return { message, status: 404 };
  if (message.includes("busy")) return { message, status: 429 };
  if (message.includes("changed")) return { message, status: 409 };
  if (message === "The remote workspace is unavailable")
    return { message, status: 503 };
  if (message.includes("timed out")) return { message, status: 504 };
  return { message: "Couldn't analyze code flow. Try again.", status: 502 };
}

const MAX_FILES = 80;
const MAX_FILE_BYTES = 128 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024;
const MAX_PATCH_BYTES = 1024 * 1024;
const MAX_CACHE = 50;

const cache = new Map<string, CodeFlowResult>();
const snapshotCache = new Map<string, CodeFlowResult>();
const inflight = new Map<string, Promise<CodeFlowResult>>();
const fetchLocks = new Map<string, Promise<void>>();
let activeRequests = 0;

function enterRequest() {
  if (activeRequests >= 2)
    throw new Error("Code-flow analysis is busy; try again");
  activeRequests++;
}

function validPath(path: string): boolean {
  return (
    Boolean(path) &&
    !path.includes("\0") &&
    !path.startsWith("/") &&
    !path.split(/[\\/]/).includes("..")
  );
}

function remember(key: string, result: CodeFlowResult) {
  cache.delete(key);
  cache.set(key, result);
  while (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value!);
}

function rememberSnapshot(key: string, result: CodeFlowResult) {
  snapshotCache.delete(key);
  snapshotCache.set(key, result);
  while (snapshotCache.size > MAX_CACHE)
    snapshotCache.delete(snapshotCache.keys().next().value!);
}

function fingerprint(
  repo: string,
  base: string,
  head: string,
  diffVersion: string,
  pairs: CodeFlowSourcePair[],
  skipped: number,
): string {
  const hash = createHash("sha256")
    .update(repo)
    .update("\0")
    .update(base)
    .update("\0")
    .update(head)
    .update("\0")
    .update(diffVersion);
  for (const pair of pairs) {
    for (const value of [pair.oldPath, pair.path, pair.before, pair.after]) {
      const tag = value === null || value === undefined ? "missing" : "value";
      const text = value ?? "";
      hash
        .update(tag)
        .update(":")
        .update(String(Buffer.byteLength(text)))
        .update(":")
        .update(text);
    }
  }
  hash.update(`skipped:${skipped}`);
  return hash.digest("hex");
}

let workerQueue: Promise<void> = Promise.resolve();
let pendingWorkers = 0;
let analysisWorker: Worker | null = null;

function resetAnalysisWorker() {
  analysisWorker?.terminate();
  analysisWorker = null;
}

function analysisWorkerUrl(): string | URL {
  return workerEntry(
    "code-flow-worker.js",
    new URL("./code-flow-worker.ts", import.meta.url).href,
  );
}

function analyzeInWorker(
  input: CodeFlowAnalysisInput,
): Promise<CodeFlowResult> {
  if (pendingWorkers >= 2)
    return Promise.reject(new Error("Code-flow analysis is busy; try again"));
  pendingWorkers++;
  const run = workerQueue
    .catch(() => {})
    .then(
      () =>
        new Promise<CodeFlowResult>((resolveResult, reject) => {
          const worker = (analysisWorker ??= new Worker(analysisWorkerUrl()));
          let settled = false;
          const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            resetAnalysisWorker();
            reject(new Error("Code-flow analysis timed out"));
          }, 15_000);
          const done = (reset = false) => {
            if (settled) return false;
            settled = true;
            clearTimeout(timer);
            worker.onmessage = null;
            worker.onerror = null;
            if (reset) resetAnalysisWorker();
            return true;
          };
          worker.onmessage = (
            event: MessageEvent<{
              ok: boolean;
              result?: CodeFlowResult;
              error?: string;
            }>,
          ) => {
            if (!done()) return;
            if (event.data.ok && event.data.result)
              resolveResult(event.data.result);
            else
              reject(
                new Error(event.data.error || "Code-flow analysis failed"),
              );
          };
          worker.onerror = () => {
            if (!done(true)) return;
            reject(new Error("Code-flow analysis failed"));
          };
          worker.postMessage(input);
        }),
    );
  workerQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run.finally(() => pendingWorkers--);
}

async function cachedAnalysis(
  repo: string,
  base: string,
  head: string,
  diffVersion: string,
  pairs: CodeFlowSourcePair[],
  skipped: number,
  cacheable = true,
) {
  const key = fingerprint(repo, base, head, diffVersion, pairs, skipped);
  if (!cacheable)
    return analyzeInWorker({
      repo,
      base,
      head,
      diffVersion,
      pairs,
      skippedFiles: skipped,
    });
  const hit = cache.get(key);
  if (hit) return hit;
  const running = inflight.get(key);
  if (running) return running;
  const promise = analyzeInWorker({
    repo,
    base,
    head,
    diffVersion,
    pairs,
    skippedFiles: skipped,
  });
  inflight.set(key, promise);
  try {
    const result = await promise;
    remember(key, result);
    return result;
  } finally {
    inflight.delete(key);
  }
}

async function execText(
  exec: WorkspaceExec,
  args: string[],
): Promise<string | null> {
  const result = await exec(args);
  return result.exitCode === 0 ? result.stdout : null;
}

async function gitFile(
  exec: WorkspaceExec,
  ref: string,
  path: string,
  limit: number,
): Promise<string | null> {
  if (!validPath(path)) return null;
  const entry = await execText(exec, [
    "git",
    "ls-tree",
    ref,
    "--",
    `:(literal)${path}`,
  ]);
  if (!entry || !/^100(?:644|755) blob /.test(entry)) return null;
  const sizeText = await execText(exec, [
    "git",
    "cat-file",
    "-s",
    `${ref}:${path}`,
  ]);
  const size = Number(sizeText?.trim());
  if (!Number.isFinite(size) || size > limit) return null;
  return execText(exec, ["git", "show", `${ref}:${path}`]);
}

const REMOTE_BOUNDED_READ = String.raw`
import { constants } from "node:fs";
import { open, readlink, realpath, stat as fileStat } from "node:fs/promises";
import { resolve, sep } from "node:path";
const [path, rawLimit] = process.argv.slice(1);
const limit = Number(rawLimit);
let handle;
try {
  const root = await realpath(".");
  const prefix = root.endsWith(sep) ? root : root + sep;
  const target = await realpath(resolve(root, path));
  if (!target.startsWith(prefix)) throw new Error("outside workspace");
  handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  const descriptor = await readlink("/proc/self/fd/" + handle.fd);
  const canonical = await realpath(descriptor);
  const [opened, current] = await Promise.all([handle.stat(), fileStat(canonical)]);
  if (!opened.isFile() || opened.size > limit || opened.dev !== current.dev || opened.ino !== current.ino || !canonical.startsWith(prefix))
    throw new Error("invalid file");
  const buffer = Buffer.alloc(limit + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
    if (!bytesRead) break;
    offset += bytesRead;
  }
  if (offset > limit) throw new Error("file grew");
  process.stdout.write(buffer.subarray(0, offset));
} catch {
  process.exitCode = 2;
} finally {
  await handle?.close();
}`;

async function worktreeFile(
  exec: WorkspaceExec,
  root: string,
  path: string,
  limit: number,
  canonicalRoot?: string,
): Promise<string | null> {
  if (!validPath(path)) return null;
  if (exec.remote) {
    return execText(exec, [
      "/home/ubuntu/.bun/bin/bun",
      "-e",
      REMOTE_BOUNDED_READ,
      path,
      String(limit),
    ]);
  }
  const full = resolve(root, path);
  const resolvedRoot =
    canonicalRoot ?? (await realpath(root).catch(() => resolve(root)));
  const prefix = resolvedRoot.endsWith(sep)
    ? resolvedRoot
    : `${resolvedRoot}${sep}`;
  const preCanonical = await realpath(full).catch(() => "");
  if (!preCanonical.startsWith(prefix)) return null;
  const handle = await open(
    preCanonical,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  ).catch(() => null);
  if (!handle) return null;
  try {
    const [stat, descriptorPath] = await Promise.all([
      handle.stat(),
      readlink(`/proc/self/fd/${handle.fd}`).catch(() =>
        readlink(`/dev/fd/${handle.fd}`).catch(() => ""),
      ),
    ]);
    const canonicalFile = descriptorPath
      ? await realpath(descriptorPath).catch(() => "")
      : await realpath(preCanonical).catch(() => "");
    const current = canonicalFile
      ? await fileStat(canonicalFile).catch(() => null)
      : null;
    if (
      !stat.isFile() ||
      stat.size > limit ||
      !current ||
      current.dev !== stat.dev ||
      current.ino !== stat.ino ||
      !canonicalFile.startsWith(prefix)
    )
      return null;
    const buffer = Buffer.alloc(limit + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        buffer.length - offset,
        null,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return offset <= limit ? buffer.subarray(0, offset).toString("utf8") : null;
  } finally {
    await handle.close();
  }
}

function eligible(files: Array<Pick<DiffFile, "path" | "oldPath" | "status">>) {
  return files.filter(
    (file) =>
      validPath(file.path) &&
      (!file.oldPath || validPath(file.oldPath)) &&
      (supportsCodeFlow(file.path) ||
        Boolean(file.oldPath && supportsCodeFlow(file.oldPath))),
  );
}

async function readPairs(
  files: Array<Pick<DiffFile, "path" | "oldPath" | "status">>,
  readBefore: (path: string, limit: number) => Promise<string | null>,
  readAfter: (path: string, limit: number) => Promise<string | null>,
): Promise<{ pairs: CodeFlowSourcePair[]; skipped: number }> {
  const candidates = eligible(files);
  let skipped = Math.max(0, candidates.length - MAX_FILES);
  let total = 0;
  const pairs: CodeFlowSourcePair[] = [];
  for (const file of candidates.slice(0, MAX_FILES)) {
    const needsBefore = file.status !== "added" && file.status !== "untracked";
    const needsAfter = file.status !== "deleted";
    let remaining = MAX_TOTAL_BYTES - total;
    const before = needsBefore
      ? await readBefore(
          file.oldPath ?? file.path,
          Math.min(MAX_FILE_BYTES, remaining),
        )
      : null;
    remaining -= Buffer.byteLength(before ?? "");
    const after = needsAfter
      ? await readAfter(file.path, Math.min(MAX_FILE_BYTES, remaining))
      : null;
    if ((needsBefore && before === null) || (needsAfter && after === null)) {
      skipped++;
      continue;
    }
    const bytes =
      Buffer.byteLength(before ?? "") + Buffer.byteLength(after ?? "");
    if (
      (!before && !after) ||
      before?.includes("\0") ||
      after?.includes("\0")
    ) {
      skipped++;
      continue;
    }
    total += bytes;
    pairs.push({ path: file.path, oldPath: file.oldPath, before, after });
  }
  return { pairs, skipped };
}

export async function sessionCodeFlow(
  session: UnifiedSession,
  repoId?: string,
): Promise<CodeFlowResult> {
  enterRequest();
  try {
    const context = resolveSessionRepoContext(session, repoId);
    if (!context) throw new Error("Repo not in session");
    const repo = getRepo(context.repo);
    const exec = await workspaceExecFor(
      context.primary ? session : null,
      context.dir,
    );
    const canonicalRoot = exec.remote
      ? undefined
      : await realpath(context.dir).catch(() => resolve(context.dir));
    const ownPaths = isSharedCheckoutDir(context.dir)
      ? await sessionTouchedPaths(session, context.dir)
      : undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      const diff = await getSessionDiff(
        context.dir,
        repo.defaultBranch,
        exec,
        false,
        MAX_PATCH_BYTES,
        ownPaths,
      );
      if (!diff.baseRef && exec.remote)
        throw new Error("The remote workspace is unavailable");
      const version = diff.diffVersion;
      const snapshotKey = `${context.repo}\0${diff.baseRef ?? "empty repository"}\0working tree\0${version}`;
      const cached = !diff.truncated && snapshotCache.get(snapshotKey);
      if (cached) return cached;
      const { pairs, skipped } = await readPairs(
        parsePatchFiles(diff.rawPatch),
        diff.baseRef
          ? (path, limit) => gitFile(exec, diff.baseRef!, path, limit)
          : async () => null,
        (path, limit) =>
          worktreeFile(exec, context.dir, path, limit, canonicalRoot),
      );
      const verified = await getSessionDiff(
        context.dir,
        repo.defaultBranch,
        exec,
        true,
        MAX_PATCH_BYTES,
        ownPaths,
      );
      if (verified.diffVersion !== version) continue;
      const result = await cachedAnalysis(
        context.repo,
        diff.baseRef ?? "empty repository",
        "working tree",
        version,
        pairs,
        skipped + Number(Boolean(diff.truncated)),
        !diff.truncated,
      );
      if (!diff.truncated) rememberSnapshot(snapshotKey, result);
      return result;
    }
    throw new Error(
      "The workspace changed during code-flow analysis; try again",
    );
  } finally {
    activeRequests--;
  }
}

async function git(dir: string, args: string[]): Promise<string> {
  const child = Bun.spawn(["git", "-C", dir, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...processEnvWithoutPrompts(), GIT_TERMINAL_PROMPT: "0" },
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, 20_000);
  let stdout: string;
  let code: number;
  try {
    [stdout, , code] = await Promise.all([
      readBounded(child.stdout, 8 * 1024 * 1024, () => child.kill()),
      readBounded(child.stderr, 64 * 1024, () => child.kill()),
      child.exited,
    ]);
  } finally {
    clearTimeout(timer);
  }
  if (timedOut || code !== 0)
    throw new Error(
      timedOut ? "Git snapshot timed out" : "Git snapshot unavailable",
    );
  return stdout.trim();
}

async function readBounded(
  stream: ReadableStream<Uint8Array>,
  limit: number,
  abort: () => void,
): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      abort();
      throw new Error("Git snapshot output exceeded its limit");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function processEnvWithoutPrompts(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

async function ensurePrObjects(
  repo: Repo,
  details: PrDetails,
  diff: PrDiffData,
) {
  const namespace = randomUUID();
  const baseRef = `refs/opensession/code-flow/${namespace}/base`;
  const headRef = `refs/opensession/code-flow/${namespace}/head`;
  try {
    const previous = fetchLocks.get(repo.id) ?? Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(async () => {
        const headSpec =
          repo.host === "codestorage"
            ? `+refs/heads/${details.headRefName}:${headRef}`
            : `+refs/pull/${details.number}/head:${headRef}`;
        await git(repo.repo, [
          "fetch",
          "--quiet",
          "--no-tags",
          "--no-write-fetch-head",
          "origin",
          `+refs/heads/${details.baseRefName}:${baseRef}`,
          headSpec,
        ]);
        const fetchedHead = await git(repo.repo, ["rev-parse", headRef]);
        if (fetchedHead !== diff.headRefOid)
          throw new Error("Pull request changed during code-flow analysis");
        if (diff.baseRefOid) {
          const fetchedBase = await git(repo.repo, ["rev-parse", baseRef]);
          if (fetchedBase !== diff.baseRefOid) {
            await git(repo.repo, [
              "fetch",
              "--quiet",
              "--no-tags",
              "--no-write-fetch-head",
              "origin",
              `+${diff.baseRefOid}:${baseRef}`,
            ]);
          }
        }
      });
    fetchLocks.set(repo.id, next);
    try {
      await next;
    } finally {
      if (fetchLocks.get(repo.id) === next) fetchLocks.delete(repo.id);
    }
    const head = diff.headRefOid;
    const fetchedBase = await git(repo.repo, ["rev-parse", baseRef]);
    const baseTip = diff.baseRefOid || fetchedBase;
    await git(repo.repo, ["cat-file", "-e", `${baseTip}^{commit}`]);
    const base = await git(repo.repo, ["merge-base", baseTip, head]);
    return { base, head, baseRef, headRef };
  } catch (error) {
    await Promise.all([
      git(repo.repo, ["update-ref", "-d", baseRef]).catch(() => {}),
      git(repo.repo, ["update-ref", "-d", headRef]).catch(() => {}),
    ]);
    throw error;
  }
}

function boundedPatch(patch: string): { patch: string; skipped: number } {
  if (Buffer.byteLength(patch) <= MAX_PATCH_BYTES) return { patch, skipped: 0 };
  const prefix = patch.slice(0, MAX_PATCH_BYTES);
  const boundary = prefix.lastIndexOf("\ndiff --git ");
  return {
    patch: boundary > 0 ? prefix.slice(0, boundary + 1) : "",
    skipped: 1,
  };
}

export async function prCodeFlow(
  repo: Repo,
  details: PrDetails,
  diff: PrDiffData,
): Promise<CodeFlowResult> {
  enterRequest();
  let refs: Awaited<ReturnType<typeof ensurePrObjects>> | null = null;
  try {
    const version =
      diff.diffVersion ??
      createHash("sha256").update(diff.patch).digest("base64url");
    const snapshotKey = `${repo.id}\0${diff.baseRefOid ?? details.baseRefName}\0${diff.headRefOid}\0${version}`;
    refs = await ensurePrObjects(repo, details, diff);
    const cached = !diff.skippedFiles && snapshotCache.get(snapshotKey);
    if (cached) return cached;
    const exec = await workspaceExecFor(null, repo.repo);
    const bounded = boundedPatch(diff.patch);
    const incomplete = Boolean(bounded.skipped || diff.skippedFiles);
    const { pairs, skipped } = await readPairs(
      parsePatchFiles(bounded.patch),
      (path, limit) => gitFile(exec, refs!.base, path, limit),
      (path, limit) => gitFile(exec, refs!.head, path, limit),
    );
    const result = await cachedAnalysis(
      repo.id,
      refs.base,
      refs.head,
      version,
      pairs,
      skipped + bounded.skipped + (diff.skippedFiles ?? 0),
      !incomplete,
    );
    if (!incomplete) rememberSnapshot(snapshotKey, result);
    return result;
  } finally {
    if (refs) {
      await Promise.all([
        git(repo.repo, ["update-ref", "-d", refs.baseRef]).catch(() => {}),
        git(repo.repo, ["update-ref", "-d", refs.headRef]).catch(() => {}),
      ]);
    }
    activeRequests--;
  }
}
