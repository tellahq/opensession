import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import {
  approveReleasePlan,
  cleanupReleaseExecution,
  consumeReleaseApproval,
  createBuildPlan,
  createUploadPlan,
  listReleaseApprovalRequests,
  loadPlan,
  planPath,
  prepareReleaseExecution,
} from "../src/plans";
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
  await Bun.write(
    join(project, "App.xcworkspace", "contents.xcworkspacedata"),
    '<Workspace version="1.0"/>\n',
  );
  key = join(root, "AuthKey_TEST.p8");
  await Bun.write(key, "test-key");
  chmodSync(key, 0o600);
  delete process.env.APPLE_MOBILE_STATE_DIR;
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
  await Bun.write(join(project, "App.swift"), "let planned = true\n");
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

  test("rejects repository config that disables clean releases", async () => {
    const configPath = join(project, ".opensession/apple-mobile.json");
    const config = JSON.parse(await Bun.file(configPath).text());
    config.release.requireClean = false;
    await Bun.write(configPath, JSON.stringify(config));
    expect(loadConfig(project)).rejects.toThrow(
      "release.requireClean cannot be false",
    );
  });

  test("rejects paths outside the project", () => {
    expect(() => resolveProjectPath(project, "../AuthKey_TEST.p8")).toThrow(
      "escapes project",
    );
  });

  test("accepts a project without host allowlist configuration", () => {
    expect(resolveProjectDir(project)).toBe(project);
  });

  test("keeps controlled release storage outside the project", async () => {
    process.env.OPENSESSION_STATE_DIR = join(project, "state");
    expect(createBuildPlan(project, "adhoc")).rejects.toThrow(
      "APPLE_MOBILE_STATE_DIR must be outside the app project",
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

  test("prepares build execution from the planned commit", async () => {
    const result = await createBuildPlan(project, "adhoc");
    await Bun.write(join(project, "App.swift"), "let changed = true\n");

    const prepared = await prepareReleaseExecution(result.plan);
    try {
      expect(
        await Bun.file(join(prepared.checkoutDir, "App.swift")).text(),
      ).toBe("let planned = true\n");
      expect(
        prepared.commands.every(
          (command) => command.cwd === prepared.checkoutDir,
        ),
      ).toBe(true);
      expect(JSON.stringify(prepared.commands)).not.toContain(project);
    } finally {
      await cleanupReleaseExecution({
        checkoutDir: prepared.checkoutDir,
        executionDir: prepared.executionDir,
        projectDir: project,
      });
    }
  });

  test("copies and identifies the exact IPA approved for upload", async () => {
    mkdirSync(join(project, ".build"));
    const ipa = join(project, ".build", "reviewed.ipa");
    await Bun.write(ipa, "approved bytes");
    const result = await createUploadPlan(project, ".build/reviewed.ipa");
    const [request] = listReleaseApprovalRequests();

    expect(request?.planId).toBe(result.plan.id);
    expect(request?.projectDir).toBe(project);
    expect(request?.sourceArtifactName).toBe("reviewed.ipa");
    expect(request?.sourceArtifactSha256).toBe(
      result.plan.sourceArtifactSha256,
    );
    expect(result.plan.sourceArtifact).not.toBe(ipa);

    await Bun.write(ipa, "changed after planning");
    const prepared = await prepareReleaseExecution(result.plan);
    try {
      const command = prepared.commands[0]!;
      const file = command.args[command.args.indexOf("--file") + 1]!;
      expect(await Bun.file(file).text()).toBe("approved bytes");
      expect(file).not.toBe(result.plan.sourceArtifact);
    } finally {
      await cleanupReleaseExecution({
        checkoutDir: prepared.checkoutDir,
        executionDir: prepared.executionDir,
        projectDir: project,
      });
    }
  });

  test("filters pending requests before sorting and limiting", async () => {
    const realNow = Date.now;
    let now = Date.parse("2026-01-01T00:00:00.000Z");
    Date.now = () => now++;
    try {
      const plans = [];
      for (let index = 0; index < 101; index++) {
        plans.push((await createBuildPlan(project, "adhoc")).plan);
      }
      for (const plan of plans.slice(0, 50)) {
        approveReleasePlan(plan.id, "alice");
      }
      expect(
        listReleaseApprovalRequests().map((request) => request.planId),
      ).toEqual(
        plans
          .slice(50)
          .toReversed()
          .map((plan) => plan.id),
      );
    } finally {
      Date.now = realNow;
    }
  }, 20_000);

  test("removes expired approval requests and grants", async () => {
    const realNow = Date.now;
    const plannedAt = Date.parse("2026-01-01T00:00:00.000Z");
    Date.now = () => plannedAt;
    try {
      const result = await createBuildPlan(project, "adhoc");
      approveReleasePlan(result.plan.id, "alice");
      Date.now = () => plannedAt + 2 * 60 * 60_000;
      expect(listReleaseApprovalRequests()).toEqual([]);
      const approvals = join(
        process.env.OPENSESSION_STATE_DIR!,
        "apple-mobile",
        "approvals",
      );
      expect(
        existsSync(join(approvals, `${result.plan.id}.request.json`)),
      ).toBe(false);
      expect(existsSync(join(approvals, `${result.plan.id}.grant.json`))).toBe(
        false,
      );
      expect(existsSync(planPath(result.plan.id))).toBe(false);
    } finally {
      Date.now = realNow;
    }
  });

  test("requires and consumes a later approval grant", async () => {
    const result = await createBuildPlan(project, "adhoc");
    expect(listReleaseApprovalRequests()).toHaveLength(1);
    expect(() => consumeReleaseApproval(result.plan)).toThrow("needs approval");
    expect(listReleaseApprovalRequests()).toHaveLength(1);

    approveReleasePlan(result.plan.id, "alice");
    expect(listReleaseApprovalRequests()).toHaveLength(0);
    expect(consumeReleaseApproval(result.plan).approvedBy).toBe("alice");
    expect(() => consumeReleaseApproval(result.plan)).toThrow("needs approval");
  });

  test("blocks concurrent reapproval and duplicate approval consumption", async () => {
    const result = await createBuildPlan(project, "adhoc");
    approveReleasePlan(result.plan.id, "alice");

    const consumed = consumeReleaseApproval(result.plan, undefined, {
      afterRequestClaimed: () => {
        expect(listReleaseApprovalRequests()).toEqual([]);
        expect(() => approveReleasePlan(result.plan.id, "bob")).toThrow(
          "not pending",
        );
        expect(() => consumeReleaseApproval(result.plan)).toThrow(
          "needs approval",
        );
      },
    });

    expect(consumed.approvedBy).toBe("alice");
    expect(() => approveReleasePlan(result.plan.id, "bob")).toThrow(
      "not pending",
    );
    expect(() => consumeReleaseApproval(result.plan)).toThrow("needs approval");
  });

  test("burns both claims when a consumed approval is invalid", async () => {
    const result = await createBuildPlan(project, "adhoc");
    approveReleasePlan(result.plan.id, "alice");

    expect(() =>
      consumeReleaseApproval({ ...result.plan, commit: "0".repeat(40) }),
    ).toThrow("does not match");
    expect(listReleaseApprovalRequests()).toEqual([]);
    expect(() => approveReleasePlan(result.plan.id, "bob")).toThrow(
      "not pending",
    );
    expect(() => consumeReleaseApproval(result.plan)).toThrow("needs approval");
  });

  test("rejects a release key stored in the project", async () => {
    process.env.APPLE_ASC_PRIVATE_KEY_PATH = join(
      project,
      ".build/AuthKey_TEST.p8",
    );
    mkdirSync(join(project, ".build"));
    await Bun.write(process.env.APPLE_ASC_PRIVATE_KEY_PATH, "test-key");
    chmodSync(process.env.APPLE_ASC_PRIVATE_KEY_PATH, 0o600);
    expect(createBuildPlan(project, "adhoc")).rejects.toThrow(
      "must be outside the project being released",
    );
  });

  test("rejects a tampered plan even when the commit is unchanged", async () => {
    const result = await createBuildPlan(project, "adhoc");
    const planFile = planPath(result.plan.id);
    const stored = JSON.parse(await Bun.file(planFile).text());
    stored.plan.commands[0].executable = "malicious-command";
    await Bun.write(planFile, JSON.stringify(stored));
    expect(loadPlan(project, result.plan.id)).rejects.toThrow(
      "signature is invalid",
    );
  });

  test("uses configuration from the planned commit", async () => {
    const result = await createBuildPlan(project, "adhoc");
    const configPath = join(project, ".opensession/apple-mobile.json");
    const config = JSON.parse(await Bun.file(configPath).text());
    config.bundleId = "com.example.Changed";
    await Bun.write(configPath, JSON.stringify(config));

    expect((await loadPlan(project, result.plan.id)).plan.id).toBe(
      result.plan.id,
    );
    const prepared = await prepareReleaseExecution(result.plan);
    try {
      expect(prepared.config.bundleId).toBe("com.example.App");
    } finally {
      await cleanupReleaseExecution({
        checkoutDir: prepared.checkoutDir,
        executionDir: prepared.executionDir,
        projectDir: project,
      });
    }
  });
});
