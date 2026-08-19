import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import {
  chmodSync,
  rmSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "mcp-oauth-security-"));
const credentials = join(root, "credentials");
const store = join(root, ".opensession-mcp-oauth.json");
// A real executable on PATH: the stdio binding pins the RESOLVED path, so the
// fixture needs something that actually resolves.
const binDir = join(root, "bin");
const key = Buffer.alloc(32, 0x42);
const ACCESS = "synthetic-access-token-never-log";
const REFRESH = "synthetic-refresh-token-never-log";
const previous = {
  state: process.env.OPENSESSION_STATE_DIR,
  credentials: process.env.CREDENTIALS_DIRECTORY,
  mcpConfig: process.env.OPENSESSION_MCP_CONFIG,
  path: process.env.PATH,
};

let oauth: typeof import("./mcp-oauth");
let connections: typeof import("./connections");
let proxy: typeof import("./mcp-oauth-proxy");
let runnerShared: typeof import("./runner-shared");
let userMappings: typeof import("./shared/user-mappings");

beforeAll(async () => {
  mkdirSync(credentials, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, "synthetic-slack-mcp"), "#!/bin/sh\nexit 0\n", {
    mode: 0o755,
  });
  process.env.PATH = `${binDir}:${process.env.PATH}`;
  writeFileSync(join(credentials, "mcp-oauth-key"), key, { mode: 0o400 });
  const mcpConfig = join(root, "mcp-config.json");
  writeFileSync(
    mcpConfig,
    JSON.stringify({
      mcpServers: {
        slack: { command: "synthetic-slack-mcp", args: [] },
        tella: { type: "http", url: "https://tella.example.test/mcp" },
        restricted: {
          type: "http",
          url: "https://restricted.example.test/mcp",
          allowedUsers: ["Michiel"],
        },
      },
    }),
  );
  // user-mappings derives its tables from configuredIdentity() ONCE at module
  // load, so a per-user grant only resolves when a roster exists. Supply one
  // that mirrors the real names: whichever config wins (this fixture in an
  // isolated run, the instance's own when another test file loaded the module
  // first), both people below resolve, and the test reads the slot name back
  // rather than assuming it.
  mkdirSync(join(root, ".opensession"), { recursive: true });
  writeFileSync(
    join(root, ".opensession", "config.json"),
    JSON.stringify({
      identity: {
        team: [
          {
            name: "Michiel Westerbeek",
            email: "michiel@example.test",
            aliases: ["michiel"],
            slackId: "UTESTMICHIEL",
          },
          {
            name: "Kent de Bruin",
            email: "kent@example.test",
            aliases: ["kent"],
            slackId: "UTESTKENT",
          },
        ],
      },
    }),
  );
  process.env.OPENSESSION_STATE_DIR = root;
  process.env.CREDENTIALS_DIRECTORY = credentials;
  process.env.OPENSESSION_MCP_CONFIG = mcpConfig;
  oauth = await import("./mcp-oauth");
  connections = await import("./connections");
  proxy = await import("./mcp-oauth-proxy");
  runnerShared = await import("./runner-shared");
  userMappings = await import("./shared/user-mappings");
});

afterAll(() => {
  if (previous.state === undefined) delete process.env.OPENSESSION_STATE_DIR;
  else process.env.OPENSESSION_STATE_DIR = previous.state;
  if (previous.credentials === undefined) delete process.env.CREDENTIALS_DIRECTORY;
  else process.env.CREDENTIALS_DIRECTORY = previous.credentials;
  if (previous.mcpConfig === undefined) delete process.env.OPENSESSION_MCP_CONFIG;
  else process.env.OPENSESSION_MCP_CONFIG = previous.mcpConfig;
  if (previous.path === undefined) delete process.env.PATH;
  else process.env.PATH = previous.path;
});

function legacyStore() {
  return {
    slack: {
      serverUrl: "https://mcp.example.test",
      endpoints: {
        authorize: "https://auth.example.test/authorize",
        token: "https://auth.example.test/token",
      },
      clientInfo: { clientId: "synthetic-client" },
      shared: {
        tokens: {
          accessToken: ACCESS,
          refreshToken: REFRESH,
          expiresAt: Date.now() + 60 * 60_000,
        },
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    },
    expired: {
      serverUrl: "https://expired.example.test/mcp",
      endpoints: {
        authorize: "https://expired.example.test/authorize",
        token: "https://expired.example.test/token",
      },
      clientInfo: { clientId: "expired-client" },
      shared: {
        tokens: {
          accessToken: "expired-access-token",
          expiresAt: Date.now() - 1,
        },
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    },
  };
}

describe("personal MCP OAuth credential storage", () => {
  test("atomically migrates a plaintext grant to authenticated ciphertext", () => {
    writeFileSync(store, JSON.stringify(legacyStore()), { mode: 0o600 });
    const seenLogs: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => seenLogs.push(args.map(String).join(" "));
    try {
      expect(oauth.mcpOauthStatus("slack").shared).toBeDefined();
    } finally {
      console.log = original;
    }

    const disk = readFileSync(store, "utf8");
    const envelope = JSON.parse(disk);
    expect(envelope).toMatchObject({ version: 2, algorithm: "aes-256-gcm" });
    expect(disk).not.toContain(ACCESS);
    expect(disk).not.toContain(REFRESH);
    expect(seenLogs.join("\n")).not.toContain(ACCESS);
    expect(seenLogs.join("\n")).not.toContain(REFRESH);
    expect(statSync(store).mode & 0o777).toBe(0o600);
    expect(oauth.mcpSharedGrantHeader("slack")).toBe(`Bearer ${ACCESS}`);
    expect(oauth.hasMcpOauthGrantForUsers("expired", [])).toBe(true);
    expect(oauth.mcpSharedGrantHeader("expired")).toBeUndefined();
    expect(
      oauth.mcpOauthBindingMatches("slack", {
        command: "synthetic-slack-mcp",
        args: [],
      }),
    ).toBe(true);
    expect(
      oauth.mcpOauthBindingMatches("slack", {
        command: "attacker-controlled-mcp",
        args: [],
      }),
    ).toBe(false);
    // The command is what runs, but the environment decides WHICH command
    // runs. Leaving command/args alone and pointing PATH at a workspace copy
    // has to break the binding too, or the replacement receives the token.
    expect(
      oauth.mcpOauthBindingMatches("slack", {
        command: "synthetic-slack-mcp",
        args: [],
        env: { PATH: "/tmp/agent-writable" },
      }),
    ).toBe(false);
    // Key ORDER in the config file is not a change of execution.
    expect(
      oauth.mcpOauthBindingMatches("slack", { command: "synthetic-slack-mcp", args: [] }),
    ).toBe(true);
    // The pin is the resolved path, and the proxy launches that rather than
    // the configured name, so shadowing the name on PATH cannot capture the
    // token without also changing what the name resolves to.
    expect(oauth.mcpOauthStdioCommand("slack")).toBe(
      join(binDir, "synthetic-slack-mcp"),
    );
    const shadow = mkdtempSync(join(tmpdir(), "mcp-oauth-shadow-"));
    writeFileSync(join(shadow, "synthetic-slack-mcp"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const realPath = process.env.PATH;
    process.env.PATH = `${shadow}:${realPath}`;
    try {
      expect(
        oauth.mcpOauthBindingMatches("slack", { command: "synthetic-slack-mcp", args: [] }),
      ).toBe(false);
    } finally {
      process.env.PATH = realPath;
    }
  });

  test("mints its own 0600 key when no systemd credential is present", () => {
    // The rootless install: no CREDENTIALS_DIRECTORY, so the store still has
    // to be ciphertext at rest rather than the feature failing closed.
    const previousCredentials = process.env.CREDENTIALS_DIRECTORY;
    const keyPath = join(root, ".opensession-mcp-oauth.key");
    delete process.env.CREDENTIALS_DIRECTORY;
    try {
      rmSync(keyPath, { force: true });
      writeFileSync(store, JSON.stringify(legacyStore()), { mode: 0o600 });
      expect(oauth.mcpOauthStatus("slack").shared).toBeDefined();

      expect(statSync(keyPath).mode & 0o777).toBe(0o600);
      expect(readFileSync(keyPath).length).toBe(32);
      const disk = readFileSync(store, "utf8");
      expect(JSON.parse(disk)).toMatchObject({ version: 2 });
      expect(disk).not.toContain(ACCESS);
      expect(disk).not.toContain(REFRESH);
      // Minted once and reused: a second read must not re-key the store.
      const minted = readFileSync(keyPath);
      expect(oauth.mcpSharedGrantHeader("slack")).toBe(`Bearer ${ACCESS}`);
      expect(readFileSync(keyPath)).toEqual(minted);
    } finally {
      if (previousCredentials === undefined) delete process.env.CREDENTIALS_DIRECTORY;
      else process.env.CREDENTIALS_DIRECTORY = previousCredentials;
      rmSync(keyPath, { force: true });
      writeFileSync(store, JSON.stringify(legacyStore()), { mode: 0o600 });
      expect(oauth.mcpOauthStatus("slack").shared).toBeDefined();
    }
  });

  test("does not inject personal tokens into engine-facing MCP config", () => {
    const resolved = connections.withDynamicCredentials(
      {
        slack: {
          command: "synthetic-slack-mcp",
          env: { SLACK_BOT_TOKEN: "workspace-bot-reference" },
        },
      },
      ["Michiel"],
    );
    const serialized = JSON.stringify(resolved);
    expect(serialized).not.toContain(ACCESS);
    expect(serialized).not.toContain(REFRESH);
    expect(process.env.SLACK_BOT_TOKEN).not.toBe(ACCESS);
  });

  test("degrades reads on the wrong key without replacing ciphertext", () => {
    const before = readFileSync(store);
    chmodSync(join(credentials, "mcp-oauth-key"), 0o600);
    writeFileSync(join(credentials, "mcp-oauth-key"), Buffer.alloc(32, 0x24));
    chmodSync(join(credentials, "mcp-oauth-key"), 0o400);
    expect(oauth.mcpOauthStatus("slack")).toEqual({ users: [] });
    expect(readFileSync(store)).toEqual(before);
    expect(() => oauth.removeMcpOauthGrant("slack")).toThrow(
      "could not be decrypted",
    );
    chmodSync(join(credentials, "mcp-oauth-key"), 0o600);
    writeFileSync(join(credentials, "mcp-oauth-key"), key);
  });

  test("consumes a connect state redeemed by a different account", async () => {
    const previousClient = process.env.SLACK_OAUTH_CLIENT_ID;
    const previousSecret = process.env.SLACK_OAUTH_CLIENT_SECRET;
    process.env.SLACK_OAUTH_CLIENT_ID = "synthetic-client";
    process.env.SLACK_OAUTH_CLIENT_SECRET = "synthetic-secret";
    try {
      const { url } = await oauth.startMcpOauthFlow(
        "slack",
        "stdio://slack",
        undefined,
        "Michiel",
      );
      const state = new URL(url).searchParams.get("state")!;
      await expect(
        oauth.completeMcpOauthFlow(state, "unused-code", "Kent"),
      ).rejects.toThrow("different signed-in account");
      await expect(
        oauth.completeMcpOauthFlow(state, "unused-code", "Michiel"),
      ).rejects.toThrow("expired");
    } finally {
      if (previousClient === undefined) delete process.env.SLACK_OAUTH_CLIENT_ID;
      else process.env.SLACK_OAUTH_CLIENT_ID = previousClient;
      if (previousSecret === undefined) delete process.env.SLACK_OAUTH_CLIENT_SECRET;
      else process.env.SLACK_OAUTH_CLIENT_SECRET = previousSecret;
    }
  });
});

// Storing a token safely says nothing about who may spend it. Anyone signed in
// can prompt anyone's session — there is deliberately no ownership gate on
// /api/sessions/:id/prompt or the WS frame, because teammates steer each
// other's work — so the boundary that has to hold is the identity a run
// resolves credentials under. It is the prompter's, never the session owner's.
// Both properties below regressed during this change and were caught in
// review; nothing else in the suite would notice them coming back.
describe("personal MCP OAuth authorization", () => {
  test("does not mount one teammate's grant for another prompter", () => {
    // The stored slot is a resolved team name, so read it back instead of
    // hardcoding it — an empty roster would otherwise make this vacuous.
    const owner = userMappings.resolveTeammate("Michiel")?.name;
    const other = userMappings.resolveTeammate("Kent")?.name;
    if (!owner || !other) {
      throw new Error("identity roster did not resolve — the test would be vacuous");
    }
    expect(owner).not.toBe(other);

    writeFileSync(
      store,
      JSON.stringify({
        tella: {
          serverUrl: "https://tella.example.test/mcp",
          endpoints: {
            authorize: "https://tella.example.test/authorize",
            token: "https://tella.example.test/token",
          },
          clientInfo: { clientId: "synthetic-tella-client" },
          users: {
            [owner]: {
              tokens: {
                accessToken: ACCESS,
                expiresAt: Date.now() + 60 * 60_000,
              },
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
          },
        },
      }),
      { mode: 0o600 },
    );

    expect(oauth.hasMcpOauthGrantForUsers("tella", ["Michiel"])).toBe(true);
    expect(oauth.hasMcpOauthGrantForUsers("tella", ["Kent"])).toBe(false);

    // Kent opening and prompting Michiel's session: the run carries Kent, so
    // the proxy that would spend Michiel's token is never built.
    expect(
      Object.keys(proxy.mcpOauthProxyServers("all", "Michiel", ["Michiel"])),
    ).toContain("tella");
    expect(
      Object.keys(proxy.mcpOauthProxyServers("all", "Kent", ["Kent"])),
    ).not.toContain("tella");
  });

  test("credential identities never widen a server's allowedUsers gate", () => {
    // grantUsers expresses which stored grant to prefer. Letting it also decide
    // visibility would make a restricted server reachable by whoever prompts a
    // permitted person's session.
    const visible = runnerShared.filterMcpServerCatalog(
      {
        restricted: {
          type: "http",
          url: "https://restricted.example.test/mcp",
          allowedUsers: ["Michiel"],
        },
      },
      "all",
      "Kent",
      ["Michiel", "Kent"],
    );
    expect(Object.keys(visible)).not.toContain("restricted");
  });
});

// Registration is the step before any grant exists, so it has no fixture state
// of its own; it goes through the same dynamically imported module so the
// fixture's state dir is in place either way.
describe("MCP OAuth client registration", () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("explains Figma's catalog restriction instead of reporting invalid JSON", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/.well-known/oauth-protected-resource")) {
        return Response.json({
          resource: "https://mcp.figma.com/mcp",
          authorization_servers: ["https://api.figma.com"],
          scopes_supported: ["mcp:connect"],
        });
      }
      if (url === "https://api.figma.com/.well-known/oauth-authorization-server") {
        return Response.json({
          authorization_endpoint: "https://www.figma.com/oauth/mcp",
          token_endpoint: "https://api.figma.com/v1/oauth/token",
          registration_endpoint: "https://api.figma.com/v1/oauth/mcp/register",
        });
      }
      if (url === "https://api.figma.com/v1/oauth/mcp/register") {
        return new Response("Forbidden", {
          status: 403,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    }) as unknown as typeof fetch;

    // Connecting is gated on a signed-in initiator, so the registration error
    // is only reachable with one; without it the flow stops a step earlier.
    await expect(
      oauth.startMcpOauthFlow(
        "Figma test",
        "https://mcp.figma.com/mcp",
        undefined,
        "Michiel",
      ),
    ).rejects.toThrow(
      "Its remote MCP server accepts only clients listed in the Figma MCP Catalog",
    );
  });
});
