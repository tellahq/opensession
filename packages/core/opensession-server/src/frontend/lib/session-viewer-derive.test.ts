import { expect, test } from "bun:test";
import {
  discoveredPrsFromKey,
  reviewReposFromKey,
  toolPathRootsFromKey,
} from "./session-viewer-derive";

test("reviewReposFromKey marks only the first repo primary", () => {
  expect(reviewReposFromKey("acme/api\u0000acme/web")).toEqual([
    { repo: "acme/api", primary: true },
    { repo: "acme/web", primary: false },
  ]);
  expect(reviewReposFromKey("acme/api")).toEqual([
    { repo: "acme/api", primary: true },
  ]);
});

test("discoveredPrsFromKey decodes each encoded PR and treats blanks as undefined", () => {
  expect(discoveredPrsFromKey("")).toEqual([]);
  expect(
    discoveredPrsFromKey(
      ["acme/api", "feature", "42", "https://example.com/42", "Title"].join(
        "\u0000",
      ),
    ),
  ).toEqual([
    {
      repo: "acme/api",
      branch: "feature",
      number: 42,
      url: "https://example.com/42",
      title: "Title",
    },
  ]);
  expect(
    discoveredPrsFromKey(["acme/api", "feature", "", "", ""].join("\u0000")),
  ).toEqual([
    {
      repo: "acme/api",
      branch: "feature",
      number: undefined,
      url: undefined,
      title: undefined,
    },
  ]);
});

test("toolPathRootsFromKey pairs the primary worktree with attached repos and drops empty dirs", () => {
  expect(
    toolPathRootsFromKey(
      [
        "/work/primary",
        ["/work/attached", "attached-repo"].join("\u0000"),
      ].join("\u0001"),
    ),
  ).toEqual([
    { dir: "/work/primary" },
    { dir: "/work/attached", label: "attached-repo" },
  ]);
  expect(toolPathRootsFromKey("")).toEqual([]);
});
