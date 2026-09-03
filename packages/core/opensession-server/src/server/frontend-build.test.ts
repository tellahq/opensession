import { describe, expect, it, afterEach } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  __setFrontendReleaseRootForTest,
  activateFrontendRelease,
  activeFrontendReleaseRoot,
  bundleVersion,
  editorName,
  ensureFrontendBuilt,
  frontendDistFile,
  frontendInputsHash,
  isPrebuiltFrontend,
  renderIndexHtml,
  SPA_HEADERS,
} from "./frontend-build";
import { __setIdentitiesForTest } from "./shared/user-mappings";
import { publishStableFrontendSnapshot } from "./stable-frontend";

let restore: (() => void) | null = null;
let scratch: string | null = null;
const previousDeployState = process.env.OPENSESSION_DEPLOY_STATE;
const previousGatewayRole = process.env.OPENSESSION_GATEWAY_ROLE;
afterEach(() => {
  restore?.();
  restore = null;
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = null;
  if (previousDeployState === undefined)
    delete process.env.OPENSESSION_DEPLOY_STATE;
  else process.env.OPENSESSION_DEPLOY_STATE = previousDeployState;
  if (previousGatewayRole === undefined)
    delete process.env.OPENSESSION_GATEWAY_ROLE;
  else process.env.OPENSESSION_GATEWAY_ROLE = previousGatewayRole;
});

function roster() {
  restore = __setIdentitiesForTest([
    {
      name: "Kent de Bruin",
      email: "kent@example.test",
      slackId: "U08S8B3P83X",
      github: "kentdebruin",
    },
    {
      name: "Michiel Westerbeek",
      email: "michiel@example.test",
      aliases: ["michiel"],
    },
  ]);
}

describe("editorName", () => {
  it("resolves a Slack run's raw user id to the person's name", () => {
    roster();
    expect(editorName("U08S8B3P83X")).toBe("Kent");
  });

  it("keeps a web run's display name", () => {
    roster();
    expect(editorName("Michiel")).toBe("Michiel");
  });

  it("names one person once, whichever id each of their runs carries", () => {
    roster();
    expect(editorName("kentdebruin")).toBe(editorName("U08S8B3P83X"));
  });

  it("drops a Slack id that resolves to nobody, rather than printing it", () => {
    roster();
    expect(editorName("U0NOTONROSTER")).toBeNull();
  });

  it("keeps a label that was never an id, like an agent loop", () => {
    roster();
    expect(editorName("Agent (loops)")).toBe("Agent (loops)");
  });

  it("has nothing to say about an empty user", () => {
    expect(editorName("")).toBeNull();
    expect(editorName(null)).toBeNull();
  });
});

describe("frontendInputsHash", () => {
  it("is stable across calls and reads as a portable content hash", () => {
    const a = frontendInputsHash();
    expect(a).toBe(frontendInputsHash());
    expect(a).toMatch(/^[0-9a-z]+$/);
  });
});

describe("SPA_HEADERS", () => {
  it("leaves offline shell caching to the service worker", () => {
    expect(SPA_HEADERS["Cache-Control"]).toBe("no-store");
  });
});

describe("renderIndexHtml", () => {
  const previousAgentation = process.env.OPENSESSION_AGENTATION;
  afterEach(() => {
    if (previousAgentation === undefined)
      delete process.env.OPENSESSION_AGENTATION;
    else process.env.OPENSESSION_AGENTATION = previousAgentation;
  });

  const meta = {
    inputsHash: "x",
    entryName: "App-abc.js",
    cssName: "global-def.css",
    twName: "tailwind-ghi.css",
    assets: ["App-abc.js", "global-def.css", "tailwind-ghi.css"],
  };

  it("points the source shell at the compiled assets and fills the instance blob", () => {
    const html = renderIndexHtml(meta);
    expect(html).toContain(
      `<script type="module" crossorigin src="/App-abc.js"></script>`,
    );
    expect(html).toContain(`<link rel="stylesheet" href="/global-def.css">`);
    expect(html).toContain(`<link rel="stylesheet" href="/tailwind-ghi.css">`);
    expect(html).toMatch(/window\.__OPENSESSION_INSTANCE__ = \{"productName":/);
    expect(html).not.toContain("window.__OPENSESSION_INSTANCE__ || {}");
  });

  it("omits the Tailwind link when no sheet compiled", () => {
    const html = renderIndexHtml({ ...meta, twName: null });
    expect(html).not.toContain('href="/tailwind-');
    expect(bundleVersion({ ...meta, twName: null })).toBe(
      "App-abc.js|global-def.css|no-tw",
    );
  });

  it("only enables Agentation through the explicit runtime flag", () => {
    delete process.env.OPENSESSION_AGENTATION;
    expect(renderIndexHtml(meta)).not.toContain('"agentationEnabled":true');
    process.env.OPENSESSION_AGENTATION = "1";
    expect(renderIndexHtml(meta)).toContain('"agentationEnabled":true');
  });
});

describe("isPrebuiltFrontend", () => {
  const prev = process.env.OPENSESSION_PREBUILT_FRONTEND;
  afterEach(() => {
    if (prev === undefined) delete process.env.OPENSESSION_PREBUILT_FRONTEND;
    else process.env.OPENSESSION_PREBUILT_FRONTEND = prev;
  });

  it("follows the env override in both directions", () => {
    process.env.OPENSESSION_PREBUILT_FRONTEND = "1";
    expect(isPrebuiltFrontend()).toBe(true);
    process.env.OPENSESSION_PREBUILT_FRONTEND = "0";
    expect(isPrebuiltFrontend()).toBe(false);
  });
});

describe("activateFrontendRelease", () => {
  it("validates and atomically promotes a prepared release bundle", async () => {
    scratch = mkdtempSync(join(tmpdir(), "opensession-frontend-release-"));
    process.env.OPENSESSION_DEPLOY_STATE = scratch;
    const sha = "a".repeat(40);
    const baseSha = "b".repeat(40);
    const releaseRoot = join(scratch, "releases", sha);
    const sourceRoot = join(
      releaseRoot,
      "packages/core/opensession-server/src/frontend",
    );
    const dist = join(releaseRoot, ".frontend-dist");
    mkdirSync(sourceRoot, { recursive: true });
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(releaseRoot, ".opensession-release"), `${sha}\n`);
    writeFileSync(
      join(sourceRoot, "index.html"),
      '<html><head><title>Open Session</title></head><body><script>window.__OPENSESSION_INSTANCE__ = window.__OPENSESSION_INSTANCE__ || {};</script><script type="module" src="./App.tsx"></script></body></html>',
    );
    for (const name of ["App-new.js", "global-new.css"])
      writeFileSync(join(dist, name), name);
    writeFileSync(
      join(dist, ".bundle-meta.json"),
      JSON.stringify({
        inputsHash: "inputs",
        entryName: "App-new.js",
        cssName: "global-new.css",
        twName: null,
        assets: ["App-new.js", "global-new.css"],
      }),
    );
    const previousSha = "c".repeat(40);
    const previousRoot = join(scratch, "releases", previousSha);
    mkdirSync(join(previousRoot, ".frontend-dist"), { recursive: true });
    writeFileSync(
      join(previousRoot, ".opensession-release"),
      `${previousSha}\n`,
    );
    writeFileSync(
      join(previousRoot, ".frontend-dist", "Settings-old.js"),
      "old settings",
    );
    publishStableFrontendSnapshot(scratch, {
      releaseRoot: previousRoot,
      version: "App-old.js|global-old.css|no-tw",
      indexHtml: '<script src="/App-old.js"></script>',
    });

    const restoreRoot = __setFrontendReleaseRootForTest(previousRoot);
    const version = activateFrontendRelease({
      sha,
      baseSha,
      releaseRoot,
      promotedAt: "2026-08-27T10:00:00.000Z",
    });
    restore = restoreRoot;
    expect(version).toBe("App-new.js|global-new.css|no-tw");
    expect(activeFrontendReleaseRoot()).toBe(releaseRoot);
    expect(
      JSON.parse(readFileSync(join(scratch, "frontend-current.json"), "utf8")),
    ).toMatchObject({ sha, baseSha });
    expect(
      JSON.parse(readFileSync(join(scratch, "stable-frontend.json"), "utf8")),
    ).toMatchObject({
      releaseRoot,
      fallbackRoots: [previousRoot],
      version,
    });
    expect(await frontendDistFile("Settings-old.js")?.exists()).toBe(true);

    publishStableFrontendSnapshot(scratch, {
      releaseRoot: previousRoot,
      version: "App-old.js|global-old.css|no-tw",
      indexHtml: '<script src="/App-old.js"></script>',
    });
    process.env.OPENSESSION_GATEWAY_ROLE = "standby";
    await ensureFrontendBuilt();
    expect(
      JSON.parse(readFileSync(join(scratch, "stable-frontend.json"), "utf8")),
    ).toMatchObject({ releaseRoot, version });

    publishStableFrontendSnapshot(scratch, {
      releaseRoot: previousRoot,
      version: "App-old.js|global-old.css|no-tw",
      indexHtml: '<script src="/App-old.js"></script>',
    });
    activateFrontendRelease({
      sha,
      baseSha,
      releaseRoot,
      promotedAt: "2026-08-27T10:01:00.000Z",
    });
    expect(
      JSON.parse(readFileSync(join(scratch, "stable-frontend.json"), "utf8")),
    ).toMatchObject({ releaseRoot: previousRoot });

    process.env.OPENSESSION_GATEWAY_ROLE = "active";
    activateFrontendRelease({
      sha,
      baseSha,
      releaseRoot,
      promotedAt: "2026-08-27T10:02:00.000Z",
    });
    expect(
      JSON.parse(readFileSync(join(scratch, "stable-frontend.json"), "utf8")),
    ).toMatchObject({ releaseRoot, version });
  });
});
