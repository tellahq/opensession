import { describe, expect, test } from "bun:test";
import {
  mergeRepoOrder,
  normalizeRepoOrder,
  replaceVisibleRepoOrder,
} from "./repo-order";

describe("repository order", () => {
  test("normalizes persisted values", () => {
    expect(normalizeRepoOrder([" beta ", "alpha", "beta", 42, ""])).toEqual([
      "beta",
      "alpha",
    ]);
  });

  test("keeps saved repositories first and appends discoveries", () => {
    expect(
      mergeRepoOrder(["gamma", "missing", "alpha"], ["alpha", "beta", "gamma"]),
    ).toEqual(["gamma", "alpha", "beta"]);
  });

  test("reorders visible slots without moving filtered-out repositories", () => {
    expect(
      replaceVisibleRepoOrder(
        ["alpha", "hidden", "beta", "gamma"],
        ["gamma", "alpha", "beta"],
      ),
    ).toEqual(["gamma", "hidden", "alpha", "beta"]);
  });

  test("retains newly visible repositories absent from the saved order", () => {
    expect(
      replaceVisibleRepoOrder(["alpha", "hidden"], ["new-repo", "alpha"]),
    ).toEqual(["new-repo", "hidden", "alpha"]);
  });
});
