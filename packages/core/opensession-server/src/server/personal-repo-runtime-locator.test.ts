import { afterAll, expect, spyOn, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPersonalRepoRuntime,
  type PersonalRepoBinding,
} from "./personal-repo-runtime";
import {
  createPersonalRepoGit,
  executePersonalGit,
} from "./personal-repo-runtime-git";
import {
  PERSONAL_HOST_AUTH_FILE,
  preparePersonalHostProjection,
} from "./personal-repo-runtime-host";
import * as defaults from "./personal-repo-runtime-default";
import { closePersonalPolicyClient } from "./personal-repo-runtime-policy";

const policyRoot = await mkdtemp(join(tmpdir(), "locator-policy-"));
const oldConfig = process.env.OPENSESSION_CONFIG;
process.env.OPENSESSION_CONFIG = join(policyRoot, "config.json");
await writeFile(process.env.OPENSESSION_CONFIG, "{}");
afterAll(async () => {
  closePersonalPolicyClient();
  if (oldConfig === undefined) delete process.env.OPENSESSION_CONFIG;
  else process.env.OPENSESSION_CONFIG = oldConfig;
  await rm(policyRoot, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "personal-locator-"));
  const seed = join(root, "seed");
  const env = {
    PATH: process.env.PATH || "/usr/bin:/bin",
    HOME: root,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  const git = (args: string[], cwd?: string) =>
    executePersonalGit({ args, cwd, env });
  await git(["init", "--initial-branch=trunk", seed]);
  await writeFile(join(seed, "fixture.txt"), "synthetic repository A\n");
  await git(["add", "."], seed);
  await git(
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-m",
      "Synthetic fixture\n\nCo-authored-by: Jaap Frolich <jfrolich@gmail.com>",
    ],
    seed,
  );
  const binding: PersonalRepoBinding = {
    registryId: "personal-A",
    descriptor: {
      kind: "personal",
      ownerGithubAccountId: 41,
      repositoryOwnerGithubAccountId: 41,
      repositoryId: 301,
      installationId: 201,
      githubAppId: 101,
      appRecordId: "fixture-app",
      accessRevision: 1,
      fullName: "fixture/old-name",
    },
  };
  let name = binding.descriptor.fullName;
  let renameOnWrite = false;
  const commands: Array<{ args: string[]; token: string; cwd?: string }> = [];
  const adapter = createPersonalRepoGit(async (command) => {
    commands.push({
      args: command.args,
      token: command.env.GH_TOKEN!,
      cwd: command.cwd,
    });
    // Only synthetic network operations use file substitution. All inspection
    // sees the exact production credential environment and effective Git URLs.
    const network = ["clone", "fetch", "ls-remote"].includes(command.args[0]!);
    return executePersonalGit({
      ...command,
      env: {
        ...command.env,
        ...(network
          ? {
              GIT_CONFIG_VALUE_5: "always",
              GIT_CONFIG_COUNT: "9",
              GIT_CONFIG_KEY_7: `url.file://${seed}.insteadOf`,
              GIT_CONFIG_VALUE_7: "https://github.com/fixture/old-name.git",
              GIT_CONFIG_KEY_8: `url.file://${seed}.insteadOf`,
              GIT_CONFIG_VALUE_8: "https://github.com/fixture/new-name.git",
            }
          : {}),
      },
    });
  });
  const runtime = createPersonalRepoRuntime({
    root: join(root, "runtime"),
    git: adapter,
    readPersonalRepository: async () => binding,
    resolveCredential: async (owner, d, kind) => {
      if (renameOnWrite && kind === "installation-write")
        name = "fixture/new-name";
      return {
        ok: true,
        credential: {
          ownerGithubAccountId: owner,
          appRecordId: d.appRecordId,
          repositoryId: d.repositoryId,
          installationId: d.installationId,
          accessRevision: d.accessRevision,
          fullName: name,
          kind,
          token: `synthetic-${kind}`,
          expiresAt: Date.now() + 3600_000,
        },
      };
    },
  });
  const prepared = await runtime.prepare(41, binding, {
    sessionId: "s",
    mode: "code",
  });
  let attempt = 0;
  const admit = async () => {
    const dir = join(root, `host-${++attempt}`);
    await mkdir(dir);
    const spy = spyOn(defaults, "personalRepoRuntime").mockResolvedValue(
      runtime,
    );
    try {
      await preparePersonalHostProjection(
        {
          hostId: `rh-${crypto.randomUUID()}`,
          logicalRunId: "fixture-logical-run",
          mcpServers: [],
          proxyMcpServers: [],
          osSessionId: "s",
          cwd: prepared.cwd,
          personalRepo: binding,
          mode: "code",
          user: "Alice",
          journalKind: "prompt",
          prompt: "fixture",
        },
        dir,
        "synthetic-hash",
      );
      return JSON.parse(
        await readFile(join(dir, PERSONAL_HOST_AUTH_FILE), "utf8"),
      );
    } catch (error) {
      expect(await Bun.file(join(dir, PERSONAL_HOST_AUTH_FILE)).exists()).toBe(
        false,
      );
      throw error;
    } finally {
      spy.mockRestore();
    }
  };
  return {
    root,
    git,
    binding,
    runtime,
    prepared,
    commands,
    admit,
    rename() {
      name = "fixture/new-name";
    },
    renameDuringProjection() {
      renameOnWrite = true;
    },
    close: () => rm(root, { recursive: true, force: true }),
  };
}

test("launch/respawn reject renamed A whose old locator can name selected B, unchanged numeric tuple/revision", async () => {
  const f = await fixture();
  try {
    const first = await f.admit();
    expect(first.repo.ghRepo).toBe("fixture/old-name");
    expect(first.env.GH_TOKEN).toBe("synthetic-installation-write");
    f.rename(); // A remains 301/revision 1; old-name can now identify selected B.
    expect(
      (await f.runtime.projectCredential(41, f.binding, "installation-write"))
        .fullName,
    ).toBe("fixture/new-name");
    await expect(
      f.runtime.assertWorkspace(41, f.binding, "s", f.prepared.cwd),
    ).rejects.toThrow("Personal repository unavailable");
    await expect(f.admit()).rejects.toThrow("Personal repository unavailable");
    await expect(f.admit()).rejects.toThrow("Personal repository unavailable");
    expect(
      await f.git(["config", "--get", "remote.origin.url"], f.prepared.cwd),
    ).toBe("https://github.com/fixture/old-name.git");
  } finally {
    await f.close();
  }
}, 30_000);

test("rename between resolve and final user credential cannot publish an earlier locator", async () => {
  const f = await fixture();
  try {
    f.renameDuringProjection();
    await expect(f.admit()).rejects.toThrow("Personal repository unavailable");
    expect(
      f.commands.some(
        (c) =>
          c.args[0] === "remote" && c.token === "synthetic-installation-write",
      ),
    ).toBe(false);
  } finally {
    await f.close();
  }
}, 30_000);

test("final-credential admission permits same-repository branch and detached-HEAD transitions", async () => {
  const f = await fixture();
  try {
    await f.git(["checkout", "-b", "legitimate-new-branch"], f.prepared.cwd);
    await f.admit();
    await f.git(["checkout", "--detach"], f.prepared.cwd);
    await f.admit();
    expect(
      f.commands.some(
        (c) =>
          c.args[0] === "remote" && c.token === "synthetic-installation-write",
      ),
    ).toBe(true);
    expect(
      f.commands
        .filter((c) => c.args[0] === "ls-remote")
        .every((c) => c.cwd?.endsWith("/home")),
    ).toBe(true);
  } finally {
    await f.close();
  }
}, 30_000);

test("effective fetch/push URLs, upstream and branch transport selectors cannot redirect final credential", async () => {
  const f = await fixture();
  const url = "https://github.com/fixture/old-name.git";
  try {
    const config = join(f.prepared.repo.repo, ".git/config");
    const original = await readFile(config, "utf8");
    for (const [key, value] of [
      ["remote.origin.pushurl", "https://github.com/fixture/B.git"],
      ["remote.upstream.url", "https://github.com/fixture/B.git"],
      ["url.https://github.com/fixture/B.git.insteadOf", url],
      ["url.https://github.com/fixture/B.git.pushInsteadOf", url],
      ["url.ssh://git@github.com/fixture/old-name.git.pushInsteadOf", url],
      [
        `branch.${f.prepared.branch}.pushRemote`,
        "https://github.com/fixture/B.git",
      ],
      [
        `branch.${f.prepared.branch}.remote`,
        "https://github.com/fixture/B.git",
      ],
      ["remote.pushDefault", "https://github.com/fixture/B.git"],
      ["remote.origin.vcs", "untrusted-transport"],
      ["remote.origin.pushurl", `${url} `],
    ]) {
      await f.git(["config", "--local", key!, value!], f.prepared.cwd);
      await expect(f.admit()).rejects.toThrow(
        "Personal repository unavailable",
      );
      await writeFile(config, original);
    }
    await f.git(
      ["config", "remote.origin.url", "https://github.com/fixture/B.git"],
      f.prepared.cwd,
    );
    await f.git(
      ["config", `url.${url}.insteadOf`, "https://github.com/fixture/B.git"],
      f.prepared.cwd,
    );
    // Git could fetch A while gh reads raw B. Both locators must agree.
    await expect(f.admit()).rejects.toThrow("Personal repository unavailable");
    await writeFile(config, original);
    await f.git(
      ["config", "--add", "remote.origin.pushurl", url],
      f.prepared.cwd,
    );
    await f.git(
      [
        "config",
        "--add",
        "remote.origin.pushurl",
        "https://github.com/fixture/B.git",
      ],
      f.prepared.cwd,
    );
    await expect(f.admit()).rejects.toThrow("Personal repository unavailable");
    await writeFile(config, original);
    const included = join(f.root, "included.config");
    await writeFile(
      included,
      `[url "ssh://git@github.com/fixture/old-name.git"]\n pushInsteadOf = ${url}\n`,
    );
    await f.git(["config", "include.path", included], f.prepared.cwd);
    await expect(f.admit()).rejects.toThrow("Personal repository unavailable");
    await writeFile(config, original);
    await f.git(
      ["config", "extensions.worktreeConfig", "true"],
      f.prepared.cwd,
    );
    await f.git(
      [
        "config",
        "--worktree",
        "remote.origin.pushurl",
        "https://github.com/fixture/B.git",
      ],
      f.prepared.cwd,
    );
    await expect(f.admit()).rejects.toThrow("Personal repository unavailable");
  } finally {
    await f.close();
  }
}, 30_000);

test("derived cwd alone cannot authorize another Git common directory", async () => {
  const f = await fixture();
  try {
    const other = join(f.root, "other");
    await f.git(["init", "--initial-branch=trunk", other]);
    await writeFile(
      join(f.prepared.cwd, ".git"),
      `gitdir: ${join(other, ".git")}\n`,
    );
    await expect(
      f.runtime.assertWorkspace(41, f.binding, "s", f.prepared.cwd),
    ).rejects.toThrow("Personal repository unavailable");
    await expect(f.admit()).rejects.toThrow("Personal repository unavailable");
  } finally {
    await f.close();
  }
}, 30_000);
