import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import {
  bootstrapSignature,
  loadRemoteWorkspaceSeedFiles,
  runRemoteLifecycleHook,
  setupRemoteWorkspace,
  type RemoteDriver,
} from "./bootstrap";

const scratch: string[] = [];

afterEach(() => {
  for (const path of scratch.splice(0))
    rmSync(path, { recursive: true, force: true });
});

function seedRepo(seedFiles: string[]) {
  const root = mkdtempSync(join(tmpdir(), "opensession-remote-seeds-"));
  scratch.push(root);
  Bun.spawnSync({ cmd: ["git", "init", "-q", root] });
  mkdirSync(join(root, ".agents"), { recursive: true });
  writeFileSync(
    join(root, ".agents/environment.json"),
    JSON.stringify({ seedFiles }),
  );
  return root;
}

function driver(
  results: Array<{ exitCode: number; stdout?: string; stderr?: string }>,
) {
  const commands: Array<{ command: string; opts?: any }> = [];
  const value: RemoteDriver = {
    exec: async (command, opts) => {
      commands.push({ command, opts });
      const result = results.shift() || { exitCode: 0 };
      return { stdout: "", stderr: "", ...result };
    },
    execBackground: async () => {},
    writeFile: async () => {},
    ensureStarted: async () => {},
  };
  return { value, commands };
}

describe("remote repo lifecycle", () => {
  test("bootstrap identity includes the preview runtime contract", () => {
    expect(bootstrapSignature()).toContain("node@24.18.1");
    expect(bootstrapSignature()).toContain("just@1.43.1");
    expect(bootstrapSignature()).toContain("gh@2.83.1");
    expect(bootstrapSignature()).toContain("workspace-runtime-v8");
  });

  test("setup is skipped after its durable stamp", async () => {
    const d = driver([{ exitCode: 0, stdout: "stamped\n" }]);
    expect(
      await runRemoteLifecycleHook(d.value, "/work/repo", "setup", "fresh"),
    ).toMatchObject({ ran: false });
    expect(d.commands).toHaveLength(1);
  });

  test("retries a transient read-only lifecycle probe", async () => {
    const d = driver([
      { exitCode: 1, stderr: "The operation timed out." },
      { exitCode: 0, stdout: "stamped\n" },
    ]);
    expect(
      await runRemoteLifecycleHook(d.value, "/work/repo", "setup", "fresh"),
    ).toMatchObject({ ran: false });
    expect(d.commands).toHaveLength(2);
    expect(d.commands[1]!.command).toBe(d.commands[0]!.command);
  });

  test("runs executable setup once with a bounded log outside the repo", async () => {
    const d = driver([
      { exitCode: 0, stdout: "present\n" },
      { exitCode: 0 },
      { exitCode: 0 },
    ]);
    const result = await runRemoteLifecycleHook(
      d.value,
      "/work/repo",
      "setup",
      "fresh",
    );
    expect(result.ran).toBe(true);
    expect(result.log).toContain("/.opensession/lifecycle/");
    expect(d.commands[2]!.command).toContain("OPENSESSION_BOOT_MODE=fresh");
    expect(d.commands[2]!.command).toContain("PATH=");
    expect(d.commands[2]!.command).toContain("setup-bin");
    expect(d.commands[2]!.command).toContain("install --frozen-lockfile");
    expect(d.commands[2]!.command).toContain("touch");
    expect(d.commands[2]!.opts.timeoutMs).toBe(20 * 60_000);
  });

  test("uses a stable repo stamp across prewarm adoption paths", async () => {
    const d = driver([
      { exitCode: 0, stdout: "present\n" },
      { exitCode: 0 },
      { exitCode: 0 },
    ]);
    await runRemoteLifecycleHook(
      d.value,
      "/home/ubuntu/.bks-warm/opensession",
      "setup",
      "fresh",
      "opensession",
    );
    expect(d.commands[0]!.command).toContain("opensession-setup.done");
    expect(d.commands[2]!.command).toContain("opensession-setup.done");
  });

  test("resume runs every wake and fails loudly", async () => {
    const d = driver([
      { exitCode: 0, stdout: "present\n" },
      { exitCode: 0 },
      { exitCode: 7 },
    ]);
    await expect(
      runRemoteLifecycleHook(d.value, "/work/repo", "resume", "resume"),
    ).rejects.toThrow(".agents/resume failed with exit 7");
    expect(d.commands[2]!.command).not.toContain("setup.done");
    expect(d.commands[2]!.command).not.toContain("setup-bin");
    expect(d.commands[2]!.command).not.toContain("install --frozen-lockfile");
  });

  test("refuses a present non-executable hook", async () => {
    const d = driver([{ exitCode: 0, stdout: "present\n" }, { exitCode: 1 }]);
    await expect(
      runRemoteLifecycleHook(d.value, "/work/repo", "resume", "resume"),
    ).rejects.toThrow("not executable");
  });

  test("adopts and syncs a prepared Daytona workspace in one command", async () => {
    const d = driver([
      { exitCode: 0, stdout: "warm\n" },
      { exitCode: 0 },
      { exitCode: 0, stdout: "absent\n" },
    ]);
    await setupRemoteWorkspace(
      d.value,
      "/work/feature",
      "https://token@example.test/repo.git",
      "feature/new-ui",
      "main",
      "opensession",
      { sandboxId: "sbx-test", provider: "daytona", repoId: "opensession" },
    );

    expect(d.commands).toHaveLength(3);
    const adoption = d.commands[1]!;
    expect(adoption.opts.timeoutMs).toBe(180_000);
    expect(adoption.command).toContain("ln -s");
    expect(adoption.command).not.toContain("mount --bind");
    expect(adoption.command).toContain("remote set-url origin");
    expect(adoption.command).toContain(
      "fetch --no-tags origin +refs/heads/feature/new-ui:refs/remotes/origin/feature/new-ui --quiet",
    );
    expect(adoption.command).toContain(
      "fetch --no-tags origin +refs/heads/main:refs/remotes/origin/main --quiet",
    );
    expect(adoption.command).toContain("__start=origin/feature/new-ui");
    expect(adoption.command).toContain("update-ref refs/heads/feature/new-ui");
    expect(adoption.command).toContain(
      "symbolic-ref HEAD refs/heads/feature/new-ui",
    );
    expect(adoption.command).toContain("checkout -B feature/new-ui");
    expect(adoption.command).toContain("opensession-adopted-by");
    expect(
      d.commands.some(({ command }) => command === "git branch --show-current"),
    ).toBe(false);
  });

  test("cold-clones instead of taking over another workspace's warm clone", async () => {
    const d = driver([
      { exitCode: 0, stdout: "warm\n" },
      { exitCode: 73 },
      { exitCode: 0 },
      { exitCode: 0, stdout: "feature/new-ui\n" },
      { exitCode: 0, stdout: "absent\n" },
    ]);
    await setupRemoteWorkspace(
      d.value,
      "/work/feature",
      "https://token@example.test/repo.git",
      "feature/new-ui",
      "main",
      "opensession",
      { sandboxId: "sbx-test", provider: "box", repoId: "opensession" },
    );

    expect(d.commands[0]!.command).toContain("echo cwd");
    expect(d.commands[0]!.command).toContain("echo warm");
    expect(d.commands[1]!.command).toContain("exit 73");
    expect(d.commands[1]!.command).toContain("ln -s");
    expect(d.commands[1]!.command).not.toContain("mount --bind");
    expect(d.commands[2]!.command).toContain("git clone --filter=blob:none");
  });

  test("scrubs a short-lived GitHub token after the bounded clone", async () => {
    const d = driver([
      { exitCode: 0, stdout: "none\n" },
      { exitCode: 0 },
      { exitCode: 0, stdout: "feature/new-ui\n" },
      { exitCode: 0 },
      { exitCode: 0, stdout: "absent\n" },
    ]);
    await setupRemoteWorkspace(
      d.value,
      "/work/feature",
      "https://x-access-token:short-lived@github.com/tellahq/opensession.git",
      "feature/new-ui",
      "main",
    );

    const scrub = d.commands.find(({ command }) =>
      command.startsWith("git remote set-url origin"),
    );
    expect(scrub?.command).toContain(
      "https://github.com/tellahq/opensession.git",
    );
    expect(scrub?.command).not.toContain("short-lived");
  });

  test("source verification skips private seed files and lifecycle hooks", async () => {
    const d = driver([
      { exitCode: 0, stdout: "none\n" },
      { exitCode: 0 },
      { exitCode: 0, stdout: "main\n" },
      { exitCode: 0 },
    ]);
    await setupRemoteWorkspace(
      d.value,
      "/work/public-review",
      "https://github.com/tellahq/opensession.git",
      "main",
      "main",
      "opensession",
      { sandboxId: "sbx-test", provider: "daytona", repoId: "opensession" },
      { seedPrivateFiles: false, runLifecycleHooks: false },
    );

    expect(d.commands).toHaveLength(4);
    expect(
      d.commands.some(({ command }) => command.includes(".agents/setup")),
    ).toBe(false);
    expect(
      d.commands.some(({ command }) =>
        command.includes("opensession/lifecycle"),
      ),
    ).toBe(false);
  });

  test("cleans up a failed warm attach before cold-cloning", async () => {
    const d = driver([
      { exitCode: 0, stdout: "warm\n" },
      { exitCode: 1, stderr: "fetch failed" },
      { exitCode: 0 },
      { exitCode: 0, stdout: "feature/new-ui\n" },
      { exitCode: 0, stdout: "absent\n" },
    ]);
    await setupRemoteWorkspace(
      d.value,
      "/work/feature",
      "https://token@example.test/repo.git",
      "feature/new-ui",
      "main",
      "opensession",
      { sandboxId: "sbx-test", provider: "daytona", repoId: "opensession" },
    );

    expect(d.commands[1]!.command).toContain("umount /work/feature");
    expect(d.commands[1]!.command).toContain("rm -f /work/feature");
    expect(d.commands[2]!.command).toContain("git clone --filter=blob:none");
  });
});

describe("remote workspace private seed files", () => {
  test("uses the remote-tracking default branch instead of a parked checkout branch", () => {
    const root = seedRepo([".env.local"]);
    writeFileSync(join(root, ".gitignore"), ".env.local\nother.env\n");
    writeFileSync(join(root, ".env.local"), "SOURCE=default\n");
    Bun.spawnSync({
      cmd: ["git", "-C", root, "add", ".agents/environment.json", ".gitignore"],
    });
    Bun.spawnSync({
      cmd: [
        "git",
        "-C",
        root,
        "-c",
        "user.name=OpenSession Test",
        "-c",
        "user.email=test@opensession.local",
        "commit",
        "-qm",
        "default manifest",
      ],
    });
    Bun.spawnSync({
      cmd: [
        "git",
        "-C",
        root,
        "update-ref",
        "refs/remotes/origin/main",
        "HEAD",
      ],
    });
    writeFileSync(
      join(root, ".agents/environment.json"),
      JSON.stringify({ seedFiles: ["other.env"] }),
    );
    writeFileSync(join(root, "other.env"), "SOURCE=parked-branch\n");

    expect(
      loadRemoteWorkspaceSeedFiles({
        id: "app",
        repo: root,
        defaultBranch: "main",
      }),
    ).toEqual([{ path: ".env.local", content: "SOURCE=default\n" }]);
  });

  test("loads declared gitignored text files from the registered checkout", () => {
    const root = seedRepo(["packages/web/.env.local", ".envrc"]);
    writeFileSync(
      join(root, ".gitignore"),
      ".envrc\npackages/web/.env.local\n",
    );
    for (const [path, content] of [
      ["packages/web/.env.local", "API_URL=https://example.test\n"],
      [".envrc", "export APP_ENV=dev\n"],
    ] as const) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }

    expect(loadRemoteWorkspaceSeedFiles({ id: "app", repo: root })).toEqual([
      {
        path: "packages/web/.env.local",
        content: "API_URL=https://example.test\n",
      },
      { path: ".envrc", content: "export APP_ENV=dev\n" },
    ]);
  });

  test("refuses traversal and files that are not gitignored", () => {
    const traversal = seedRepo(["../outside.env"]);
    expect(() =>
      loadRemoteWorkspaceSeedFiles({ id: "app", repo: traversal }),
    ).toThrow("unsafe path");

    const tracked = seedRepo([".env.local"]);
    writeFileSync(join(tracked, ".env.local"), "SECRET=value\n");
    expect(() =>
      loadRemoteWorkspaceSeedFiles({ id: "app", repo: tracked }),
    ).toThrow("must be gitignored");
  });

  test("refuses symlinks even when the path is ignored", () => {
    const root = seedRepo([".env.local"]);
    writeFileSync(join(root, ".gitignore"), ".env.local\n");
    writeFileSync(join(root, "actual.env"), "SECRET=value\n");
    symlinkSync("actual.env", join(root, ".env.local"));
    expect(() =>
      loadRemoteWorkspaceSeedFiles({ id: "app", repo: root }),
    ).toThrow("regular file");
  });
});
