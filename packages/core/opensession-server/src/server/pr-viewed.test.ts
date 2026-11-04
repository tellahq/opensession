import { getConfigAsync } from "./config";
import { loadGithubAuthStore } from "./github-auth";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { getPrViewedFiles, viewedMutation } from "./pr-viewed";
import { __setGhBackoffForTest } from "./github-limit";
import type { RouteContext } from "./routes/context";

const savedConfig = process.env.OPENSESSION_CONFIG;
const savedStore = process.env.OPENSESSION_GITHUB_AUTH_STORE;
const realFetch = globalThis.fetch;
let dir = "";
let savedGraphqlBackoff = 0;

beforeEach(async () => {
  savedGraphqlBackoff = __setGhBackoffForTest(0, "graphql");
  dir = mkdtempSync(join(tmpdir(), "os-pr-viewed-test-"));
  process.env.OPENSESSION_CONFIG = join(dir, "config.json");
  await getConfigAsync();
  process.env.OPENSESSION_GITHUB_AUTH_STORE = join(dir, "github-auth.json");
  writeFileSync(
    process.env.OPENSESSION_CONFIG,
    JSON.stringify({ integrations: { github: { userPrAuth: false } } }),
  );
  writeFileSync(
    process.env.OPENSESSION_GITHUB_AUTH_STORE,
    JSON.stringify({
      users: {
        alice: {
          login: "alice",
          token: "ghu_simple_alice",
          source: "device",
          connectedAt: "2026-08-20T00:00:00.000Z",
        },
      },
    }),
  );
  await loadGithubAuthStore();
});

afterEach(async () => {
  __setGhBackoffForTest(savedGraphqlBackoff, "graphql");
  globalThis.fetch = realFetch;
  rmSync(dir, { recursive: true, force: true });
  if (savedConfig === undefined) delete process.env.OPENSESSION_CONFIG;
  else {
    process.env.OPENSESSION_CONFIG = savedConfig;
    await getConfigAsync();
  }
  if (savedStore === undefined)
    delete process.env.OPENSESSION_GITHUB_AUTH_STORE;
  else process.env.OPENSESSION_GITHUB_AUTH_STORE = savedStore;
});

describe("PR viewed state credential", () => {
  test("uses the sole connected account in simple mode", async () => {
    let authorization = "";
    globalThis.fetch = (async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      authorization = String(
        (init?.headers as Record<string, string>)?.Authorization || "",
      );
      return Response.json({
        data: {
          repository: {
            pullRequest: {
              id: "PR_node",
              files: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  { path: "README.md", viewerViewedState: "VIEWED" },
                  { path: "src/app.ts", viewerViewedState: "DIRTY" },
                  { path: "src/new.ts", viewerViewedState: "UNVIEWED" },
                ],
              },
            },
          },
        },
      });
    }) as typeof fetch;

    const req = new Request("http://localhost/api/pr-viewed-files");
    const ctx: RouteContext = {
      req,
      url: new URL(req.url),
      path: "/api/pr-viewed-files",
      publicPrefix: "",
      authUser: null,
    };
    const result = await getPrViewedFiles(ctx, "", "tellahq/opensession", 112);

    expect(authorization).toBe("Bearer ghu_simple_alice");
    expect(result).toEqual({
      prId: "PR_node",
      viewed: ["README.md"],
      changed: ["src/app.ts"],
    });
  });
});

describe("viewedMutation", () => {
  test("aliases one mutation per path in a single request", () => {
    expect(viewedMutation(2, true)).toBe(
      "mutation($id: ID!, $p0: String!, $p1: String!) { f0: markFileAsViewed(input: { pullRequestId: $id, path: $p0 }) { clientMutationId } f1: markFileAsViewed(input: { pullRequestId: $id, path: $p1 }) { clientMutationId } }",
    );
    expect(viewedMutation(1, false)).toContain("f0: unmarkFileAsViewed");
  });
});
