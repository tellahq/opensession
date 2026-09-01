import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { __setSessionsDirForTest } from "./paths";
import {
  filterManifest,
  isNodeModulesEntry,
  seedableManifest,
  templateStatus,
  type TemplateStatus,
  type WarmTemplateState,
} from "./warm-template";

// The manifest is `git ls-files -o -i --exclude-standard --directory` output
// from the template worktree: fully-ignored dirs collapsed with a trailing
// slash, individually-ignored files (ReScript's in-source *.res.mjs) listed
// one per line. filterManifest strips the runtime junk that must never be
// seeded into a fresh worktree.

describe("filterManifest", () => {
  test("keeps build artifacts, drops runtime junk", () => {
    const raw = [
      "node_modules/",
      "packages/core/webapp/node_modules/",
      "packages/core/webapp/.next/",
      "packages/core/webapp/lib/",
      "packages/core/webapp/src/frontend/App.res.mjs",
      "packages/core/webapp/src/bindings/wasm-bindings/tella_wasm_bindings.js",
      ".ports.conf",
      ".ports/",
      ".tunnels.env",
      "dev-server.log",
      "packages/core/webapp/.env.local",
      "packages/core/webapp/.env.development",
      ".direnv/",
      ".DS_Store",
      "packages/.DS_Store",
      "",
      "   ",
    ];
    expect(filterManifest(raw)).toEqual([
      "node_modules/",
      "packages/core/webapp/node_modules/",
      "packages/core/webapp/.next/",
      "packages/core/webapp/lib/",
      "packages/core/webapp/src/frontend/App.res.mjs",
      "packages/core/webapp/src/bindings/wasm-bindings/tella_wasm_bindings.js",
    ]);
  });

  test("keeps files that merely contain 'log' or 'env' in their name", () => {
    expect(
      filterManifest([
        "packages/logger/dist/",
        "src/environment.res.mjs",
        "catalog.res.mjs",
      ]),
    ).toEqual([
      "packages/logger/dist/",
      "src/environment.res.mjs",
      "catalog.res.mjs",
    ]);
  });
});

describe("seedableManifest", () => {
  test("keeps only node_modules trees — warm-preview-era manifests seed identically", () => {
    // A manifest captured before 2026-07-21 also lists .next/ReScript/WASM
    // artifacts; the same filter runs at capture AND seed time, so those
    // entries are ignored wherever they come from.
    const legacy = [
      "node_modules/",
      "packages/core/webapp/node_modules/",
      "packages/core/webapp/.next/",
      "packages/core/webapp/lib/",
      "packages/core/webapp/src/frontend/App.res.mjs",
      ".ports.conf",
      "dev-server.log",
    ];
    expect(seedableManifest(legacy)).toEqual([
      "node_modules/",
      "packages/core/webapp/node_modules/",
    ]);
  });
});

describe("isNodeModulesEntry", () => {
  test("matches node_modules dirs at any depth (hardlink-safe)", () => {
    expect(isNodeModulesEntry("node_modules/")).toBe(true);
    expect(isNodeModulesEntry("packages/core/webapp/node_modules/")).toBe(true);
  });

  test("everything else is a real copy (compilers rewrite in place)", () => {
    expect(isNodeModulesEntry("packages/core/webapp/.next/")).toBe(false);
    expect(isNodeModulesEntry("packages/core/webapp/lib/")).toBe(false);
    expect(isNodeModulesEntry("src/App.res.mjs")).toBe(false);
    // A file INSIDE node_modules would come from a partial listing — the
    // manifest only carries the collapsed dir, so anything else copies.
    expect(isNodeModulesEntry("node_modules/react/package.json")).toBe(false);
  });
});

// ── templateStatus ───────────────────────────────────────────────────────────
//
// One predicate for "is this template usable", over a throwaway state dir:
// state file + manifest + the dep trees on disk + both refresh guards. The
// case that motivates it is "ok but gutted" (state.ok true, trees gone),
// which used to seed a worktree a half-linked node_modules.

type Case = {
  name: string;
  /** ok / sha / dir written into <repo>.state.json (null = no state file). */
  state: Partial<WarmTemplateState> | null;
  /** manifest lines (null = no manifest file). */
  manifest: string[] | null;
  /** dep trees actually created under the template dir. */
  trees: string[];
  /** refresh lock file, with an mtime this many ms in the past. */
  lockAgeMs?: number;
  /** omit the template worktree dir entirely. */
  noTemplateDir?: boolean;
  expect: TemplateStatus["kind"];
  reason?: string;
};

const CASES: Case[] = [
  {
    name: "ok with every tree present",
    state: { ok: true, sha: "abc1234" },
    manifest: ["node_modules/", "packages/webapp/node_modules/"],
    trees: ["node_modules", "packages/webapp/node_modules"],
    expect: "warm",
  },
  {
    name: "ok but gutted (trees deleted under a live state file)",
    state: { ok: true, sha: "abc1234" },
    manifest: ["node_modules/", "packages/webapp/node_modules/"],
    trees: ["node_modules"],
    expect: "stale",
    reason: "packages/webapp/node_modules/ missing",
  },
  {
    name: "ok but the template worktree is gone",
    state: { ok: true, sha: "abc1234" },
    manifest: ["node_modules/"],
    trees: [],
    noTemplateDir: true,
    expect: "stale",
    reason: "template worktree missing",
  },
  {
    name: "no manifest (refresh never captured one)",
    state: { ok: true, sha: "abc1234" },
    manifest: null,
    trees: ["node_modules"],
    expect: "stale",
    reason: "no manifest",
  },
  {
    name: "manifest lists no node_modules trees",
    state: { ok: true, sha: "abc1234" },
    manifest: ["packages/webapp/.next/"],
    trees: ["packages/webapp/.next"],
    expect: "stale",
    reason: "no dep trees",
  },
  {
    name: "last refresh failed",
    state: { ok: false, sha: "abc1234", lastError: "install deps timed out" },
    manifest: ["node_modules/"],
    trees: ["node_modules"],
    expect: "stale",
    reason: "install deps timed out",
  },
  {
    name: "refresh succeeded but wrote no sha",
    state: { ok: true },
    manifest: ["node_modules/"],
    trees: ["node_modules"],
    expect: "stale",
  },
  {
    name: "no state at all",
    state: null,
    manifest: null,
    trees: [],
    expect: "absent",
  },
  {
    name: "refresh lock held (another process is resetting the tree)",
    state: { ok: true, sha: "abc1234" },
    manifest: ["node_modules/"],
    trees: ["node_modules"],
    lockAgeMs: 1000,
    expect: "refreshing",
  },
  {
    name: "stale lock (crashed refresh) doesn't wedge seeding forever",
    state: { ok: true, sha: "abc1234" },
    manifest: ["node_modules/"],
    trees: ["node_modules"],
    lockAgeMs: 30 * 60_000,
    expect: "warm",
  },
];

describe("templateStatus", () => {
  for (const c of CASES) {
    test(c.name, () => {
      const root = mkdtempSync(join(tmpdir(), "warm-template-"));
      const warm = join(root, "warm-templates");
      const templateDir = join(root, "app-warm-template");
      mkdirSync(warm, { recursive: true });
      if (!c.noTemplateDir) mkdirSync(templateDir, { recursive: true });
      for (const t of c.trees)
        mkdirSync(join(templateDir, t), { recursive: true });
      if (c.state) {
        writeFileSync(
          join(warm, "app.state.json"),
          JSON.stringify({ repoId: "app", dir: templateDir, ...c.state }),
        );
      }
      if (c.manifest) {
        writeFileSync(join(warm, "app.manifest"), c.manifest.join("\n") + "\n");
      }
      if (c.lockAgeMs != null) {
        const lock = join(warm, "app.refresh.lock");
        writeFileSync(lock, "1234\n");
        const when = new Date(Date.now() - c.lockAgeMs);
        utimesSync(lock, when, when);
      }
      const prev = __setSessionsDirForTest(root);
      try {
        const status = templateStatus("app");
        expect(status.kind).toBe(c.expect);
        if (c.reason && status.kind === "stale")
          expect(status.reason).toContain(c.reason);
        // Only "warm" carries the entries, so no caller can link from a
        // template it did not verify.
        if (status.kind === "warm") {
          expect(status.dir).toBe(templateDir);
          expect(status.sha).toBe("abc1234");
          expect(status.entries).toEqual(
            c.manifest!.filter(isNodeModulesEntry),
          );
        }
      } finally {
        __setSessionsDirForTest(prev);
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});
