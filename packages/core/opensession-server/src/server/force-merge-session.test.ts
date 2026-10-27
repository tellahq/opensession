import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { forceMergeRefusal } from "./force-merge-session";
import { __setIdentitiesForTest } from "./shared/user-mappings";

// Ada is a Slack member; Grace has only a GitHub login (no Slack, no email).
let restore: (() => void) | undefined;
beforeAll(() => {
  restore = __setIdentitiesForTest([
    {
      name: "Ada",
      email: "ada@example.test",
      slackId: "UADA00001",
      github: "ada-gh",
    },
    { name: "Grace", github: "grace-gh" },
    { name: "Nolan", email: "nolan@example.test", slackId: "UNOLAN001" },
  ]);
});
afterAll(() => restore?.());

describe("forceMergeRefusal", () => {
  test("automation runs can never open a card", () => {
    expect(forceMergeRefusal({ automationId: "a1" }, "Ada", true)).toContain(
      "not available to automation runs",
    );
    expect(
      forceMergeRefusal({ automationDescendantPolicy: {} }, "Ada", true),
    ).toContain("not available to automation runs");
  });

  test("without GitHub sign-in nobody could confirm, so it refuses", () => {
    expect(forceMergeRefusal({}, "Ada", false)).toContain(
      "needs GitHub sign-in",
    );
  });

  test("an unknown driver cannot confirm", () => {
    expect(forceMergeRefusal({}, undefined, true)).toContain(
      "signed-in teammate",
    );
    expect(forceMergeRefusal({}, "nobody-on-the-roster", true)).toContain(
      "signed-in teammate",
    );
  });

  test("a signed-in teammate may confirm, with or without Slack", () => {
    expect(forceMergeRefusal({}, "Ada", true)).toBeNull();
    expect(forceMergeRefusal({}, "Grace", true)).toBeNull();
  });

  test("a roster member without a GitHub login cannot confirm", () => {
    expect(forceMergeRefusal({}, "Nolan", true)).toContain(
      "signed-in teammate",
    );
  });
});
