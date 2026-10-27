import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// Scratch state and MCP config before anything reads them at import time.
const root = mkdtempSync(join(tmpdir(), "automation-mcp-run-as-"));
process.env.OPENSESSION_STATE_DIR = root;
process.env.OPENSESSION_MCP_CONFIG = join(root, "mcp-config.json");

const { __setIdentitiesForTest } = await import("./shared/user-mappings");
const { statePath } = await import("./paths");
const {
  authorizeMcpRunAs,
  mcpRunAsForAutomationTurn,
  parseMcpRunAsInput,
  CLEAR_MCP_RUN_AS,
} = await import("./automation-mcp-run-as");
const { mcpGrantCandidates } = await import("./mcp-runtime");
const { mintMcpRelayToken, handleMcpRelay } = await import("./mcp-relay");
const { createAutomation, getAutomation, updateAutomation } =
  await import("./automations");

const restoreIdentities = __setIdentitiesForTest([
  {
    name: "Ada Lovelace",
    email: "ada@example.test",
    github: "adalovelace",
    slackId: "UADA000001",
  },
  {
    name: "Grace Hopper",
    email: "grace@example.test",
    github: "gracehopper",
    slackId: "UGRACE0001",
  },
]);

// A stand-in for an OAuth-only MCP server that reports the Authorization it
// received, reached through the same relay real runs use.
let upstream: ReturnType<typeof Bun.serve>;
beforeAll(() => {
  upstream = Bun.serve({
    port: 0,
    fetch: (req) =>
      Response.json({ authorization: req.headers.get("authorization") }),
  });
  writeFileSync(
    process.env.OPENSESSION_MCP_CONFIG!,
    JSON.stringify({
      mcpServers: {
        acme: { type: "http", url: `http://127.0.0.1:${upstream.port}/mcp` },
      },
    }),
  );
  const oauthStore = statePath(".opensession-mcp-oauth.json");
  mkdirSync(dirname(oauthStore), { recursive: true });
  writeFileSync(
    oauthStore,
    JSON.stringify({
      acme: {
        serverUrl: `http://127.0.0.1:${upstream.port}/mcp`,
        endpoints: { authorize: "x", token: "x" },
        clientInfo: { clientId: "client" },
        // Personal grants only, like a server with no workspace connection.
        users: {
          "Ada Lovelace": {
            tokens: { accessToken: "ada-token" },
            updatedAt: "2026-10-27T00:00:00Z",
          },
        },
      },
    }),
  );
});
afterAll(() => {
  upstream?.stop(true);
  restoreIdentities();
  rmSync(root, { recursive: true, force: true });
});

/** The Authorization header the upstream server sees for one run's grant
 *  identities, through the relay token the runtime would mint. */
async function upstreamAuthorization(
  candidates: string[],
): Promise<string | null> {
  const token = mintMcpRelayToken("acme", candidates);
  const res = await handleMcpRelay(
    new Request("http://127.0.0.1/relay/acme", {
      method: "POST",
      body: "{}",
      headers: { "content-type": "application/json" },
    }),
    "acme",
    token,
  );
  return ((await res.json()) as { authorization: string | null }).authorization;
}

describe("automation runs with Run MCP sign-ins as", () => {
  test("an automation with the setting gets the named person's grant", async () => {
    const runAs = mcpRunAsForAutomationTurn({
      mcpServers: ["acme", "slack"],
      mcpRunAs: {
        person: "Ada Lovelace",
        servers: ["acme"],
        setAt: "2026-10-27T00:00:00Z",
      },
    });
    expect(runAs).toEqual({ user: "Ada Lovelace", servers: ["acme"] });
    // Automation runs carry no user and no creator grant identity.
    const candidates = mcpGrantCandidates("acme", { mcpRunAs: runAs });
    expect(candidates).toEqual(["Ada Lovelace"]);
    expect(await upstreamAuthorization(candidates)).toBe("Bearer ada-token");
    // Servers outside the pinned set never get it.
    expect(mcpGrantCandidates("slack", { mcpRunAs: runAs })).toEqual([]);
  });

  test("an automation without it gets no personal grant", async () => {
    const runAs = mcpRunAsForAutomationTurn({ mcpServers: ["acme"] });
    expect(runAs).toBeUndefined();
    const candidates = mcpGrantCandidates("acme", { mcpRunAs: runAs });
    expect(candidates).toEqual([]);
    expect(await upstreamAuthorization(candidates)).toBeNull();
  });

  test("it follows the current allowlist and never a different sender", () => {
    const automation = {
      mcpServers: ["acme"],
      mcpRunAs: {
        person: "Ada Lovelace",
        servers: ["acme"],
        setAt: "2026-10-27T00:00:00Z",
      },
    };
    expect(
      mcpRunAsForAutomationTurn({ ...automation, mcpServers: ["slack"] }),
    ).toBeUndefined();
    expect(
      mcpRunAsForAutomationTurn({ ...automation, mcpServers: undefined }),
    ).toBeUndefined();
    expect(mcpRunAsForAutomationTurn(automation, "Grace")).toBeUndefined();
    expect(mcpRunAsForAutomationTurn(automation, "Ada")).toEqual({
      user: "Ada Lovelace",
      servers: ["acme"],
    });
  });
});

describe("who can set it", () => {
  test("only the named teammate, to themselves", () => {
    const request = { person: "Ada" };
    expect(authorizeMcpRunAs(request, "adalovelace", ["acme"])).toMatchObject({
      person: "Ada Lovelace",
      servers: ["acme"],
    });
    expect(authorizeMcpRunAs(request, "gracehopper", ["acme"])).toHaveProperty(
      "error",
    );
    expect(authorizeMcpRunAs(request, undefined, ["acme"])).toHaveProperty(
      "error",
    );
    expect(authorizeMcpRunAs(request, "adalovelace", undefined)).toHaveProperty(
      "error",
    );
    expect(
      authorizeMcpRunAs({ person: "Ada", servers: ["other"] }, "adalovelace", [
        "acme",
      ]),
    ).toHaveProperty("error");
    expect(parseMcpRunAsInput("") === CLEAR_MCP_RUN_AS).toBe(true);
    expect(parseMcpRunAsInput(null) === CLEAR_MCP_RUN_AS).toBe(true);
  });

  test("the automation store enforces it on every write", async () => {
    const created = await createAutomation({
      name: "Docs sync",
      prompt: "Record the help videos.",
      schedule: "",
      mode: "ask",
      createdBy: "Grace",
      mcpServers: ["acme"],
    });
    if ("error" in created) throw new Error(created.error);

    // A request body alone (no verified actor) cannot set it.
    expect(
      await updateAutomation(created.id, { mcpRunAs: "Ada" }),
    ).toHaveProperty("error");
    // Another person cannot point it at Ada's grants.
    expect(
      await updateAutomation(
        created.id,
        { mcpRunAs: "Ada" },
        { actor: "gracehopper" },
      ),
    ).toHaveProperty("error");
    expect((await getAutomation(created.id))?.mcpRunAs).toBeUndefined();

    const set = await updateAutomation(
      created.id,
      { mcpRunAs: "Ada" },
      { actor: "adalovelace" },
    );
    if ("error" in set) throw new Error(set.error);
    expect(set.mcpRunAs).toMatchObject({
      person: "Ada Lovelace",
      servers: ["acme"],
    });

    // Unrelated edits by someone else leave it alone; clearing needs no
    // identity because it only removes access.
    const renamed = await updateAutomation(created.id, { name: "Docs sync 2" });
    if ("error" in renamed) throw new Error(renamed.error);
    expect(renamed.mcpRunAs?.person).toBe("Ada Lovelace");
    const cleared = await updateAutomation(created.id, { mcpRunAs: "" });
    if ("error" in cleared) throw new Error(cleared.error);
    expect(cleared.mcpRunAs).toBeUndefined();
  });
});
