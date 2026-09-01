import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { getSessionDiff } from "./git-diff";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("getSessionDiff", () => {
  test("coalesces concurrent reads of the same worktree", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opensession-git-diff-"));
    dirs.push(dir);
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: "Open Session Test",
      GIT_AUTHOR_EMAIL: "test@opensession.local",
      GIT_COMMITTER_NAME: "Open Session Test",
      GIT_COMMITTER_EMAIL: "test@opensession.local",
    };
    expect(
      Bun.spawnSync(["git", "init", "-b", "main"], { cwd: dir, env }).exitCode,
    ).toBe(0);
    writeFileSync(join(dir, "file.txt"), "before\n");
    expect(
      Bun.spawnSync(["git", "add", "file.txt"], { cwd: dir, env }).exitCode,
    ).toBe(0);
    expect(
      Bun.spawnSync(["git", "commit", "-m", "initial"], { cwd: dir, env })
        .exitCode,
    ).toBe(0);
    writeFileSync(join(dir, "file.txt"), "after\n");

    const first = getSessionDiff(dir);
    const second = getSessionDiff(dir);

    expect(second).toBe(first);
    const result = await first;
    expect(result.rawPatch).toContain("+after");
    expect(result.diffVersion).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const next = getSessionDiff(dir);
    expect(next).not.toBe(first);
    await next;
  });

  test("keeps non-ASCII paths literal in patches", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opensession-git-diff-unicode-"));
    dirs.push(dir);
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: "Open Session Test",
      GIT_AUTHOR_EMAIL: "test@opensession.local",
      GIT_COMMITTER_NAME: "Open Session Test",
      GIT_COMMITTER_EMAIL: "test@opensession.local",
    };
    writeFileSync(join(dir, "café.ts"), "export const value = 1;\n");
    expect(
      Bun.spawnSync(["git", "init", "-b", "main"], { cwd: dir, env }).exitCode,
    ).toBe(0);
    expect(
      Bun.spawnSync(["git", "add", "café.ts"], { cwd: dir, env }).exitCode,
    ).toBe(0);
    expect(
      Bun.spawnSync(["git", "commit", "-m", "initial"], { cwd: dir, env })
        .exitCode,
    ).toBe(0);
    writeFileSync(join(dir, "café.ts"), "export const value = 2;\n");

    const result = await getSessionDiff(dir);
    expect(result.rawPatch).toContain("café.ts");
    expect(result.files[0]?.path).toBe("café.ts");
  });

  test("scopes tracked and untracked files to the supplied paths", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opensession-git-diff-scoped-"));
    dirs.push(dir);
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: "Open Session Test",
      GIT_AUTHOR_EMAIL: "test@opensession.local",
      GIT_COMMITTER_NAME: "Open Session Test",
      GIT_COMMITTER_EMAIL: "test@opensession.local",
    };
    expect(
      Bun.spawnSync(["git", "init", "-b", "main"], { cwd: dir, env }).exitCode,
    ).toBe(0);
    writeFileSync(join(dir, "mine.txt"), "before\n");
    writeFileSync(join(dir, "literal[1].txt"), "before\n");
    writeFileSync(join(dir, "theirs.txt"), "before\n");
    expect(Bun.spawnSync(["git", "add", "."], { cwd: dir, env }).exitCode).toBe(
      0,
    );
    expect(
      Bun.spawnSync(["git", "commit", "-m", "initial"], { cwd: dir, env })
        .exitCode,
    ).toBe(0);
    writeFileSync(join(dir, "mine.txt"), "mine\n");
    writeFileSync(join(dir, "literal[1].txt"), "mine\n");
    writeFileSync(join(dir, "theirs.txt"), "theirs\n");
    writeFileSync(join(dir, "mine-new.txt"), "new\n");
    writeFileSync(join(dir, "theirs-new.txt"), "new\n");

    const result = await getSessionDiff(
      dir,
      "main",
      undefined,
      false,
      undefined,
      ["mine.txt", "mine-new.txt", "literal[1].txt"],
    );
    expect(result.files.map((file) => file.path).sort()).toEqual([
      "literal[1].txt",
      "mine-new.txt",
      "mine.txt",
    ]);
    expect(result.rawPatch).toContain("mine.txt");
    expect(result.rawPatch).toContain("mine-new.txt");
    expect(result.rawPatch).not.toContain("theirs.txt");
    expect(result.rawPatch).not.toContain("theirs-new.txt");

    const magic = await getSessionDiff(
      dir,
      "main",
      undefined,
      true,
      undefined,
      [":(glob)**"],
    );
    expect(magic.files).toEqual([]);
  });

  test("keeps a timed-out computation coalesced until the underlying work settles", async () => {
    let call = 0;
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => (releaseFirst = resolve));
    const exec = Object.assign(
      async () => {
        call++;
        if (call === 1) await firstGate;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      { sandboxed: false, remote: false } as const,
    );

    const first = getSessionDiff(
      "/virtual/diff",
      "main",
      exec,
      false,
      undefined,
      [],
      10,
    );
    await expect(first).rejects.toThrow("Git diff timed out");

    const timedOut = getSessionDiff(
      "/virtual/diff",
      "main",
      exec,
      false,
      undefined,
      [],
      10,
    );
    expect(timedOut).toBe(first);
    await expect(timedOut).rejects.toThrow("Git diff timed out");

    releaseFirst();
    await Bun.sleep(10);
    const replacement = getSessionDiff(
      "/virtual/diff",
      "main",
      exec,
      false,
      undefined,
      [],
      1000,
    );
    expect(replacement).not.toBe(first);
    await replacement;
  });
});
