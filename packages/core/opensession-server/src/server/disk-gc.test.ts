import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  diskUsagePct,
  findBuildCaches,
  hasEntryNewerThan,
  sweepDiskGc,
  worktreesInUse,
} from "./disk-gc";
import { __setWorkloadScopingForTest } from "./workload-scope";

const root = mkdtempSync(join(tmpdir(), "disk-gc-test-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** Build a worktree with an optional cargo target dir at `rel`. */
function worktree(
  name: string,
  opts: { targetAt?: string; cargo?: boolean; ageDays?: number } = {},
) {
  const wt = join(root, name);
  mkdirSync(wt, { recursive: true });
  if (opts.targetAt) {
    const target = join(wt, opts.targetAt);
    mkdirSync(join(target, "debug", "deps"), { recursive: true });
    writeFileSync(join(target, "debug", "deps", "lib.rlib"), "x");
    // Cargo marks its target dirs with CACHEDIR.TAG; that's how we identify them.
    if (opts.cargo !== false)
      writeFileSync(
        join(target, "CACHEDIR.TAG"),
        "Signature: 8a477f597d28d172",
      );
    if (opts.ageDays) {
      const t = new Date(Date.now() - opts.ageDays * 86_400_000);
      for (const p of [
        join(target, "debug", "deps", "lib.rlib"),
        join(target, "debug", "deps"),
        join(target, "debug"),
        join(target, "CACHEDIR.TAG"),
        target,
      ]) {
        try {
          utimesSync(p, t, t);
        } catch {
          /* CACHEDIR.TAG may not exist in the non-cargo case */
        }
      }
    }
    return target;
  }
  return wt;
}

worktree("tella-fusion-cold", { targetAt: "target", ageDays: 30 });
worktree("tella-fusion-cold", {
  targetAt: "packages/core/webapp/wasm-bindings/target",
  ageDays: 30,
});
worktree("tella-fusion-fresh", { targetAt: "target" });
worktree("tella-fusion-notcargo", { targetAt: "target", cargo: false });
worktree("tella-fusion-warm-template", { targetAt: "target", ageDays: 30 });
worktree("tella-fusion-ask-checkout", { targetAt: "target", ageDays: 30 });
/** A ReScript project at `rel` with build output in lib/ plus `extra` entries. */
function rescriptProject(name: string, rel: string, extra: string[] = []) {
  const project = join(root, name, rel);
  mkdirSync(join(project, "lib", "bs", "src"), { recursive: true });
  mkdirSync(join(project, "lib", "ocaml"), { recursive: true });
  writeFileSync(join(project, "lib", "bs", "src", "App.cmj"), "x");
  writeFileSync(join(project, "rescript.json"), "{}");
  for (const entry of extra) writeFileSync(join(project, "lib", entry), "x");
}

rescriptProject("tella-fusion-rescript", "packages/core/webapp");
// A lib/ that also holds hand-written files is source, not build output.
rescriptProject("tella-fusion-rescript-src", "packages/app", ["index.js"]);
// A lib/bs with no ReScript project beside it is not ours to judge.
mkdirSync(join(root, "tella-fusion-rescript-src", "lib", "bs"), {
  recursive: true,
});
// node_modules can contain a dir literally named "target" — must never match.
mkdirSync(join(root, "tella-fusion-fresh", "node_modules", "pkg", "target"), {
  recursive: true,
});

describe("findBuildCaches", () => {
  let found: Awaited<ReturnType<typeof findBuildCaches>>;
  let paths: string[];

  beforeAll(async () => {
    found = await findBuildCaches(root);
    paths = found.map((cache) => cache.path.slice(root.length + 1));
  });

  it("finds cargo target dirs, including nested ones", () => {
    expect(paths).toContain("tella-fusion-cold/target");
    expect(paths).toContain(
      "tella-fusion-cold/packages/core/webapp/wasm-bindings/target",
    );
    expect(paths).toContain("tella-fusion-fresh/target");
  });

  it("finds ReScript lib/ output beside a rescript.json", () => {
    const lib = found.find(
      (c) =>
        c.path === join(root, "tella-fusion-rescript/packages/core/webapp/lib"),
    );
    expect(lib?.kind).toBe("rescript");
    expect(lib?.worktree).toBe(join(root, "tella-fusion-rescript"));
    expect(found.find((c) => c.path.endsWith("/target"))?.kind).toBe("cargo");
  });

  it("ignores a lib/ holding anything but ReScript output, or with no project", () => {
    expect(paths.some((p) => p.startsWith("tella-fusion-rescript-src"))).toBe(
      false,
    );
  });

  it("ignores a non-cargo dir named target (no CACHEDIR.TAG)", () => {
    expect(paths).not.toContain("tella-fusion-notcargo/target");
  });

  it("never descends into node_modules", () => {
    expect(paths.some((p) => p.includes("node_modules"))).toBe(false);
  });

  it("spares infrastructure worktrees", () => {
    expect(paths.some((p) => p.startsWith("tella-fusion-warm-template"))).toBe(
      false,
    );
    expect(paths.some((p) => p.startsWith("tella-fusion-ask-checkout"))).toBe(
      false,
    );
  });

  it("attributes each cache to its worktree", () => {
    const nested = found.find((c) => c.path.includes("wasm-bindings"))!;
    expect(nested.worktree).toBe(join(root, "tella-fusion-cold"));
  });

  it("reports an old mtime for cold caches and a recent one for fresh", () => {
    const cold = found.find(
      (c) => c.path === join(root, "tella-fusion-cold", "target"),
    )!;
    const fresh = found.find(
      (c) => c.path === join(root, "tella-fusion-fresh", "target"),
    )!;
    const cutoff = Date.now() - 7 * 86_400_000;
    expect(cold.mtimeMs).toBeLessThan(cutoff);
    expect(fresh.mtimeMs).toBeGreaterThan(cutoff);
  });
});

describe("hasEntryNewerThan", () => {
  const cutoff = Date.now() - 24 * 3_600_000;

  it("is true for a freshly built cache", async () => {
    expect(
      await hasEntryNewerThan(
        join(root, "tella-fusion-fresh", "target"),
        cutoff,
      ),
    ).toBe(true);
  });

  it("is false for a cache untouched since the cutoff", async () => {
    expect(
      await hasEntryNewerThan(
        join(root, "tella-fusion-cold", "target"),
        cutoff,
      ),
    ).toBe(false);
  });

  it("is false for a path that does not exist", async () => {
    expect(await hasEntryNewerThan(join(root, "nope"), cutoff)).toBe(false);
  });
});

describe("worktreesInUse", () => {
  it("returns a set on supported hosts and never invents entries for an empty root", async () => {
    const inUse = await worktreesInUse(root);
    if (process.platform === "linux" || process.platform === "darwin")
      expect(inUse).not.toBeNull();
    if (inUse !== null) expect(inUse.size).toBe(0);
  });

  it("ignores a non-build process's cwd", async () => {
    // This test runs under `bun`, which never writes to a cargo target/. Idle
    // session subprocesses (stdio MCP servers, engine servers) sit in a
    // worktree for hours the same way; treating them as in-use pinned every
    // worktree and made the sweep reclaim nothing.
    const cwd = process.cwd();
    const inUse = await worktreesInUse(join(cwd, ".."));
    if (inUse !== null) expect(inUse.has(cwd)).toBe(false);
  });

  it("detects a real build process's cwd as in use", async () => {
    const wt = join(root, "wt-building");
    mkdirSync(wt, { recursive: true });
    // `cargo` is in BUILD_PROCESS_NAMES; sleep under that name stands in for a
    // build so the test needs no toolchain and leaves nothing to clean up.
    const fakeCargo = join(root, "cargo");
    if (process.platform === "darwin") symlinkSync("/bin/sleep", fakeCargo);
    else copyFileSync("/bin/sleep", fakeCargo);
    const proc = Bun.spawn([fakeCargo, "30"], { cwd: wt });
    try {
      await Bun.sleep(150);
      const inUse = await worktreesInUse(root);
      if (inUse !== null) expect(inUse.has(wt)).toBe(true);
    } finally {
      proc.kill();
      await proc.exited;
    }
  });

  it("treats a running ReScript compiler as a build", async () => {
    const wt = join(root, "wt-rescript");
    mkdirSync(wt, { recursive: true });
    const fakeBsc = join(root, "bsc.exe");
    if (process.platform === "darwin") symlinkSync("/bin/sleep", fakeBsc);
    else copyFileSync("/bin/sleep", fakeBsc);
    const proc = Bun.spawn([fakeBsc, "30"], { cwd: wt });
    try {
      await Bun.sleep(150);
      const inUse = await worktreesInUse(root);
      if (inUse !== null) expect(inUse.has(wt)).toBe(true);
    } finally {
      proc.kill();
      await proc.exited;
    }
  });
});

describe("sweepDiskGc under pressure", () => {
  const HOUR = 3_600_000;
  const ages = { "built-1h": 1, "idle-5h": 5, "idle-30h": 30 };

  /** A fresh worktree root with one cargo cache per age, plus a fake disk. */
  function fleet() {
    const sweepRoot = mkdtempSync(join(tmpdir(), "disk-gc-sweep-"));
    const targets = new Map<string, string>();
    for (const [name, hours] of Object.entries(ages)) {
      const target = join(sweepRoot, name, "target");
      mkdirSync(join(target, "debug", "deps"), { recursive: true });
      writeFileSync(join(target, "debug", "deps", "lib.rlib"), "x");
      writeFileSync(
        join(target, "CACHEDIR.TAG"),
        "Signature: 8a477f597d28d172",
      );
      const t = new Date(Date.now() - hours * HOUR);
      for (const path of [
        join(target, "debug", "deps", "lib.rlib"),
        join(target, "debug", "deps"),
        join(target, "debug"),
        join(target, "CACHEDIR.TAG"),
        target,
      ])
        utimesSync(path, t, t);
      targets.set(name, target);
    }
    return { sweepRoot, targets };
  }

  /** Usage that drops `perReclaim` points for each cache already removed. */
  function fakeDisk(
    targets: Map<string, string>,
    start: number,
    perReclaim: number,
  ) {
    return async () => {
      const gone = [...targets.values()].filter((t) => !existsSync(t)).length;
      return start - gone * perReclaim;
    };
  }

  beforeAll(() => __setWorkloadScopingForTest(false));
  afterAll(() => __setWorkloadScopingForTest(null));

  it("keeps caches built in the last 24h however long the disk stays over the threshold", async () => {
    const { sweepRoot, targets } = fleet();
    try {
      const result = await sweepDiskGc({
        root: sweepRoot,
        usagePct: fakeDisk(targets, 88, 0.5),
      });
      expect(result.reclaimed).toEqual([targets.get("idle-30h")!]);
      expect(existsSync(targets.get("idle-5h")!)).toBe(true);
      expect(existsSync(targets.get("built-1h")!)).toBe(true);
    } finally {
      rmSync(sweepRoot, { recursive: true, force: true });
    }
  });

  it("near a full disk reclaims recent idle caches only until back under the emergency line", async () => {
    const { sweepRoot, targets } = fleet();
    try {
      // 95% -> 94% after the 30h cache, still >= 92%, so the 5h cache goes
      // too. The cache built an hour ago is never a candidate.
      const result = await sweepDiskGc({
        root: sweepRoot,
        usagePct: fakeDisk(targets, 95, 1),
      });
      expect(result.reclaimed).toEqual([
        targets.get("idle-30h")!,
        targets.get("idle-5h")!,
      ]);
      expect(existsSync(targets.get("built-1h")!)).toBe(true);
    } finally {
      rmSync(sweepRoot, { recursive: true, force: true });
    }
  });

  it("stops the emergency pass as soon as usage is under the emergency line", async () => {
    const { sweepRoot, targets } = fleet();
    try {
      const result = await sweepDiskGc({
        root: sweepRoot,
        usagePct: fakeDisk(targets, 93, 2),
      });
      expect(result.reclaimed).toEqual([targets.get("idle-30h")!]);
      expect(existsSync(targets.get("idle-5h")!)).toBe(true);
    } finally {
      rmSync(sweepRoot, { recursive: true, force: true });
    }
  });
});

describe("diskUsagePct", () => {
  it("reports a plausible percentage", async () => {
    const pct = await diskUsagePct("/");
    expect(pct).toBeGreaterThan(0);
    expect(pct).toBeLessThanOrEqual(100);
  });
});

describe("event-loop safety", () => {
  it("does not use synchronous filesystem or subprocess APIs", async () => {
    const source = await Bun.file(
      new URL("./disk-gc.ts", import.meta.url),
    ).text();
    expect(source).not.toMatch(
      /\b(?:readdir|readFile|readlink|realpath|stat|statfs|spawn)Sync\b/,
    );
  });
});
