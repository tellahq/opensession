import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { pathToFileURL } from "url";
import {
  inspectRepo,
  normalizeRepoOrigin,
  repoHasBranch,
  repoOriginIdentity,
} from "./repo-inspection";

function git(...args: string[]): void {
  expect(Bun.spawnSync(["git", ...args]).exitCode).toBe(0);
}

describe("normalizeRepoOrigin", () => {
  test("treats HTTPS and scp-style remotes as the same repository", async () => {
    expect(
      await normalizeRepoOrigin("https://gitlab.com/acme/widget.git"),
    ).toBe("gitlab.com/acme/widget");
    expect(await normalizeRepoOrigin("git@gitlab.com:acme/widget.git")).toBe(
      "gitlab.com/acme/widget",
    );
    expect(
      await normalizeRepoOrigin("https://token@gitlab.com/acme/widget.git"),
    ).toBe("gitlab.com/acme/widget");
  });

  test("normalizes local paths, file URLs, and resolvable symlinks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opensession-origin-identity-"));
    try {
      const remote = join(dir, "widget.git");
      const symlink = join(dir, "widget-link.git");
      mkdirSync(remote);
      symlinkSync(remote, symlink);
      const expected = await normalizeRepoOrigin(remote);

      expect(await normalizeRepoOrigin(pathToFileURL(remote).href)).toBe(
        expected,
      );
      expect(await normalizeRepoOrigin(symlink)).toBe(expected);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("ignores registered checkouts that are unavailable", async () => {
    await expect(repoOriginIdentity("/missing/repository")).resolves.toBeNull();
  });
});

describe("inspectRepo", () => {
  test("accepts an empty repository using its unborn local branch", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opensession-empty-repo-"));
    try {
      const remote = join(dir, "remote.git");
      const checkout = join(dir, "checkout");
      git("init", "-q", "--bare", "-b", "main", remote);
      git("init", "-q", "-b", "main", checkout);
      git("-C", checkout, "remote", "add", "origin", remote);

      expect(await inspectRepo(checkout)).toMatchObject({
        path: checkout,
        defaultBranch: "main",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("uses the remote HEAD when the local origin/HEAD is stale", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opensession-repo-inspection-"));
    try {
      const source = join(dir, "source");
      const remote = join(dir, "remote.git");
      const checkout = join(dir, "checkout");
      git("init", "-q", "-b", "master", source);
      writeFileSync(join(source, "README.md"), "test\n");
      git("-C", source, "add", "README.md");
      git(
        "-C",
        source,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "-q",
        "-m",
        "initial",
      );
      git("clone", "-q", "--bare", source, remote);
      git("clone", "-q", remote, checkout);
      git(
        "-C",
        checkout,
        "symbolic-ref",
        "refs/remotes/origin/HEAD",
        "refs/remotes/origin/main",
      );

      expect((await inspectRepo(checkout)).defaultBranch).toBe("master");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("repoHasBranch", () => {
  test("requires the branch to exist on origin", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opensession-repo-branch-"));
    try {
      const source = join(dir, "source");
      const remote = join(dir, "remote.git");
      git("init", "-q", "-b", "main", source);
      writeFileSync(join(source, "README.md"), "test\n");
      git("-C", source, "add", "README.md");
      git(
        "-C",
        source,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "-q",
        "-m",
        "initial",
      );
      git("-C", source, "branch", "local-only");
      git("init", "-q", "--bare", remote);
      git("-C", source, "remote", "add", "origin", remote);
      git("-C", source, "push", "-q", "-u", "origin", "main");

      expect(await repoHasBranch(source, "main")).toBe(true);
      expect(await repoHasBranch(source, "local-only")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
