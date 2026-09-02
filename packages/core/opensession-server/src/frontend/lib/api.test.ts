import { afterEach, expect, test } from "bun:test";
import {
  fetchProviderAccounts,
  fetchRepos,
  fetchWorkspaces,
  fetchReads,
  fetchSessionsSnapshot,
  fetchWorkspaceArchivedSessions,
  newSessionApi,
} from "./api";

const originalFetch = globalThis.fetch;
type FetchImplementation = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => Promise<Response>;

function stubFetch(implementation: FetchImplementation): typeof fetch {
  return Object.assign(implementation, {
    preconnect: originalFetch.preconnect,
  });
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("read marks load from the current user's API namespace", async () => {
  let url = "";
  globalThis.fetch = stubFetch(async (input) => {
    url = String(input);
    return Response.json({ reads: { "bks-1": "2026-08-11T10:00:00.000Z" } });
  });

  await expect(fetchReads("Ada Lovelace")).resolves.toEqual({
    "bks-1": "2026-08-11T10:00:00.000Z",
  });
  expect(url).toBe("/api/reads?user=Ada%20Lovelace");
});

test("provider account loading reports a failed pool and keeps the other pool", async () => {
  const failures: unknown[] = [];
  globalThis.fetch = stubFetch(async (input) => {
    if (String(input).endsWith("/claude-accounts")) {
      return Response.json(
        { error: "Claude accounts unavailable" },
        { status: 502 },
      );
    }
    return Response.json({
      accounts: [
        {
          id: "codex-1",
          name: "Codex account",
          owner: "Ada",
          usable: true,
        },
      ],
    });
  });

  await expect(
    fetchProviderAccounts({
      onPoolError: (cause) => failures.push(cause),
    }),
  ).resolves.toEqual([
    {
      id: "codex-1",
      name: "Codex account",
      provider: "codex",
      owner: "Ada",
      usable: true,
    },
  ]);
  expect(failures).toHaveLength(1);
  expect(failures[0]).toBeInstanceOf(Error);
});

test("workspace loading reports a failure while preserving its empty fallback", async () => {
  const failures: unknown[] = [];
  globalThis.fetch = stubFetch(async () =>
    Response.json({ error: "Workspaces unavailable" }, { status: 502 }),
  );

  await expect(
    fetchWorkspaces({ onError: (cause) => failures.push(cause) }),
  ).resolves.toEqual([]);
  expect(failures).toHaveLength(1);
  expect(failures[0]).toBeInstanceOf(Error);
});

test("repository loading rejects after transient retries are exhausted", async () => {
  let calls = 0;
  globalThis.fetch = stubFetch(async () => {
    calls++;
    return Response.json(
      { error: "Repositories unavailable" },
      { status: 502 },
    );
  });

  await expect(fetchRepos()).rejects.toThrow("Repositories unavailable");
  expect(calls).toBe(4);
});

test("repository loading recovers from transient server failures", async () => {
  let calls = 0;
  globalThis.fetch = stubFetch(async () => {
    calls++;
    if (calls < 3) {
      return Response.json(
        { error: "temporarily unavailable" },
        { status: 502 },
      );
    }
    return Response.json({
      repos: [
        {
          id: "tella-fusion",
          label: "tella-fusion",
          defaultBranch: "main",
          sharedCheckout: false,
        },
      ],
    });
  });

  await expect(fetchRepos()).resolves.toEqual([
    {
      id: "tella-fusion",
      label: "tella-fusion",
      defaultBranch: "main",
      sharedCheckout: false,
    },
  ]);
  expect(calls).toBe(3);
});

test("session snapshots send validators and accept bodyless 304 responses", async () => {
  let requestHeaders: Headers | undefined;
  globalThis.fetch = stubFetch(async (_input, init) => {
    requestHeaders = new Headers(init?.headers);
    return new Response(null, {
      status: 304,
      headers: {
        ETag: '"sessions-v1"',
      },
    });
  });

  await expect(
    fetchSessionsSnapshot({ etag: '"sessions-v1"' }),
  ).resolves.toEqual({
    text: null,
    etag: '"sessions-v1"',
    notModified: true,
  });
  expect(requestHeaders?.get("If-None-Match")).toBe('"sessions-v1"');
});

test("session snapshots retain response validators on changed data", async () => {
  globalThis.fetch = stubFetch(
    async () =>
      new Response('[{"id":"session-1"}]', {
        headers: { ETag: '"sessions-v2"' },
      }),
  );

  await expect(fetchSessionsSnapshot()).resolves.toEqual({
    text: '[{"id":"session-1"}]',
    etag: '"sessions-v2"',
    notModified: false,
  });
});

test("workspace archive fetches stay scoped and slim", async () => {
  let url = "";
  const archived = {
    id: "archived-1",
    source: "opensession" as const,
    branch: "main",
    worktreeDir: "/tmp/worktree",
    startedBy: "Kent",
    title: "Archived session",
    lastActivity: "2026-08-22T10:00:00.000Z",
    createdAt: "2026-08-22T09:00:00.000Z",
    isRunning: false,
    archived: true,
  };
  globalThis.fetch = stubFetch(async (input) => {
    url = String(input);
    return Response.json([archived]);
  });

  await expect(fetchWorkspaceArchivedSessions("ws / one")).resolves.toEqual([
    archived,
  ]);
  expect(url).toBe(
    "/api/sessions?archived=only&slim=1&workspace=ws%20%2F%20one",
  );
});

test("new workspace tabs create an idle sibling session", async () => {
  let url = "";
  let init: RequestInit | undefined;
  globalThis.fetch = stubFetch(async (input, requestInit) => {
    url = String(input);
    init = requestInit;
    return Response.json({ id: "bks-new", session: { id: "bks-new" } });
  });

  const clientSessionId = "os-019f0000-0000-7000-8000-000000000001";
  const created = await newSessionApi(
    "bks-source",
    "Kent",
    "share",
    clientSessionId,
  );
  expect(created.id).toBe("bks-new");
  expect(created.session?.id).toBe("bks-new");
  expect(url).toBe("/api/sessions/bks-source/new-session");
  expect(init?.method).toBe("POST");
  expect(JSON.parse(String(init?.body))).toEqual({
    user: "Kent",
    mode: "share",
    clientSessionId,
  });

  await newSessionApi("bks-source", "Kent", "share", clientSessionId, true);
  expect(JSON.parse(String(init?.body))).toEqual({
    user: "Kent",
    mode: "share",
    clientSessionId,
    duplicate: true,
  });
});
