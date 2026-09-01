import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";

// Point BOTH the roster (config.json) and the per-user state root at scratch
// dirs before importing anything that reads them: these tests write the
// identity table, which on a real instance is the live team.
const root = mkdtempSync(`${tmpdir()}/profile-route-test-`);
const configFile = `${root}/config.json`;
const previous = {
  config: process.env.OPENSESSION_CONFIG,
  state: process.env.OPENSESSION_STATE_DIR,
  auth: process.env.OPENSESSION_GITHUB_WEB_AUTH,
};
process.env.OPENSESSION_CONFIG = configFile;
process.env.OPENSESSION_STATE_DIR = root;

afterAll(() => {
  for (const [key, value] of [
    ["OPENSESSION_CONFIG", previous.config],
    ["OPENSESSION_STATE_DIR", previous.state],
    ["OPENSESSION_GITHUB_WEB_AUTH", previous.auth],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

const { handleProfileRoutes } = await import("./profile");
const { getPins, setPins } = await import("../pins");
import type { RouteContext } from "./context";

function seedRoster(): void {
  writeFileSync(
    configFile,
    JSON.stringify({
      // Sign-in mode: the route trusts the VERIFIED identity only when
      // per-user GitHub auth is on, which is a config flag plus a client id
      // (github-auth.ts githubUserAuthSettings), not an env switch.
      integrations: {
        github: { userPrAuth: true, oauthClientId: "test-client" },
      },
      identity: {
        team: [
          {
            name: "Ada Lovelace",
            email: "ada@example.com",
            github: "adalovelace",
            timezone: "Europe/London",
          },
          { name: "Grace Hopper", github: "gracehopper" },
        ],
      },
    }),
  );
}

function context(
  path: string,
  method: string,
  opts: { authUser?: RouteContext["authUser"]; body?: unknown } = {},
): RouteContext {
  const url = new URL(`http://localhost${path}`);
  return {
    req: new Request(url, {
      method,
      ...(opts.body !== undefined
        ? {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(opts.body),
          }
        : {}),
    }),
    url,
    path,
    publicPrefix: "",
    authUser: opts.authUser,
  };
}

/** The config cache keys on path + mtime + size, so rewriting the file is
 *  enough to make the loader re-read it. */
function reload(): void {
  seedRoster();
}

const ADA = { login: "adalovelace", name: "Ada Lovelace" };

describe("your own profile", () => {
  beforeEach(() => {
    reload();
  });

  test("reads the signed-in person's own row", async () => {
    const res = await handleProfileRoutes(
      context("/api/profile", "GET", { authUser: ADA }),
    );
    const body = await res?.json();
    expect(body.user).toBe("Ada Lovelace");
    expect(body.name).toBe("Ada Lovelace");
    expect(body.shortName).toBe("Ada");
    expect(body.github).toBe("adalovelace");
    expect(body.editable).toBe(true);
  });

  test("uses the verified login when the session display name is stale", async () => {
    const res = await handleProfileRoutes(
      context("/api/profile", "GET", {
        authUser: { login: "adalovelace", name: "Ada Oldname" },
      }),
    );
    const body = await res?.json();
    expect(body.user).toBe("Ada Lovelace");
    expect(body.name).toBe("Ada Lovelace");
    expect(body.github).toBe("adalovelace");
    expect(body.editable).toBe(true);
  });

  // The whole authz design: there is no member id to pass, so a body naming
  // someone else cannot reach them.
  test("a body cannot address another person's row", async () => {
    const res = await handleProfileRoutes(
      context("/api/profile", "PUT", {
        authUser: ADA,
        body: { name: "Grace Hopper" },
      }),
    );
    // Renaming yourself ONTO an existing member is a conflict, not a takeover.
    expect(res?.status).toBe(409);
    const after = await handleProfileRoutes(
      context("/api/profile", "GET", { authUser: ADA }),
    );
    expect((await after?.json()).name).toBe("Ada Lovelace");
  });

  test("saves the fields you own", async () => {
    const res = await handleProfileRoutes(
      context("/api/profile", "PUT", {
        authUser: ADA,
        body: {
          name: "Ada King",
          email: "ada@lovelace.dev",
          timezone: "Europe/Amsterdam",
          aliases: ["countess"],
        },
      }),
    );
    expect(res?.status).toBe(200);
    const body = await res?.json();
    expect(body.name).toBe("Ada King");
    expect(body.email).toBe("ada@lovelace.dev");
    expect(body.timezone).toBe("Europe/Amsterdam");
    expect(body.aliases).toContain("countess");
    // The short name did not move, so nothing was re-keyed.
    expect(body.shortName).toBe("Ada");
    expect(body.renamedFrom).toBeUndefined();
  });

  test("refuses fields that are not yours to change here", async () => {
    for (const patch of [
      { github: "someoneelse" },
      { slackId: "U0DEADBEEF" },
      { admin: true },
    ]) {
      const res = await handleProfileRoutes(
        context("/api/profile", "PUT", { authUser: ADA, body: patch }),
      );
      expect(res?.status).toBe(400);
    }
    const after = await handleProfileRoutes(
      context("/api/profile", "GET", { authUser: ADA }),
    );
    expect((await after?.json()).github).toBe("adalovelace");
  });

  test("a name is required", async () => {
    const res = await handleProfileRoutes(
      context("/api/profile", "PUT", { authUser: ADA, body: { name: "" } }),
    );
    expect(res?.status).toBe(400);
  });

  // Changing the first word re-keys the identity everything matches on, so
  // the old spelling has to survive as an alias and the per-user state has to
  // travel. Without both, mentions stop resolving and the sidebar resets.
  test("a short-name change keeps the old name and carries state", async () => {
    setPins("Ada", ["os-1"]);
    const res = await handleProfileRoutes(
      context("/api/profile", "PUT", {
        authUser: ADA,
        body: { name: "Augusta Lovelace" },
      }),
    );
    const body = await res?.json();
    expect(body.shortName).toBe("Augusta");
    expect(body.renamedFrom).toBe("Ada");
    expect(body.aliases).toContain("Ada");
    expect(body.carriedState).toContain("pins");
    expect(getPins("Augusta")).toEqual(["os-1"]);
  });

  test("a signed-in person who is not on the roster cannot edit one", async () => {
    const res = await handleProfileRoutes(
      context("/api/profile", "GET", {
        authUser: { login: "stranger", name: "Stranger" },
      }),
    );
    const body = await res?.json();
    expect(body.editable).toBe(false);

    const write = await handleProfileRoutes(
      context("/api/profile", "PUT", {
        authUser: { login: "stranger", name: "Stranger" },
        body: { name: "Stranger Danger" },
      }),
    );
    expect(write?.status).toBe(404);
  });

  test("rejects a picture that is not an image", async () => {
    const url = new URL("http://localhost/api/profile/image");
    const res = await handleProfileRoutes({
      req: new Request(url, {
        method: "POST",
        headers: { "Content-Type": "application/pdf" },
        body: new Uint8Array([1, 2, 3]),
      }),
      url,
      path: "/api/profile/image",
      publicPrefix: "",
      authUser: ADA,
    });
    expect(res?.status).toBe(415);
  });

  test("stores and clears a picture", async () => {
    const url = new URL("http://localhost/api/profile/image");
    // A 1x1 GIF: real bytes, so the stored file is a real image.
    const gif = Buffer.from(
      "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
      "base64",
    );
    const stored = await handleProfileRoutes({
      req: new Request(url, {
        method: "POST",
        headers: { "Content-Type": "image/gif" },
        body: gif,
      }),
      url,
      path: "/api/profile/image",
      publicPrefix: "",
      authUser: ADA,
    });
    expect(stored?.status).toBe(200);
    expect((await stored?.json()).image).toContain("/media?path=");

    const read = await handleProfileRoutes(
      context("/api/profile", "GET", { authUser: ADA }),
    );
    expect((await read?.json()).image).toContain("/media?path=");

    const cleared = await handleProfileRoutes(
      context("/api/profile/image", "DELETE", { authUser: ADA }),
    );
    expect(cleared?.status).toBe(200);
    const after = await handleProfileRoutes(
      context("/api/profile", "GET", { authUser: ADA }),
    );
    expect((await after?.json()).image).toBe("");
  });

  test("requires an identity", async () => {
    const res = await handleProfileRoutes(
      context("/api/profile", "GET", { authUser: null }),
    );
    expect(res?.status).toBe(401);
  });
});
