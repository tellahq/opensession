import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  captureTurnWorkspace,
  deleteTurnWorkspaces,
  inspectTurnRestore,
  pruneTurnWorkspaces,
  restoreTurnWorkspace,
  turnCheckpointRef,
  turnWorkspaceDiff,
} from "./turn-workspace-checkpoint";
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});
async function git(cwd: string, ...args: string[]): Promise<string> {
  const p = Bun.spawn(["git", "-C", cwd, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  if (code) throw new Error(err);
  return out.trim();
}
async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "turn-checkpoint-test-"));
  dirs.push(cwd);
  await git(cwd, "init", "-b", "feature");
  await git(cwd, "config", "user.email", "test@example.test");
  await git(cwd, "config", "user.name", "Test");
  await writeFile(join(cwd, ".gitignore"), "ignored\n");
  await writeFile(join(cwd, "tracked"), "base\n");
  await git(cwd, "add", ".");
  await git(cwd, "commit", "-m", "initial");
  return { cwd, sessionId: "os-test", turnId: "turn-1" };
}
test("capture and restore tracked and untracked files without touching HEAD or staging", async () => {
  const input = await fixture();
  const { cwd } = input;
  await writeFile(join(cwd, "tracked"), "staged\n");
  await git(cwd, "add", "tracked");
  await writeFile(join(cwd, "tracked"), "before\n");
  await writeFile(join(cwd, "old-untracked"), "keep\n");
  await writeFile(join(cwd, "ignored"), "private\n");
  const index = await readFile(join(cwd, ".git/index"));
  const head = await git(cwd, "rev-parse", "HEAD");
  await captureTurnWorkspace(input, "before");
  await writeFile(join(cwd, "tracked"), "after\n");
  await rm(join(cwd, "old-untracked"));
  await mkdir(join(cwd, "new-dir"));
  await writeFile(join(cwd, "new-dir/new"), "new\n");
  await captureTurnWorkspace(input, "after");
  expect(await turnWorkspaceDiff(input)).toContain("+after");
  const preview = await inspectTurnRestore(input);
  expect(preview.files.sort()).toEqual([
    "new-dir/new",
    "old-untracked",
    "tracked",
  ]);
  await restoreTurnWorkspace(input, preview.currentTree);
  expect(await readFile(join(cwd, "tracked"), "utf8")).toBe("before\n");
  expect(await readFile(join(cwd, "old-untracked"), "utf8")).toBe("keep\n");
  expect(await readFile(join(cwd, "ignored"), "utf8")).toBe("private\n");
  expect(await Bun.file(join(cwd, "new-dir/new")).exists()).toBe(false);
  expect(await readFile(join(cwd, ".git/index"))).toEqual(index);
  expect(await git(cwd, "rev-parse", "HEAD")).toBe(head);
});
test("retries retain original capture and stale confirmation refuses before writing", async () => {
  const input = await fixture();
  await captureTurnWorkspace(input, "before");
  await writeFile(join(input.cwd, "tracked"), "change\n");
  await captureTurnWorkspace(input, "before");
  const preview = await inspectTurnRestore(input);
  await writeFile(join(input.cwd, "tracked"), "later\n");
  await expect(
    restoreTurnWorkspace(input, preview.currentTree),
  ).rejects.toThrow("Workspace changed");
  expect(await readFile(join(input.cwd, "tracked"), "utf8")).toBe("later\n");
});
test("HEAD and staging changes refuse restore", async () => {
  const input = await fixture();
  await captureTurnWorkspace(input, "before");
  await writeFile(join(input.cwd, "tracked"), "staged\n");
  await git(input.cwd, "add", "tracked");
  await expect(inspectTurnRestore(input)).rejects.toThrow(
    "staging index changed",
  );
  await git(input.cwd, "commit", "-m", "new commit");
  await expect(inspectTurnRestore(input)).rejects.toThrow("Commits changed");
});
test("assume-unchanged does not hide edits", async () => {
  const input = await fixture();
  await git(input.cwd, "update-index", "--assume-unchanged", "tracked");
  await writeFile(join(input.cwd, "tracked"), "hidden edit\n");
  await captureTurnWorkspace(input, "before");
  expect(
    await git(
      input.cwd,
      "show",
      `${turnCheckpointRef(input.sessionId, input.turnId, "before")}:tracked`,
    ),
  ).toBe("hidden edit");
});
test("bounded pruning and session deletion remove paired local refs", async () => {
  const input = await fixture();
  for (const turnId of ["a", "b", "c"]) {
    await captureTurnWorkspace({ ...input, turnId }, "before");
    await captureTurnWorkspace({ ...input, turnId }, "after");
  }
  await pruneTurnWorkspaces(input.cwd, input.sessionId, 2);
  expect(
    (
      await git(
        input.cwd,
        "for-each-ref",
        "--format=%(refname)",
        `refs/opensession/turns/${input.sessionId}`,
      )
    ).split("\n"),
  ).toHaveLength(4);
  await deleteTurnWorkspaces(input.cwd, input.sessionId);
  expect(await git(input.cwd, "for-each-ref", "refs/opensession/turns/")).toBe(
    "",
  );
});
test("rejects ref injection", () => {
  expect(() => turnCheckpointRef("../bad", "turn", "before")).toThrow();
});
