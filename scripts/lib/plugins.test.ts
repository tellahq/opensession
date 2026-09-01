import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import type {
  InstalledArtifact,
  PackageManifest,
} from "../../packages/core/opensession-server/src/server/plugins";
import {
  applyPlan,
  automationKey,
  planInstall,
  recipeFor,
  removeInstalled,
  resolveSource,
  reviewLines,
  type InstanceState,
  type InstanceStores,
} from "./plugins";

const MANIFEST: PackageManifest = {
  name: "video-library",
  version: "1.0.0",
  description: "Your team's videos as a project.",
  mcpServers: {
    "video-library": {
      type: "http",
      url: "https://mcp.video-library.example/mcp",
      headers: { Authorization: "${VIDEO_LIBRARY_TOKEN}" },
    },
  },
  feeds: [
    {
      id: "video-library",
      title: "Video library",
      refKind: "video-library",
      mcpServers: ["video-library"],
      items: {
        server: "video-library",
        tool: "list_videos",
        map: { id: "id", title: "name" },
      },
    },
  ],
  automations: [
    {
      id: "weekly",
      label: "Weekly digest",
      automation: {
        name: "Video library weekly digest",
        prompt: "Summarise last week.",
        schedule: "0 9 * * 1",
      },
    },
  ],
  skills: ["skills/video-library-editing"],
};

/**
 * The stores as maps. The port exists so a test never has to point the real
 * feeds or config writers at a scratch directory, which is one env var away
 * from writing into the live instance.
 */
function fakeStores(options: { failOn?: string } = {}) {
  const mcp = new Map<string, unknown>();
  const feeds = new Map<string, unknown>();
  const automations = new Map<string, string>();
  const skills = new Map<string, string>();

  const stores: InstanceStores = {
    async state(): Promise<InstanceState> {
      return {
        mcpServers: [...mcp.keys()],
        feeds: [...feeds.keys()],
        automations: new Set(automations.keys()),
        skills: [...skills.keys()],
      };
    },
    addMcpServer(name, entry, allowedUsers) {
      if (options.failOn === `mcp:${name}`) throw new Error("boom");
      mcp.set(
        name,
        allowedUsers ? { ...(entry as object), allowedUsers } : entry,
      );
    },
    removeMcpServer(name) {
      mcp.delete(name);
    },
    upsertFeed(feed) {
      const id = (feed as { id: string }).id;
      if (options.failOn === `feed:${id}`) throw new Error("boom");
      feeds.set(id, feed);
    },
    removeFeed(id) {
      feeds.delete(id);
    },
    async addAutomation(recipe, createdBy) {
      const key = automationKey(recipe.automation);
      if (options.failOn === `automation:${key}`) throw new Error("boom");
      automations.set(key, createdBy);
    },
    async removeAutomation(recipe) {
      automations.delete(automationKey(recipe.automation));
    },
    addSkill(name, sourceDir) {
      if (options.failOn === `skill:${name}`) throw new Error("boom");
      skills.set(name, sourceDir);
      return `sha-${name}`;
    },
    removeSkill(name) {
      skills.delete(name);
    },
  };

  return { stores, mcp, feeds, automations, skills };
}

async function install(
  fake: ReturnType<typeof fakeStores>,
  manifest = MANIFEST,
  owned: InstalledArtifact[] = [],
  allowedUsers?: string[],
) {
  const plan = planInstall(manifest, await fake.stores.state(), owned);
  const record = await applyPlan({
    manifest,
    plan,
    stores: fake.stores,
    dir: "/tmp/pkg",
    source: "acme/opensession-video-library",
    commit: "deadbeef",
    allowedUsers,
  });
  return { plan, record };
}

describe("resolveSource", () => {
  test("owner/repo becomes a GitHub clone URL", () => {
    expect(resolveSource("acme/opensession-video-library")).toEqual({
      url: "https://github.com/acme/opensession-video-library.git",
    });
  });

  test("git URLs and local paths pass through", () => {
    expect(resolveSource("https://git.example/x.git")).toEqual({
      url: "https://git.example/x.git",
    });
    expect(resolveSource("git@github.com:acme/x.git")).toEqual({
      url: "git@github.com:acme/x.git",
    });
    expect(resolveSource("/tmp/pkg")).toEqual({ url: "/tmp/pkg" });
  });

  // ext:: is remote command execution wearing a URL costume, and a leading
  // dash is an argument pretending to be a source.
  test("command-execution transports and argument injection are refused", () => {
    expect(resolveSource("ext::sh -c 'id'")).toHaveProperty("error");
    expect(resolveSource("--upload-pack=touch /tmp/x")).toHaveProperty("error");
    expect(resolveSource("")).toHaveProperty("error");
    expect(resolveSource("not a source")).toHaveProperty("error");
  });
});

describe("planInstall", () => {
  const empty: InstanceState = {
    mcpServers: [],
    feeds: [],
    automations: new Set(),
    skills: [],
  };

  test("every artifact in the manifest becomes an add", () => {
    const plan = planInstall(MANIFEST, empty);
    expect(plan.actions.map((a) => `${a.kind}:${a.ref}`)).toEqual([
      "mcp:video-library",
      "feed:video-library",
      "automation:Video library weekly digest",
      "skill:video-library-editing",
    ]);
    expect(plan.actions.every((a) => a.verb === "add")).toBe(true);
    expect(plan.conflicts).toEqual([]);
  });

  test("a name already taken by somebody else is a conflict, not a merge", () => {
    const plan = planInstall(MANIFEST, {
      ...empty,
      mcpServers: ["video-library"],
    });
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0]).toContain("not from this package");
    expect(plan.actions.map((a) => a.kind)).not.toContain("mcp");
  });

  test("a name this package already owns is an update", () => {
    const owned: InstalledArtifact[] = [{ kind: "mcp", ref: "video-library" }];
    const plan = planInstall(
      MANIFEST,
      { ...empty, mcpServers: ["video-library"] },
      owned,
    );
    expect(plan.conflicts).toEqual([]);
    expect(plan.actions.find((a) => a.kind === "mcp")?.verb).toBe("update");
  });

  test("an artifact the new manifest drops becomes a removal", () => {
    const owned: InstalledArtifact[] = [
      { kind: "mcp", ref: "video-library" },
      { kind: "feed", ref: "gone" },
    ];
    const plan = planInstall(
      MANIFEST,
      { ...empty, mcpServers: ["video-library"], feeds: ["gone"] },
      owned,
    );
    expect(plan.removals).toEqual([{ kind: "feed", ref: "gone" }]);
  });

  test("a feed pointing at a server nobody installs warns without blocking", () => {
    const manifest = { ...MANIFEST, mcpServers: undefined };
    const plan = planInstall(manifest, empty);
    expect(plan.conflicts).toEqual([]);
    expect(plan.warnings[0]).toContain("not installed");
  });

  test("the review names every artifact it would write", () => {
    const lines = reviewLines(MANIFEST, planInstall(MANIFEST, empty)).join(
      "\n",
    );
    expect(lines).toContain("mcp.video-library.example");
    expect(lines).toContain("VIDEO_LIBRARY_TOKEN");
    expect(lines).toContain("installs disabled");
  });

  test("a skill upstream rewrote is reported as a changed hash", () => {
    // The ADR's promise: a SKILL.md is text an agent loads into context, so an
    // upstream edit is a code change and the review has to say so rather than
    // print the same line it prints for an untouched one.
    const owned: InstalledArtifact[] = [
      { kind: "skill", ref: "video-library-editing", hash: "a".repeat(64) },
    ];
    const state = {
      ...empty,
      mcpServers: ["video-library"],
      feeds: ["video-library"],
      skills: ["video-library-editing"],
    };
    const changed = planInstall(MANIFEST, state, owned, () => "b".repeat(64));
    const line = reviewLines(MANIFEST, changed).find((l) =>
      l.includes("video-library-editing"),
    )!;
    expect(line).toContain("content changed: aaaaaaaa to bbbbbbbb");
    const action = changed.actions.find((a) => a.kind === "skill")!;
    expect(action).toMatchObject({
      hash: "b".repeat(64),
      previousHash: "a".repeat(64),
    });

    const same = planInstall(MANIFEST, state, owned, () => "a".repeat(64));
    expect(
      reviewLines(MANIFEST, same).find((l) =>
        l.includes("video-library-editing"),
      ),
    ).toContain("(unchanged)");

    // A first install has nothing to compare against and says nothing.
    const fresh = planInstall(MANIFEST, empty, [], () => "b".repeat(64));
    const freshLine = reviewLines(MANIFEST, fresh).find((l) =>
      l.includes("video-library-editing"),
    )!;
    expect(freshLine).not.toContain("changed");
    expect(freshLine).not.toContain("unchanged");
  });
});

describe("recipeFor", () => {
  test("a package automation always installs disabled", () => {
    const recipe = recipeFor("video-library", {
      id: "weekly",
      automation: { name: "n", prompt: "p", enabled: true },
    });
    expect(recipe.id).toBe("video-library/weekly");
    expect(recipe.automation.enabled).toBe(false);
  });
});

describe("install and remove", () => {
  test("installing writes every artifact and records what it wrote", async () => {
    const fake = fakeStores();
    const { record } = await install(fake);
    expect([...fake.mcp.keys()]).toEqual(["video-library"]);
    expect([...fake.feeds.keys()]).toEqual(["video-library"]);
    expect([...fake.automations.keys()]).toEqual([
      "Video library weekly digest",
    ]);
    expect([...fake.skills.keys()]).toEqual(["video-library-editing"]);
    expect(fake.automations.get("Video library weekly digest")).toBe(
      "opensession package: video-library",
    );
    expect(record.artifacts).toEqual([
      { kind: "mcp", ref: "video-library" },
      { kind: "feed", ref: "video-library" },
      { kind: "automation", ref: "Video library weekly digest" },
      {
        kind: "skill",
        ref: "video-library-editing",
        hash: "sha-video-library-editing",
      },
    ]);
    expect(record.commit).toBe("deadbeef");
    expect(record.updatedAt).toBeUndefined();
  });

  test("installing the same package again changes nothing", async () => {
    const fake = fakeStores();
    const first = await install(fake);
    const before = JSON.stringify([
      ...fake.mcp,
      ...fake.feeds,
      ...fake.automations,
      ...fake.skills,
    ]);

    const second = await install(fake, MANIFEST, first.record.artifacts);
    expect(second.plan.conflicts).toEqual([]);
    expect(second.plan.actions.every((a) => a.verb === "update")).toBe(true);
    expect(second.record.artifacts).toEqual(first.record.artifacts);
    expect(
      JSON.stringify([
        ...fake.mcp,
        ...fake.feeds,
        ...fake.automations,
        ...fake.skills,
      ]),
    ).toBe(before);
  });

  test("scoping is applied to the servers, and an update keeps it", async () => {
    const fake = fakeStores();
    const first = await install(fake, MANIFEST, [], ["michiel", "kent"]);
    expect(fake.mcp.get("video-library")).toMatchObject({
      allowedUsers: ["michiel", "kent"],
    });
    expect(first.record.allowedUsers).toEqual(["michiel", "kent"]);

    await install(
      fake,
      MANIFEST,
      first.record.artifacts,
      first.record.allowedUsers,
    );
    expect(fake.mcp.get("video-library")).toMatchObject({
      allowedUsers: ["michiel", "kent"],
    });
  });

  test("an update drops what the manifest no longer declares", async () => {
    const fake = fakeStores();
    const first = await install(fake);
    const trimmed: PackageManifest = { ...MANIFEST, feeds: [], skills: [] };
    const second = await install(fake, trimmed, first.record.artifacts);
    expect(second.plan.removals.map((r) => r.ref)).toEqual([
      "video-library",
      "video-library-editing",
    ]);
    expect([...fake.feeds.keys()]).toEqual([]);
    expect([...fake.skills.keys()]).toEqual([]);
    expect([...fake.mcp.keys()]).toEqual(["video-library"]);
  });

  test("removing reverses everything, and removing twice is not an error", async () => {
    const fake = fakeStores();
    const { record } = await install(fake);
    await removeInstalled(record, fake.stores);
    expect([
      ...fake.mcp.keys(),
      ...fake.feeds.keys(),
      ...fake.automations.keys(),
      ...fake.skills.keys(),
    ]).toEqual([]);
    await removeInstalled(record, fake.stores);
    expect([
      ...fake.mcp.keys(),
      ...fake.feeds.keys(),
      ...fake.automations.keys(),
      ...fake.skills.keys(),
    ]).toEqual([]);
  });

  test("install then remove then install lands in the same place", async () => {
    const fake = fakeStores();
    const first = await install(fake);
    await removeInstalled(first.record, fake.stores);
    const again = await install(fake);
    expect(again.record.artifacts).toEqual(first.record.artifacts);
    expect(again.plan.conflicts).toEqual([]);
  });

  // A half-installed package is worse than a failed one: nothing can cleanly
  // remove it, because nothing recorded what landed.
  test("a failure part-way through rolls back what it had already written", async () => {
    const fake = fakeStores({ failOn: "skill:video-library-editing" });
    await expect(install(fake)).rejects.toThrow("boom");
    expect([...fake.mcp.keys()]).toEqual([]);
    expect([...fake.feeds.keys()]).toEqual([]);
    expect([...fake.automations.keys()]).toEqual([]);
  });

  test("a rollback leaves a previous install of the same package alone", async () => {
    const fake = fakeStores();
    const first = await install(fake);

    // The same package again, now with a second server that fails.
    const grown: PackageManifest = {
      ...MANIFEST,
      mcpServers: { ...MANIFEST.mcpServers, extra: { command: "node" } },
    };
    const failing = fakeStores({ failOn: "mcp:extra" });
    // Reuse the first fake's state by replaying the install into it.
    failing.mcp.set("video-library", fake.mcp.get("video-library"));
    failing.feeds.set("video-library", fake.feeds.get("video-library"));
    failing.automations.set(
      "Video library weekly digest",
      "opensession package: video-library",
    );
    failing.skills.set(
      "video-library-editing",
      "/tmp/pkg/skills/video-library-editing",
    );

    const plan = planInstall(
      grown,
      await failing.stores.state(),
      first.record.artifacts,
    );
    await expect(
      applyPlan({
        manifest: grown,
        plan,
        stores: failing.stores,
        dir: "/tmp/pkg",
        source: "x",
      }),
    ).rejects.toThrow("boom");
    expect([...failing.mcp.keys()]).toEqual(["video-library"]);
    expect([...failing.feeds.keys()]).toEqual(["video-library"]);
  });
});

/**
 * `update` against a real upstream, through the real CLI.
 *
 * Everything above runs against fakes, which is what keeps them fast and keeps
 * them off the live stores. That leaves the verb itself untested: the git
 * fetch, the ledger, the real writers, and the difference between what the
 * first install wrote and what the second one has to reconcile. This drives all
 * of it in a subprocess whose state dir, config, MCP config and skills dir are
 * a temp directory, so it can use the real writers without being able to reach
 * the instance running it.
 */
describe("plugins update, end to end", () => {
  const CLI = join(resolve(import.meta.dir, "..", ".."), "scripts/cli.ts");

  function manifest(version: string, servers: string[]): string {
    return JSON.stringify({
      name: "scratch-pkg",
      version,
      description: "Scratch package",
      mcpServers: Object.fromEntries(
        servers.map((s) => [s, { command: "/bin/true", args: [`--${s}`] }]),
      ),
      skills: ["skills/scratch-demo"],
      automations: [
        {
          id: "sweep",
          automation: {
            name: "Scratch sweep",
            prompt: "Check it.",
            schedule: "0 9 * * *",
          },
        },
      ],
    });
  }

  test("a changed upstream is fetched, re-planned and reconciled", async () => {
    const root = mkdtempSync(join(tmpdir(), "plugins-update-"));
    const upstream = join(root, "upstream");
    const skill = join(upstream, "skills", "scratch-demo");
    const ledgerPath = join(root, "state", ".opensession-plugins.json");
    const mcpPath = join(root, "mcp-config.json");
    const skillsDir = join(root, "skills");
    const env = {
      ...process.env,
      OPENSESSION_STATE_DIR: join(root, "state"),
      OPENSESSION_CONFIG: join(root, "config.json"),
      OPENSESSION_SKILLS_DIR: skillsDir,
      OPENSESSION_MCP_CONFIG: mcpPath,
      GIT_AUTHOR_NAME: "Scratch",
      GIT_AUTHOR_EMAIL: "scratch@example.invalid",
      GIT_COMMITTER_NAME: "Scratch",
      GIT_COMMITTER_EMAIL: "scratch@example.invalid",
    };
    const git = (...args: string[]) =>
      Bun.spawnSync(["git", "-C", upstream, ...args], {
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
    const cli = (...args: string[]) => {
      const proc = Bun.spawnSync([process.execPath, CLI, "plugins", ...args], {
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      return {
        code: proc.exitCode,
        out: proc.stdout.toString() + proc.stderr.toString(),
      };
    };
    const ledger = () =>
      JSON.parse(readFileSync(ledgerPath, "utf8")).packages[0];
    const refs = (kind: string) =>
      ledger()
        .artifacts.filter((a: InstalledArtifact) => a.kind === kind)
        .map((a: InstalledArtifact) => a.ref);

    try {
      mkdirSync(join(root, "state"), { recursive: true });
      mkdirSync(skill, { recursive: true });
      writeFileSync(
        join(upstream, "opensession-plugin.json"),
        manifest("0.1.0", ["alpha", "beta"]),
      );
      writeFileSync(
        join(skill, "SKILL.md"),
        "---\nname: scratch-demo\n---\n\nVersion one.\n",
      );
      git("init", "-q", "-b", "main");
      git("add", "-A");
      git("commit", "-qm", "v1");

      const installed = cli("add", upstream, "--yes", "--users", "alice,bob");
      expect(installed.code).toBe(0);
      const before = ledger();
      expect(before.version).toBe("0.1.0");
      expect(refs("mcp")).toEqual(["alpha", "beta"]);

      // Upstream: the skill is rewritten, one server is dropped, another added.
      writeFileSync(
        join(upstream, "opensession-plugin.json"),
        manifest("0.2.0", ["alpha", "gamma"]),
      );
      writeFileSync(
        join(skill, "SKILL.md"),
        "---\nname: scratch-demo\n---\n\nVersion TWO.\n",
      );
      git("add", "-A");
      git("commit", "-qm", "v2");
      const head = Bun.spawnSync(["git", "-C", upstream, "rev-parse", "HEAD"], {
        env,
        stdout: "pipe",
      })
        .stdout.toString()
        .trim();

      const updated = cli("update", "scratch-pkg", "--yes");
      expect(updated.code).toBe(0);
      // The rewrite is named in the review rather than swapped in quietly.
      expect(updated.out).toContain("content changed:");
      expect(updated.out).toContain("upstream rewrote scratch-demo");
      expect(updated.out).toContain("removed (no longer in the manifest)");

      const after = ledger();
      expect(after.version).toBe("0.2.0");
      expect(after.commit).toBe(head);
      // The install date is the package's, not this fetch's.
      expect(after.installedAt).toBe(before.installedAt);
      expect(after.updatedAt).toBeTruthy();
      // Scoping is the operator's, and an update must not widen it back.
      expect(after.allowedUsers).toEqual(["alice", "bob"]);

      expect(refs("mcp")).toEqual(["alpha", "gamma"]);
      const servers = JSON.parse(readFileSync(mcpPath, "utf8")).mcpServers;
      expect(Object.keys(servers).sort()).toEqual(["alpha", "gamma"]);
      expect(servers.gamma.allowedUsers).toEqual(["alice", "bob"]);

      // The skill's recorded hash tracks the new text, which is on disk.
      const skillArtifact = ledger().artifacts.find(
        (a: InstalledArtifact) => a.kind === "skill",
      );
      const oldHash = before.artifacts.find(
        (a: InstalledArtifact) => a.kind === "skill",
      ).hash;
      expect(skillArtifact.hash).not.toBe(oldHash);
      expect(
        readFileSync(join(skillsDir, "scratch-demo", "SKILL.md"), "utf8"),
      ).toContain("Version TWO");

      // A dropped skill is a removal too, and takes its directory with it.
      writeFileSync(
        join(upstream, "opensession-plugin.json"),
        JSON.stringify({
          ...JSON.parse(manifest("0.3.0", ["alpha"])),
          skills: undefined,
        }),
      );
      git("add", "-A");
      git("commit", "-qm", "v3");
      expect(cli("update", "scratch-pkg", "--yes").code).toBe(0);
      expect(refs("skill")).toEqual([]);
      expect(existsSync(join(skillsDir, "scratch-demo"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);

  test("a package that renames itself upstream keeps one ledger entry", async () => {
    const root = mkdtempSync(join(tmpdir(), "plugins-rename-"));
    const upstream = join(root, "upstream");
    const ledgerPath = join(root, "state", ".opensession-plugins.json");
    const mcpPath = join(root, "mcp-config.json");
    const checkouts = join(root, "state", ".opensession-plugins");
    const env = {
      ...process.env,
      OPENSESSION_STATE_DIR: join(root, "state"),
      OPENSESSION_CONFIG: join(root, "config.json"),
      OPENSESSION_SKILLS_DIR: join(root, "skills"),
      OPENSESSION_MCP_CONFIG: mcpPath,
      GIT_AUTHOR_NAME: "Scratch",
      GIT_AUTHOR_EMAIL: "scratch@example.invalid",
      GIT_COMMITTER_NAME: "Scratch",
      GIT_COMMITTER_EMAIL: "scratch@example.invalid",
    };
    const git = (...args: string[]) =>
      Bun.spawnSync(["git", "-C", upstream, ...args], {
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
    const cli = (...args: string[]) => {
      const proc = Bun.spawnSync([process.execPath, CLI, "plugins", ...args], {
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      return {
        code: proc.exitCode,
        out: proc.stdout.toString() + proc.stderr.toString(),
      };
    };
    const packages = () =>
      JSON.parse(readFileSync(ledgerPath, "utf8")).packages;
    // Named differently from the package, so the rename cannot be read
    // off an artifact by accident.
    const named = (name: string, version: string, servers: string[]) =>
      JSON.stringify({
        name,
        version,
        description: "Scratch package",
        mcpServers: Object.fromEntries(
          servers.map((s) => [s, { command: "/bin/true", args: [`--${s}`] }]),
        ),
      });

    try {
      mkdirSync(join(root, "state"), { recursive: true });
      mkdirSync(upstream, { recursive: true });
      writeFileSync(
        join(upstream, "opensession-plugin.json"),
        named("scratch-pkg", "0.1.0", ["alpha", "beta"]),
      );
      git("init", "-q", "-b", "main");
      git("add", "-A");
      git("commit", "-qm", "v1");
      expect(cli("add", upstream, "--yes").code).toBe(0);
      const before = packages()[0];
      expect(before.name).toBe("scratch-pkg");

      // Upstream renames the package and drops a server. The remaining
      // server keeps its name, which is the half that used to fail: the
      // lookup missed the ledger entry, so "alpha" came back as a
      // collision with something this very package installed.
      writeFileSync(
        join(upstream, "opensession-plugin.json"),
        named("scratch-renamed", "0.2.0", ["alpha"]),
      );
      git("add", "-A");
      git("commit", "-qm", "v2");

      const updated = cli("update", "scratch-pkg", "--yes");
      expect(updated.code).toBe(0);
      expect(updated.out).toContain("renamed: scratch-pkg → scratch-renamed");

      // One entry, under the new name, carrying the original install.
      const after = packages();
      expect(after.map((p: { name: string }) => p.name)).toEqual([
        "scratch-renamed",
      ]);
      expect(after[0].version).toBe("0.2.0");
      expect(after[0].installedAt).toBe(before.installedAt);
      expect(after[0].artifacts.map((a: InstalledArtifact) => a.ref)).toEqual([
        "alpha",
      ]);

      // The dropped server really went, rather than being orphaned with
      // nothing in the ledger left pointing at it.
      expect(
        Object.keys(JSON.parse(readFileSync(mcpPath, "utf8")).mcpServers),
      ).toEqual(["alpha"]);
      expect(existsSync(join(checkouts, "scratch-pkg"))).toBe(false);

      // And the new name is what remove now answers to.
      expect(cli("update", "scratch-renamed", "--yes").code).toBe(0);
      expect(cli("remove", "scratch-renamed").code).toBe(0);
      expect(packages()).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});
