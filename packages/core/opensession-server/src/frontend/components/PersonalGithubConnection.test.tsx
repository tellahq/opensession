import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { PersonalGithubStatus } from "../lib/personal-github";
import {
  INITIAL_PERSONAL_GITHUB_STATE,
  type PersonalGithubState,
} from "../lib/personal-github-state";
import { PersonalGithubCard } from "./PersonalGithubConnection";

const DISCLOSURE_TEXT =
  "Your connection is personal, but the server is shared. Other Open Session users can use agents on this server to read your repository files, GitHub credentials, and session data. Server operators and anyone with administrator (root) access can also read them. Only connect repositories you trust these people and this server with.";

const app = {
  recordId: "rec_1",
  githubAppId: 1234,
  slug: "open-session-alice",
  clientId: "Iv1.abc",
  ownerLoginAtCreation: "alice",
  createdAt: 1_700_000_000_000,
  installUrl: "https://github.com/apps/open-session-alice/installations/new",
};

function status(
  connection: PersonalGithubStatus["status"],
  repositoryAdmission = false,
): PersonalGithubStatus {
  return {
    ok: true,
    ownerGithubAccountId: 11,
    disclosure: { version: "shared-host-v2", text: DISCLOSURE_TEXT },
    repositoryAdmission,
    status: connection,
  };
}

function ready(
  connection: PersonalGithubStatus["status"],
  overrides: Partial<PersonalGithubState> = {},
): PersonalGithubState {
  return {
    ...INITIAL_PERSONAL_GITHUB_STATE,
    scope: "github:11",
    generation: 1,
    owner: 11,
    status: { kind: "ready", data: status(connection) },
    ...overrides,
  };
}

function render(
  state: PersonalGithubState,
  notice: string | null = null,
): string {
  return renderToStaticMarkup(
    <PersonalGithubCard
      state={state}
      notice={notice}
      onConsentChange={() => {}}
      onConnect={() => {}}
      onAuthorize={() => {}}
      onCancelGrant={() => {}}
      onRefresh={() => {}}
      onDisconnect={() => {}}
      onReload={() => {}}
      onDismissError={() => {}}
      onDismissNotice={() => {}}
      onShowDisclosure={() => {}}
    />,
  );
}

const none = { app: null, installation: null, userGrant: null };

describe("personal GitHub card", () => {
  test("shows the server's disclosure in full and keeps connect off until it is accepted", () => {
    const html = render(ready(none));
    expect(html).toContain("Before you connect");
    expect(html).toContain(DISCLOSURE_TEXT);
    expect(html).toContain("Disclosure version shared-host-v2");
    expect(html).toContain("I understand and trust this server.");
    expect(html).toContain('aria-checked="false"');
    expect(html).toMatch(
      /<button[^>]*disabled=""[^>]*>[^<]*<span[^>]*>Create GitHub App/,
    );
    expect(html).toContain("Repository sessions are not available yet.");
    expect(html).toContain("Read the server disclosure");
    expect(html).toContain(
      "Other users’ agents can access your repository files, GitHub credentials, and session data.",
    );
  });

  test("accepting the disclosure makes the connect button live", () => {
    const html = render(ready(none, { consent: true }));
    expect(html).toContain('aria-checked="true"');
    expect(html).not.toMatch(
      /<button[^>]*disabled=""[^>]*>[^<]*<span[^>]*>Create GitHub App/,
    );
    expect(html).toContain("Create GitHub App");
  });

  test("reports each step of the manifest hand-off while it is in flight", () => {
    expect(
      render(
        ready(none, { consent: true, operation: { kind: "acknowledging" } }),
      ),
    ).toContain("Recording…");
    expect(
      render(ready(none, { consent: true, operation: { kind: "preparing" } })),
    ).toContain("Preparing…");
    expect(
      render(
        ready(none, { consent: true, operation: { kind: "redirecting" } }),
      ),
    ).toContain("Opening GitHub…");
  });

  test("an unverified sign-in asks for a fresh sign-in instead of offering to connect", () => {
    const html = render({
      ...INITIAL_PERSONAL_GITHUB_STATE,
      scope: "github:11",
      status: {
        kind: "signin_required",
        message: "Sign in again with GitHub to establish a verified identity.",
      },
    });
    expect(html).toContain("Sign in again");
    expect(html).toContain("verified account id");
    expect(html).not.toContain("Create GitHub App");
    expect(html).not.toContain("I understand and trust this server.");
  });

  test("a failed load offers a retry and nothing else", () => {
    const html = render({
      ...INITIAL_PERSONAL_GITHUB_STATE,
      scope: "github:11",
      status: { kind: "error", message: "Could not load", previous: null },
    });
    expect(html).toContain("Could not load");
    expect(html).toContain("Try again");
    expect(html).not.toContain("Create GitHub App");
  });

  test("a created App asks for authorization and links the install picker", () => {
    const html = render(ready({ ...none, app }));
    expect(html).toContain("open-session-alice");
    expect(html).toContain("Authorize needed");
    expect(html).toContain("Authorize");
    expect(html).toContain(`href="${app.installUrl}"`);
    expect(html).toContain('aria-label="Manage open-session-alice"');
    expect(html).not.toContain("I understand and trust this server.");
  });

  test("a device flow shows the code, the link and a way out", () => {
    const html = render(
      ready(
        { ...none, app },
        {
          operation: {
            kind: "grant",
            flow: {
              ok: true,
              ownerGithubAccountId: 11,
              flowId: "flow-1",
              userCode: "ABCD-1234",
              verificationUri: "https://github.com/login/device",
              interval: 5,
              expiresIn: 900,
            },
          },
        },
      ),
    );
    expect(html).toContain("ABCD-1234");
    expect(html).toContain("github.com/login/device");
    expect(html).toContain("Waiting for GitHub");
    expect(html).toContain("Cancel");
    expect(html).not.toContain("flow-1");
  });

  test("connected stays honest about admission and keeps the disclosure reachable", () => {
    const connected = {
      app,
      installation: {
        installationId: 7,
        accountLogin: "alice",
        repositorySelection: "selected" as const,
        suspended: false,
      },
      userGrant: {
        grantedLogin: "alice",
        connectedAt: 1_700_000_000_000,
        expiresAt: null,
        needsReconnect: false,
      },
    };
    const html = render(ready(connected), "3 repositories are reachable.");
    expect(html).toContain("Connected");
    expect(html).toContain("@alice");
    expect(html).toContain("Repository sessions are not available yet.");
    expect(html).toContain("Manage which repositories the App can access");
    expect(html).toContain("selected repositories");
    expect(html).toContain("3 repositories are reachable.");
    expect(html).toContain("Read the server disclosure");
    expect(html).not.toContain("Create GitHub App");
  });

  test("a lost authorization and a suspended installation are named, not hidden", () => {
    const grant = {
      grantedLogin: "alice",
      connectedAt: 1,
      expiresAt: null,
      needsReconnect: true,
    };
    expect(render(ready({ ...none, app, userGrant: grant }))).toContain(
      "Authorize again",
    );
    expect(
      render(
        ready({
          app,
          userGrant: { ...grant, needsReconnect: false },
          installation: {
            installationId: 7,
            accountLogin: "alice",
            repositorySelection: "selected",
            suspended: true,
          },
        }),
      ),
    ).toContain("Suspended on GitHub");
  });
});

test("revoking connection keeps the App manageable without offering grant or refresh", () => {
  const html = render(ready({ ...none, app, needsDisconnect: true }));
  expect(html).toContain("Disconnect this connection and set it up again.");
  expect(html).toContain("Disconnect needed");
  expect(html).toContain('aria-label="Manage open-session-alice"');
  expect(html).not.toContain(">Authorize<");
  expect(html).not.toContain("Refresh repositories");
  expect(html).not.toContain("Create GitHub App");
});

test("Device Flow setup stays available after authorization failure without replacing installation choice", () => {
  const html = render(
    ready({ ...none, app }, { error: "Device Flow is disabled" }),
  );
  expect(html).toContain("Enable Device Flow");
  expect(html).toContain(
    'href="https://github.com/settings/apps/open-session-alice"',
  );
  expect(html).toContain("Open App settings");
  expect(html).toContain("Device Flow is disabled");
  expect(html).toContain("Install on repositories");
  expect(html).toContain(`href="${app.installUrl}"`);
  expect(render(ready(none))).not.toContain("Open App settings");
  expect(render(ready({ ...none, app, needsDisconnect: true }))).not.toContain(
    "Open App settings",
  );
  expect(
    render(ready({ ...none, app: { ...app, slug: "../evil" } })),
  ).not.toContain("Open App settings");
});

test("repository selection requires coordinator admission and usable connection, never consent alone", () => {
  const connection = {
    app,
    installation: {
      installationId: 7,
      accountLogin: "alice",
      repositorySelection: "selected" as const,
      suspended: false,
    },
    userGrant: {
      grantedLogin: "alice",
      connectedAt: 1,
      expiresAt: null,
      needsReconnect: false,
    },
  };
  const admitted = status(connection, true);
  const state = ready(connection, {
    status: { kind: "ready", data: admitted },
  });
  expect(render(state)).toContain("Check repositories");
  expect(render(state)).not.toContain("Repository ID:");
  expect(render(ready(connection, { consent: true }))).not.toContain(
    "Check repositories",
  );
  expect(
    render({ ...state, status: { kind: "loading", previous: admitted } }),
  ).toContain("Check repositories");
  expect(
    render({ ...state, operation: { kind: "disconnecting" } }),
  ).not.toContain("Check repositories");
  expect(
    render({
      ...state,
      status: {
        kind: "ready",
        data: { ...admitted, status: { ...connection, needsDisconnect: true } },
      },
    }),
  ).not.toContain("Check repositories");
});
