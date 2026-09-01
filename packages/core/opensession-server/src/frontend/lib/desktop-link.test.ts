import { describe, expect, test } from "bun:test";
import { desktopProtocolUrl } from "./desktop-link";

const macLink = {
  pathname: "/workspace/ws-1/session/os-123",
  search: "?tab=review",
  hash: "#latest",
  platform: "MacIntel",
  maxTouchPoints: 0,
  desktop: false,
  standalone: false,
};

describe("desktopProtocolUrl", () => {
  test("maps shared Mac browser links to the desktop protocol", () => {
    expect(desktopProtocolUrl(macLink)).toBe(
      "os1://workspace/ws-1/session/os-123?tab=review#latest",
    );
    expect(
      desktopProtocolUrl({ ...macLink, pathname: "/session/os-123" }),
    ).toBe("os1://session/os-123?tab=review#latest");
    expect(
      desktopProtocolUrl({ ...macLink, pathname: "/pr/opensession/main" }),
    ).toBe("os1://pr/opensession/main?tab=review#latest");
  });

  test("accepts old prefixed links after normalizing their route", () => {
    expect(
      desktopProtocolUrl({
        ...macLink,
        pathname: "/backstage/session/os-123",
      }),
    ).toBe("os1://session/os-123?tab=review#latest");
  });

  test("leaves ordinary pages, app shells, and touch devices alone", () => {
    expect(
      desktopProtocolUrl({ ...macLink, pathname: "/settings" }),
    ).toBeNull();
    expect(desktopProtocolUrl({ ...macLink, desktop: true })).toBeNull();
    expect(desktopProtocolUrl({ ...macLink, standalone: true })).toBeNull();
    expect(desktopProtocolUrl({ ...macLink, maxTouchPoints: 5 })).toBeNull();
    expect(desktopProtocolUrl({ ...macLink, platform: "Win32" })).toBeNull();
  });
});
