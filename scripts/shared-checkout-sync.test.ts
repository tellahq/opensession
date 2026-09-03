import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";

const SCRIPT = new URL("./shared-checkout-sync.ts", import.meta.url).pathname;
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync({
    cmd: ["git", ...args],
    cwd,
    env: GIT_ENV,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0)
    throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

function sync(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync({
    cmd: ["bun", SCRIPT, ...args],
    cwd,
    env: GIT_ENV,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: result.exitCode,
    out: result.stdout.toString() + result.stderr.toString(),
  };
}

let root: string;
let remote: string;
let shared: string;
let other: string;

function commitUpstream(files: Record<string, string | null>, message: string) {
  git(other, "pull", "--ff-only", "--quiet");
  for (const [path, content] of Object.entries(files)) {
    if (content === null) git(other, "rm", "--quiet", path);
    else {
      writeFileSync(join(other, path), content);
      git(other, "add", path);
    }
  }
  git(other, "commit", "--quiet", "-m", message);
  git(other, "push", "--quiet", "origin", "main");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "shared-sync-test-"));
  remote = join(root, "remote.git");
  shared = join(root, "shared");
  other = join(root, "other");
  git(root, "init", "--quiet", "--bare", "-b", "main", remote);
  git(root, "clone", "--quiet", remote, shared);
  git(shared, "config", "core.autocrlf", "false");
  writeFileSync(join(shared, "a.txt"), "a1\na2\na3\na4\na5\na6\na7\na8\n");
  writeFileSync(join(shared, "b.txt"), "b1\nb2\nb3\n");
  writeFileSync(join(shared, "gone.txt"), "gone\n");
  git(shared, "add", ".");
  git(shared, "commit", "--quiet", "-m", "seed");
  git(shared, "push", "--quiet", "origin", "main");
  git(root, "clone", "--quiet", remote, other);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("shared-checkout-sync", () => {
  test("is a no-op when already current", () => {
    const result = sync(shared);
    expect(result.code).toBe(0);
    expect(result.out).toContain("already at origin/main");
  });

  test("fast-forwards clean paths, adopts landed edits, removes deletions", () => {
    commitUpstream(
      {
        "a.txt": "a1\na2\na3\na4\na5\na6\na7\na8\na9\n",
        "new.txt": "new\n",
        "gone.txt": null,
      },
      "upstream",
    );
    // b.txt untouched; a.txt residue identical to what landed upstream.
    writeFileSync(
      join(shared, "a.txt"),
      "a1\na2\na3\na4\na5\na6\na7\na8\na9\n",
    );
    git(shared, "add", "a.txt");

    const result = sync(shared);
    expect(result.code).toBe(0);
    expect(git(shared, "rev-parse", "main")).toBe(
      git(shared, "rev-parse", "origin/main"),
    );
    expect(git(shared, "status", "--porcelain")).toBe("");
    expect(existsSync(join(shared, "gone.txt"))).toBe(false);
    expect(readFileSync(join(shared, "new.txt"), "utf8")).toBe("new\n");
  });

  test("rebases a non-overlapping local edit onto the new base and keeps staged apart from unstaged", () => {
    commitUpstream(
      { "a.txt": "A1\na2\na3\na4\na5\na6\na7\na8\n" },
      "upstream edits line 1",
    );
    // Staged edit at the end, then a further unstaged edit on top of it.
    writeFileSync(
      join(shared, "a.txt"),
      "a1\na2\na3\na4\na5\na6\na7\nstaged8\n",
    );
    git(shared, "add", "a.txt");
    writeFileSync(
      join(shared, "a.txt"),
      "a1\na2\na3\na4\na5\na6\na7\nstaged8\nunstaged9\n",
    );

    const result = sync(shared);
    expect(result.code).toBe(0);
    expect(result.out).toContain("rebased  a.txt");
    expect(git(shared, "rev-parse", "main")).toBe(
      git(shared, "rev-parse", "origin/main"),
    );
    expect(readFileSync(join(shared, "a.txt"), "utf8")).toBe(
      "A1\na2\na3\na4\na5\na6\na7\nstaged8\nunstaged9\n",
    );
    // The staged diff is exactly the staged edit against the new base.
    expect(git(shared, "diff", "--cached")).toContain("+staged8");
    expect(git(shared, "diff", "--cached")).not.toContain("-A1");
    expect(git(shared, "diff")).toContain("+unstaged9");
    expect(git(shared, "diff")).not.toContain("+staged8");
    const backups = git(shared, "rev-parse", "--absolute-git-dir");
    expect(existsSync(join(backups, "shared-checkout-sync"))).toBe(true);
  });

  test("leaves a conflicting edit untouched but still moves main", () => {
    commitUpstream({ "b.txt": "B1\nb2\nb3\n" }, "upstream edits b line 1");
    writeFileSync(join(shared, "b.txt"), "mine1\nb2\nb3\n");
    const before = readFileSync(join(shared, "b.txt"), "utf8");

    const result = sync(shared);
    expect(result.code).toBe(2);
    expect(result.out).toContain("conflict b.txt");
    expect(readFileSync(join(shared, "b.txt"), "utf8")).toBe(before);
    expect(git(shared, "rev-parse", "main")).toBe(
      git(shared, "rev-parse", "origin/main"),
    );
  });

  test("adopts a staged new file and a staged deletion that both landed upstream", () => {
    commitUpstream({ "added.txt": "added\n", "gone.txt": null }, "upstream");
    writeFileSync(join(shared, "added.txt"), "added\n");
    git(shared, "add", "added.txt");
    git(shared, "rm", "--quiet", "gone.txt");

    const result = sync(shared);
    expect(result.code).toBe(0);
    expect(git(shared, "rev-parse", "main")).toBe(
      git(shared, "rev-parse", "origin/main"),
    );
    expect(git(shared, "status", "--porcelain")).toBe("");
  });

  test("merges a staged new file whose upstream twin differs in another region", () => {
    commitUpstream(
      { "both.txt": "one\ntwo\nthree\nfour\nfive\nsix\n" },
      "upstream",
    );
    writeFileSync(
      join(shared, "both.txt"),
      "one\ntwo\nthree\nfour\nfive\nsix\nlocal seven\n",
    );
    git(shared, "add", "both.txt");

    const result = sync(shared);
    expect([0, 2]).toContain(result.code);
    expect(git(shared, "rev-parse", "main")).toBe(
      git(shared, "rev-parse", "origin/main"),
    );
    expect(readFileSync(join(shared, "both.txt"), "utf8")).toContain(
      "local seven",
    );
  });

  test("refuses when local main carries unpushed commits", () => {
    commitUpstream({ "b.txt": "B1\nb2\nb3\n" }, "upstream");
    writeFileSync(join(shared, "c.txt"), "c\n");
    git(shared, "add", "c.txt");
    git(shared, "commit", "--quiet", "-m", "local");
    const head = git(shared, "rev-parse", "main");

    const result = sync(shared);
    expect(result.code).toBe(1);
    expect(result.out).toContain("diverged");
    expect(git(shared, "rev-parse", "main")).toBe(head);
  });

  test("dry run reports without changing anything", () => {
    commitUpstream({ "a.txt": "A1\na2\na3\na4\na5\na6\na7\na8\n" }, "upstream");
    const head = git(shared, "rev-parse", "main");
    const result = sync(shared, "--dry-run");
    expect(result.code).toBe(0);
    expect(result.out).toContain("dry run");
    expect(git(shared, "rev-parse", "main")).toBe(head);
    expect(readFileSync(join(shared, "a.txt"), "utf8")).toBe(
      "a1\na2\na3\na4\na5\na6\na7\na8\n",
    );
  });
});
