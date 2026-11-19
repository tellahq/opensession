import { describe, expect, test } from "bun:test";
import { $ } from "bun";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GIT_FETCH_TIMEOUT_SECONDS, gitFetchArgv } from "./git-fetch";

describe("gitFetchArgv", () => {
  test("bounds the fetch with a timeout that also kills the transport", () => {
    expect(gitFetchArgv("/repos/acme-app", ["origin", "main", "--quiet"])).toEqual([
      "timeout",
      "--kill-after=10",
      String(GIT_FETCH_TIMEOUT_SECONDS),
      "git",
      "-C",
      "/repos/acme-app",
      "fetch",
      "origin",
      "main",
      "--quiet",
    ]);
  });

  test("runs a real fetch", async () => {
    const root = await mkdtemp(join(tmpdir(), "git-fetch-"));
    try {
      const origin = join(root, "origin");
      const clone = join(root, "clone");
      await $`git init -q -b main ${origin}`.quiet();
      await $`git -C ${origin} -c user.name=acme -c user.email=acme@example.test commit -q --allow-empty -m first`.quiet();
      await $`git clone -q ${origin} ${clone}`.quiet();
      await $`git -C ${origin} -c user.name=acme -c user.email=acme@example.test commit -q --allow-empty -m second`.quiet();

      const fetch = await $`${gitFetchArgv(clone, ["origin", "main", "--quiet"])}`
        .quiet()
        .nothrow();
      expect(fetch.exitCode).toBe(0);
      const fetched = (await $`git -C ${clone} rev-parse origin/main`.text()).trim();
      const head = (await $`git -C ${origin} rev-parse HEAD`.text()).trim();
      expect(fetched).toBe(head);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
