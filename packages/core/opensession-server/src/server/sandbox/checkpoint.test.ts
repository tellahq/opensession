/**
 * The checkpoint round trip against a local bare "origin": the script pushes
 * one synthetic commit holding the branch tip plus the dirty tree to the
 * hidden ref, and the restore script reproduces branch, tip, and uncommitted
 * changes in a fresh clone. Pure git, no provider or network.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { $ } from "bun";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { checkpointRestoreScript } from "./adapters/bootstrap";
import {
  checkpointCapable,
  checkpointLandScript,
  checkpointRef,
  checkpointScript,
  restorableCheckpoint,
} from "./checkpoint";
import {
  sessionLifecycleInFlight,
  settleSessionLifecycle,
  withSessionLifecycleLane,
} from "./lifecycle-lane";

let scratch: string;
let origin: string;
let work: string;
const identity = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};
const git = (cwd: string) => $.cwd(cwd).env({ ...process.env, ...identity });

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), "os-checkpoint-"));
  origin = join(scratch, "origin.git");
  work = join(scratch, "work");
  await git(scratch)`git init --bare -q --initial-branch=main origin.git`;
  await git(scratch)`git clone -q ${origin} work`;
  writeFileSync(join(work, "README.md"), "hello\n");
  writeFileSync(join(work, ".gitignore"), "ignored.txt\n");
  await git(work)`git add -A`;
  await git(work)`git commit -q -m init`;
  await git(work)`git push -q origin main`;
  await git(work)`git checkout -q -b feature`;
  writeFileSync(join(work, "README.md"), "hello\nfeature\n");
  await git(work)`git commit -q -am feature`;
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const ref = checkpointRef("os-test-session");

async function runCheckpoint(env: Record<string, string>) {
  return git(work)`bash -c ${checkpointScript([".ports.conf", "secrets/.env"])}`
    .env({
      ...process.env,
      ...identity,
      OS_CWD: work,
      OS_REF: ref,
      OS_SESSION: "os-test-session",
      OS_DEFAULT_BRANCH: "main",
      OS_LAST_HEAD: "",
      OS_LAST_TREE: "",
      OS_LAST_BRANCH: "",
      ...env,
    })
    .quiet()
    .nothrow();
}

describe("checkpointCapable", () => {
  test("needs a GitHub repository", () => {
    expect(checkpointCapable({ ghRepo: "tellahq/x" })).toBe(true);
    expect(checkpointCapable({ ghRepo: "" })).toBe(false);
    expect(
      checkpointCapable({ ghRepo: "tellahq/x", host: "codestorage" }),
    ).toBe(false);
  });
});

describe("checkpointLandScript", () => {
  test("puts a mirror checkout on the checkpoint whatever branch it is on, keeping only the excluded paths", async () => {
    writeFileSync(join(work, "README.md"), "hello\nfeature\nlanded\n");
    writeFileSync(join(work, "new.txt"), "untracked\n");
    const pushed = await runCheckpoint({});
    expect(pushed.exitCode).toBe(0);
    const [, commit] = pushed.stdout.toString().trim().split(/\s+/);
    const tip = (await git(work)`git rev-parse HEAD`.text()).trim();

    const mirror = join(scratch, "mirror");
    await git(scratch)`git clone -q ${origin} mirror`;
    // A Portal Sandbox's checkout: on the default branch, with the Portal
    // registry and a leftover from an earlier landing lying around.
    writeFileSync(join(mirror, ".ports.conf"), "WEBAPP_PORT=3300\n");
    writeFileSync(join(mirror, "stale.txt"), "from last time\n");
    const land = await git(
      mirror,
    )`bash -c ${checkpointLandScript(ref, commit!, "feature", [".ports.conf"])}`
      .quiet()
      .nothrow();
    expect(land.stderr.toString()).toBe("");
    expect(land.exitCode).toBe(0);
    expect((await git(mirror)`git branch --show-current`.text()).trim()).toBe(
      "feature",
    );
    expect((await git(mirror)`git rev-parse HEAD`.text()).trim()).toBe(tip);
    expect(readFileSync(join(mirror, "README.md"), "utf-8")).toBe(
      "hello\nfeature\nlanded\n",
    );
    expect(readFileSync(join(mirror, "new.txt"), "utf-8")).toBe("untracked\n");
    expect(readFileSync(join(mirror, ".ports.conf"), "utf-8")).toBe(
      "WEBAPP_PORT=3300\n",
    );
    expect(existsSync(join(mirror, "stale.txt"))).toBe(false);
    // The wrong commit for the ref is refused before anything moves.
    const wrong = await git(
      mirror,
    )`bash -c ${checkpointLandScript(ref, tip, "feature")}`
      .quiet()
      .nothrow();
    expect(wrong.exitCode).not.toBe(0);

    // A git that crashed during an earlier landing left its lock behind.
    // (Aged, since other gits may be running on the machine this test runs
    // on; inside a Portal Sandbox no running git also clears it.)
    const lock = join(mirror, ".git", "index.lock");
    writeFileSync(lock, "");
    const old = new Date(Date.now() - 10 * 60_000);
    utimesSync(lock, old, old);
    const relanded = await git(
      mirror,
    )`bash -c ${checkpointLandScript(ref, commit!, "feature", [".ports.conf"])}`
      .quiet()
      .nothrow();
    expect(relanded.stderr.toString()).toBe("");
    expect(relanded.exitCode).toBe(0);
    expect(existsSync(lock)).toBe(false);
  });
});

describe("restorableCheckpoint", () => {
  const checkpoint = {
    ref: checkpointRef("s"),
    commit: "c",
    head: "h",
    tree: "t",
    branch: "feature-a",
    at: "2026-09-16T00:00:00.000Z",
  };
  test("only a checkpoint taken on the session's current branch", () => {
    expect(
      restorableCheckpoint({
        branch: "feature-a",
        sandboxCheckpoint: checkpoint,
      }),
    ).toBe(checkpoint);
    expect(
      restorableCheckpoint({
        branch: "feature-b",
        sandboxCheckpoint: checkpoint,
      }),
    ).toBeUndefined();
    expect(restorableCheckpoint({ branch: "feature-a" })).toBeUndefined();
  });
});

describe("lifecycle lane", () => {
  test("runs a session's operations one at a time, in order, and a turn waits for them", async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    const first = withSessionLifecycleLane("s1", async () => {
      order.push("first start");
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      order.push("first end");
      return 1;
    });
    const second = withSessionLifecycleLane("s1", async () => {
      order.push("second");
      return 2;
    });
    // Claimed synchronously: a turn asking now already has to wait.
    expect(sessionLifecycleInFlight("s1")).toBe(true);
    let turnStarted = false;
    const turn = settleSessionLifecycle("s1").then(() => {
      turnStarted = true;
    });
    await Promise.resolve();
    expect(order).toEqual(["first start"]);
    expect(turnStarted).toBe(false);
    releaseFirst();
    expect(await first).toBe(1);
    expect(await second).toBe(2);
    await turn;
    expect(order).toEqual(["first start", "first end", "second"]);
    expect(turnStarted).toBe(true);
    expect(sessionLifecycleInFlight("s1")).toBe(false);
  });

  test("a failed operation neither blocks the lane nor fails the waiting turn", async () => {
    const failed = withSessionLifecycleLane("s2", async () => {
      throw new Error("push refused");
    });
    const next = withSessionLifecycleLane("s2", async () => "ok");
    await expect(failed).rejects.toThrow("push refused");
    expect(await next).toBe("ok");
    await expect(settleSessionLifecycle("s2")).resolves.toBeUndefined();
  });

  test("other sessions do not wait", async () => {
    let release!: () => void;
    void withSessionLifecycleLane(
      "s3",
      () => new Promise<void>((r) => (release = r)),
    );
    let otherRan = false;
    await withSessionLifecycleLane("s4", async () => {
      otherRan = true;
    });
    expect(otherRan).toBe(true);
    release();
    await settleSessionLifecycle("s3");
  });

  test("an operation on the lane may claim the same lane again without waiting on itself", async () => {
    const result = await withSessionLifecycleLane("s5", async () => {
      // A move that checkpoints first: the checkpoint claims the lane the
      // move already holds, and the lane stays held until the move ends.
      const inner = await withSessionLifecycleLane("s5", async () => "inner");
      expect(sessionLifecycleInFlight("s5")).toBe(true);
      return `${inner} then outer`;
    });
    expect(result).toBe("inner then outer");
    // A queued operation only runs once the whole outer one has finished.
    const order: string[] = [];
    let releaseOuter!: () => void;
    const outer = withSessionLifecycleLane("s6", async () => {
      await withSessionLifecycleLane("s6", async () => {
        order.push("nested");
      });
      await new Promise<void>((r) => (releaseOuter = r));
      order.push("outer end");
    });
    const queued = withSessionLifecycleLane("s6", async () => {
      order.push("queued");
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["nested"]);
    releaseOuter();
    await outer;
    await queued;
    expect(order).toEqual(["nested", "outer end", "queued"]);
  });
});

describe("checkpoint script", () => {
  test("pushes tip + dirty tree to the hidden ref, leaving out ignored, excluded, and Portal state", async () => {
    writeFileSync(join(work, "README.md"), "hello\nfeature\ndirty\n");
    writeFileSync(join(work, "new.txt"), "untracked\n");
    writeFileSync(join(work, "ignored.txt"), "never\n");
    writeFileSync(join(work, ".ports.conf"), "WEBAPP_PORT=3300\n");
    await $`mkdir -p ${join(work, "secrets")}`;
    writeFileSync(join(work, "secrets/.env"), "SECRET=1\n");

    const result = await runCheckpoint({});
    expect(result.exitCode).toBe(0);
    const [state, commit, head, , branch] = result.stdout
      .toString()
      .trim()
      .split(/\s+/);
    expect(state).toBe("pushed");
    // The branch is read from the checkout, not handed in.
    expect(branch).toBe("feature");
    expect(
      (await git(origin)`git log -1 --format=%B ${ref}`.text()).trim(),
    ).toContain("Branch: feature");
    const tip = (await git(work)`git rev-parse HEAD`.text()).trim();
    expect(head).toBe(tip);
    // The branch itself did not move and the tree is still dirty.
    expect((await git(work)`git rev-parse feature`.text()).trim()).toBe(tip);
    expect((await git(work)`git status --porcelain`.text()).trim()).not.toBe(
      "",
    );
    // Origin holds the ref; the checkpoint's parent is the tip.
    const onOrigin = (await git(origin)`git rev-parse ${ref}`.text()).trim();
    expect(onOrigin).toBe(commit);
    expect((await git(origin)`git rev-parse ${ref}^`.text()).trim()).toBe(tip);
    const files = (await git(origin)`git ls-tree -r --name-only ${ref}`.text())
      .trim()
      .split("\n")
      .sort();
    expect(files).toEqual([".gitignore", "README.md", "new.txt"]);
  });

  test("captures the working tree, not what happens to be staged", async () => {
    const before = readFileSync(join(work, "README.md"), "utf-8");
    // Starting from the checkout's own index must not freeze a stale stage.
    writeFileSync(join(work, "README.md"), "staged version\n");
    await git(work)`git add README.md`;
    writeFileSync(join(work, "README.md"), "working version\n");
    const result = await runCheckpoint({});
    expect(result.exitCode).toBe(0);
    expect((await git(origin)`git show ${ref}:README.md`.text()).trim()).toBe(
      "working version",
    );
    // The checkout's real index is untouched.
    expect((await git(work)`git show :README.md`.text()).trim()).toBe(
      "staged version",
    );
    await git(work)`git reset -q README.md`;
    writeFileSync(join(work, "README.md"), before);
  });

  test("an assume-unchanged file is still captured", async () => {
    const before = readFileSync(join(work, "README.md"), "utf-8");
    await git(work)`git update-index --assume-unchanged README.md`;
    try {
      writeFileSync(join(work, "README.md"), "hidden from git status\n");
      const result = await runCheckpoint({});
      expect(result.exitCode).toBe(0);
      expect((await git(origin)`git show ${ref}:README.md`.text()).trim()).toBe(
        "hidden from git status",
      );
    } finally {
      await git(work)`git update-index --no-assume-unchanged README.md`;
      writeFileSync(join(work, "README.md"), before);
    }
  });

  test("reports unchanged when the last checkpoint already holds this state", async () => {
    const first = await runCheckpoint({});
    const [, , head, tree] = first.stdout.toString().trim().split(/\s+/);
    const again = await runCheckpoint({
      OS_LAST_HEAD: head!,
      OS_LAST_TREE: tree!,
      OS_LAST_BRANCH: "feature",
    });
    expect(again.exitCode).toBe(0);
    expect(again.stdout.toString().trim()).toBe(
      `unchanged ${head} ${tree} feature`,
    );
  });

  test("a renamed branch is a new checkpoint labeled with the checkout's branch", async () => {
    const first = await runCheckpoint({});
    const [, , head, tree] = first.stdout.toString().trim().split(/\s+/);
    await git(work)`git branch -m feature feature-renamed`;
    try {
      // Same tip, same tree, other branch: not `unchanged`.
      const renamed = await runCheckpoint({
        OS_LAST_HEAD: head!,
        OS_LAST_TREE: tree!,
        OS_LAST_BRANCH: "feature",
      });
      expect(renamed.exitCode).toBe(0);
      const [state, , , , branch] = renamed.stdout
        .toString()
        .trim()
        .split(/\s+/);
      expect(state).toBe("pushed");
      expect(branch).toBe("feature-renamed");
    } finally {
      await git(work)`git branch -m feature-renamed feature`;
    }
  });

  test("nothing is pushed from a detached HEAD or the default branch", async () => {
    const before = (await git(origin)`git rev-parse ${ref}`.text()).trim();
    await git(work)`git checkout -q --detach`;
    try {
      const detached = await runCheckpoint({});
      expect(detached.exitCode).toBe(0);
      expect(detached.stdout.toString().trim()).toBe("detached");
    } finally {
      await git(work)`git checkout -q feature`;
    }
    const onDefault = await runCheckpoint({ OS_DEFAULT_BRANCH: "feature" });
    expect(onDefault.exitCode).toBe(0);
    expect(onDefault.stdout.toString().trim()).toBe("default feature");
    expect((await git(origin)`git rev-parse ${ref}`.text()).trim()).toBe(
      before,
    );
  });

  test("restore reproduces branch, tip, and uncommitted changes in a fresh clone", async () => {
    const pushed = await runCheckpoint({});
    const [, commit] = pushed.stdout.toString().trim().split(/\s+/);
    const tip = (await git(work)`git rev-parse HEAD`.text()).trim();

    const fresh = join(scratch, "fresh");
    await git(scratch)`git clone -q ${origin} fresh`;
    // Origin never saw `feature`: start it anywhere, as a Sandbox clone does.
    await git(fresh)`git checkout -q -b feature origin/main`;
    const restore = await git(
      fresh,
    )`bash -c ${checkpointRestoreScript(ref, commit!)}`
      .quiet()
      .nothrow();
    expect(restore.stderr.toString()).toBe("");
    expect(restore.exitCode).toBe(0);
    expect((await git(fresh)`git rev-parse HEAD`.text()).trim()).toBe(tip);
    expect((await git(fresh)`git branch --show-current`.text()).trim()).toBe(
      "feature",
    );
    expect(readFileSync(join(fresh, "README.md"), "utf-8")).toBe(
      "hello\nfeature\ndirty\n",
    );
    expect(readFileSync(join(fresh, "new.txt"), "utf-8")).toBe("untracked\n");
    const status = (await git(fresh)`git status --porcelain`.text())
      .split("\n")
      .filter(Boolean)
      .sort();
    expect(status).toEqual([" M README.md", "?? new.txt"]);
    // The temporary local ref is gone; nothing but the working tree remains.
    expect(
      (await git(fresh)`git show-ref refs/opensession/checkpoint`.nothrow())
        .exitCode,
    ).not.toBe(0);
  });

  test("a forward-only restore refuses a checkout whose tip the checkpoint does not extend", async () => {
    const pushed = await runCheckpoint({});
    const [, commit] = pushed.stdout.toString().trim().split(/\s+/);
    // A checkout of the same branch with a commit of its own: reused, it
    // would lose that commit.
    const diverged = join(scratch, "diverged");
    await git(scratch)`git clone -q ${origin} diverged`;
    await git(diverged)`git checkout -q -b feature origin/main`;
    writeFileSync(join(diverged, "theirs.txt"), "kept\n");
    await git(diverged)`git add theirs.txt`;
    await git(diverged)`git commit -q -m theirs`;
    const theirTip = (await git(diverged)`git rev-parse HEAD`.text()).trim();
    const refused = await git(
      diverged,
    )`bash -c ${checkpointRestoreScript(ref, commit!, { onlyForward: true })}`
      .quiet()
      .nothrow();
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr.toString()).toContain(
      "commits the checkpoint does not include",
    );
    expect((await git(diverged)`git rev-parse HEAD`.text()).trim()).toBe(
      theirTip,
    );
    expect(readFileSync(join(diverged, "theirs.txt"), "utf-8")).toBe("kept\n");
    // The same checkout parked on an ancestor of the checkpoint is fine.
    await git(diverged)`git reset -q --hard origin/main`;
    const allowed = await git(
      diverged,
    )`bash -c ${checkpointRestoreScript(ref, commit!, { onlyForward: true })}`
      .quiet()
      .nothrow();
    expect(allowed.stderr.toString()).toBe("");
    expect(allowed.exitCode).toBe(0);
    expect(readFileSync(join(diverged, "new.txt"), "utf-8")).toBe(
      "untracked\n",
    );
  });

  test("restore refuses a checkout on another branch than the checkpoint's", async () => {
    const pushed = await runCheckpoint({});
    const [, commit] = pushed.stdout.toString().trim().split(/\s+/);
    const elsewhere = join(scratch, "elsewhere");
    await git(scratch)`git clone -q ${origin} elsewhere`;
    await git(elsewhere)`git checkout -q -b feature-b origin/main`;
    const tip = (await git(elsewhere)`git rev-parse HEAD`.text()).trim();
    const refused = await git(
      elsewhere,
    )`bash -c ${checkpointRestoreScript(ref, commit!, { branch: "feature" })}`
      .quiet()
      .nothrow();
    expect(refused.exitCode).not.toBe(0);
    expect((await git(elsewhere)`git rev-parse HEAD`.text()).trim()).toBe(tip);
    expect(
      (await git(elsewhere)`git branch --show-current`.text()).trim(),
    ).toBe("feature-b");
    // The same checkout on the checkpoint's branch restores.
    await git(elsewhere)`git checkout -q -b feature origin/main`;
    const allowed = await git(
      elsewhere,
    )`bash -c ${checkpointRestoreScript(ref, commit!, { branch: "feature" })}`
      .quiet()
      .nothrow();
    expect(allowed.stderr.toString()).toBe("");
    expect(allowed.exitCode).toBe(0);
  });

  test("restore refuses a ref that is not the recorded commit", async () => {
    const other = join(scratch, "other");
    await git(scratch)`git clone -q ${origin} other`;
    await git(other)`git checkout -q -b feature origin/main`;
    const restore = await git(
      other,
    )`bash -c ${checkpointRestoreScript(ref, "0".repeat(40))}`
      .quiet()
      .nothrow();
    expect(restore.exitCode).not.toBe(0);
    expect((await git(other)`git status --porcelain`.text()).trim()).toBe("");
  });
});
