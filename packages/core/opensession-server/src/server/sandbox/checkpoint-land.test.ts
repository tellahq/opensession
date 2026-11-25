/**
 * Landing checkpoints on a machine's partial clone (`--filter=blob:none`,
 * as GPU job machines and Portal Sandboxes clone), with a file watcher in
 * mind: only files whose content changed may be rewritten, no blob of the
 * checkpoint's parent may be fetched, and a live job's own untracked files
 * survive a landing without `clean`. Pure git against a local origin.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { $ } from "bun";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  checkpointLandScript,
  checkpointRef,
  checkpointScript,
  checkpointBundle,
  parseLandOutput,
  stepTimings,
  withoutSteps,
} from "./checkpoint";

let scratch: string;
let origin: string;
let work: string;
let machine: string;
const identity = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};
const git = (cwd: string) => $.cwd(cwd).env({ ...process.env, ...identity });
const ref = checkpointRef("os-land-session");

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), "os-checkpoint-land-"));
  origin = join(scratch, "origin.git");
  work = join(scratch, "work");
  machine = join(scratch, "machine");
  await git(scratch)`git init --bare -q --initial-branch=main origin.git`;
  await git(origin)`git config uploadpack.allowFilter true`;
  await git(scratch)`git clone -q ${origin} work`;
  for (const name of ["a.txt", "b.txt", "c.txt", "README.md"])
    writeFileSync(join(work, name), `${name} base\n`);
  writeFileSync(join(work, ".gitignore"), "ignored/\n");
  await git(work)`git add -A`;
  await git(work)`git commit -q -m init`;
  await git(work)`git push -q origin main`;
  await git(work)`git checkout -q -b feature`;
  // The machine: a blobless clone with the settings bootstrap gives it.
  await git(scratch)`git clone -q --filter=blob:none file://${origin} machine`;
  await git(machine)`git config core.checkStat minimal`;
  await git(machine)`git config core.trustctime false`;
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** Push the work checkout's state (tip + dirty tree) as the checkpoint. */
async function checkpoint(): Promise<string> {
  const result = await git(work)`bash -c ${checkpointScript([".ports.conf"])}`
    .env({
      ...process.env,
      ...identity,
      OS_CWD: work,
      OS_REF: ref,
      OS_SESSION: "os-land-session",
      OS_DEFAULT_BRANCH: "main",
    })
    .quiet()
    .nothrow();
  expect(withoutSteps(result.stderr.toString())).toBe("");
  const [state, commit] = result.stdout.toString().trim().split(/\s+/);
  expect(state).toBe("pushed");
  return commit!;
}

/** Land on the machine, tracing which git commands ran. */
async function land(
  commit: string,
  options: { clean?: boolean; bundle?: string } = {},
  { quiet = true } = {},
) {
  const result = await git(
    machine,
  )`bash -c ${checkpointLandScript(ref, commit, "feature", [".ports.conf"], options)}`
    .env({ ...process.env, ...identity, GIT_TRACE: "1" })
    .quiet()
    .nothrow();
  const trace = result.stderr.toString();
  const errors = trace
    .split("\n")
    .filter(
      (line) => line && !/^\d\d:\d\d:\d\d\.\d+ |^remote: |^step /.test(line),
    );
  if (quiet) expect(errors).toEqual([]);
  expect(result.exitCode).toBe(0);
  return {
    outcome: parseLandOutput(result.stdout.toString()),
    /** Promisor (lazy) fetches: blobs fetched outside the landing's own fetch. */
    lazyFetches: trace
      .split("\n")
      .filter(
        (line) =>
          line.includes("built-in: git fetch") &&
          line.includes("--no-write-fetch-head"),
      ).length,
    fetched: trace.includes("built-in: git fetch --no-tags"),
    steps: stepTimings(trace),
  };
}

const OLD = new Date("2026-01-01T00:00:00Z");
function ageAll(names: string[]) {
  for (const name of names) utimesSync(join(machine, name), OLD, OLD);
}
const mtime = (name: string) => statSync(join(machine, name)).mtimeMs;
const read = (name: string) => readFileSync(join(machine, name), "utf8");
const head = async () => (await git(machine)`git rev-parse HEAD`.text()).trim();
const status = async () =>
  (await git(machine)`git status --porcelain`.text()).trimEnd();

describe("landing a checkpoint in a partial clone", () => {
  test("first landing: tip, branch and uncommitted changes", async () => {
    writeFileSync(join(work, "a.txt"), "a.txt session 1\n");
    writeFileSync(join(work, "new.txt"), "new\n");
    const commit = await checkpoint();
    const { outcome } = await land(commit);
    expect(outcome).toMatchObject({ state: "landed", changed: null });
    expect((await git(machine)`git branch --show-current`.text()).trim()).toBe(
      "feature",
    );
    expect(await head()).toBe(
      (await git(work)`git rev-parse HEAD`.text()).trim(),
    );
    expect(read("a.txt")).toBe("a.txt session 1\n");
    expect(await status()).toBe(" M a.txt\n?? new.txt");
  });

  test("commit, edit the same file again, land: no blob of the parent is fetched, unchanged files keep their mtime, the job's files stay", async () => {
    // The session edits further, commits (a version of a.txt the machine
    // never saw), and edits the same file again.
    writeFileSync(join(work, "a.txt"), "a.txt committed\n");
    await git(work)`git add -A`;
    await git(work)`git commit -q -m session`;
    writeFileSync(join(work, "a.txt"), "a.txt session 2\n");
    writeFileSync(join(work, "b.txt"), "b.txt session 2\n");
    const parent = (await git(work)`git rev-parse HEAD`.text()).trim();
    const commit = await checkpoint();

    // The running job wrote a scratch file and a build output.
    writeFileSync(join(machine, "scratch.log"), "job\n");
    ageAll(["a.txt", "b.txt", "c.txt", "README.md", "new.txt"]);

    const { outcome, lazyFetches } = await land(commit, { clean: false });
    expect(outcome).toMatchObject({
      state: "landed",
      changed: ["a.txt", "b.txt"],
    });
    // One batch for the checkpoint's own new blobs at most; the parent's
    // version of a.txt (committed, never checked out here) stays unfetched.
    expect(lazyFetches).toBeLessThanOrEqual(1);
    const missing = await git(machine)`git cat-file -e ${parent}:a.txt`
      .env({ ...process.env, ...identity, GIT_NO_LAZY_FETCH: "1" })
      .quiet()
      .nothrow();
    expect(missing.exitCode).not.toBe(0);

    expect(read("a.txt")).toBe("a.txt session 2\n");
    expect(read("b.txt")).toBe("b.txt session 2\n");
    expect(mtime("a.txt")).not.toBe(OLD.getTime());
    expect(mtime("b.txt")).not.toBe(OLD.getTime());
    // Unchanged: never in a diff, and new.txt went from untracked to
    // committed without its content changing.
    for (const name of ["c.txt", "README.md", "new.txt"])
      expect(mtime(name)).toBe(OLD.getTime());
    expect(read("scratch.log")).toBe("job\n");
    expect(await head()).toBe(parent);
    expect(await status()).toBe(" M a.txt\n M b.txt\n?? scratch.log");
  });

  test("files the session deleted are deleted, even one only a checkpoint had; the job's files stay", async () => {
    writeFileSync(join(work, "only-checkpoint.txt"), "x\n");
    const first = await checkpoint();
    await land(first, { clean: false });
    expect(read("only-checkpoint.txt")).toBe("x\n");

    rmSync(join(work, "only-checkpoint.txt"));
    rmSync(join(work, "c.txt"));
    const commit = await checkpoint();
    ageAll(["a.txt", "b.txt", "README.md"]);
    const { outcome } = await land(commit, { clean: false });
    expect(outcome).toMatchObject({
      state: "landed",
      changed: ["c.txt", "only-checkpoint.txt"],
    });
    expect(existsSync(join(machine, "only-checkpoint.txt"))).toBe(false);
    expect(existsSync(join(machine, "c.txt"))).toBe(false);
    expect(existsSync(join(machine, "scratch.log"))).toBe(true);
    for (const name of ["a.txt", "b.txt", "README.md"])
      expect(mtime(name)).toBe(OLD.getTime());

    // The same checkpoint again: nothing fetched, nothing touched.
    const again = await land(commit, { clean: false });
    expect(again.outcome).toMatchObject({ state: "unchanged" });
    expect(again.fetched).toBe(false);
  });

  test("a bundle from the host lands without any fetch from origin", async () => {
    const previous = (
      await git(machine)`git rev-parse refs/opensession/landed`.text()
    ).trim();
    writeFileSync(join(work, "a.txt"), "a.txt from a bundle\n");
    const commit = await checkpoint();
    const bundle = await checkpointBundle(work, commit, [previous]);
    expect(bundle).not.toBeNull();
    expect(bundle!.length).toBeLessThan(4096);
    const path = join(scratch, "checkpoint.bundle");
    writeFileSync(path, bundle!);
    ageAll(["b.txt", "README.md"]);
    const { outcome, fetched, lazyFetches, steps } = await land(commit, {
      clean: false,
      bundle: path,
    });
    expect(outcome).toMatchObject({ state: "landed", changed: ["a.txt"] });
    expect(fetched).toBe(false);
    expect(lazyFetches).toBe(0);
    expect(steps).toStartWith("bundle ");
    expect(outcome.head).toBe(await head());
    expect(read("a.txt")).toBe("a.txt from a bundle\n");
    for (const name of ["b.txt", "README.md"])
      expect(mtime(name)).toBe(OLD.getTime());

    // A commit the host does not know: no bundle.
    expect(await checkpointBundle(work, commit, ["0".repeat(40)])).toBeNull();
    // A bundle that does not apply falls back to origin.
    writeFileSync(join(work, "a.txt"), "a.txt from origin\n");
    const next = await checkpoint();
    writeFileSync(path, "not a bundle");
    const fallback = await land(
      next,
      { clean: false, bundle: path },
      { quiet: false },
    );
    expect(fallback.fetched).toBe(true);
    expect(read("a.txt")).toBe("a.txt from origin\n");
  });

  test("a landing with clean (a new job) also removes the previous job's files", async () => {
    writeFileSync(join(work, "d.txt"), "d\n");
    const commit = await checkpoint();
    writeFileSync(join(machine, ".ports.conf"), "WEBAPP_PORT=1\n");
    await land(commit);
    expect(existsSync(join(machine, "scratch.log"))).toBe(false);
    expect(read(".ports.conf")).toBe("WEBAPP_PORT=1\n");
    expect(read("d.txt")).toBe("d\n");
  });
});

describe("parseLandOutput", () => {
  test("reads the outcome and the changed paths", () => {
    expect(parseLandOutput("unchanged\n")).toEqual({ state: "unchanged" });
    expect(parseLandOutput("head abc\nunchanged\n")).toEqual({
      state: "unchanged",
      head: "abc",
    });
    expect(parseLandOutput("head abc\nlanded\nx\n")).toEqual({
      state: "landed",
      changed: ["x"],
      head: "abc",
    });
    expect(parseLandOutput("landed\n?\n")).toEqual({
      state: "landed",
      changed: null,
    });
    expect(parseLandOutput("landed\na b.txt\nc\n")).toEqual({
      state: "landed",
      changed: ["a b.txt", "c"],
    });
    expect(parseLandOutput("landed\n\n")).toEqual({
      state: "landed",
      changed: [],
    });
  });
});
