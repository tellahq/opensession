import { beforeEach, describe, expect, test } from "bun:test";
import { claimPreviewAutoOpen } from "./preview-auto-open";

const store = new Map<string, string>();
Object.assign(globalThis, {
  localStorage: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
  },
});

describe("claimPreviewAutoOpen", () => {
  beforeEach(() => store.clear());

  test("answers true once per PR", () => {
    expect(claimPreviewAutoOpen("https://github.com/acme/app/pull/1")).toBe(
      true,
    );
    expect(claimPreviewAutoOpen("https://github.com/acme/app/pull/1")).toBe(
      false,
    );
    expect(claimPreviewAutoOpen("https://github.com/acme/app/pull/2")).toBe(
      true,
    );
  });

  test("remembers a claim made in an earlier page load", () => {
    localStorage.setItem(
      "opensession-preview-auto-opened",
      JSON.stringify(["https://github.com/acme/app/pull/3"]),
    );
    expect(claimPreviewAutoOpen("https://github.com/acme/app/pull/3")).toBe(
      false,
    );
  });
});
