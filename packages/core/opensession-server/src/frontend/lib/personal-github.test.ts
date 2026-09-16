import { afterEach, describe, expect, test } from "bun:test";
import {
  PersonalGithubApiError,
  acceptPersonalGithubDisclosure,
  fetchPersonalGithubStatus,
  isVerifiedSignInRequired,
  manifestSubmission,
  personalGithubAppSettingsUrl,
  personalGithubDescription,
  personalGithubPhase,
  registerPersonalRepository,
  personalRepositoryIsListed,
  pollPersonalGithubGrant,
  type PersonalGithubConnection,
} from "./personal-github";

const originalFetch = globalThis.fetch;

interface RecordedRequest {
  url: string;
  method: string;
  body: string | null;
}

/** `body` is the JSON text the fake server answers with. */
function fakeFetch(status: number, body: string) {
  const calls: RecordedRequest[] = [];
  const fake = async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      body: init?.body === undefined ? null : String(init.body),
    });
    return new Response(body, {
      status,
      headers: { "Content-Type": "application/json" },
    });
  };
  // SAFETY: the module under test only calls fetch(url, init) and reads the
  // Response; Bun's extra static members on `fetch` are never touched.
  globalThis.fetch = fake as typeof fetch;
  return { calls };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const app = {
  recordId: "rec_1",
  githubAppId: 1234,
  slug: "open-session-alice",
  clientId: "Iv1.abc",
  ownerLoginAtCreation: "alice",
  createdAt: 1_700_000_000_000,
  installUrl: "https://github.com/apps/open-session-alice/installations/new",
};

const grant = {
  grantedLogin: "alice",
  connectedAt: 1_700_000_000_000,
  expiresAt: null,
  needsReconnect: false,
};

describe("personal GitHub status boundary", () => {
  test("parses the secret-free status and sends credentials only to the personal API", async () => {
    const { calls } = fakeFetch(
      200,
      JSON.stringify({
        ok: true,
        ownerGithubAccountId: 11,
        disclosure: { version: "shared-host-v1", text: "Shared server." },
        repositoryAdmission: false,
        status: { app, installation: null, userGrant: null },
      }),
    );
    const status = await fetchPersonalGithubStatus();
    expect(status.ownerGithubAccountId).toBe(11);
    expect(status.status.app?.slug).toBe("open-session-alice");
    expect(calls).toEqual([
      { url: "/api/personal/github/status", method: "GET", body: null },
    ]);
  });

  test("keeps the server's error code so an unverified sign-in is its own state", async () => {
    fakeFetch(
      401,
      JSON.stringify({
        code: "verified_signin_required",
        error: "Sign in again with GitHub.",
      }),
    );
    const failure = await fetchPersonalGithubStatus().catch(
      (error: Error) => error,
    );
    expect(failure).toBeInstanceOf(PersonalGithubApiError);
    expect(isVerifiedSignInRequired(failure)).toBe(true);
    expect(failure).toMatchObject({ message: "Sign in again with GitHub." });
  });

  test("rejects a response that is not the documented shape", async () => {
    fakeFetch(200, JSON.stringify({ ok: true, ownerGithubAccountId: "11" }));
    await expect(fetchPersonalGithubStatus()).rejects.toThrow(
      "unexpected response",
    );
  });

  test("acknowledges exactly the disclosure version shown", async () => {
    const { calls } = fakeFetch(
      200,
      JSON.stringify({
        ok: true,
        ownerGithubAccountId: 11,
        disclosureReceipt: "r-1",
        expiresAt: 5,
      }),
    );
    const receipt = await acceptPersonalGithubDisclosure("shared-host-v1");
    expect(receipt.disclosureReceipt).toBe("r-1");
    expect(calls[0]).toEqual({
      url: "/api/personal/github/disclosure",
      method: "POST",
      body: JSON.stringify({ version: "shared-host-v1", accepted: true }),
    });
  });

  test("poll carries only the opaque flow id", async () => {
    const { calls } = fakeFetch(
      200,
      JSON.stringify({ ok: true, ownerGithubAccountId: 11, status: "pending" }),
    );
    await pollPersonalGithubGrant("flow-1");
    expect(calls[0]?.body).toBe(JSON.stringify({ flowId: "flow-1" }));
  });
});

describe("manifest submission", () => {
  const response = {
    ok: true as const,
    ownerGithubAccountId: 11,
    action: "https://github.com/settings/apps/new?state=abc",
    manifest: '{"name":"Open Session (alice)"}',
    state: "abc",
  };

  test("only posts to GitHub with the state the server bound", () => {
    expect(manifestSubmission(response)).toEqual({
      action: "https://github.com/settings/apps/new?state=abc",
      manifest: '{"name":"Open Session (alice)"}',
    });
    expect(
      manifestSubmission({
        ...response,
        action: "https://evil.example/settings/apps/new?state=abc",
      }),
    ).toBeNull();
    expect(
      manifestSubmission({
        ...response,
        action: "https://github.com/settings/apps/new?state=other",
      }),
    ).toBeNull();
    expect(
      manifestSubmission({
        ...response,
        action: "https://github.com/settings/apps/new",
      }),
    ).toBeNull();
  });
});

describe("connection phase", () => {
  const none: PersonalGithubConnection = {
    app: null,
    installation: null,
    userGrant: null,
  };

  test("reads the phase from the App, grant and installation", () => {
    expect(personalGithubPhase(none)).toBe("none");
    expect(personalGithubPhase({ ...none, app })).toBe("app_created");
    expect(personalGithubPhase({ ...none, app, userGrant: grant })).toBe(
      "connected",
    );
    expect(
      personalGithubPhase({
        ...none,
        app,
        userGrant: { ...grant, needsReconnect: true },
      }),
    ).toBe("reconnect");
    expect(
      personalGithubPhase({
        app,
        userGrant: grant,
        installation: {
          installationId: 1,
          accountLogin: "alice",
          repositorySelection: "selected",
          suspended: true,
        },
      }),
    ).toBe("suspended");
  });

  test("never claims sessions are ready while admission is off", () => {
    const connected = { ...none, app, userGrant: grant };
    expect(personalGithubDescription(connected, false)).toBe(
      "Authorized as @alice. Repository sessions are not available yet.",
    );
    expect(personalGithubDescription(connected, true)).toBe(
      "Authorized as @alice.",
    );
  });
});

test("personal App settings links accept only a GitHub slug", () => {
  expect(personalGithubAppSettingsUrl("open-session-alice")).toBe(
    "https://github.com/settings/apps/open-session-alice",
  );
  for (const slug of [
    "",
    "..",
    "../evil",
    "a/b",
    "a?x=y",
    "a#x",
    "https://evil.example",
    "a%2fb",
    "a\\b",
    "a\n",
  ]) {
    expect(personalGithubAppSettingsUrl(slug)).toBeNull();
  }
});

const selection = {
  appRecordId: "rec_1",
  githubAppId: 1234,
  installationId: 7,
  repositoryId: 8,
};
const registration = {
  ok: true as const,
  ownerGithubAccountId: 11,
  registryId: "opaque-catalog-id",
  descriptor: {
    kind: "personal" as const,
    ...selection,
    ownerGithubAccountId: 11,
    repositoryOwnerGithubAccountId: 11,
    accessRevision: 1,
    fullName: "alice/private",
  },
};

test("registration sends only the selection and returns the server's opaque registry id", async () => {
  const { calls } = fakeFetch(200, JSON.stringify(registration));
  expect(await registerPersonalRepository(selection, 11)).toEqual(registration);
  expect(calls).toEqual([
    {
      url: "/api/personal/repos",
      method: "POST",
      body: JSON.stringify(selection),
    },
  ]);
});

test("registration rejects mismatched owners, tuples, malformed success and empty ids", async () => {
  for (const response of [
    { ...registration, ownerGithubAccountId: 22 },
    { ...registration, registryId: "" },
    { ok: true, ownerGithubAccountId: 11, repositories: [] },
    ...Object.entries({
      ownerGithubAccountId: 22,
      repositoryOwnerGithubAccountId: 22,
      appRecordId: "other",
      githubAppId: 9,
      installationId: 9,
      repositoryId: 9,
    }).map(([field, value]) => ({
      ...registration,
      descriptor: { ...registration.descriptor, [field]: value },
    })),
  ]) {
    fakeFetch(200, JSON.stringify(response));
    await expect(registerPersonalRepository(selection, 11)).rejects.toThrow();
  }
});

test("registration retains revocation errors and catalog listing is distinct from discovery", async () => {
  fakeFetch(
    403,
    JSON.stringify({
      ok: false,
      code: "access_revoked",
      error: "Repository access was revoked",
    }),
  );
  await expect(registerPersonalRepository(selection, 11)).rejects.toThrow(
    "Repository access was revoked",
  );
  const { calls } = fakeFetch(
    200,
    JSON.stringify({ repos: [{ id: "opaque-catalog-id" }] }),
  );
  expect(await personalRepositoryIsListed("opaque-catalog-id")).toBe(true);
  expect(await personalRepositoryIsListed("8")).toBe(false);
  expect(calls[0]?.url).toBe("/api/repos");
});
