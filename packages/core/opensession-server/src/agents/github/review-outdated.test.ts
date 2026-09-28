import { describe, expect, test } from "bun:test";
import { outdatedReviewBody } from "./github-rest";

const REVIEW = [
  "<!-- os-review -->",
  "### 🤖 OS review",
  "",
  "Looks good overall.",
  "",
  "<details><summary>📡 <b>How we'll know</b></summary>",
  "",
  "**Should happen**",
  "- Error X drops to zero",
  "",
  "</details>",
  "",
  "<details><summary>📈 Change diagram</summary>",
  "",
  "graph",
  "",
  "</details>",
].join("\n");

describe("outdatedReviewBody", () => {
  test("keeps the whole review, including its own details sections", () => {
    const body = outdatedReviewBody(REVIEW);
    expect(body.startsWith("<!-- os-review-outdated -->\n<details>\n")).toBe(
      true,
    );
    expect(body).not.toContain("<!-- os-review -->");
    expect(body).toContain("Looks good overall.");
    expect(body).toContain("📡 <b>How we'll know</b>");
    expect(body).toContain("📈 Change diagram");
    expect(body.match(/<details>/g)?.length).toBe(3);
    expect(body.match(/<\/details>/g)?.length).toBe(3);
  });

  test("does not nest the outdated wrapper when superseded again", () => {
    const once = outdatedReviewBody(REVIEW);
    expect(outdatedReviewBody(once)).toBe(once);
  });
});
