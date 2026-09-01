import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "opensession-review-requests-"));
const paths = await import("./paths");
const previousDir = paths.__setSessionsDirForTest(dir);
const reviewRequests = await import(
  `./review-requests?test=${crypto.randomUUID()}`
);

const request = {
  to: "Kent",
  by: "Alex",
  at: "2026-08-28T10:00:00.000Z",
};

afterAll(() => {
  paths.__setSessionsDirForTest(previousDir);
  rmSync(dir, { recursive: true, force: true });
});

test("clearing a canonical session also clears an alias-keyed request", () => {
  reviewRequests.setReviewRequest("old-id", request);

  expect(reviewRequests.getReviewRequest("canonical-id", ["old-id"])).toEqual(
    request,
  );

  reviewRequests.setReviewRequest("canonical-id", null, ["old-id"]);

  expect(reviewRequests.getReviewRequest("canonical-id")).toBeUndefined();
  expect(reviewRequests.getReviewRequest("old-id")).toBeUndefined();
});

test("accepting an alias-keyed request migrates it to the canonical id", () => {
  reviewRequests.setReviewRequest("old-id", request);
  reviewRequests.setReviewAccepted(
    "canonical-id",
    { by: "Kent", at: "2026-08-28T10:05:00.000Z" },
    ["old-id"],
  );

  expect(reviewRequests.getReviewRequest("canonical-id")).toEqual({
    ...request,
    accepted: { by: "Kent", at: "2026-08-28T10:05:00.000Z" },
  });
  expect(reviewRequests.getReviewRequest("old-id")).toBeUndefined();
});
