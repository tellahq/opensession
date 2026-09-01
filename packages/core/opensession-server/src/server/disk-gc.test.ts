import { afterAll, describe, expect, it } from "bun:test";
import {
  copyFileSync,
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
  findTargetCaches,
  hasEntryNewerThan,
  worktreesInUse,
} from "./disk-gc";

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
// node_modules can contain a dir literally named "target" — must never match.
mkdirSync(join(root, "tella-fusion-fresh", "node_modules", "pkg", "target"), {
  recursive: true,
});

describe("findTargetCaches", () => {
  const found = findTargetCaches(root);
  const paths = found.map((c) => c.path.slice(root.length + 1));

  it("finds cargo target dirs, including nested ones", () => {
    expect(paths).toContain("tella-fusion-cold/target");
    expect(paths).toContain(
      "tella-fusion-cold/packages/core/webapp/wasm-bindings/target",
    );
    expect(paths).toContain("tella-fusion-fresh/target");
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

  it("is true for a freshly built cache", () => {
    expect(
      hasEntryNewerThan(join(root, "tella-fusion-fresh", "target"), cutoff),
    ).toBe(true);
  });

  it("is false for a cache untouched since the cutoff", () => {
    expect(
      hasEntryNewerThan(join(root, "tella-fusion-cold", "target"), cutoff),
    ).toBe(false);
  });

  it("is false for a path that does not exist", () => {
    expect(hasEntryNewerThan(join(root, "nope"), cutoff)).toBe(false);
  });
});

describe("worktreesInUse", () => {
  it("returns a set on supported hosts and never invents entries for an empty root", () => {
    const inUse = worktreesInUse(root);
    if (process.platform === "linux" || process.platform === "darwin")
      expect(inUse).not.toBeNull();
    if (inUse !== null) expect(inUse.size).toBe(0);
  });

  it("ignores a non-build process's cwd", () => {
    // This test runs under `bun`, which never writes to a cargo target/. Idle
    // session subprocesses (stdio MCP servers, engine servers) sit in a
    // worktree for hours the same way; treating them as in-use pinned every
    // worktree and made the sweep reclaim nothing.
    const cwd = process.cwd();
    const inUse = worktreesInUse(join(cwd, ".."));
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
      const inUse = worktreesInUse(root);
      if (inUse !== null) expect(inUse.has(wt)).toBe(true);
    } finally {
      proc.kill();
      await proc.exited;
    }
  });
});

describe("diskUsagePct", () => {
  it("reports a plausible percentage", () => {
    const pct = diskUsagePct("/");
    expect(pct).toBeGreaterThan(0);
    expect(pct).toBeLessThanOrEqual(100);
  });
});
