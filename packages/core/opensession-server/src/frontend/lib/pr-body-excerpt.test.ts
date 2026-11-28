import { expect, test } from "bun:test";
import { prBodyExcerpt } from "./pr-body-excerpt";

test("takes the first readable line of a PR body", () => {
  expect(prBodyExcerpt(undefined)).toBe("");
  expect(prBodyExcerpt("<!-- template -->\n\n## Summary\n")).toBe("Summary");
  expect(
    prBodyExcerpt(
      "- [x] Drop the **promo** card from [settings](https://x.test)",
    ),
  ).toBe("Drop the promo card from settings");
});
