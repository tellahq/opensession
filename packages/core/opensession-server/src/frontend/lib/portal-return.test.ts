import { describe, expect, it } from "bun:test";
import { portalReturnUrl } from "./portal-return";

const APP = { hostname: "os.example.dev", origin: "https://os.example.dev" };

describe("portalReturnUrl", () => {
  it("accepts a Portal port on the app's host", () => {
    expect(
      portalReturnUrl(
        "?return=" + encodeURIComponent("https://os.example.dev:27286/x?y=1"),
        APP,
      ),
    ).toBe("https://os.example.dev:27286/x?y=1");
  });

  it("is case-insensitive on the host", () => {
    expect(portalReturnUrl("?return=https://OS.example.dev:9000/", APP)).toBe(
      "https://os.example.dev:9000/",
    );
  });

  it("returns null without a target", () => {
    expect(portalReturnUrl("", APP)).toBeNull();
    expect(portalReturnUrl("?return=", APP)).toBeNull();
    expect(portalReturnUrl("?return=not a url", APP)).toBeNull();
  });

  it("refuses other hosts and non-web schemes", () => {
    expect(
      portalReturnUrl("?return=https://evil.example.net/", APP),
    ).toBeNull();
    expect(
      portalReturnUrl("?return=https://os.example.dev.evil.net/", APP),
    ).toBeNull();
    expect(portalReturnUrl("?return=javascript:alert(1)", APP)).toBeNull();
  });

  it("refuses the app's own origin so it cannot loop", () => {
    expect(
      portalReturnUrl("?return=https://os.example.dev/?return=x", APP),
    ).toBeNull();
  });
});
