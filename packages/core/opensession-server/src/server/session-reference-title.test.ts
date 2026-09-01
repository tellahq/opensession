import { describe, expect, test } from "bun:test";
import { nameSessionReferencesForTitle } from "./session-reference-title";

const ID = "bks-01a023f8-b134-71f3-bc17-a9388195ad65";

function find(id: string) {
  return id === ID
    ? { title: "Fix landing page", workspaceName: "Landingpage" }
    : undefined;
}

describe("session reference titles", () => {
  test("uses the visible workspace name for a pasted session reference", () => {
    expect(
      nameSessionReferencesForTitle(
        `${ID} on this session I can't close the tab`,
        find,
      ),
    ).toBe("Landingpage on this session I can't close the tab");
  });

  test("also names explicit session mentions", () => {
    expect(nameSessionReferencesForTitle(`Review @session:${ID}`, find)).toBe(
      "Review Landingpage",
    );
  });

  test("falls back to the session title", () => {
    expect(
      nameSessionReferencesForTitle(ID, () => ({ title: "Fix landing page" })),
    ).toBe("Fix landing page");
  });

  test("keeps unknown and partial references unchanged", () => {
    expect(nameSessionReferencesForTitle(ID, () => undefined)).toBe(ID);
    expect(nameSessionReferencesForTitle(`prefix-${ID}`, find)).toBe(
      `prefix-${ID}`,
    );
  });
});
