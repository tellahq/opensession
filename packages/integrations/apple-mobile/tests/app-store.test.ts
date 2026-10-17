import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AscClient, ascBaseUrl } from "../src/asc";
import { distributeTestFlight, nextBuildNumber } from "../src/app-store";
import { loadConfig } from "../src/config";
import { runChecked } from "../src/exec";
import {
  approveReleasePlan,
  createBuildPlan,
  createStorePlan,
  listReleaseApprovalRequests,
  prepareReleaseExecution,
  cleanupReleaseExecution,
} from "../src/plans";
import { executePlan } from "../src/release";
import { createApp, targetName } from "../src/scaffold";
import { app, fakeAsc, writeTestKey } from "./fake-asc";

let root: string;
let project: string;
let key: string;
let publicKey: CryptoKey;
let asc: ReturnType<typeof fakeAsc> | undefined;
const previous = { ...process.env };

async function git(...args: string[]) {
  return runChecked({ executable: "git", args, cwd: project });
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "apple-store-test-"));
  project = join(root, "app");
  key = join(root, "AuthKey_TEST.p8");
  publicKey = await writeTestKey(key);
  delete process.env.APPLE_MOBILE_STATE_DIR;
  process.env.OPENSESSION_STATE_DIR = join(root, "state");
  process.env.APPLE_ASC_KEY_ID = "TESTKEY";
  process.env.APPLE_ASC_ISSUER_ID = "00000000-0000-0000-0000-000000000000";
  process.env.APPLE_ASC_PRIVATE_KEY_PATH = key;
  createApp({
    projectDir: project,
    name: "Acme Notes",
    bundleId: "com.example.App",
    teamId: "ABCDE12345",
  });
  await git("init", "-b", "main");
  await git("config", "user.email", "test@example.invalid");
  await git("config", "user.name", "Test");
  await git("add", ".");
  await git("commit", "-m", "fixture");
});

afterEach(() => {
  asc?.stop();
  asc = undefined;
  rmSync(root, { recursive: true, force: true });
  process.env = { ...previous };
});

function useAsc(routes: Parameters<typeof fakeAsc>[0]) {
  asc = fakeAsc(routes);
  process.env.APPLE_ASC_API_BASE_URL = asc.url;
  return asc;
}

function client() {
  return new AscClient({
    keyId: "TESTKEY",
    issuerId: "issuer",
    keyPath: key,
  });
}

const build = (id: string, version: string, state = "VALID") => ({
  type: "builds",
  id,
  attributes: {
    version,
    processingState: state,
    usesNonExemptEncryption: false,
  },
  relationships: {
    preReleaseVersion: {
      data: { type: "preReleaseVersions", id: `pre-${id}` },
    },
  },
});
const preRelease = (id: string, version: string) => ({
  type: "preReleaseVersions",
  id: `pre-${id}`,
  attributes: { version },
});

describe("App Store Connect client", () => {
  test("signs a verifiable ES256 token for appstoreconnect-v1", async () => {
    const fake = useAsc({ "GET /v1/apps": () => app() });
    await client().get("/v1/apps");
    const token = fake.requests[0]!.authorization!.replace("Bearer ", "");
    const [header, payload, signature] = token.split(".");
    const decode = (part: string) =>
      JSON.parse(Buffer.from(part, "base64url").toString());
    expect(decode(header!)).toEqual({
      alg: "ES256",
      kid: "TESTKEY",
      typ: "JWT",
    });
    const claims = decode(payload!);
    expect(claims.aud).toBe("appstoreconnect-v1");
    expect(claims.iss).toBe("issuer");
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(20 * 60);
    const valid = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicKey,
      Buffer.from(signature!, "base64url"),
      new TextEncoder().encode(`${header}.${payload}`),
    );
    expect(valid).toBe(true);
  });

  test("only allows loopback base URL overrides", () => {
    process.env.APPLE_ASC_API_BASE_URL = "http://example.test";
    expect(() => ascBaseUrl()).toThrow("loopback");
    process.env.APPLE_ASC_API_BASE_URL = "https://127.0.0.1";
    expect(() => ascBaseUrl()).toThrow("loopback");
  });

  test("refuses to follow a pagination link to another host", async () => {
    useAsc({
      "GET /v1/apps": () => ({
        data: [],
        links: { next: "https://example.test/v1/apps?cursor=2" },
      }),
    });
    await expect(client().list("/v1/apps")).rejects.toThrow("offsite");
  });

  test("next build number is one above every integer build", async () => {
    useAsc({
      "GET /v1/builds": () => ({
        data: [build("b1", "7"), build("b2", "12"), build("b3", "1.2.3")],
      }),
    });
    expect(await nextBuildNumber(client(), "app-1")).toBe("13");
  });
});

describe("new app scaffold", () => {
  test("writes a project the release tools accept", async () => {
    const { config } = await loadConfig(project);
    expect(config).toMatchObject({
      backend: "xcode",
      platform: "ios",
      bundleId: "com.example.App",
      xcode: {
        container: "project",
        path: "AcmeNotes.xcodeproj",
        scheme: "AcmeNotes",
        generator: "xcodegen",
      },
    });
    const spec = await Bun.file(join(project, "project.yml")).text();
    expect(spec).toContain("PRODUCT_BUNDLE_IDENTIFIER: com.example.App");
    expect(spec).toContain("ITSAppUsesNonExemptEncryption: false");
    expect(spec).toContain("DEVELOPMENT_TEAM: ABCDE12345");
  });

  test("never writes into a non-empty directory", () => {
    expect(() =>
      createApp({
        projectDir: project,
        name: "Again",
        bundleId: "com.example.B",
      }),
    ).toThrow("not empty");
  });

  test("derives a Swift target name", () => {
    expect(targetName("acme notes!")).toBe("AcmeNotes");
    expect(targetName("1Password helper")).toBe("App1PasswordHelper");
  });

  test("generates the Xcode project in the release checkout", async () => {
    const result = await createBuildPlan(project, "adhoc", {
      buildNumber: "3",
    });
    expect(result.plan.commands.map((command) => command.step)).toEqual([
      "generate",
      "archive",
      "export",
    ]);
    const prepared = await prepareReleaseExecution(result.plan);
    try {
      const [generate, archive] = prepared.commands;
      expect(generate!.args).toEqual([
        "generate",
        "--spec",
        join(prepared.checkoutDir, "project.yml"),
        "--project",
        prepared.checkoutDir,
      ]);
      expect(archive!.args).toContain(
        join(prepared.checkoutDir, "AcmeNotes.xcodeproj"),
      );
    } finally {
      await cleanupReleaseExecution({
        checkoutDir: prepared.checkoutDir,
        executionDir: prepared.executionDir,
        projectDir: project,
      });
    }
  });

  test("macOS apps scaffold but cannot be released yet", async () => {
    const mac = join(root, "mac");
    createApp({
      projectDir: mac,
      name: "Mac Tool",
      bundleId: "com.example.Mac",
      platform: "macos",
    });
    expect((await loadConfig(mac)).config.platform).toBe("macos");
    expect(await Bun.file(join(mac, "project.yml")).text()).toContain(
      "platform: macOS",
    );
    project = mac;
    await git("init", "-b", "main");
    await git("config", "user.email", "test@example.invalid");
    await git("config", "user.name", "Test");
    await git("add", ".");
    await git("commit", "-m", "fixture");
    await expect(
      createBuildPlan(mac, "testflight", { buildNumber: "1" }),
    ).rejects.toThrow("macos distribution is not supported yet");
  });
});

describe("TestFlight", () => {
  test("plans the next build number from App Store Connect", async () => {
    useAsc({
      "GET /v1/apps": () => app(),
      "GET /v1/builds": () => ({ data: [build("b1", "41")] }),
    });
    const result = await createBuildPlan(project, "testflight", {
      marketingVersion: "1.1",
    });
    expect(result.plan.buildNumber).toBe("42");
    const archive = result.plan.commands.find(
      (command) => command.step === "archive",
    )!;
    expect(archive.args).toContain("CURRENT_PROJECT_VERSION=42");
    expect(result.plan.effects.join("\n")).toContain("build 42");
    expect(listReleaseApprovalRequests()[0]!.effects).toEqual(
      result.plan.effects,
    );
  });

  test("a TestFlight plan without an app record explains the setup", async () => {
    useAsc({});
    await expect(createBuildPlan(project, "testflight")).rejects.toThrow(
      "apple_release_app_status",
    );
  });

  test("distributes a processed build only to internal groups", async () => {
    const fake = useAsc({
      "GET /v1/apps": () => app(),
      "GET /v1/builds": () => ({
        data: [build("b1", "42")],
        included: [preRelease("b1", "1.1")],
      }),
      "GET /v1/apps/app-1/betaGroups": () => ({
        data: [
          {
            type: "betaGroups",
            id: "g1",
            attributes: { name: "Team", isInternalGroup: true },
          },
          {
            type: "betaGroups",
            id: "g2",
            attributes: { name: "Public", isInternalGroup: false },
          },
        ],
      }),
      "POST /v1/betaBuildLocalizations": () => ({
        data: { type: "betaBuildLocalizations", id: "l1" },
      }),
      "POST /v1/builds/b1/relationships/betaGroups": () => undefined,
    });
    const input = {
      bundleId: "com.example.App",
      platform: "ios" as const,
      buildNumber: "42",
    };
    await expect(
      distributeTestFlight(client(), { ...input, groups: ["Public"] }),
    ).rejects.toThrow("Beta App Review");
    expect(fake.writes()).toEqual([]);

    const result = await distributeTestFlight(client(), {
      ...input,
      whatToTest: "Try the new editor",
      groups: ["Team"],
    });
    expect(result.effects).toEqual([
      "Set What to Test (en-US)",
      "Added to Team",
    ]);
    expect(fake.writes().map((request) => request.body)).toEqual([
      {
        data: {
          type: "betaBuildLocalizations",
          attributes: { locale: "en-US", whatsNew: "Try the new editor" },
          relationships: { build: { data: { type: "builds", id: "b1" } } },
        },
      },
      { data: [{ type: "betaGroups", id: "g1" }] },
    ]);
  });

  test("refuses to distribute a build that is still processing", async () => {
    useAsc({
      "GET /v1/apps": () => app(),
      "GET /v1/builds": () => ({ data: [build("b1", "42", "PROCESSING")] }),
    });
    await expect(
      distributeTestFlight(client(), {
        bundleId: "com.example.App",
        platform: "ios",
        buildNumber: "42",
        groups: ["Team"],
      }),
    ).rejects.toThrow("PROCESSING");
  });
});

describe("App Store submission and release", () => {
  function submissionRoutes() {
    return {
      "GET /v1/apps": () => app(),
      "GET /v1/builds": () => ({
        data: [build("b1", "42")],
        included: [preRelease("b1", "1.1")],
      }),
      "POST /v1/appStoreVersions": () => ({
        data: { type: "appStoreVersions", id: "v1" },
      }),
      "PATCH /v1/appStoreVersions/v1/relationships/build": () => undefined,
      "GET /v1/appStoreVersions/v1/appStoreVersionLocalizations": () => ({
        data: [{ type: "appStoreVersionLocalizations", id: "loc1" }],
      }),
      "PATCH /v1/appStoreVersionLocalizations/loc1": () => ({
        data: { type: "appStoreVersionLocalizations", id: "loc1" },
      }),
      "POST /v1/reviewSubmissions": () => ({
        data: { type: "reviewSubmissions", id: "s1" },
      }),
      "POST /v1/reviewSubmissionItems": () => ({
        data: { type: "reviewSubmissionItems", id: "i1" },
      }),
      "PATCH /v1/reviewSubmissions/s1": () => ({
        data: {
          type: "reviewSubmissions",
          id: "s1",
          attributes: { state: "WAITING_FOR_REVIEW" },
        },
      }),
    };
  }

  test("submits for review only after a separate approval", async () => {
    const fake = useAsc(submissionRoutes());
    const { plan } = await createStorePlan(project, "submit", {
      marketingVersion: "1.1",
      buildNumber: "42",
      whatsNew: "Bug fixes",
    });
    expect(plan.commands).toEqual([]);
    expect(plan.releaseType).toBe("manual");
    expect(plan.effects).toContain("Submit com.example.App 1.1 for App Review");
    expect(fake.writes()).toEqual([]);

    await expect(executePlan(project, plan.id, plan.commit)).rejects.toThrow(
      "needs approval",
    );
    expect(fake.writes()).toEqual([]);

    approveReleasePlan(plan.id, "alice");
    const result = await executePlan(project, plan.id, plan.commit);
    expect(result).toMatchObject({
      approvedBy: "alice",
      result: {
        reviewSubmissionId: "s1",
        reviewSubmissionState: "WAITING_FOR_REVIEW",
      },
    });
    expect(
      fake.writes().map((request) => `${request.method} ${request.path}`),
    ).toEqual([
      "POST /v1/appStoreVersions",
      "PATCH /v1/appStoreVersions/v1/relationships/build",
      "PATCH /v1/appStoreVersionLocalizations/loc1",
      "POST /v1/reviewSubmissions",
      "POST /v1/reviewSubmissionItems",
      "PATCH /v1/reviewSubmissions/s1",
    ]);
    expect(fake.writes()[0]!.body).toMatchObject({
      data: {
        attributes: {
          versionString: "1.1",
          releaseType: "MANUAL",
          platform: "IOS",
        },
      },
    });
    // The approval is single use.
    await expect(executePlan(project, plan.id, plan.commit)).rejects.toThrow();
  });

  test("will not plan a submission for a version already in review", async () => {
    useAsc({
      ...submissionRoutes(),
      "GET /v1/apps/app-1/appStoreVersions": () => ({
        data: [
          {
            type: "appStoreVersions",
            id: "v1",
            attributes: {
              versionString: "1.1",
              appVersionState: "WAITING_FOR_REVIEW",
            },
          },
        ],
      }),
    });
    await expect(
      createStorePlan(project, "submit", {
        marketingVersion: "1.1",
        buildNumber: "42",
      }),
    ).rejects.toThrow("cannot be submitted");
  });

  test("releases only a version waiting for developer release", async () => {
    let state = "IN_REVIEW";
    const fake = useAsc({
      "GET /v1/apps": () => app(),
      "GET /v1/apps/app-1/appStoreVersions": () => ({
        data: [
          {
            type: "appStoreVersions",
            id: "v1",
            attributes: { versionString: "1.1", appVersionState: state },
          },
        ],
      }),
      "POST /v1/appStoreVersionReleaseRequests": () => ({
        data: { type: "appStoreVersionReleaseRequests", id: "r1" },
      }),
    });
    await expect(
      createStorePlan(project, "release", { marketingVersion: "1.1" }),
    ).rejects.toThrow("IN_REVIEW");

    state = "PENDING_DEVELOPER_RELEASE";
    const { plan } = await createStorePlan(project, "release", {
      marketingVersion: "1.1",
    });
    approveReleasePlan(plan.id, "alice");
    await expect(executePlan(project, plan.id, "0".repeat(40))).rejects.toThrow(
      "confirmation",
    );
    await executePlan(project, plan.id, plan.commit);
    expect(fake.writes()).toHaveLength(1);
    expect(fake.writes()[0]!.body).toEqual({
      data: {
        type: "appStoreVersionReleaseRequests",
        relationships: {
          appStoreVersion: { data: { type: "appStoreVersions", id: "v1" } },
        },
      },
    });
  });

  test("store plans follow the branch policy", async () => {
    useAsc(submissionRoutes());
    await git("checkout", "-b", "feature");
    await expect(
      createStorePlan(project, "submit", {
        marketingVersion: "1.1",
        buildNumber: "42",
      }),
    ).rejects.toThrow("not release-enabled");
  });
});
