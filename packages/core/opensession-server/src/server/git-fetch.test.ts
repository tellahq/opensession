import { describe, expect, test } from "bun:test";
import { $ } from "bun";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GIT_FETCH_TIMED_OUT_EXIT_CODE,
  GIT_FETCH_TIMEOUT_SECONDS,
  gitFetchArgv,
} from "./git-fetch";

describe("gitFetchArgv", () => {
  test("bounds the fetch with a timeout that also kills the transport", () => {
    expect(
      gitFetchArgv("/repos/acme-app", ["origin", "main", "--quiet"]),
    ).toEqual([
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

      const fetch =
        await $`${gitFetchArgv(clone, ["origin", "main", "--quiet"])}`
          .quiet()
          .nothrow();
      expect(fetch.exitCode).toBe(0);
      const fetched = (
        await $`git -C ${clone} rev-parse origin/main`.text()
      ).trim();
      const head = (await $`git -C ${origin} rev-parse HEAD`.text()).trim();
      expect(fetched).toBe(head);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("stops a fetch whose transport never answers, ssh included", async () => {
    const root = await mkdtemp(join(tmpdir(), "git-fetch-"));
    try {
      const clone = join(root, "clone");
      const marker = `git-fetch-hang-${process.pid}-${Date.now()}`;
      await $`git init -q -b main ${clone}`.quiet();
      await $`git -C ${clone} remote add origin ssh://example.test/acme/app.git`.quiet();

      const started = Date.now();
      const fetch =
        await $`${gitFetchArgv(clone, ["origin", "main", "--quiet"], 1)}`
          .env({ ...process.env, GIT_SSH_COMMAND: `sleep 30; : ${marker} #` })
          .quiet()
          .nothrow();
      expect(fetch.exitCode).toBe(GIT_FETCH_TIMED_OUT_EXIT_CODE);
      expect(Date.now() - started).toBeLessThan(10_000);
      const left = await $`pgrep -f ${marker}`.quiet().nothrow();
      expect(left.stdout.toString().trim()).toBe("");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
