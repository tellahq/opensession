import { describe, expect, it } from "bun:test";
import { isPortalAuthPath, portalSignInRedirect } from "./portal-sign-in";

const APP = "https://os.example.dev";

function probe(headers: Record<string, string>, method = "GET"): Request {
  return new Request("http://127.0.0.1:3850/api/portal-auth/27286", {
    method,
    headers: {
      host: "os.example.dev:27286",
      "x-forwarded-method": "GET",
      "x-forwarded-uri": "/dashboard?x=1",
      ...headers,
    },
  });
}

const NAVIGATE = {
  "sec-fetch-mode": "navigate",
  "sec-fetch-dest": "document",
  accept: "text/html,application/xhtml+xml",
};

describe("isPortalAuthPath", () => {
  it("matches only the forward-auth probe", () => {
    expect(isPortalAuthPath("/api/portal-auth/27286")).toBe(true);
    expect(isPortalAuthPath("/api/portal-auth/")).toBe(false);
    expect(isPortalAuthPath("/api/portals")).toBe(false);
  });
});

describe("portalSignInRedirect", () => {
  it("sends a browser navigation to the app's sign-in with the Portal URL", () => {
    const res = portalSignInRedirect(
      probe(NAVIGATE),
      "/api/portal-auth/27286",
      APP,
    );
    expect(res?.status).toBe(302);
    expect(res?.headers.get("cache-control")).toBe("no-store");
    const location = new URL(res!.headers.get("location")!);
    expect(location.origin + location.pathname).toBe(`${APP}/`);
    expect(location.searchParams.get("return")).toBe(
      "https://os.example.dev:27286/dashboard?x=1",
    );
  });

  it("keeps the app's base path", () => {
    const res = portalSignInRedirect(
      probe(NAVIGATE),
      "/api/portal-auth/27286",
      "https://os.example.dev/opensession?stale=1",
    );
    const location = new URL(res!.headers.get("location")!);
    expect(location.pathname).toBe("/opensession/");
    expect(location.searchParams.get("stale")).toBeNull();
  });

  it("prefers the forwarded host over the proxy hop's host", () => {
    const res = portalSignInRedirect(
      probe({ ...NAVIGATE, "x-forwarded-host": "os.example.dev:27286" }),
      "/api/portal-auth/27286",
      APP,
    );
    expect(
      new URL(res!.headers.get("location")!).searchParams.get("return"),
    ).toBe("https://os.example.dev:27286/dashboard?x=1");
  });

  it("falls back to the Accept header for browsers without fetch metadata", () => {
    const res = portalSignInRedirect(
      probe({ accept: "text/html" }),
      "/api/portal-auth/27286",
      APP,
    );
    expect(res?.status).toBe(302);
  });

  it("leaves fetches and asset loads with the plain 401", () => {
    expect(
      portalSignInRedirect(
        probe({ accept: "application/json" }),
        "/api/portal-auth/27286",
        APP,
      ),
    ).toBeNull();
    expect(
      portalSignInRedirect(
        probe({ "sec-fetch-mode": "cors", accept: "text/html" }),
        "/api/portal-auth/27286",
        APP,
      ),
    ).toBeNull();
    expect(
      portalSignInRedirect(
        probe({ "sec-fetch-dest": "script", accept: "*/*" }),
        "/api/portal-auth/27286",
        APP,
      ),
    ).toBeNull();
  });

  it("only redirects forwarded GET and HEAD requests", () => {
    expect(
      portalSignInRedirect(
        probe({ ...NAVIGATE, "x-forwarded-method": "POST" }),
        "/api/portal-auth/27286",
        APP,
      ),
    ).toBeNull();
    expect(
      portalSignInRedirect(
        probe({ ...NAVIGATE, "x-forwarded-method": "HEAD" }),
        "/api/portal-auth/27286",
        APP,
      )?.status,
    ).toBe(302);
  });

  it("never hands the browser to another host", () => {
    expect(
      portalSignInRedirect(
        probe({ ...NAVIGATE, host: "evil.example.net:27286" }),
        "/api/portal-auth/27286",
        APP,
      ),
    ).toBeNull();
    expect(
      portalSignInRedirect(
        probe({ ...NAVIGATE, "x-forwarded-host": "evil.example.net" }),
        "/api/portal-auth/27286",
        APP,
      ),
    ).toBeNull();
  });

  it("ignores every other path", () => {
    expect(
      portalSignInRedirect(probe(NAVIGATE), "/api/sessions", APP),
    ).toBeNull();
  });
});
