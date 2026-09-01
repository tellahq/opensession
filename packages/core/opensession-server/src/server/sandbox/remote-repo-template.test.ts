import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { connectSandboxProvider, updateSandboxConnection } from "./connections";

let scratch = "";

beforeEach(async () => {
  scratch = mkdtempSync(join(tmpdir(), "os-remote-template-"));
  process.env.OPENSESSION_SESSIONS_DIR = `${scratch}/sessions`;
  process.env.OPENSESSION_SANDBOX_CONFIG = `${scratch}/sandbox.json`;
  process.env.OPENSESSION_WORKSPACE_SECRETS_STORE = `${scratch}/secrets.json`;
  await Bun.write(
    process.env.OPENSESSION_SANDBOX_CONFIG,
    JSON.stringify({ runnerSha: "abc" }),
  );
  connectSandboxProvider("modal", {
    tokenId: "test-id",
    tokenSecret: "test-secret",
    settings: { image: "base:v1" },
  });
});

afterEach(() => {
  delete process.env.OPENSESSION_SESSIONS_DIR;
  delete process.env.OPENSESSION_SANDBOX_CONFIG;
  delete process.env.OPENSESSION_WORKSPACE_SECRETS_STORE;
  rmSync(scratch, { recursive: true, force: true });
});

describe("remote repo template index", () => {
  test("keeps credential-free stopped artifacts until an input changes", async () => {
    const mod = await import(
      `./remote-repo-template?roundtrip=${Math.random()}`
    );
    mod.writeRemoteRepoTemplate("modal", "app", "im-1", 1_000);
    expect(mod.readRemoteRepoTemplate("modal", "app", 2_000)?.artifactId).toBe(
      "im-1",
    );
    expect(
      mod.readRemoteRepoTemplate("modal", "app", 365 * 24 * 60 * 60_000)
        ?.artifactId,
    ).toBe("im-1");
  });

  test("refreshes source images every 30 minutes without expiring the old mapping", async () => {
    const mod = await import(`./remote-repo-template?refresh=${Math.random()}`);
    const { current } = mod.writeRemoteRepoTemplate(
      "modal",
      "app",
      "im-1",
      1_000,
    );
    expect(
      mod.remoteRepoTemplateNeedsRefresh(current, 1_000 + 29 * 60_000),
    ).toBe(false);
    expect(
      mod.remoteRepoTemplateNeedsRefresh(current, 1_000 + 30 * 60_000),
    ).toBe(true);
    expect(
      mod.readRemoteRepoTemplate("modal", "app", 1_000 + 30 * 60_000)
        ?.artifactId,
    ).toBe("im-1");
  });

  test("preserves Box's daily start quota with a six-hour source refresh", async () => {
    const mod = await import(
      `./remote-repo-template?box-refresh=${Math.random()}`
    );
    const { current } = mod.writeRemoteRepoTemplate(
      "box",
      "app",
      "snapshot-1",
      1_000,
    );
    expect(
      mod.remoteRepoTemplateNeedsRefresh(current, 1_000 + 30 * 60_000),
    ).toBe(false);
    expect(
      mod.remoteRepoTemplateNeedsRefresh(current, 1_000 + 6 * 60 * 60_000),
    ).toBe(true);
  });

  test("a runner commit pin bump alone keeps the artifact mapping", async () => {
    const mod = await import(`./remote-repo-template?pin=${Math.random()}`);
    mod.writeRemoteRepoTemplate("modal", "app", "im-1");
    // Every deploy bumps runnerSha; the template must survive it — adoption's
    // bootstrap reconciles the pin inside the restored filesystem instead.
    // (Read-modify-write: connectSandboxProvider persists into this same file.)
    const cfgPath = process.env.OPENSESSION_SANDBOX_CONFIG!;
    const cfg = JSON.parse(await Bun.file(cfgPath).text());
    await Bun.write(cfgPath, JSON.stringify({ ...cfg, runnerSha: "def" }));
    expect(mod.readRemoteRepoTemplate("modal", "app")?.artifactId).toBe("im-1");
  });

  test("create-shape changes invalidate the local artifact mapping", async () => {
    const mod = await import(`./remote-repo-template?shape=${Math.random()}`);
    mod.writeRemoteRepoTemplate("modal", "app", "im-1");
    updateSandboxConnection("modal", { settings: { image: "base:v2" } });
    expect(mod.readRemoteRepoTemplate("modal", "app")).toBeNull();
  });

  test("replacements report the old artifact for provider cleanup", async () => {
    const mod = await import(`./remote-repo-template?replace=${Math.random()}`);
    mod.writeRemoteRepoTemplate("daytona", "app", "snap-1");
    const result = mod.writeRemoteRepoTemplate("daytona", "app", "snap-2");
    expect(result.previous?.artifactId).toBe("snap-1");
    const stored = JSON.parse(
      readFileSync(
        `${scratch}/sessions/sandbox-repo-templates/daytona-app.json`,
        "utf-8",
      ),
    );
    expect(stored.artifactId).toBe("snap-2");
  });
});

describe("repo-declared preparation inputs", () => {
  test("parsePreparationInputs keeps only safe repo-relative paths", async () => {
    const mod = await import(`./remote-repo-template?parse=${Math.random()}`);
    expect(
      mod.parsePreparationInputs({
        preparationInputs: [
          "Cargo.lock",
          "patches/",
          "Cargo.lock",
          "/etc/passwd",
          "../outside",
          "a/../b",
          "-rf",
          "has:colon",
          "",
          42,
        ],
      }),
    ).toEqual(["Cargo.lock", "patches"]);
    expect(mod.parsePreparationInputs({})).toEqual([]);
    expect(mod.parsePreparationInputs(null)).toEqual([]);
    expect(
      mod.parsePreparationInputs({ preparationInputs: "Cargo.lock" }),
    ).toEqual([]);
  });

  test("declaredPreparationInputs reads the committed environment file, not the worktree", async () => {
    const mod = await import(
      `./remote-repo-template?declared=${Math.random()}`
    );
    const repoDir = join(scratch, "declared-repo");
    const sh = (...cmd: string[]) => {
      const r = Bun.spawnSync({
        cmd,
        cwd: repoDir,
        stdout: "pipe",
        stderr: "pipe",
      });
      if (r.exitCode !== 0) throw new Error(r.stderr.toString());
    };
    mkdirSync(join(repoDir, ".agents"), { recursive: true });
    await Bun.write(
      join(repoDir, ".agents/sandbox-environment.json"),
      JSON.stringify({ preparationInputs: ["Cargo.lock", "bun.lock"] }),
    );
    // No HEAD yet: falls back to working-tree bytes.
    expect(mod.declaredPreparationInputs(repoDir, false)).toEqual([
      "Cargo.lock",
    ]);
    sh("git", "init", "-q");
    sh("git", "-c", "user.email=t@t", "-c", "user.name=t", "add", "-A");
    sh(
      "git",
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "commit",
      "-q",
      "-m",
      "init",
    );
    expect(mod.declaredPreparationInputs(repoDir, true)).toEqual([
      "Cargo.lock",
    ]);
    // A dirty edit must not change what the committed signature sees.
    await Bun.write(
      join(repoDir, ".agents/sandbox-environment.json"),
      JSON.stringify({ preparationInputs: ["patches"] }),
    );
    expect(mod.declaredPreparationInputs(repoDir, true)).toEqual([
      "Cargo.lock",
    ]);
  });
});
