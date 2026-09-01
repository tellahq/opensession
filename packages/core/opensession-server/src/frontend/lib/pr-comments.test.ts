import { describe, expect, test } from "bun:test";
import {
  isBotAuthor,
  isMachinePrComment,
  isOutdatedReviewComment,
} from "./pr-comments";

// Authors and bodies below are the real ones from a tella-fusion PR. The info
// panel's comment list is about what the team said, so all of these are noise.
describe("isMachinePrComment", () => {
  test("the agent's own review is a machine comment", () => {
    expect(
      isMachinePrComment({
        author: "tella-butler",
        body: "<!-- os-review -->\n### 🤖 OS review · **approve**",
      }),
    ).toBe(true);
  });

  test("integrations posting under a plain login are caught by their marker", () => {
    expect(
      isMachinePrComment({
        author: "vercel",
        body: "[vc]: #SH3yxWfHe5=:eyJpc01v",
      }),
    ).toBe(true);
    expect(
      isMachinePrComment({
        author: "linear-code",
        body: "<!-- linear-linkback -->\n<details>",
      }),
    ).toBe(true);
  });

  test("a comment the bot relayed for a person stays", () => {
    expect(
      isMachinePrComment({
        author: "tella-butler",
        body: "**Kent** via OS:\n\nCan we keep the old spacing here?",
      }),
    ).toBe(false);
    expect(
      isMachinePrComment({
        author: "tella-butler",
        body: "Review by **Kent** via OS.",
      }),
    ).toBe(false);
  });

  test("a teammate's comment stays, marker in prose and all", () => {
    expect(
      isMachinePrComment({
        author: "kentdebruin",
        body: "Can we keep the old spacing here?",
      }),
    ).toBe(false);
    expect(
      isMachinePrComment({
        author: "kentdebruin",
        body: "The `<!-- os-review -->` marker is what we key on.",
      }),
    ).toBe(false);
  });
});

describe("isOutdatedReviewComment", () => {
  test("recognizes superseded review markers", () => {
    expect(
      isOutdatedReviewComment(
        "<!-- os-review-outdated -->\n<details>...</details>",
      ),
    ).toBe(true);
  });

  test("keeps active reviews and ordinary comments", () => {
    expect(isOutdatedReviewComment("<!-- os-review -->\n## Review")).toBe(
      false,
    );
    expect(isOutdatedReviewComment("Please update this error message.")).toBe(
      false,
    );
  });
});

describe("isBotAuthor", () => {
  test("app logins, whatever their case", () => {
    expect(isBotAuthor("dependabot[bot]")).toBe(true);
    expect(isBotAuthor("Renovate[Bot]")).toBe(true);
    expect(isBotAuthor("tella-review-bot")).toBe(true);
    expect(isBotAuthor("kentdebruin")).toBe(false);
    expect(isBotAuthor("")).toBe(false);
    expect(isBotAuthor(null)).toBe(false);
  });
});
