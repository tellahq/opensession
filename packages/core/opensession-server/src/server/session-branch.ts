import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { dirname, join } from "path";
import { findSessionAsync, touchNativeSession } from "./session-cache";
import { sessionTouchedPaths } from "./session-touched";
import { porcelainPaths } from "./git-status";
import {
  createWorktree,
  getRepo,
  isSharedCheckoutDir,
  resolveUniqueBranch,
} from "./worktree";
import { suggestBranchName } from "./suggest-branch";
import { getWorkspace, updateWorkspace } from "./workspaces";

async function git(
  dir: string,
  args: string[],
  stdin?: string,
): Promise<string> {
  const proc = Bun.spawn(["git", "-C", dir, ...args], {
    stdin: stdin === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (stdin !== undefined) {
    proc.stdin!.write(stdin);
    proc.stdin!.end();
  }
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if (code !== 0) throw new Error(stderr.trim() || `git ${args[0]} failed`);
  return stdout;
}

type UntrackedSnapshot =
  | { path: string; kind: "file"; data: Buffer; mode: number }
  | { path: string; kind: "symlink"; target: string };

interface SharedChangesSnapshot {
  patch: string;
  untracked: UntrackedSnapshot[];
  paths: string[];
}

/** Capture only dirty paths attributable to this session before changing cwd. */
async function snapshotSessionChanges(
  session: Awaited<ReturnType<typeof findSessionAsync>> & { id: string },
  dir: string,
): Promise<SharedChangesSnapshot> {
  const touched = await sessionTouchedPaths(session, dir);
  if (!touched.length) return { patch: "", untracked: [], paths: [] };
  const status = await git(dir, [
    "--literal-pathspecs",
    "status",
    "--porcelain",
    "--untracked-files=all",
    "--",
    ...touched,
  ]);
  const paths = [...new Set(porcelainPaths(status))];
  if (!paths.length) return { patch: "", untracked: [], paths: [] };
  const patch = await git(dir, [
    "--literal-pathspecs",
    "diff",
    "--binary",
    "HEAD",
    "--",
    ...paths,
  ]);
  const untrackedPaths = (
    await git(dir, [
      "--literal-pathspecs",
      "ls-files",
      "-z",
      "--others",
      "--exclude-standard",
      "--",
      ...paths,
    ])
  )
    .split("\0")
    .filter(Boolean);
  const untracked = untrackedPaths.map((path): UntrackedSnapshot => {
    const source = join(dir, path);
    const stat = lstatSync(source);
    if (stat.isSymbolicLink())
      return { path, kind: "symlink", target: readlinkSync(source) };
    return {
      path,
      kind: "file",
      data: readFileSync(source),
      mode: stat.mode,
    };
  });
  return { patch, untracked, paths };
}

async function restoreSessionChanges(
  dir: string,
  snapshot: SharedChangesSnapshot,
): Promise<void> {
  if (snapshot.patch.trim())
    await git(
      dir,
      ["apply", "--binary", "--whitespace=nowarn", "-"],
      snapshot.patch,
    );
  for (const item of snapshot.untracked) {
    const target = join(dir, item.path);
    mkdirSync(dirname(target), { recursive: true });
    if (item.kind === "symlink") symlinkSync(item.target, target);
    else {
      writeFileSync(target, item.data);
      chmodSync(target, item.mode & 0o777);
    }
  }
}

/**
 * Move one shared-checkout session into a real branch without switching the
 * live checkout. Dirty files attributed to this session are copied into the
 * new worktree and deliberately remain in the shared checkout, where removing
 * them could erase overlapping edits from another session.
 */
export async function moveSessionToBranch(
  sessionId: string,
): Promise<{ branch: string; worktreeDir: string; copiedFiles: number }> {
  const session = await findSessionAsync(sessionId);
  if (!session) throw new Error("Session not found");
  if (session.source !== "opensession")
    throw new Error("Only Open Session sessions can move to a branch");
  if (session.isRunning)
    throw new Error(
      "Stop the current turn before moving this session to a branch",
    );
  const repo = getRepo(session.repo);
  if (!repo.sharedCheckout)
    throw new Error("This session already uses an isolated worktree");
  const current = session.worktreeDir || repo.repo;
  if (!isSharedCheckoutDir(current)) {
    if (session.branch && existsSync(current))
      return {
        branch: session.branch,
        worktreeDir: current,
        copiedFiles: 0,
      };
    throw new Error("This session does not have a shared checkout to move");
  }

  const snapshot = await snapshotSessionChanges(session, current);
  const suggested =
    (await suggestBranchName(session.title || "session")) ||
    `session-${sessionId.slice(4, 10)}`;
  const branch = await resolveUniqueBranch(suggested.trim(), repo.id);
  const worktreeDir = await createWorktree(branch, repo.id, { isolated: true });
  await restoreSessionChanges(worktreeDir, snapshot);

  touchNativeSession(sessionId, {
    mode: "code",
    branch,
    worktreeDir,
    repo: repo.id,
  });
  if (session.workspaceId) {
    const workspace = getWorkspace(session.workspaceId);
    if (workspace && !workspace.worktreeDir)
      updateWorkspace(workspace.id, { branch, worktreeDir });
  }
  return {
    branch,
    worktreeDir,
    copiedFiles: snapshot.paths.length,
  };
}
