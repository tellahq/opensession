import { describe, expect, test } from "bun:test";
import {
  createPersonalGithubApi,
  MAX_RESPONSE_BYTES,
  parseTokenGrant,
  parseRepository,
  parseAuthenticatedUser,
} from "./github-api";
import { buildGithubAppJwt, decodeJwtPayload } from "./jwt";
import { syntheticFixture } from "./synthetic.test-support";

describe("bounded personal GitHub API", () => {
  test("rejects large declared and streamed response bodies", async () => {
    for (const response of [
      new Response("{}", {
        headers: { "content-length": String(MAX_RESPONSE_BYTES + 1) },
      }),
      new Response("x".repeat(MAX_RESPONSE_BYTES + 1)),
    ]) {
      const api = createPersonalGithubApi({ transport: async () => response });
      expect(await api.getAuthenticatedUser("synthetic")).toMatchObject({
        code: "response_too_large",
      });
    }
  });
  test("never returns transport errors or GitHub error text that could contain secrets", async () => {
    for (const transport of [
      async () => {
        throw new Error("private-token-123");
      },
      async () =>
        new Response(JSON.stringify({ message: "private-token-123" }), {
          status: 403,
        }),
    ]) {
      const result = await createPersonalGithubApi({
        transport,
      }).getAuthenticatedUser("private-token-123");
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain("private-token-123");
    }
  });
  test("timeout bounds stalled transport AND body, refuses redirects", async () => {
    for (const transport of [
      () => new Promise<Response>(() => {}),
      async () => new Response(new ReadableStream({ start() {} })),
    ]) {
      const result = await createPersonalGithubApi({
        transport,
        timeoutMs: 5,
      }).getAuthenticatedUser("synthetic");
      expect(result.ok).toBe(false);
    }
    const api = createPersonalGithubApi({
      transport: async (_url, init) => {
        expect(init.redirect).toBe("error");
        return new Response(null, {
          status: 302,
          headers: { location: "https://outside.example" },
        });
      },
    });
    expect(await api.getAuthenticatedUser("synthetic")).toMatchObject({
      code: "denied",
    });
  });
  test("bounds outgoing bodies, header values, path IDs, and permission levels", async () => {
    let calls = 0;
    const api = createPersonalGithubApi({
      transport: async () => {
        calls++;
        return new Response("{}");
      },
    });
    expect((await api.startDeviceFlow("x".repeat(20_000))).ok).toBe(false);
    expect((await api.getAuthenticatedUser("a\r\nb")).ok).toBe(false);
    expect((await api.convertManifest("../shared")).ok).toBe(false);
    expect(
      (
        await api.mintInstallationToken({
          appJwt: "jwt",
          installationId: -1,
          permissions: { metadata: "read" },
        })
      ).ok,
    ).toBe(false);
    expect(
      (
        await api.mintInstallationToken({
          appJwt: "jwt",
          installationId: 1,
          permissions: { actions: "write" },
        })
      ).ok,
    ).toBe(false);
    expect(
      (
        await api.mintInstallationToken({
          appJwt: "jwt",
          installationId: 1,
          permissions: { members: "read" },
        })
      ).ok,
    ).toBe(false);
    expect(calls).toBe(0);
  });
  test("bounds actual page lengths, not merely requested per_page", async () => {
    const f = syntheticFixture();
    f.respond(async () =>
      f.json(Array.from({ length: 101 }, () => f.install())),
    );
    expect((await f.api.listAppInstallations("synthetic")).ok).toBe(false);
    f.respond(async () =>
      f.json({
        total_count: 101,
        repositories: Array.from({ length: 101 }, () => f.repository()),
      }),
    );
    expect((await f.api.listInstallationRepositories("synthetic")).ok).toBe(
      false,
    );
  });
  test("bounded pagination reports incomplete discovery and rejects incomplete installation list", async () => {
    const f = syntheticFixture();
    f.respond(async () =>
      f.json(Array.from({ length: 100 }, (_, i) => f.install(11, i + 1))),
    );
    expect((await f.api.listAppInstallations("synthetic")).ok).toBe(false);
    expect(f.calls).toHaveLength(3);
    f.calls.length = 0;
    f.respond(async (url) => {
      const page = Number(new URL(url).searchParams.get("page"));
      return f.json({
        total_count: 600,
        repositories: Array.from({ length: 100 }, (_, i) =>
          f.repository(11, page * 100 + i),
        ),
      });
    });
    expect(await f.api.listInstallationRepositories("synthetic")).toMatchObject(
      { ok: true, value: { truncated: true } },
    );
    expect(f.calls).toHaveLength(5);
  });
  test("parsers reject malformed authority, unsafe repository names, ambiguous token expiry", () => {
    expect(
      parseAuthenticatedUser({ id: "11", login: "person", type: "User" }),
    ).toBeNull();
    expect(
      parseTokenGrant({ access_token: "token", expires_in: "3600" }),
    ).toBeNull();
    expect(
      parseTokenGrant({ access_token: "token", expires_in: 0 }),
    ).toBeNull();
    expect(
      parseTokenGrant({ access_token: "token", refresh_token: "bad token" }),
    ).toBeNull();
    expect(
      parseRepository({
        id: 1,
        name: "../../escape",
        full_name: "owner/../../escape",
        owner: { id: 11, login: "owner", type: "User" },
        private: true,
      }),
    ).toBeNull();
  });
  test("JWT is explicit-key/issuer/clock only, no ambient shared App", () => {
    const f = syntheticFixture();
    const token = buildGithubAppJwt({
      privateKeyPem: f.pem,
      issuer: "personal-client",
      nowSeconds: 1000,
    });
    expect(decodeJwtPayload(token)).toEqual({
      iss: "personal-client",
      iat: 940,
      exp: 1540,
    });
    expect(() =>
      buildGithubAppJwt({
        privateKeyPem: "",
        issuer: "personal-client",
        nowSeconds: 1000,
      }),
    ).toThrow();
  });
});
