import { describe, expect, test } from "bun:test";
import { portalWaitingResponse } from "./portal-waiting-page";

describe("portalWaitingResponse", () => {
  test("waking is a 503 that refreshes itself", async () => {
    const res = portalWaitingResponse({ state: "waking", retrySeconds: 4 });
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("4");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Content-Type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain('<meta http-equiv="refresh" content="4">');
    expect(html).toContain("location.replace(location.href)},4000)");
    expect(html).toContain("Starting the Portal");
    expect(html).not.toContain("Open the session");
  });

  test("waking defaults to a short retry and never below a second", () => {
    expect(
      portalWaitingResponse({ state: "waking" }).headers.get("Retry-After"),
    ).toBe("3");
    expect(
      portalWaitingResponse({ state: "waking", retrySeconds: 0 }).headers.get(
        "Retry-After",
      ),
    ).toBe("1");
  });

  test("unavailable is a 404 with a way back to the session", async () => {
    const res = portalWaitingResponse({
      state: "unavailable",
      sessionUrl: "https://os.example.test/session/bks-1",
    });
    expect(res.status).toBe(404);
    expect(res.headers.get("Retry-After")).toBeNull();
    const html = await res.text();
    expect(html).not.toContain("http-equiv");
    expect(html).not.toContain("<script>");
    expect(html).toContain('href="https://os.example.test/session/bks-1"');
    expect(html).toContain("This Portal is not running");
  });

  test("refuses a session link that is not an http(s) URL", async () => {
    for (const sessionUrl of ["javascript:alert(1)", "not a url", ""]) {
      const html = await portalWaitingResponse({
        state: "unavailable",
        sessionUrl,
      }).text();
      expect(html).not.toContain("Open the session");
      expect(html).not.toContain("javascript:");
    }
  });

  test("escapes the session link", async () => {
    const html = await portalWaitingResponse({
      state: "unavailable",
      sessionUrl: 'https://os.example.test/session/x"><script>1</script>',
    }).text();
    // URL parsing percent-encodes the path; the href must not close early.
    expect(html).not.toContain("<script>1</script>");
    expect(html).not.toContain('x"><');
    expect(html).toContain("/session/x%22%3E%3Cscript%3E1%3C/script%3E");
  });
});
