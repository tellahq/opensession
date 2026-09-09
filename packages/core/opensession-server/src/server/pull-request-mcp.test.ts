import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AUTO_CONTINUE_USER } from "./auto-continue";
import type { GithubCredential } from "./github-auth";
import type { MutationPrMeta } from "./pr-contract";
import {
  createPullRequestMcpServer,
  ownerGithubUser,
  type PullRequestToolContext,
} from "./pull-request-mcp";
import { GITHUB_ACTOR, workerActor } from "./session-actors";

describe("ownerGithubUser", () => {
  test("a person's own turn, or an auto-continue of it, is that person", () => {
    expect(ownerGithubUser("Alice", "Alice")).toBe("Alice");
    expect(ownerGithubUser(AUTO_CONTINUE_USER, "Alice")).toBe("Alice");
  });

  test("machine senders are nobody, whatever session they land in", () => {
    expect(ownerGithubUser(GITHUB_ACTOR, "Alice")).toBeUndefined();
    expect(
      ownerGithubUser(
        workerActor("os-01a00000-0000-7000-8000-000000000001"),
        "Alice",
      ),
    ).toBeUndefined();
    expect(ownerGithubUser("Automation", "Alice")).toBeUndefined();
    expect(ownerGithubUser(undefined, undefined)).toBeUndefined();
  });
});

const credential: GithubCredential = {
  kind: "user",
  principal: "user:alice",
  env: { GH_TOKEN: "gho_alice" },
};

function harness(
  overrides: Partial<PullRequestToolContext> & {
    meta?: MutationPrMeta | null;
  } = {},
) {
  const calls: Array<{ args: string[]; stdin?: string; token?: string }> = [];
  const notices: Array<{ text: string; id: string }> = [];
  const ctx: PullRequestToolContext = {
    sessionId: "os-test",
    login: "alice",
    credential: () => credential,
    workspace: () => ({
      ghRepo: "acme/app",
      branch: "feat/x",
      baseBranch: "main",
    }),
    prMeta: async () => overrides.meta ?? null,
    prDetails: async () => null,
    notice: async (text, id) => {
      notices.push({ text, id });
    },
    gh: async (args, cred, stdin) => {
      calls.push({ args, stdin, token: cred.env.GH_TOKEN });
      return "https://github.com/acme/app/pull/7\n";
    },
    ...overrides,
  };
  const server = createPullRequestMcpServer(ctx);
  return { server, calls, notices };
}

async function call(
  server: ReturnType<typeof createPullRequestMcpServer>,
  name: string,
  args: Record<string, unknown>,
) {
  const client = new Client({ name: "test", version: "0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.instance.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return (await client.callTool({ name, arguments: args })) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };
  } finally {
    await client.close();
    await server.instance.close();
  }
}

describe("opensession-pull-requests", () => {
  test("open_pull_request runs gh as the person, body over stdin", async () => {
    const { server, calls } = harness();
    const result = await call(server, "open_pull_request", {
      title: "Add thing",
      body: "Body\n\nStarted by Alice",
      draft: true,
    });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("as @alice");
    expect(calls).toHaveLength(1);
    expect(calls[0].token).toBe("gho_alice");
    expect(calls[0].args).toEqual([
      "pr",
      "create",
      "--repo",
      "acme/app",
      "--head",
      "feat/x",
      "--base",
      "main",
      "--title",
      "Add thing",
      "--body-file",
      "-",
      "--draft",
    ]);
    expect(calls[0].stdin).toContain("Started by Alice");
  });

  test("open_pull_request refuses to duplicate an open PR", async () => {
    const { server, calls } = harness({
      meta: {
        number: 7,
        headRefOid: "abc1234",
        state: "OPEN",
        isDraft: false,
        url: "https://github.com/acme/app/pull/7",
      },
    });
    const result = await call(server, "open_pull_request", {
      title: "t",
      body: "b",
    });
    expect(result.content[0].text).toContain("already open");
    expect(calls).toHaveLength(0);
  });

  test("a disconnected person fails closed", async () => {
    const { server, calls } = harness({ credential: () => null });
    const result = await call(server, "open_pull_request", {
      title: "t",
      body: "b",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("no longer connected");
    expect(calls).toHaveLength(0);
  });

  test("edit_pull_request patches through the REST API as the person", async () => {
    const { server, calls } = harness({
      meta: {
        number: 7,
        headRefOid: "abc1234",
        state: "OPEN",
        isDraft: true,
        url: "https://github.com/acme/app/pull/7",
      },
    });
    const result = await call(server, "edit_pull_request", {
      body: "new body",
      ready: true,
    });
    expect(result.isError).toBeFalsy();
    expect(calls.map((c) => c.args.slice(0, 2))).toEqual([
      ["api", "-X"],
      ["pr", "ready"],
    ]);
    expect(calls[0].args).toContain("repos/acme/app/pulls/7");
    expect(JSON.parse(calls[0].stdin!)).toEqual({ body: "new body" });
    expect(calls[1].args).toEqual(["pr", "ready", "7", "--repo", "acme/app"]);
  });

  test("propose_merge never calls gh to merge; it posts a notice", async () => {
    const { server, calls, notices } = harness({
      meta: {
        number: 7,
        headRefOid: "abc1234def",
        state: "OPEN",
        isDraft: false,
        url: "https://github.com/acme/app/pull/7",
      },
    });
    const result = await call(server, "propose_merge", { note: "Reviewed." });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("taps Merge");
    expect(calls).toHaveLength(0);
    expect(notices).toHaveLength(1);
    expect(notices[0].id).toBe("merge-proposal:acme/app#7@abc1234");
    expect(notices[0].text).toContain("PR #7");
    expect(notices[0].text).toContain("Reviewed.");
  });

  test("propose_merge refuses drafts and closed PRs", async () => {
    const draft = harness({
      meta: {
        number: 7,
        headRefOid: "abc1234",
        state: "OPEN",
        isDraft: true,
        url: "u",
      },
    });
    expect(
      (await call(draft.server, "propose_merge", {})).content[0].text,
    ).toContain("draft");
    const merged = harness({
      meta: {
        number: 7,
        headRefOid: "abc1234",
        state: "MERGED",
        isDraft: false,
        url: "u",
      },
    });
    expect(
      (await call(merged.server, "propose_merge", {})).content[0].text,
    ).toContain("merged");
    expect(draft.notices).toHaveLength(0);
    expect(merged.notices).toHaveLength(0);
  });
});
