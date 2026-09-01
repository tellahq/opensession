import { describe, expect, test } from "bun:test";
import {
  workspaceComposerTarget,
  workspaceDraftPatch,
} from "./workspace-draft";

const UPDATED_AT = "2026-08-20T12:00:00.000Z";

describe("workspace draft create target", () => {
  test("a parked draft with a repo starts in Code on a fresh branch", () => {
    expect(
      workspaceComposerTarget(
        {
          repo: "opensession",
          draft: {
            text: "Fix the stale draft mode",
            updatedAt: UPDATED_AT,
          },
        },
        "Fix the stale draft mode",
      ),
    ).toEqual({
      mode: "code",
      branch: "fix-the-stale-draft-mode",
      repo: "opensession",
    });
  });

  test("an existing workspace branch stays in Code and is reused", () => {
    expect(
      workspaceComposerTarget(
        { repo: "opensession", branch: "kent/fix-draft" },
        "ignored",
      ),
    ).toEqual({
      mode: "code",
      branch: "kent/fix-draft",
      repo: "opensession",
      fromPr: true,
    });
  });

  test("a repo workspace without a parked draft remains Ask", () => {
    expect(
      workspaceComposerTarget({ repo: "opensession" }, "Investigate this"),
    ).toEqual({ mode: "ask", branch: "", repo: "opensession" });
  });
});

describe("workspace draft patches", () => {
  test("empty text removes the parked draft", () => {
    expect(workspaceDraftPatch("", UPDATED_AT, "Kent", true)).toEqual({
      draft: null,
    });
  });

  test("whitespace-only text also removes the parked draft", () => {
    expect(workspaceDraftPatch("  \n\t", UPDATED_AT)).toEqual({ draft: null });
  });

  test("nonempty text remains a draft with its naming state", () => {
    expect(
      workspaceDraftPatch("  Keep the spacing  ", UPDATED_AT, "Kent", false),
    ).toEqual({
      draft: {
        text: "  Keep the spacing  ",
        updatedAt: UPDATED_AT,
        by: "Kent",
        autoName: false,
      },
    });
  });
});
