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

  test("first publish creates v1, a snapshot, and a port in the deploy range", () => {
    const r = publish();
    expect(r.version).toBe(1);
    expect(r.deploy.port).toBeGreaterThanOrEqual(7100);
    expect(r.deploy.port).toBeLessThanOrEqual(7899);
    expect(existsSync(join(dp.versionDir(r.deploy.id, 1), "server.ts"))).toBe(
      true,
    );
    expect(dp.listDeploys()).toHaveLength(1);
  });

  test("republishing the same name adds a version instead of a second app", () => {
    publish();
    const r2 = publish();
    expect(r2.version).toBe(2);
    expect(r2.deploy.currentVersion).toBe(2);
    expect(dp.listDeploys()).toHaveLength(1);
    expect(existsSync(dp.versionDir(r2.deploy.id, 1))).toBe(true);
  });

  test("each app gets its own port", () => {
    const a = publish({ name: "one" });
    const b = publish({ name: "two" });
    expect(a.deploy.port).not.toBe(b.deploy.port);
  });

  test("rollback moves the live version and refuses versions that aren't retained", () => {
    const r = publish();
    publish();
    const rolled = dp.rollbackDeploy("tool", 1);
    expect(rolled.currentVersion).toBe(1);
    expect(() => dp.rollbackDeploy("tool", 99)).toThrow(/isn't retained/);
    expect(r.deploy.id).toBe(rolled.id);
  });

  test("renameFrom moves an existing app rather than creating one", () => {
    publish({ name: "old-name" });
    const r = publish({ name: "new-name", renameFrom: "old-name" });
    expect(dp.listDeploys()).toHaveLength(1);
    expect(r.deploy.name).toBe("new-name");
    expect(r.version).toBe(2);
    expect(dp.getDeploy("old-name")).toBeUndefined();
    expect(dp.getDeploy("new-name")).toBeDefined();
  });

  test("renaming onto a name another app already holds is refused", () => {
    publish({ name: "one" });
    publish({ name: "two" });
    expect(() => publish({ name: "one", renameFrom: "two" })).toThrow(
      /already taken/,
    );
  });

  test("bad input is rejected before anything is written", () => {
    expect(() => publish({ name: "Bad Name" })).toThrow(/name must be/);
    expect(() => publish({ entrypoint: "  " })).toThrow(
      /entrypoint is required/,
    );
    expect(() => publish({ entrypoint: "cd x && node y" })).toThrow(
      /single command/,
    );
    expect(() => publish({ dir: join(ROOT, "does-not-exist") })).toThrow(
      /does not exist/,
    );
    expect(dp.listDeploys()).toHaveLength(0);
  });

  test("lookup works by name and by id, and is case-insensitive on the name", () => {
    const r = publish();
    expect(dp.getDeploy("tool")?.id).toBe(r.deploy.id);
    expect(dp.getDeploy("TOOL")?.id).toBe(r.deploy.id);
    expect(dp.getDeploy(r.deploy.id)?.name).toBe("tool");
    expect(dp.getDeploy("nope")).toBeUndefined();
  });

  test("only the last 10 versions are retained", () => {
    let last: ReturnType<typeof publish> | undefined;
    for (let i = 0; i < 12; i++) last = publish();
    expect(last!.version).toBe(12);
    const d = dp.getDeploy("tool")!;
    expect(d.versions).toHaveLength(10);
    expect(d.versions[0]!.version).toBe(3);
    expect(existsSync(dp.versionDir(d.id, 1))).toBe(false);
    expect(existsSync(dp.versionDir(d.id, 12))).toBe(true);
  });

  test("data dir is separate from every version snapshot", () => {
    const r = publish();
    mkdirSync(dp.dataDir(r.deploy.id), { recursive: true });
    writeFileSync(join(dp.dataDir(r.deploy.id), "app.db"), "state");
    publish();
    // The redeploy created a new snapshot; durable data is untouched by it.
    expect(existsSync(join(dp.dataDir(r.deploy.id), "app.db"))).toBe(true);
    expect(dp.dataDir(r.deploy.id)).not.toContain("/versions/");
  });
});
