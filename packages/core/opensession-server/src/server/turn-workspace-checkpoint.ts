import { copyFile, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/;
export const TURN_CHECKPOINT_LIMIT = 50;
export interface TurnCheckpointInput {
  cwd: string;
  sessionId: string;
  turnId: string;
}
export interface TurnConversationAnchor {
  engineId: string;
  file: string;
  leafId: string | null;
}
interface CheckpointMetadata {
  version: 1;
  createdAt: number;
  head: string;
  branch: string;
  indexHash: string;
  indexTree: string;
  conversation?: TurnConversationAnchor;
}
function namespace(sessionId: string): string {
  if (!ID.test(sessionId)) throw new Error("Invalid checkpoint session id");
  return `refs/opensession/turns/${sessionId}/`;
}
export function turnCheckpointRef(
  sessionId: string,
  turnId: string,
  phase: "before" | "after",
): string {
  if (!ID.test(turnId)) throw new Error("Invalid checkpoint turn id");
  return `${namespace(sessionId)}${phase}/${turnId}`;
}
/** Async only. Do not inherit repository/index overrides from a launcher. */
async function git(
  cwd: string,
  args: string[],
  index?: string,
  input?: string,
): Promise<string> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  const child = Bun.spawn(["git", "-C", cwd, ...args], {
    env: {
      ...env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: "Open Session",
      GIT_AUTHOR_EMAIL: "opensession@localhost",
      GIT_COMMITTER_NAME: "Open Session",
      GIT_COMMITTER_EMAIL: "opensession@localhost",
      ...(index ? { GIT_INDEX_FILE: index } : {}),
    },
    stdin: input === undefined ? "ignore" : new TextEncoder().encode(input),
    stdout: "pipe",
    stderr: "pipe",
    timeout: 30_000,
  });
  const boundedText = async (
    stream: ReadableStream<Uint8Array>,
  ): Promise<string> => {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > 4 * 1024 * 1024) {
        child.kill();
        throw new Error("Checkpoint output exceeds the 4 MiB limit");
      }
      chunks.push(next.value);
    }
    return Buffer.concat(chunks).toString();
  };
  const [stdout, stderr, exitCode] = await Promise.all([
    boundedText(child.stdout),
    boundedText(child.stderr),
    child.exited,
  ]);
  if (exitCode !== 0)
    throw new Error(
      `Checkpoint git operation failed: ${stderr.trim().slice(0, 400)}`,
    );
  return stdout;
}
export async function turnWorkspaceFence(
  cwd: string,
): Promise<{ head: string; indexTree: string }> {
  const dir = await mkdtemp(join(tmpdir(), "opensession-index-fence-"));
  try {
    const source = (
      await git(cwd, [
        "rev-parse",
        "--path-format=absolute",
        "--git-path",
        "index",
      ])
    ).trim();
    const index = join(dir, "index");
    await copyFile(source, index);
    return {
      head: (await git(cwd, ["rev-parse", "HEAD"])).trim(),
      indexTree: (await git(cwd, ["write-tree"], index)).trim(),
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function indexHash(cwd: string): Promise<string> {
  const path = (
    await git(cwd, [
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "index",
    ])
  ).trim();
  return new Bun.CryptoHasher("sha256")
    .update(await readFile(path))
    .digest("hex");
}
async function withSnapshotIndex<T>(
  cwd: string,
  operation: (index: string, tree: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "opensession-turn-"));
  const index = join(dir, "index");
  try {
    const source = (
      await git(cwd, [
        "rev-parse",
        "--path-format=absolute",
        "--git-path",
        "index",
      ])
    ).trim();
    // Reuse stat data. Sparse/assume-unchanged indexes would hide edits.
    const flags = await git(cwd, ["ls-files", "-v"]);
    if (/^[a-zS]/m.test(flags)) await git(cwd, ["read-tree", "HEAD"], index);
    else await copyFile(source, index);
    await git(cwd, ["add", "-A", "--", "."], index);
    const tree = (await git(cwd, ["write-tree"], index)).trim();
    if (/^160000 /m.test(await git(cwd, ["ls-tree", "-r", tree])))
      throw new Error(
        "Turn checkpoints do not support nested repositories or submodules",
      );
    return await operation(index, tree);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
export async function captureTurnWorkspace(
  input: TurnCheckpointInput,
  phase: "before" | "after",
  conversation?: TurnConversationAnchor,
  prune = true,
): Promise<void> {
  const { cwd, sessionId, turnId } = input;
  if (
    (await realpath(cwd)) !==
    (await realpath((await git(cwd, ["rev-parse", "--show-toplevel"])).trim()))
  )
    throw new Error("Turn checkpoints require the worktree root");
  const ref = turnCheckpointRef(sessionId, turnId, phase);
  // Retries must not replace the original pre-turn state.
  if (
    (await git(cwd, ["for-each-ref", "--format=%(refname)", ref]))
      .trim()
      .split("\n")
      .includes(ref)
  )
    return;
  const head = (await git(cwd, ["rev-parse", "HEAD"])).trim();
  const metadata: CheckpointMetadata = {
    version: 1,
    createdAt: Date.now(),
    head,
    branch: (await git(cwd, ["symbolic-ref", "--short", "HEAD"])).trim(),
    indexHash: await indexHash(cwd),
    indexTree: (await turnWorkspaceFence(cwd)).indexTree,
    ...(conversation ? { conversation } : {}),
  };
  await withSnapshotIndex(cwd, async (_index, tree) => {
    const commit = (
      await git(
        cwd,
        ["commit-tree", tree, "-p", head],
        undefined,
        JSON.stringify(metadata),
      )
    ).trim();
    await git(cwd, ["update-ref", ref, commit, ""]);
  });
  if (prune) await pruneTurnWorkspaces(cwd, sessionId);
}
export async function turnCheckpointTree(
  cwd: string,
  ref: string,
): Promise<string> {
  if (!/^refs\/opensession\/turns\/[A-Za-z0-9_/-]+$/.test(ref))
    throw new Error("Invalid checkpoint ref");
  return (await git(cwd, ["rev-parse", "--verify", `${ref}^{tree}`])).trim();
}

export async function turnWorkspaceDiff(
  input: TurnCheckpointInput,
): Promise<string> {
  return git(input.cwd, [
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--binary",
    turnCheckpointRef(input.sessionId, input.turnId, "before"),
    turnCheckpointRef(input.sessionId, input.turnId, "after"),
    "--",
  ]);
}
export async function inspectTurnRestore(input: TurnCheckpointInput): Promise<{
  metadata: CheckpointMetadata;
  patch: string;
  files: string[];
  currentTree: string;
}> {
  const ref = turnCheckpointRef(input.sessionId, input.turnId, "before");
  const metadata = JSON.parse(
    await git(input.cwd, ["show", "-s", "--format=%B", ref]),
  ) as CheckpointMetadata;
  if (metadata.version !== 1) throw new Error("Unsupported turn checkpoint");
  if ((await git(input.cwd, ["rev-parse", "HEAD"])).trim() !== metadata.head)
    throw new Error(
      "Commits changed since this turn. Restore is unavailable; HEAD will not be moved.",
    );
  if (
    (await git(input.cwd, ["symbolic-ref", "--short", "HEAD"])).trim() !==
    metadata.branch
  )
    throw new Error("The checkout branch changed since this turn.");
  if ((await turnWorkspaceFence(input.cwd)).indexTree !== metadata.indexTree)
    throw new Error(
      "The staging index changed since this turn. Restore is unavailable; staged work will not be overwritten.",
    );
  return withSnapshotIndex(input.cwd, async (_index, tree) => ({
    metadata,
    currentTree: tree,
    patch: await git(input.cwd, [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--binary",
      tree,
      ref,
      "--",
    ]),
    files: (
      await git(input.cwd, ["diff", "--name-only", "-z", tree, ref, "--"])
    )
      .split("\0")
      .filter(Boolean),
  }));
}
/** Internal only: hold the lifecycle lane and preflight conversation rewind
 * BEFORE calling. The preview tree fences stale confirms. HEAD and the real
 * index never change. Ignored files remain untouched. */
export async function restoreTurnWorkspace(
  input: TurnCheckpointInput,
  expectedTree: string,
): Promise<void> {
  await inspectTurnRestore(input);
  await withSnapshotIndex(input.cwd, async (index, tree) => {
    if (tree !== expectedTree)
      throw new Error(
        "Workspace changed since the restore preview. Review it again.",
      );
    const ignored = (
      await git(input.cwd, [
        "ls-files",
        "--others",
        "--ignored",
        "--exclude-standard",
        "-z",
      ])
    )
      .split("\0")
      .filter(Boolean);
    const paths = (
      await git(input.cwd, [
        "ls-tree",
        "-r",
        "--name-only",
        "-z",
        turnCheckpointRef(input.sessionId, input.turnId, "before"),
      ])
    )
      .split("\0")
      .filter(Boolean);
    if (
      ignored.some((path) =>
        paths.some(
          (target) =>
            target === path ||
            path.startsWith(`${target}/`) ||
            target.startsWith(`${path}/`),
        ),
      )
    )
      throw new Error("Ignored files would be overwritten by this restore");
    await git(
      input.cwd,
      [
        "read-tree",
        "--reset",
        "-u",
        turnCheckpointRef(input.sessionId, input.turnId, "before"),
      ],
      index,
    );
  });
}
export async function pruneTurnWorkspaces(
  cwd: string,
  sessionId: string,
  limit = TURN_CHECKPOINT_LIMIT,
  keep: string[] = [],
): Promise<void> {
  const prefix = namespace(sessionId);
  const rows = (
    await git(cwd, [
      "for-each-ref",
      "--format=%(refname) %(contents:subject)",
      `${prefix}before/`,
    ])
  )
    .trim()
    .split("\n")
    .filter(Boolean);
  const refs = rows
    .map((row) => {
      const space = row.indexOf(" ");
      return {
        ref: row.slice(0, space),
        at: (JSON.parse(row.slice(space + 1)) as CheckpointMetadata).createdAt,
      };
    })
    .sort((a, b) => b.at - a.at);
  const unpinned = refs.filter(({ ref }) => !keep.includes(ref));
  for (const { ref: before } of unpinned.slice(
    Math.max(0, limit - keep.length),
  )) {
    await git(cwd, ["update-ref", "-d", before]);
    await git(cwd, [
      "update-ref",
      "-d",
      turnCheckpointRef(
        sessionId,
        before.slice(`${prefix}before/`.length),
        "after",
      ),
    ]);
  }
}
export async function deleteTurnWorkspaces(
  cwd: string,
  sessionId: string,
): Promise<void> {
  const refs = (
    await git(cwd, [
      "for-each-ref",
      "--format=%(refname)",
      namespace(sessionId),
    ])
  )
    .trim()
    .split("\n")
    .filter(Boolean);
  for (const ref of refs) await git(cwd, ["update-ref", "-d", ref]);
}
