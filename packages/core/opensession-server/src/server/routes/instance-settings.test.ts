import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { configuredAssetStorage } from "../config";
import type { RouteContext } from "./context";
import {
  assetStorageCandidate,
  handleInstanceSettingsRoutes,
} from "./instance-settings";
import { handleStaticAssetsRoutes } from "./static-assets";

const saved = {
  config: process.env.OPENSESSION_CONFIG,
  state: process.env.OPENSESSION_STATE_DIR,
  clientId: process.env.OPENSESSION_GITHUB_CLIENT_ID,
};
const dirs: string[] = [];

function seed(options: { storage?: boolean } = {}): {
  root: string;
  config: string;
} {
  const root = mkdtempSync(join(tmpdir(), "opensession-instance-settings-"));
  dirs.push(root);
  const config = join(root, "config.json");
  writeFileSync(
    config,
    JSON.stringify({
      branding: { productName: "Open Session" },
      future: { keep: true },
      ...(options.storage
        ? {
            storage: {
              assets: {
                provider: "s3",
                bucket: "assets",
                region: "auto",
                endpoint: "https://account.r2.cloudflarestorage.com",
                prefix: "sessions/assets",
                accessKeyId: "key-id",
                secretAccessKey: "secret",
                forcePathStyle: false,
              },
            },
          }
        : {}),
      integrations: {
        github: { userPrAuth: true, oauthClientId: "test-client" },
      },
      identity: {
        team: [
          { name: "Ada", github: "ada", admin: true },
          { name: "Grace", github: "grace", admin: false },
        ],
      },
    }),
  );
  process.env.OPENSESSION_CONFIG = config;
  process.env.OPENSESSION_STATE_DIR = root;
  process.env.OPENSESSION_GITHUB_CLIENT_ID = "test-client";
  return { root, config };
}

function context(
  path: string,
  method = "GET",
  opts: { login?: string; body?: unknown; bytes?: Uint8Array } = {},
): RouteContext {
  const url = new URL(`http://localhost${path}`);
  return {
    req: new Request(url, {
      method,
      ...(opts.bytes
        ? {
            body: opts.bytes.slice().buffer as ArrayBuffer,
            headers: { "Content-Type": "image/png" },
          }
        : opts.body !== undefined
          ? {
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(opts.body),
            }
          : {}),
    }),
    url,
    path,
    publicPrefix: "",
    authUser: opts.login ? { login: opts.login, name: opts.login } : null,
  };
}

function squarePngHeader(side = 256): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  bytes.set([73, 72, 68, 82], 12);
  for (const offset of [16, 20]) {
    bytes[offset] = (side >>> 24) & 0xff;
    bytes[offset + 1] = (side >>> 16) & 0xff;
    bytes[offset + 2] = (side >>> 8) & 0xff;
    bytes[offset + 3] = side & 0xff;
  }
  return bytes;
}

afterEach(() => {
  for (const [key, value] of [
    ["OPENSESSION_CONFIG", saved.config],
    ["OPENSESSION_STATE_DIR", saved.state],
    ["OPENSESSION_GITHUB_CLIENT_ID", saved.clientId],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("instance general settings", () => {
  test("writes the organization name and preserves unrelated config", async () => {
    const { config } = seed();
    const response = await handleInstanceSettingsRoutes(
      context("/api/settings/general", "PUT", {
        login: "ada",
        body: { organizationName: " Acme " },
      }),
    );
    expect(response?.status).toBe(200);
    expect((await response?.json()).organizationName).toBe("Acme");
    const stored = JSON.parse(readFileSync(config, "utf-8"));
    expect(stored.organization).toEqual({ name: "Acme" });
    expect(stored.future).toEqual({ keep: true });
  });

  test("persists the worktree policy for new shared-checkout sessions", async () => {
    const { config } = seed();
    const initial = await handleInstanceSettingsRoutes(
      context("/api/settings/worktrees", "GET", { login: "ada" }),
    );
    expect(initial?.status).toBe(200);
    expect((await initial?.json()).mode).toBe("shared");

    const updated = await handleInstanceSettingsRoutes(
      context("/api/settings/worktrees", "PUT", {
        login: "ada",
        body: { mode: "worktree" },
      }),
    );
    expect(updated?.status).toBe(200);
    expect((await updated?.json()).mode).toBe("worktree");
    const stored = JSON.parse(readFileSync(config, "utf-8"));
    expect(stored.selfDev).toBe("worktree");
    expect(stored.future).toEqual({ keep: true });
  });

  test("rejects an invalid worktree policy", async () => {
    const { config } = seed();
    const response = await handleInstanceSettingsRoutes(
      context("/api/settings/worktrees", "PUT", {
        login: "ada",
        body: { mode: "sometimes" },
      }),
    );
    expect(response?.status).toBe(400);
    expect(JSON.parse(readFileSync(config, "utf-8")).selfDev).toBeUndefined();
  });

  test("rejects shared-setting writes from non-admin teammates", async () => {
    const { config } = seed();
    for (const path of [
      "/api/settings/general",
      "/api/settings/identity",
      "/api/settings/asset-storage",
      "/api/settings/worktrees",
    ]) {
      const response = await handleInstanceSettingsRoutes(
        context(path, "PUT", {
          login: "grace",
          body: path.endsWith("general")
            ? { organizationName: "Nope" }
            : path.endsWith("asset-storage")
              ? { provider: "local" }
              : { productName: "Nope" },
        }),
      );
      expect(response?.status).toBe(403);
    }
    expect(
      JSON.parse(readFileSync(config, "utf-8")).organization,
    ).toBeUndefined();
  });

  test("masks the asset secret and retains it when a draft leaves it blank", async () => {
    seed({ storage: true });
    const response = await handleInstanceSettingsRoutes(
      context("/api/settings/asset-storage", "GET", { login: "ada" }),
    );
    const body = await response?.json();
    expect(response?.status).toBe(200);
    expect(body).toMatchObject({
      provider: "s3",
      bucket: "assets",
      endpoint: "https://account.r2.cloudflarestorage.com",
      secretAccessKeySet: true,
    });
    expect(body.secretAccessKey).toBeUndefined();
    expect(configuredAssetStorage()).toMatchObject({
      provider: "s3",
      bucket: "assets",
      prefix: "sessions/assets",
      secretAccessKey: "secret",
    });

    expect(
      assetStorageCandidate({
        provider: "s3",
        bucket: "assets",
        region: "auto",
        endpoint: "https://account.r2.cloudflarestorage.com",
        prefix: "/sessions/assets/",
        accessKeyId: "key-id",
        secretAccessKey: "",
      }),
    ).toMatchObject({
      provider: "s3",
      prefix: "sessions/assets",
      secretAccessKey: "secret",
    });
  });

  test("switches back to local without deleting unrelated config", async () => {
    const { config } = seed({ storage: true });
    const response = await handleInstanceSettingsRoutes(
      context("/api/settings/asset-storage", "PUT", {
        login: "ada",
        body: { provider: "local" },
      }),
    );
    expect(response?.status).toBe(200);
    expect((await response?.json()).provider).toBe("local");
    const stored = JSON.parse(readFileSync(config, "utf8"));
    expect(stored.storage).toBeUndefined();
    expect(stored.future).toEqual({ keep: true });
  });

  test("stores, serves, and removes the organization icon", async () => {
    seed();
    const bytes = squarePngHeader();
    const upload = await handleInstanceSettingsRoutes(
      context("/api/settings/general/icon", "POST", { login: "ada", bytes }),
    );
    const uploaded = await upload?.json();
    expect(upload?.status).toBe(200);
    expect(uploaded.organizationIconUrl).toMatch(
      /^\/organization-icon\.png\?v=[a-f0-9]{12}$/,
    );

    const asset = await handleStaticAssetsRoutes(
      context("/organization-icon.png"),
    );
    expect(asset?.status).toBe(200);
    expect(asset?.headers.get("Content-Type")).toBe("image/png");
    expect(Array.from(new Uint8Array(await asset!.arrayBuffer()))).toEqual(
      Array.from(bytes),
    );

    const removed = await handleInstanceSettingsRoutes(
      context("/api/settings/general/icon", "DELETE", { login: "ada" }),
    );
    expect((await removed?.json()).organizationIconUrl).toBeNull();
    expect(
      (await handleStaticAssetsRoutes(context("/organization-icon.png")))
        ?.status,
    ).toBe(404);
  });

  test("rejects non-square or oversized icon dimensions", async () => {
    seed();
    const bytes = squarePngHeader(4096);
    const response = await handleInstanceSettingsRoutes(
      context("/api/settings/general/icon", "POST", { login: "ada", bytes }),
    );
    expect(response?.status).toBe(400);
    expect((await response?.json()).error).toContain("square icon");
  });

  test("rejects oversized icon bodies before storing them", async () => {
    seed();
    const response = await handleInstanceSettingsRoutes(
      context("/api/settings/general/icon", "POST", {
        login: "ada",
        bytes: new Uint8Array(4 * 1024 * 1024 + 1),
      }),
    );
    expect(response?.status).toBe(413);
    expect((await response?.json()).error).toContain("4 MB");
  });
});
