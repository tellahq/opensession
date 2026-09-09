import { describe, expect, test } from "bun:test";
import type { Repo } from "./config";
import { applyPrLabels, type GithubLabelApi } from "./pr-labels";

const repo = {
  id: "app",
  ghRepo: "acme/app",
  host: "github",
} as unknown as Repo;

function fakeApi(initial: string[]) {
  let labels = [...initial];
  const calls: string[] = [];
  const api: GithubLabelApi = {
    add: async (_repo, _number, names) => {
      calls.push(`add ${names.join(",")}`);
      labels = [...new Set([...labels, ...names])];
      return labels;
    },
    remove: async (_repo, _number, name) => {
      calls.push(`remove ${name}`);
      if (!labels.includes(name)) throw new Error("Label does not exist (404)");
      labels = labels.filter((l) => l !== name);
      return labels;
    },
    list: async () => {
      calls.push("list");
      return labels;
    },
  };
  return { api, calls };
}

describe("applyPrLabels", () => {
  test("adds, removes, and reports the resulting set", async () => {
    const { api, calls } = fakeApi(["os-review", "stale"]);
    const res = await applyPrLabels(
      { repo, number: 7 },
      {
        add: ["preview-temporal", " preview-instant ", "preview-temporal"],
        remove: ["stale"],
      },
      api,
    );
    expect(calls).toEqual([
      "add preview-temporal,preview-instant",
      "remove stale",
    ]);
    expect(res).toEqual({
      repo: "app",
      ghRepo: "acme/app",
      number: 7,
      labels: ["os-review", "preview-temporal", "preview-instant"],
    });
  });

  test("removing a label the PR does not carry is not an error", async () => {
    const { api } = fakeApi(["a"]);
    const res = await applyPrLabels(
      { repo, number: 1 },
      { remove: ["missing"] },
      api,
    );
    expect(res.labels).toEqual(["a"]);
  });

  test("a label in both lists is added, not removed", async () => {
    const { api, calls } = fakeApi([]);
    await applyPrLabels(
      { repo, number: 1 },
      { add: ["x"], remove: ["x"] },
      api,
    );
    expect(calls).toEqual(["add x"]);
  });

  test("other API failures propagate", async () => {
    const { api } = fakeApi([]);
    api.add = async () => {
      throw new Error("Resource not accessible by integration (403)");
    };
    await expect(
      applyPrLabels({ repo, number: 1 }, { add: ["x"] }, api),
    ).rejects.toThrow("403");
  });
});
