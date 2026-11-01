import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  detectDirectPush,
  latestShipped,
  mergeDirectShips,
  parseReflog,
  reconcileDirectShips,
  shouldArchiveShipped,
  type ReflogEntry,
} from "./direct-ship";
import type { DirectShip } from "./types";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);

describe("detectDirectPush", () => {
  const reflog: ReflogEntry[] = [
    { sha: C, subject: "fetch: fast-forward" },
    { sha: B, subject: "update by push" },
    { sha: A, subject: "fetch origin main: fast-forward" },
  ];

  test("a push of this worktree's HEAD is a ship, with the old tip", () => {
    expect(detectDirectPush({ head: B, reflog, recorded: [] })).toEqual({
      sha: B,
      previousSha: A,
    });
  });

  test("a fetch that happens to land on HEAD is not a ship", () => {
    expect(detectDirectPush({ head: C, reflog, recorded: [] })).toBeNull();
    expect(detectDirectPush({ head: A, reflog, recorded: [] })).toBeNull();
  });

  test("a sibling worktree's push is not attributed here", () => {
    expect(
      detectDirectPush({ head: "d".repeat(40), reflog, recorded: [] }),
    ).toBeNull();
  });

  test("an already recorded ship is not recorded twice", () => {
    expect(
      detectDirectPush({ head: B, reflog, recorded: [{ sha: B }] }),
    ).toBeNull();
  });

  test("parseReflog keeps only well-formed lines", () => {
    expect(
      parseReflog(
        `${B}\tupdate by push\nnot a line\n${A}\tfetch: fast-forward\n`,
      ),
    ).toEqual([
      { sha: B, subject: "update by push" },
      { sha: A, subject: "fetch: fast-forward" },
    ]);
  });
});

describe("ship bookkeeping", () => {
  const ship = (sha: string, shippedAt?: string): DirectShip => ({
    repo: "app",
    branch: "feat",
    target: "main",
    sha,
    commits: [sha],
    pushedAt: "2026-11-01T00:00:00.000Z",
    ...(shippedAt ? { shippedAt } : {}),
  });

  test("latestShipped skips a newer push that is not confirmed yet", () => {
    const ships = [ship(A, "t1"), ship(B)];
    expect(latestShipped(ships)?.sha).toBe(A);
    expect(latestShipped([ship(B)])).toBeUndefined();
  });

  test("mergeDirectShips keeps the newest twenty", () => {
    let ships: DirectShip[] = [];
    for (let i = 0; i < 25; i++)
      ships = mergeDirectShips(ships, ship(i.toString(16).padStart(40, "0")));
    expect(ships).toHaveLength(20);
    expect(ships[0].sha).toBe((5).toString(16).padStart(40, "0"));
  });

  test("archive only when opted in, confirmed, at HEAD and clean", () => {
    const shipped = { sha: A, shippedAt: "t" };
    expect(
      shouldArchiveShipped({
        optedIn: true,
        ship: shipped,
        head: A,
        clean: true,
      }),
    ).toBe(true);
    expect(
      shouldArchiveShipped({
        optedIn: false,
        ship: shipped,
        head: A,
        clean: true,
      }),
    ).toBe(false);
    expect(
      shouldArchiveShipped({
        optedIn: true,
        ship: { sha: A },
        head: A,
        clean: true,
      }),
    ).toBe(false);
    expect(
      shouldArchiveShipped({
        optedIn: true,
        ship: shipped,
        head: B,
        clean: true,
      }),
    ).toBe(false);
    expect(
      shouldArchiveShipped({
        optedIn: true,
        ship: shipped,
        head: A,
        clean: false,
      }),
    ).toBe(false);
  });
});

// The whole pass against real repositories: a bare remote, the repository's
// checkout, and a workspace worktree on its own branch.
describe("reconcileDirectShips with git", () => {
  let root = "";
  let remote = "";
  let checkout = "";
  let worktree = "";
  let sibling = "";

  const git = async (dir: string, ...args: string[]) => {
    const proc = Bun.spawn(["git", "-C", dir, ...args], {
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@example.test",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@example.test",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0) throw new Error(`git ${args.join(" ")}: ${err}`);
    return out.trim();
  };
  const commit = async (dir: string, file: string) => {
    writeFileSync(join(dir, file), `${file}\n`);
    await git(dir, "add", file);
    await git(dir, "commit", "-q", "-m", file);
    return git(dir, "rev-parse", "HEAD");
  };
  const session = (dir: string, branch: string, ships?: DirectShip[]) => ({
    id: "os-test",
    branch,
    worktreeDir: dir,
    directShips: ships,
  });
  const repo = { id: "app", defaultBranch: "main", archiveShipped: true };

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "direct-ship-"));
    remote = join(root, "remote.git");
    checkout = join(root, "app");
    worktree = join(root, "app-feat");
    sibling = join(root, "app-other");
    await git(root, "init", "-q", "--bare", "-b", "main", remote);
    await git(root, "clone", "-q", remote, checkout);
    await commit(checkout, "base.txt");
    await git(checkout, "push", "-q", "origin", "HEAD:refs/heads/main");
    await git(checkout, "fetch", "-q", "origin");
    await git(
      checkout,
      "worktree",
      "add",
      "-q",
      "-b",
      "feat",
      worktree,
      "origin/main",
    );
    await git(
      checkout,
      "worktree",
      "add",
      "-q",
      "-b",
      "other",
      sibling,
      "origin/main",
    );
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  test("nothing pushed yet records nothing", async () => {
    await commit(worktree, "one.txt");
    const outcome = await reconcileDirectShips({
      session: session(worktree, "feat"),
      repo,
    });
    expect(outcome).toEqual({ ships: [], changed: false, archive: false });
  });

  test("a branch push is not a ship", async () => {
    await git(worktree, "push", "-q", "-u", "origin", "feat");
    const outcome = await reconcileDirectShips({
      session: session(worktree, "feat"),
      repo,
    });
    expect(outcome.changed).toBe(false);
  });

  let first: DirectShip[] = [];
  test("a push to the default branch is recorded, confirmed and archivable", async () => {
    const base = await git(worktree, "rev-parse", "origin/main");
    const two = await commit(worktree, "two.txt");
    await git(worktree, "push", "-q", "origin", "HEAD:refs/heads/main");
    const outcome = await reconcileDirectShips({
      session: session(worktree, "feat"),
      repo,
    });
    expect(outcome.changed).toBe(true);
    expect(outcome.archive).toBe(true);
    expect(outcome.ships).toHaveLength(1);
    const [ship] = outcome.ships;
    expect(ship.sha).toBe(two);
    expect(ship.previousSha).toBe(base);
    expect(ship.commits).toHaveLength(2);
    expect(ship.commits.at(-1)).toBe(two);
    expect(ship.shippedAt).toBeTruthy();
    first = outcome.ships;
  });

  test("the next pass is quiet", async () => {
    const outcome = await reconcileDirectShips({
      session: session(worktree, "feat", first),
      repo,
    });
    expect(outcome.changed).toBe(false);
  });

  test("a sibling's push is not attributed to this workspace", async () => {
    await git(sibling, "merge", "-q", "--ff-only", "origin/main");
    await commit(sibling, "sibling.txt");
    await git(sibling, "push", "-q", "origin", "HEAD:refs/heads/main");
    const outcome = await reconcileDirectShips({
      session: session(worktree, "feat", first),
      repo,
    });
    expect(outcome.changed).toBe(false);
  });

  test("uncommitted work keeps the workspace open after a ship", async () => {
    await git(worktree, "fetch", "-q", "origin");
    await git(worktree, "merge", "-q", "--no-edit", "origin/main");
    const three = await commit(worktree, "three.txt");
    await git(worktree, "push", "-q", "origin", "HEAD:refs/heads/main");
    writeFileSync(join(worktree, "draft.txt"), "wip\n");
    const outcome = await reconcileDirectShips({
      session: session(worktree, "feat", first),
      repo,
    });
    expect(outcome.ships.at(-1)?.sha).toBe(three);
    expect(outcome.ships.at(-1)?.shippedAt).toBeTruthy();
    // Integrating the sibling's push fast-forwarded this branch, so the ship
    // added one commit, and never claims the sibling's.
    const siblingCommit = await git(sibling, "rev-parse", "HEAD");
    expect(outcome.ships.at(-1)?.commits).toEqual([three]);
    expect(outcome.ships.at(-1)?.commits).not.toContain(siblingCommit);
    expect(outcome.archive).toBe(false);
    rmSync(join(worktree, "draft.txt"));
  });

  test("a push the remote no longer has stays unconfirmed", async () => {
    const four = await commit(worktree, "four.txt");
    await git(worktree, "push", "-q", "origin", "HEAD:refs/heads/main");
    // Someone rewrites the default branch back past it.
    await git(checkout, "fetch", "-q", "origin");
    await git(
      checkout,
      "push",
      "-q",
      "--force",
      "origin",
      `${four}~1:refs/heads/main`,
    );
    const outcome = await reconcileDirectShips({
      session: session(worktree, "feat", first),
      repo: { ...repo, archiveShipped: false },
    });
    const ship = outcome.ships.find((candidate) => candidate.sha === four);
    expect(ship).toBeTruthy();
    expect(ship?.shippedAt).toBeUndefined();
    expect(outcome.archive).toBe(false);
  });
});
