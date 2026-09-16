import { expect, test } from "bun:test";
import { handleMentionPaletteRoutes } from "./mention-palette";
import type { RouteContext } from "./context";

type Dependencies = NonNullable<
  Parameters<typeof handleMentionPaletteRoutes>[1]
>;
async function request(
  query: string,
  kind: "personal" | "shared" | "missing" | "other-owner" = "shared",
) {
  let configReads = 0;
  const url = new URL(`http://local/api/mention-suggestions?${query}`);
  const ctx = {
    req: new Request(url),
    url,
    path: url.pathname,
    publicPrefix: "",
    applicationAccess: { principal: { githubAccountId: 41 }, privacy: true },
  } as unknown as RouteContext;
  const deps: Dependencies = {
    fence: async (work) =>
      work({ incarnation: "fixture", generation: 1, replica: "fixture" }),
    findSessionAsync: async () =>
      kind === "missing"
        ? undefined
        : ({
            id: "canonical",
            accessScope:
              kind === "personal" || kind === "other-owner"
                ? {
                    kind: "personal",
                    ownerGithubAccountId: kind === "other-owner" ? 42 : 41,
                  }
                : { kind },
            mcpServers: [],
          } as any),
    readMcpConfig: () => {
      configReads++;
      return { mcpServers: { fixtureService: { command: "fixture" } } } as any;
    },
    sessions: async () => [],
    workspaces: async () => [],
  };
  const response = (await handleMentionPaletteRoutes(ctx, deps))!;
  return { response, configReads, body: await response.json() };
}

test("private canonical session suppresses config enumeration without client option", async () => {
  const result = await request("session=alias", "personal");
  expect(result.response.status).toBe(200);
  expect(result.configReads).toBe(0);
  expect(result.body.items.some((item: any) => item.kind === "tool")).toBe(
    false,
  );
});
test("private explicit nonempty MCP scope rejects before config read", async () => {
  const result = await request("session=alias&mcp=fixtureService", "personal");
  expect(result.response.status).toBe(400);
  expect(result.configReads).toBe(0);
});
test("tools=none narrows new draft and shared session without config reads", async () => {
  for (const query of [
    "tools=none",
    "session=alias&tools=none&mcp=fixtureService",
  ]) {
    const result = await request(query);
    expect(result.response.status).toBe(200);
    expect(result.configReads).toBe(0);
  }
});
test("missing or inaccessible supplied session never falls back to shared suggestions", async () => {
  for (const query of ["session=missing", "session="]) {
    const result = await request(query, "missing");
    expect(result.response.status).toBe(404);
    expect(result.configReads).toBe(0);
  }
});
test("shared default retains service suggestions", async () => {
  const result = await request("session=alias");
  expect(result.response.status).toBe(200);
  expect(result.configReads).toBe(1);
  expect(result.body.items.some((item: any) => item.kind === "tool")).toBe(
    true,
  );
});

test("inaccessible other-owner canonical session denies without config read", async () => {
  const result = await request("session=other", "other-owner");
  expect(result.response.status).toBe(404);
  expect(result.configReads).toBe(0);
});
