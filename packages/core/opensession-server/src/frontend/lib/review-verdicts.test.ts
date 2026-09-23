import { expect, test } from "bun:test";
import { allowedReviewEvent, canGiveReviewVerdict } from "./review-verdicts";

test("GitHub authors can comment but cannot approve or request changes", () => {
  const allowed = canGiveReviewVerdict(
    "github",
    "Acme-Author",
    " acme-author ",
  );
  expect(allowed).toBe(false);
  for (const event of ["APPROVE", "REQUEST_CHANGES", "COMMENT"] as const)
    expect(allowedReviewEvent(event, allowed)).toBe("COMMENT");
});

test("other reviewers keep every verdict", () => {
  const allowed = canGiveReviewVerdict(
    "github",
    "acme-author",
    "acme-reviewer",
  );
  expect(allowed).toBe(true);
  for (const event of ["APPROVE", "REQUEST_CHANGES", "COMMENT"] as const)
    expect(allowedReviewEvent(event, allowed)).toBe(event);
});

test("unresolved GitHub identities offer comments only", () => {
  expect(canGiveReviewVerdict("github", "acme", null)).toBe(false);
  expect(canGiveReviewVerdict("github", undefined, "acme")).toBe(false);
  expect(canGiveReviewVerdict("github", "acme", " ")).toBe(false);
  expect(canGiveReviewVerdict("codestorage", "acme", null)).toBe(true);
});
