import { expect, test } from "bun:test";

// The test runtime has no Web Storage, and the module treats a missing one as
// "no cache" rather than an error, so the persistence half would silently pass
// on nothing. Stand one up before the module reads it.
const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage ??= {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, String(value)),
  removeItem: (key: string) => void store.delete(key),
};

import { cachedNewSessionRepo, cachedRepos, rememberRepos } from "./repo-cache";

// The cache is what lets a repo picker open on the list it showed last time
// instead of on "Loading…", so what is worth pinning is that a remembered list
// reads back whole (ids, colours and the workspace default), and that a later
// answer replaces it rather than merging into it — a repo someone removed has
// to leave the picker.

test("a remembered list reads back with its workspace default", () => {
  rememberRepos(
    [
      {
        id: "tella-fusion",
        defaultBranch: "main",
        sharedCheckout: false,
        color: "#009a69",
      },
    ],
    "tella-fusion",
  );

  expect(cachedRepos()).toEqual([
    {
      id: "tella-fusion",
      defaultBranch: "main",
      sharedCheckout: false,
      color: "#009a69",
    },
  ]);
  expect(cachedNewSessionRepo()).toBe("tella-fusion");
  // Stored, not just held in memory: the point is the NEXT load.
  expect(
    JSON.parse(localStorage.getItem("opensession-repos") || "null"),
  ).toEqual({
    repos: [
      {
        id: "tella-fusion",
        defaultBranch: "main",
        sharedCheckout: false,
        color: "#009a69",
      },
    ],
    newSessionRepo: "tella-fusion",
  });
});

test("a later answer replaces the remembered one", () => {
  rememberRepos(
    [{ id: "gitops", defaultBranch: "main", sharedCheckout: false }],
    "",
  );

  expect(cachedRepos().map((repo) => repo.id)).toEqual(["gitops"]);
  expect(cachedNewSessionRepo()).toBe("gitops");
});

test("retired automatic defaults fall back to a real repository", () => {
  rememberRepos(
    [
      { id: "app", defaultBranch: "main", sharedCheckout: false },
      {
        id: "docs",
        defaultBranch: "main",
        sharedCheckout: false,
        default: true,
      },
    ],
    "auto",
  );

  expect(cachedNewSessionRepo()).toBe("docs");
});
