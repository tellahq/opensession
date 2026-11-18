import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import * as accounts from "../claude-accounts";
import { __setIdentitiesForTest } from "../shared/user-mappings";
import * as webAuth from "../web-auth";
import { handleAccountsRoutes } from "./accounts";
import type { RouteContext } from "./context";

const dir = mkdtempSync(join(tmpdir(), "accounts-route-"));
const accountsFile = join(dir, "accounts.json");
const savedPath = process.env.OPENSESSION_CLAUDE_ACCOUNTS_PATH;

function apiAccount(id: string, owner?: string) {
  return {
    id,
    name: id,
    token: `sk-ant-api03-${id}`,
    authKind: "api-key",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...(owner ? { owner } : {}),
  };
}

function ctx(
  method: string,
  path: string,
  authUser: RouteContext["authUser"],
  body?: unknown,
): RouteContext {
  const url = new URL(`http://127.0.0.1${path}`);
  return {
    req: new Request(url, {
      method,
      ...(body === undefined
        ? {}
        : {
            body: JSON.stringify(body),
            headers: { "content-type": "application/json" },
          }),
    }),
    url,
    path,
    publicPrefix: "/backstage",
    authUser,
  };
}

const alice = { login: "alice", name: "Alice Example" };
const bob = { login: "bob", name: "Bob Example" };

beforeAll(() => {
  process.env.OPENSESSION_CLAUDE_ACCOUNTS_PATH = accountsFile;
});
afterAll(() => {
  if (savedPath === undefined)
    delete process.env.OPENSESSION_CLAUDE_ACCOUNTS_PATH;
  else process.env.OPENSESSION_CLAUDE_ACCOUNTS_PATH = savedPath;
  rmSync(dir, { recursive: true, force: true });
});

let authRequired: ReturnType<typeof spyOn> | undefined;
afterEach(() => authRequired?.mockRestore());

async function seed(): Promise<void> {
  writeFileSync(
    accountsFile,
    JSON.stringify({
      accounts: [apiAccount("alice-key", "Alice"), apiAccount("shared-key")],
    }),
  );
  await accounts.loadClaudeAccounts();
}

describe("Claude API account authorization with web sign-in on", () => {
  test("only the host operator can enroll a federation binding", async () => {
    authRequired = spyOn(webAuth, "webAuthRequired").mockReturnValue(true);
    const res = await handleAccountsRoutes(
      ctx("POST", "/api/claude-accounts/api", bob, {
        name: "borrowed",
        federation: {
          organizationId: "00000000-0000-0000-0000-000000000000",
          federationRuleId: "fdrl_example",
          serviceAccountId: "svac_example",
        },
      }),
    );
    expect(res?.status).toBe(403);
  });

  test("another member cannot reassign, rename, or remove a personal API account", async () => {
    authRequired = spyOn(webAuth, "webAuthRequired").mockReturnValue(true);
    await seed();
    const put = await handleAccountsRoutes(
      ctx("PUT", "/api/claude-accounts/alice-key", bob, { owner: "Bob" }),
    );
    expect(put?.status).toBe(403);
    const rename = await handleAccountsRoutes(
      ctx("PUT", "/api/claude-accounts/alice-key", bob, { label: "Mine" }),
    );
    expect(rename?.status).toBe(403);
    const del = await handleAccountsRoutes(
      ctx("DELETE", "/api/claude-accounts/alice-key", bob),
    );
    expect(del?.status).toBe(403);
    expect(accounts.getAccountById("alice-key")?.owner).toBe("Alice");
    // A shared API account is the operator's to change.
    const shared = await handleAccountsRoutes(
      ctx("PUT", "/api/claude-accounts/shared-key", bob, { owner: "Bob" }),
    );
    expect(shared?.status).toBe(403);
    // The owner still manages their own account.
    const own = await handleAccountsRoutes(
      ctx("PUT", "/api/claude-accounts/alice-key", alice, { label: "Mine" }),
    );
    expect(own?.status).toBe(200);
  });

  test("a shared first name authorizes neither person", async () => {
    authRequired = spyOn(webAuth, "webAuthRequired").mockReturnValue(true);
    const restore = __setIdentitiesForTest([
      { name: "Alex Rivera", github: "alex-rivera" },
      { name: "Alex Chen", github: "alex-chen" },
    ]);
    try {
      writeFileSync(
        accountsFile,
        JSON.stringify({
          accounts: [
            apiAccount("alex-key", "Alex"),
            apiAccount("rivera-key", "Alex Rivera"),
          ],
        }),
      );
      await accounts.loadClaudeAccounts();
      const chen = { login: "alex-chen", name: "Alex Chen" };
      const rivera = { login: "alex-rivera", name: "Alex Rivera" };
      for (const user of [chen, rivera]) {
        const res = await handleAccountsRoutes(
          ctx("PUT", "/api/claude-accounts/alex-key", user, { label: "Mine" }),
        );
        expect(res?.status).toBe(403);
      }
      const other = await handleAccountsRoutes(
        ctx("PUT", "/api/claude-accounts/rivera-key", chen, { label: "Mine" }),
      );
      expect(other?.status).toBe(403);
      const own = await handleAccountsRoutes(
        ctx("PUT", "/api/claude-accounts/rivera-key", rivera, {
          label: "Mine",
        }),
      );
      expect(own?.status).toBe(200);
    } finally {
      restore();
    }
  });

  test("an owner's pending change is refused once the account is transferred", async () => {
    authRequired = spyOn(webAuth, "webAuthRequired").mockReturnValue(true);
    await seed();
    // The operator's transfer is queued first; Alice's request passes the
    // route check against the cached owner, then reaches the writer after it.
    const transfer = accounts.setAccountOwner("alice-key", "Bob");
    const [rename, release, del] = await Promise.all([
      handleAccountsRoutes(
        ctx("PUT", "/api/claude-accounts/alice-key", alice, { label: "Mine" }),
      ),
      handleAccountsRoutes(
        ctx("PUT", "/api/claude-accounts/alice-key", alice, { owner: "" }),
      ),
      handleAccountsRoutes(
        ctx("DELETE", "/api/claude-accounts/alice-key", alice),
      ),
      transfer,
    ]);
    expect(rename?.status).toBe(403);
    expect(release?.status).toBe(403);
    expect(del?.status).toBe(403);
    const account = accounts.getAccountById("alice-key");
    expect(account?.owner).toBe("Bob");
    expect(account?.label).toBeUndefined();
  });

  test("the host operator can change any API account", async () => {
    authRequired = spyOn(webAuth, "webAuthRequired").mockReturnValue(true);
    await seed();
    const res = await handleAccountsRoutes(
      ctx(
        "PUT",
        "/api/claude-accounts/shared-key",
        {
          login: "opensession-automation",
          name: "Automation",
          automation: true,
        },
        { label: "Team" },
      ),
    );
    expect(res?.status).toBe(200);
  });
});
