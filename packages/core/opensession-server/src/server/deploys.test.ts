import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point the registry and version store at a throwaway tree BEFORE importing —
// the real ~/.opensession-deploys holds published apps.
const ROOT = mkdtempSync(join(tmpdir(), "deploys-test-"));
process.env.OPENSESSION_DEPLOYS_DIR = ROOT;
process.env.OPENSESSION_DEPLOYS_REGISTRY = join(ROOT, "registry.json");

let dp: typeof import("./deploys");
let src: string;

beforeEach(async () => {
  process.env.OPENSESSION_DEPLOYS_DIR = ROOT;
  process.env.OPENSESSION_DEPLOYS_REGISTRY = join(ROOT, "registry.json");
  dp = await import("./deploys");
  dp.__resetDeploysForTest();
  if (existsSync(join(ROOT, "registry.json")))
    rmSync(join(ROOT, "registry.json"));
  src = mkdtempSync(join(tmpdir(), "deploys-src-"));
  writeFileSync(join(src, "server.ts"), "// app\n");
});

afterEach(() => {
  rmSync(src, { recursive: true, force: true });
});

afterEach(() => {
  // Nothing in this suite launches a process (publish is exercised through
  // publishDeploy's bookkeeping only when the entrypoint is a no-op `true`),
  // but make sure nothing is left registered.
  dp.__resetDeploysForTest();
});

describe("names", () => {
  test("accepts handles that make sane URL segments", () => {
    for (const ok of ["a", "counter", "my-tool-2", "x9"]) {
      expect(dp.isValidDeployName(ok)).toBe(true);
    }
  });

  test("rejects anything that would break /d/<name>/ or read as a path", () => {
    for (const bad of [
      "",
      "-lead",
      "trail-",
      "Upper",
      "has space",
      "a/b",
      "a".repeat(41),
      "a_b",
    ]) {
      expect(dp.isValidDeployName(bad), bad).toBe(false);
    }
  });
});

describe("entrypoint validation", () => {
  test("single commands are accepted", () => {
    for (const ok of [
      "bun server.ts",
      "node index.js",
      "python3 -u app.py",
      "sh start.sh",
    ]) {
      expect(dp.compoundEntrypointError(ok), ok).toBeNull();
    }
  });

  test("compound commands are rejected with a fix, since exec cannot supervise them", () => {
    for (const bad of [
      "cd app && node index.js",
      "node a.js; node b.js",
      "cat x | node -",
      "node a.js || node b.js",
    ]) {
      const err = dp.compoundEntrypointError(bad);
      expect(err, bad).toBeTruthy();
      expect(err).toContain("start script");
    }
  });

  test("redirections are not compound", () => {
    expect(dp.compoundEntrypointError("node index.js 2>&1")).toBeNull();
    expect(dp.compoundEntrypointError("node index.js >log.txt")).toBeNull();
  });
});

describe("snapshot filter", () => {
  test("skips build detritus and git, keeps everything else", () => {
    expect(dp.snapshotFilter("/x/app/node_modules")).toBe(false);
    expect(dp.snapshotFilter("/x/app/.git")).toBe(false);
    expect(dp.snapshotFilter("/x/app/dist")).toBe(false);
    expect(dp.snapshotFilter("/x/app/server.ts")).toBe(true);
    expect(dp.snapshotFilter("/x/app/public")).toBe(true);
  });
});

describe("publish bookkeeping", () => {
  const publish = (
    over: Partial<Parameters<typeof dp.publishDeploy>[0]> = {},
  ) =>
    dp.publishDeploy({
      dir: src,
      // `true` exits 0 immediately: enough to exercise versioning and the
      // registry without leaving a server bound to a port in CI.
      entrypoint: "true",
      name: "tool",
      owner: "Alex",
      ...over,
    });

  test("first publish creates v1, a snapshot, and a port in the deploy range", async () => {
    const r = await publish();
    expect(r.version).toBe(1);
    expect(r.deploy.port).toBeGreaterThanOrEqual(7100);
    expect(r.deploy.port).toBeLessThanOrEqual(7899);
    expect(existsSync(join(dp.versionDir(r.deploy.id, 1), "server.ts"))).toBe(
      true,
    );
    expect(await dp.listDeploys()).toHaveLength(1);
  });

  test("republishing the same name adds a version instead of a second app", async () => {
    await publish();
    const r2 = await publish();
    expect(r2.version).toBe(2);
    expect(r2.deploy.currentVersion).toBe(2);
    expect(await dp.listDeploys()).toHaveLength(1);
    expect(existsSync(dp.versionDir(r2.deploy.id, 1))).toBe(true);
  });

  test("each app gets its own port", async () => {
    const a = await publish({ name: "one" });
    const b = await publish({ name: "two" });
    expect(a.deploy.port).not.toBe(b.deploy.port);
  });

  test("rollback moves the live version and refuses versions that aren't retained", async () => {
    const r = await publish();
    await publish();
    const rolled = await dp.rollbackDeploy("tool", 1);
    expect(rolled.currentVersion).toBe(1);
    await expect(dp.rollbackDeploy("tool", 99)).rejects.toThrow(
      /isn't retained/,
    );
    expect(r.deploy.id).toBe(rolled.id);
  });

  test("renameFrom moves an existing app rather than creating one", async () => {
    await publish({ name: "old-name" });
    const r = await publish({ name: "new-name", renameFrom: "old-name" });
    expect(await dp.listDeploys()).toHaveLength(1);
    expect(r.deploy.name).toBe("new-name");
    expect(r.version).toBe(2);
    expect(await dp.getDeploy("old-name")).toBeUndefined();
    expect(await dp.getDeploy("new-name")).toBeDefined();
  });

  test("renaming onto a name another app already holds is refused", async () => {
    await publish({ name: "one" });
    await publish({ name: "two" });
    await expect(publish({ name: "one", renameFrom: "two" })).rejects.toThrow(
      /already taken/,
    );
  });

  test("bad input is rejected before anything is written", async () => {
    await expect(publish({ name: "Bad Name" })).rejects.toThrow(/name must be/);
    await expect(publish({ entrypoint: "  " })).rejects.toThrow(
      /entrypoint is required/,
    );
    await expect(publish({ entrypoint: "cd x && node y" })).rejects.toThrow(
      /single command/,
    );
    await expect(
      publish({ dir: join(ROOT, "does-not-exist") }),
    ).rejects.toThrow(/does not exist/);
    expect(await dp.listDeploys()).toHaveLength(0);
  });

  test("lookup works by name and by id, and is case-insensitive on the name", async () => {
    const r = await publish();
    expect((await dp.getDeploy("tool"))?.id).toBe(r.deploy.id);
    expect((await dp.getDeploy("TOOL"))?.id).toBe(r.deploy.id);
    expect((await dp.getDeploy(r.deploy.id))?.name).toBe("tool");
    expect(await dp.getDeploy("nope")).toBeUndefined();
  });

  test("only the last 10 versions are retained", async () => {
    let last: Awaited<ReturnType<typeof publish>> | undefined;
    for (let i = 0; i < 12; i++) last = await publish();
    expect(last!.version).toBe(12);
    const d = (await dp.getDeploy("tool"))!;
    expect(d.versions).toHaveLength(10);
    expect(d.versions[0]!.version).toBe(3);
    expect(existsSync(dp.versionDir(d.id, 1))).toBe(false);
    expect(existsSync(dp.versionDir(d.id, 12))).toBe(true);
  });

  test("data dir is separate from every version snapshot", async () => {
    const r = await publish();
    mkdirSync(dp.dataDir(r.deploy.id), { recursive: true });
    writeFileSync(join(dp.dataDir(r.deploy.id), "app.db"), "state");
    await publish();
    // The redeploy created a new snapshot; durable data is untouched by it.
    expect(existsSync(join(dp.dataDir(r.deploy.id), "app.db"))).toBe(true);
    expect(dp.dataDir(r.deploy.id)).not.toContain("/versions/");
  });
});
