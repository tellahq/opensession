import { describe, expect, test } from "bun:test";
import { providerAccountLabel } from "./provider-account";

describe("providerAccountLabel", () => {
  test("prefers the subscription email", () => {
    expect(
      providerAccountLabel({
        name: "Team account",
        email: " person@example.com ",
      }),
    ).toBe("person@example.com");
  });

  test("keeps names as a compatibility fallback", () => {
    expect(providerAccountLabel({ name: "Platform key" })).toBe("Platform key");
    expect(providerAccountLabel({ name: "Older account", email: " " })).toBe(
      "Older account",
    );
  });
});
