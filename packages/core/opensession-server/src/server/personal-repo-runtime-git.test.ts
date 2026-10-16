import { expect, test } from "bun:test";
import { mkdtemp, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPersonalRepoGit,
  executePersonalGit,
} from "./personal-repo-runtime-git";
import {
  createPersonalRepoRuntime,
  type PersonalRepoBinding,
} from "./personal-repo-runtime";

test("real synthetic git clone/worktree recovery uses no live remote or ambient authority", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "personal-runtime-git-"));
  const seed = join(tmp, "seed");
  const env = {
    PATH: process.env.PATH || "/usr/bin:/bin",
    HOME: tmp,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  const git = (args: string[], cwd?: string) =>
    executePersonalGit({ args, cwd, env });
  try {
    await git(["init", "--initial-branch=trunk", seed]);
    await writeFile(join(seed, "fixture.txt"), "synthetic only\n");
    await git(["add", "fixture.txt"], seed);
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
    const calls: string[][] = [];
    const adapter = createPersonalRepoGit(async (command) => {
      calls.push(command.args);
      expect(command.env.GH_TOKEN).toBe("synthetic-read");
      expect(command.env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
      // Synthetic-only transport substitution. The production adapter always
      // denies file transport; no actual GitHub request or credential is used.
      return executePersonalGit({
        ...command,
        env: {
          ...command.env,
          ...(["clone", "fetch", "ls-remote"].includes(command.args[0]!)
            ? {
                GIT_CONFIG_VALUE_5: "always",
                GIT_CONFIG_COUNT: "8",
                GIT_CONFIG_KEY_7: `url.file://${seed}.insteadOf`,
                GIT_CONFIG_VALUE_7: "https://github.com/fixture/private.git",
              }
            : {}),
        },
      });
    });
    const binding: PersonalRepoBinding = {
      registryId: "personal-synthetic",
      descriptor: {
        kind: "personal",
        ownerGithubAccountId: 41,
        appRecordId: "app",
        githubAppId: 1,
        installationId: 2,
        repositoryId: 3,
        repositoryOwnerGithubAccountId: 41,
        accessRevision: 1,
        fullName: "fixture/private",
      },
    };
    const runtime = createPersonalRepoRuntime({
      root: join(tmp, "runtime"),
      git: adapter,
      readPersonalRepository: async () => binding,
      resolveCredential: async (owner, d, kind) => ({
        ok: true,
        credential: {
          ownerGithubAccountId: owner,
          appRecordId: d.appRecordId,
          repositoryId: d.repositoryId,
          installationId: d.installationId,
          accessRevision: d.accessRevision,
          fullName: d.fullName,
          kind,
          token: "synthetic-read",
          expiresAt: Date.now() + 3600_000,
        },
      }),
    });
    const first = await runtime.prepare(41, binding, {
      sessionId: "s",
      mode: "code",
    });
    expect(await Bun.file(join(first.cwd, "fixture.txt")).text()).toBe(
      "synthetic only\n",
    );
    const same = await runtime.prepare(41, binding, {
      sessionId: "s",
      mode: "code",
      branch: first.branch,
    });
    expect(same.cwd).toBe(first.cwd);
    await git(["worktree", "remove", first.cwd], first.repo.repo);
    const recovered = await runtime.prepare(41, binding, {
      sessionId: "s",
      mode: "code",
      branch: first.branch,
    });
    expect(recovered.cwd).toBe(first.cwd);
    expect(calls.filter((args) => args[0] === "clone")).toHaveLength(1);
    const ask = await runtime.prepare(41, binding, {
      sessionId: "ask",
      mode: "ask",
    });
    expect(await git(["rev-parse", "--abbrev-ref", "HEAD"], ask.cwd)).toBe(
      "HEAD",
    );
    expect(
      await git(["config", "--get", "remote.origin.url"], first.repo.repo),
    ).toBe("https://github.com/fixture/private.git");
    expect(
      await Bun.file(join(first.repo.repo, ".git/config")).text(),
    ).not.toContain("synthetic-read");
    await git(["worktree", "remove", first.cwd], first.repo.repo);
    await symlink(seed, first.cwd);
    await expect(
      runtime.prepare(41, binding, {
        sessionId: "s",
        mode: "code",
        branch: first.branch,
      }),
    ).rejects.toThrow("Personal repository unavailable");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}, 30_000);
