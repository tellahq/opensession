const { describe, expect, test } = require("bun:test");
const {
  accountForContext,
  isOpenSessionAppUrl,
  resumableAccountUrl,
} = require("./account-navigation");

describe("accountForContext", () => {
  const accounts = [
    { id: "one", url: "https://one.example/" },
    { id: "two", url: "https://two.example/" },
  ];

  test("keeps a window on its assigned organization", () => {
    expect(
      accountForContext(
        accounts,
        "two",
        "one",
        "https://two.example/session/os-2",
      )?.id,
    ).toBe("one");
  });

  test("infers legacy windows from their current origin before the default", () => {
    expect(
      accountForContext(
        accounts,
        "one",
        null,
        "https://two.example/session/os-2",
      )?.id,
    ).toBe("two");
  });

  test("uses the active organization for a new window", () => {
    expect(accountForContext(accounts, "two", null, "")?.id).toBe("two");
  });
});

describe("isOpenSessionAppUrl", () => {
  const account = "https://one.example/";

  test("accepts Open Session pages", () => {
    expect(isOpenSessionAppUrl(account, "https://one.example/")).toBe(true);
    expect(
      isOpenSessionAppUrl(
        account,
        "https://one.example/workspace/ws-1/session/os-1?tab=changes#latest",
      ),
    ).toBe(true);
    expect(
      isOpenSessionAppUrl(account, "https://one.example/reports/daily/latest"),
    ).toBe(true);
  });

  test("rejects same-origin documents that are not app pages", () => {
    expect(
      isOpenSessionAppUrl(
        account,
        "https://one.example/api/sessions/os-1/assets/raw/report.html",
      ),
    ).toBe(false);
    expect(
      isOpenSessionAppUrl(
        account,
        "https://one.example/api/reports/daily/latest/raw",
      ),
    ).toBe(false);
    expect(isOpenSessionAppUrl(account, "https://one.example/docs/help")).toBe(
      false,
    );
  });

  test("rejects another origin and non-web URLs", () => {
    expect(
      isOpenSessionAppUrl(account, "https://two.example/session/os-2"),
    ).toBe(false);
    expect(isOpenSessionAppUrl(account, "file:///offline.html")).toBe(false);
    expect(isOpenSessionAppUrl(account, "not a URL")).toBe(false);
  });
});

describe("resumableAccountUrl", () => {
  test("retains an in-app route exactly", () => {
    expect(
      resumableAccountUrl(
        "https://one.example/",
        "https://one.example/workspace/ws-1/session/os-1?tab=changes#latest",
      ),
    ).toBe(
      "https://one.example/workspace/ws-1/session/os-1?tab=changes#latest",
    );
  });

  test("rejects documents, another account and shell pages", () => {
    expect(
      resumableAccountUrl(
        "https://one.example/",
        "https://one.example/api/sessions/os-1/assets/raw/report.html",
      ),
    ).toBeNull();
    expect(
      resumableAccountUrl(
        "https://one.example/",
        "https://two.example/session/os-2",
      ),
    ).toBeNull();
    expect(
      resumableAccountUrl("https://one.example/", "file:///offline.html"),
    ).toBeNull();
    expect(resumableAccountUrl("https://one.example/", "not a URL")).toBeNull();
  });
});
