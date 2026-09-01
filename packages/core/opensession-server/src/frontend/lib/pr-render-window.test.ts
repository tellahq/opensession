import { describe, expect, test } from "bun:test";
import {
  expandPrRenderWindow,
  INITIAL_PR_ROWS,
  PR_ROWS_PAGE,
  visiblePrRowLimit,
} from "./pr-render-window";

describe("PR render window", () => {
  test("resets to the bounded opening window when filters change", () => {
    expect(
      visiblePrRowLimit({ scope: "all", limit: INITIAL_PR_ROWS * 3 }, "mine"),
    ).toBe(INITIAL_PR_ROWS);
  });

  test("expands one bounded page at a time", () => {
    const next = expandPrRenderWindow("all", INITIAL_PR_ROWS);
    expect(next).toEqual({
      scope: "all",
      limit: INITIAL_PR_ROWS + PR_ROWS_PAGE,
    });
    expect(visiblePrRowLimit(next, "all")).toBe(INITIAL_PR_ROWS + PR_ROWS_PAGE);
  });
});
