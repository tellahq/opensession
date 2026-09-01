/**
 * Live git diff for a session's worktree, Devin-style "Changes" tab.
 * Diff is computed against the merge-base with origin/main so it shows
 * exactly what the session has changed, committed or not.
 *
 * rawPatch is the full unified patch (including synthesized entries for
 * untracked files) — rendered client-side by @pierre/diffs. files[] only
 * carries per-file stats for the summary row.
 *
 * Sandbox-aware (docs/sandboxes-plan.md Phase 2): callers may pass a
 * WorkspaceExec (workspaceExecFor) so every git command — and, for
 * `exec.remote` (volume-mode) workspaces, the untracked-file reads and the
 * discard deletions too — runs inside the session's sandbox. Omitted = the
 * host path, unchanged.
 */
import { $ } from "bun";
import { createHash } from "node:crypto";
import { readFileSync, statSync, rmSync } from "fs";
import { join } from "path";
import type { WorkspaceExec } from "./sandbox/workspace-exec";

/** `git -C <dir> <args>` on the host (Bun $) or through the workspace exec.
 *  Throws on non-zero exit — matching Bun $'s .text() behavior that every
 *  call site here already wraps in try/catch. */
async function gitText(
  dir: string,
  args: string[],
  exec?: WorkspaceExec,
): Promise<string> {
  const argv = ["git", "-C", dir, ...args];
  if (exec) {
    const r = await exec(argv, { timeoutMs: DIFF_TIMEOUT_MS });
    if (r.exitCode !== 0)
      throw new Error(r.stderr.trim() || `git ${args[0]} failed`);
    return r.stdout;
  }
  return await $`${argv}`.quiet().text();
}

async function readPrefix(
  stream: ReadableStream<Uint8Array>,
  limit: number,
  abort: () => void,
): Promise<{ text: string; truncated: boolean }> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const remaining = limit + 1 - size;
    if (remaining > 0) chunks.push(value.subarray(0, remaining));
    size += value.byteLength;
    if (size > limit) {
      truncated = true;
      abort();
      break;
    }
  }
  return {
    text: Buffer.concat(chunks).subarray(0, limit).toString("utf8"),
    truncated,
  };
}

async function gitTextPrefix(
  dir: string,
  args: string[],
  limit: number,
  exec?: WorkspaceExec,
): Promise<{ text: string; truncated: boolean }> {
  const argv = ["git", "-C", dir, ...args];
  if (exec) {
    // WorkspaceExec buffers command output, so cap it inside the sandbox.
    const result = await exec(
      [
        "bash",
        "-o",
        "pipefail",
        "-c",
        'limit="$1"; shift; "$@" | head -c "$limit"',
        "bash",
        String(limit + 1),
        ...argv,
      ],
      { timeoutMs: DIFF_TIMEOUT_MS },
    );
    const bytes = Buffer.from(result.stdout);
    if (result.exitCode !== 0 && bytes.byteLength <= limit)
      throw new Error(result.stderr.trim() || `git ${args[0]} failed`);
    return {
      text: bytes.subarray(0, limit).toString("utf8"),
      truncated: bytes.byteLength > limit,
    };
  }
  const child = Bun.spawn(argv, {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: DIFF_TIMEOUT_MS,
  });
  const [output, stderr] = await Promise.all([
    readPrefix(child.stdout, limit, () => child.kill()),
    readPrefix(child.stderr, 64 * 1024, () => child.kill()),
  ]);
  const code = await child.exited;
  if (code !== 0 && !output.truncated)
    throw new Error(stderr.text.trim() || `git ${args[0]} failed`);
  return output;
}

export interface DiffFile {
  path: string;
  oldPath?: string;
  status: "added" | "modified" | "deleted" | "renamed" | "untracked";
  additions: number;
  deletions: number;
  binary?: boolean;
}

export interface SessionDiff {
  branch: string | null;
  baseRef: string | null;
  files: DiffFile[];
  totalAdditions: number;
  totalDeletions: number;
  rawPatch: string;
  /** SHA-256 identity of the exact patch sent to the browser. */
  diffVersion: string;
  truncated?: boolean;
}

export class SessionDiffTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Git diff timed out after ${timeoutMs}ms`);
    this.name = "SessionDiffTimeoutError";
  }
}

const MAX_RAW_PATCH = 600_000; // chars — keep huge diffs from flooding the browser
const MAX_UNTRACKED_BYTES = 60_000;
const DIFF_TIMEOUT_MS = 30_000;
const g = globalThis as any;
const inflightDiffs: Map<
  string,
  Promise<SessionDiff>
> = (g.__sessionDiffInflight ??= new Map());

/**
 * Merge-base of the worktree's HEAD with the base branch — the ref the
 * "Changes" diff is computed against. Tries the project default branch first
 * (e.g. gstreamer uses `tla_main`), then falls back to main so older
 * single-repo sessions keep working.
 */
async function resolveMergeBase(
  worktreeDir: string,
  baseBranch: string,
  exec?: WorkspaceExec,
): Promise<string | null> {
  const candidates = [
    `origin/${baseBranch}`,
    baseBranch,
    ...(baseBranch === "main" ? [] : ["origin/main", "main"]),
  ];
  for (const ref of candidates) {
    try {
      const base = (
        await gitText(worktreeDir, ["merge-base", ref, "HEAD"], exec)
      ).trim();
      if (base) return base;
    } catch {}
  }
  return null;
}

async function computeSessionDiff(
  worktreeDir: string,
  baseBranch = "main",
  exec?: WorkspaceExec,
  patchLimit?: number,
  paths?: string[],
): Promise<SessionDiff> {
  const base = await resolveMergeBase(worktreeDir, baseBranch, exec);
  const scopedPaths =
    paths === undefined ? undefined : [...new Set(paths)].sort();
  const pathspec = scopedPaths?.length ? ["--", ...scopedPaths] : [];

  let branch: string | null = null;
  try {
    branch =
      (await gitText(worktreeDir, ["branch", "--show-current"], exec)).trim() ||
      null;
  } catch {}

  const files: DiffFile[] = [];
  let rawPatch = "";
  let truncated = false;

  // Stats per file (additions/deletions, "-" for binary)
  const stats = new Map<
    string,
    { add: number; del: number; binary: boolean }
  >();
  if (base && scopedPaths?.length !== 0) {
    try {
      const numstat = await gitText(
        worktreeDir,
        [
          "--literal-pathspecs",
          "-c",
          "core.quotePath=false",
          "diff",
          "--numstat",
          base,
          ...pathspec,
        ],
        exec,
      );
      for (const line of numstat.split("\n")) {
        if (!line.trim()) continue;
        const [add, del, ...rest] = line.split("\t");
        const path = rest.join("\t");
        if (!path) continue;
        stats.set(path, {
          add: add === "-" ? 0 : parseInt(add!) || 0,
          del: del === "-" ? 0 : parseInt(del!) || 0,
          binary: add === "-",
        });
      }
    } catch {}

    try {
      const output = await gitTextPrefix(
        worktreeDir,
        [
          "--literal-pathspecs",
          "-c",
          "core.quotePath=false",
          "diff",
          base,
          ...pathspec,
        ],
        Math.min(patchLimit ?? MAX_RAW_PATCH, MAX_RAW_PATCH),
        exec,
      );
      rawPatch = output.text;
      if (output.truncated) {
        const boundary = rawPatch.lastIndexOf("\ndiff --git ");
        rawPatch = boundary > 0 ? rawPatch.slice(0, boundary + 1) : "";
        truncated = true;
      }
      files.push(...parsePatchStats(rawPatch, stats));
    } catch {}
  }

  // Untracked files as synthetic all-added patch entries
  if (scopedPaths?.length !== 0) {
    try {
      const untracked = (
        await gitText(
          worktreeDir,
          [
            "-c",
            "core.quotePath=false",
            "--literal-pathspecs",
            "ls-files",
            "-z",
            "--others",
            "--exclude-standard",
            ...pathspec,
          ],
          exec,
        )
      )
        .split("\0")
        .filter(Boolean);

      for (const path of untracked) {
        const full = `${worktreeDir}/${path}`;
        try {
          // Volume-mode workspaces have no host copy — read size/content through
          // the sandbox exec. Host-visible workspaces keep the direct fs reads.
          let size: number;
          let readContent: () => Promise<string>;
          if (exec?.remote) {
            const st = await exec(["stat", "-c", "%s", "--", path], {
              timeoutMs: DIFF_TIMEOUT_MS,
            });
            size = st.exitCode === 0 ? parseInt(st.stdout.trim(), 10) : NaN;
            if (!Number.isFinite(size)) continue;
            readContent = async () => {
              const r = await exec(["cat", "--", path], {
                timeoutMs: DIFF_TIMEOUT_MS,
              });
              if (r.exitCode !== 0)
                throw new Error(r.stderr.trim() || `cat ${path} failed`);
              return r.stdout;
            };
          } else {
            size = statSync(full).size;
            readContent = async () => readFileSync(full, "utf-8");
          }
          if (size > MAX_UNTRACKED_BYTES) {
            files.push({
              path,
              status: "untracked",
              additions: 0,
              deletions: 0,
            });
            truncated = true;
            continue;
          }
          const content = await readContent();
          if (content.includes("\0")) {
            files.push({
              path,
              status: "untracked",
              additions: 0,
              deletions: 0,
              binary: true,
            });
            truncated = true;
            continue;
          }
          const lines = content.split("\n");
          if (lines[lines.length - 1] === "") lines.pop();
          files.push({
            path,
            status: "untracked",
            additions: lines.length,
            deletions: 0,
          });
          rawPatch +=
            `diff --git a/${path} b/${path}\n` +
            `new file mode 100644\n` +
            `--- /dev/null\n` +
            `+++ b/${path}\n` +
            `@@ -0,0 +1,${lines.length} @@\n` +
            lines.map((l) => `+${l}`).join("\n") +
            "\n";
        } catch {}
      }
    } catch {}
  }

  if (rawPatch.length > MAX_RAW_PATCH) {
    // Cut at a file boundary so the renderer never sees a torn patch
    const cut = rawPatch.lastIndexOf("\ndiff --git ", MAX_RAW_PATCH);
    rawPatch =
      cut > 0 ? rawPatch.slice(0, cut + 1) : rawPatch.slice(0, MAX_RAW_PATCH);
    truncated = true;
  }

  return {
    branch,
    baseRef: base,
    files,
    totalAdditions: files.reduce((n, f) => n + f.additions, 0),
    totalDeletions: files.reduce((n, f) => n + f.deletions, 0),
    rawPatch,
    diffVersion: createHash("sha256").update(rawPatch).digest("base64url"),
    truncated: truncated || undefined,
  };
}

export function getSessionDiff(
  worktreeDir: string,
  baseBranch = "main",
  exec?: WorkspaceExec,
  fresh = false,
  patchLimit?: number,
  paths?: string[],
  timeoutMs = DIFF_TIMEOUT_MS,
): Promise<SessionDiff> {
  const scopedPaths =
    paths === undefined ? undefined : [...new Set(paths)].sort();
  const pathKey = scopedPaths === undefined ? "all" : scopedPaths.join("\0");
  const compute = () => {
    const work = computeSessionDiff(
      worktreeDir,
      baseBranch,
      exec,
      patchLimit,
      scopedPaths,
    );
    let timer: ReturnType<typeof setTimeout>;
    const bounded = new Promise<SessionDiff>((resolve, reject) => {
      timer = setTimeout(
        () => reject(new SessionDiffTimeoutError(timeoutMs)),
        timeoutMs,
      );
      work.then(resolve, reject);
    });
    return { work, bounded: bounded.finally(() => clearTimeout(timer)) };
  };
  if (fresh) return compute().bounded;
  const key = `${worktreeDir}\0${baseBranch}\0${exec?.remote ? "remote" : "host"}\0${patchLimit ?? "full"}\0${pathKey}`;
  const running = inflightDiffs.get(key);
  if (running) return running;

  const { work, bounded: diff } = compute();
  inflightDiffs.set(key, diff);
  const clear = () => {
    if (inflightDiffs.get(key) === diff) inflightDiffs.delete(key);
  };
  void work.then(clear, clear);
  return diff;
}

/**
 * Discard one file's changes in a session worktree, so it drops out of the
 * "Changes" diff (which is computed against the merge-base). This resets the
 * file to its base-branch state — covering both committed and uncommitted work:
 *   - a file that exists at base (modified / deleted-on-branch) is checked out
 *     from base into the index + worktree;
 *   - a file added on the branch (tracked or untracked) is removed.
 * Renames pass `oldPath` so the original path is restored too.
 *
 * Destructive and irreversible — the caller gates it on user intent.
 */
export async function discardSessionFile(
  worktreeDir: string,
  baseBranch: string,
  path: string,
  oldPath?: string,
  exec?: WorkspaceExec,
): Promise<void> {
  for (const p of [path, oldPath]) {
    if (!p) continue;
    // Refuse anything that could escape the worktree.
    if (p.startsWith("/") || p.split("/").includes("..")) {
      throw new Error(`Refusing to discard unsafe path: ${p}`);
    }
  }

  const base = await resolveMergeBase(worktreeDir, baseBranch, exec);
  const src = base || "HEAD";

  const restore = async (p: string) => {
    let existsAtBase = false;
    try {
      await gitText(worktreeDir, ["cat-file", "-e", `${src}:${p}`], exec);
      existsAtBase = true;
    } catch {}

    if (existsAtBase) {
      // Reset index + worktree to the base version — the file vanishes from the diff.
      await gitText(worktreeDir, ["checkout", src, "--", p], exec);
    } else {
      // Added on the branch (tracked commit or untracked): drop it entirely.
      try {
        await gitText(
          worktreeDir,
          ["rm", "-f", "--ignore-unmatch", "--", p],
          exec,
        );
      } catch {}
      try {
        if (exec?.remote) await exec(["rm", "-f", "--", p]);
        else rmSync(join(worktreeDir, p), { force: true });
      } catch {}
    }
  };

  await restore(path);
  if (oldPath && oldPath !== path) await restore(oldPath);
}

function parsePatchStats(
  patch: string,
  stats: Map<string, { add: number; del: number; binary: boolean }>,
): DiffFile[] {
  const files: DiffFile[] = [];
  const sections = patch.split(/^diff --git /m).filter((s) => s.trim());

  for (const section of sections) {
    const headerLine = section.split("\n")[0] || "";
    const m = headerLine.match(/^"?a\/(.+?)"? "?b\/(.+?)"?$/);
    const oldPath = m?.[1] || "";
    const newPath = m?.[2] || oldPath;

    let status: DiffFile["status"] = "modified";
    if (/^new file mode /m.test(section)) status = "added";
    else if (/^deleted file mode /m.test(section)) status = "deleted";
    else if (/^rename from /m.test(section)) status = "renamed";

    const path = status === "deleted" ? oldPath : newPath;
    const stat = stats.get(path) || { add: 0, del: 0, binary: false };

    files.push({
      path,
      oldPath: status === "renamed" ? oldPath : undefined,
      status,
      additions: stat.add,
      deletions: stat.del,
      binary: stat.binary || /^Binary files /m.test(section) || undefined,
    });
  }
  return files;
}

/** File records represented by a unified patch, independent of repository state. */
export function parsePatchFiles(patch: string): DiffFile[] {
  return parsePatchStats(patch, new Map());
}
