import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { createBuildPlan, loadPlan } from "../src/plans";
import { resolveProjectDir, resolveProjectPath } from "../src/security";
import { runChecked } from "../src/exec";

let root: string;
let project: string;
let key: string;
const previous = { ...process.env };

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "apple-mobile-test-"));
  project = join(root, "app");
  mkdirSync(join(project, ".opensession"), { recursive: true });
  mkdirSync(join(project, "App.xcworkspace"));
  key = join(root, "AuthKey_TEST.p8");
  await Bun.write(key, "test-key");
  chmodSync(key, 0o600);
  process.env.APPLE_MOBILE_ALLOWED_ROOTS = project;
  process.env.OPENSESSION_STATE_DIR = join(root, "state");
  process.env.APPLE_ASC_KEY_ID = "TESTKEY";
  process.env.APPLE_ASC_ISSUER_ID = "00000000-0000-0000-0000-000000000000";
  process.env.APPLE_ASC_PRIVATE_KEY_PATH = key;
  await Bun.write(
    join(project, ".opensession/apple-mobile.json"),
    JSON.stringify({
      version: 1,
      backend: "xcode",
      bundleId: "com.example.App",
      teamId: "TEAM123",
      xcode: { container: "workspace", path: "App.xcworkspace", scheme: "App" },
      release: {
        requireClean: true,
        allowedBranches: ["main"],
        artifactDirectory: ".build/apple-mobile",
      },
    }),
  );
  await Bun.write(join(project, ".gitignore"), ".build\n");
  await runChecked({
    executable: "git",
    args: ["init", "-b", "main"],
    cwd: project,
  });
  await runChecked({
    executable: "git",
    args: ["config", "user.email", "test@example.invalid"],
    cwd: project,
  });
  await runChecked({
    executable: "git",
    args: ["config", "user.name", "Test"],
    cwd: project,
  });
  await runChecked({ executable: "git", args: ["add", "."], cwd: project });
  await runChecked({
    executable: "git",
    args: ["commit", "-m", "fixture"],
    cwd: project,
  });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  process.env = { ...previous };
});

describe("configuration and path boundary", () => {
  test("loads a valid Xcode app config", async () => {
    const loaded = await loadConfig(resolveProjectDir(project));
    expect(loaded.config.bundleId).toBe("com.example.App");
    expect(loaded.hash).toHaveLength(64);
  });

  test("rejects paths outside the project", () => {
    expect(() => resolveProjectPath(project, "../AuthKey_TEST.p8")).toThrow(
      "escapes project",
    );
  });

  test("rejects projects outside configured roots", () => {
    process.env.APPLE_MOBILE_ALLOWED_ROOTS = join(root, "other");
    expect(() => resolveProjectDir(project)).toThrow(
      "outside APPLE_MOBILE_ALLOWED_ROOTS",
    );
  });
});

describe("release plans", () => {
  test("binds a TestFlight plan to commit and config", async () => {
    const result = await createBuildPlan(project, "testflight", {
      marketingVersion: "1.2.3",
      buildNumber: "42",
    });
    expect(result.plan.action).toBe("testflight");
    expect(result.plan.commit).toHaveLength(40);
    expect(result.plan.commands).toHaveLength(3);
    expect(result.plan.commands[0]!.args).toContain("MARKETING_VERSION=1.2.3");
    const loaded = await loadPlan(project, result.plan.id);
    expect(loaded.plan.id).toBe(result.plan.id);
  });

  test("rejects a release key stored in an allowed worktree", async () => {
    process.env.APPLE_ASC_PRIVATE_KEY_PATH = join(
      project,
      ".build/AuthKey_TEST.p8",
    );
    mkdirSync(join(project, ".build"));
    await Bun.write(process.env.APPLE_ASC_PRIVATE_KEY_PATH, "test-key");
    chmodSync(process.env.APPLE_ASC_PRIVATE_KEY_PATH, 0o600);
    expect(createBuildPlan(project, "adhoc")).rejects.toThrow(
      "must be outside APPLE_MOBILE_ALLOWED_ROOTS",
    );
  });

  test("rejects a tampered plan even when the commit is unchanged", async () => {
    const result = await createBuildPlan(project, "adhoc");
    const planFile = join(project, result.planFile);
    const stored = JSON.parse(await Bun.file(planFile).text());
    stored.plan.commands[0].executable = "malicious-command";
    await Bun.write(planFile, JSON.stringify(stored));
    expect(loadPlan(project, result.plan.id)).rejects.toThrow(
      "signature is invalid",
    );
  });

  test("invalidates a plan when configuration changes", async () => {
    const result = await createBuildPlan(project, "adhoc");
    const configPath = join(project, ".opensession/apple-mobile.json");
    const config = JSON.parse(await Bun.file(configPath).text());
    config.bundleId = "com.example.Changed";
    await Bun.write(configPath, JSON.stringify(config));
    expect(loadPlan(project, result.plan.id)).rejects.toThrow();
  });
});
