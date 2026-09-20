import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, linkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { getSessionDiff, MAX_UNTRACKED_FILES } from "./git-diff";

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
  test("bounds binary-tree scans and lets the event loop run during local reads", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opensession-diff-media-"));
    dirs.push(dir);
    const source = join(dir, "source");
    writeFileSync(source, "\0" + "x".repeat(127));
    const names = Array.from(
      { length: MAX_UNTRACKED_FILES + 5 },
      (_, i) => `fragment-${i}.m4s`,
    );
    for (const name of names) linkSync(source, join(dir, name));
    let heartbeat = false;
    const exec = Object.assign(
      async (cmd: string[]) => {
        if (cmd.includes("ls-files")) {
          setTimeout(() => {
            heartbeat = true;
          }, 0);
          return { exitCode: 0, stdout: names.join("\0") + "\0", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      { sandboxed: false, remote: false } as const,
    );
    const result = await getSessionDiff(dir, "main", exec);
    expect(heartbeat).toBe(true);
    expect(result.files).toHaveLength(MAX_UNTRACKED_FILES);
    expect(result.files.every((file) => file.binary)).toBe(true);
    expect(result.rawPatch).toBe("");
    expect(result.truncated).toBe(true);
  });

  test("honors a small patch budget before reading the rest of an untracked tree", async () => {
    let reads = 0;
    const exec = Object.assign(
      async (cmd: string[]) => {
        const stdout = cmd.includes("ls-files")
          ? "first.txt\0second.txt\0"
          : cmd[0] === "stat"
            ? "100"
            : cmd[0] === "head"
              ? (++reads, "x".repeat(100))
              : "";
        return { exitCode: 0, stdout, stderr: "" };
      },
      { sandboxed: true, remote: true } as const,
    );
    const result = await getSessionDiff(
      "/virtual/patch-budget",
      "main",
      exec,
      false,
      120,
    );
    expect(reads).toBe(1);
    expect(result.rawPatch.length).toBeLessThanOrEqual(120);
    expect(result.truncated).toBe(true);
  });

  test("bounds cumulative content reads even when binary files add no patch", async () => {
    let reads = 0;
    const exec = Object.assign(
      async (cmd: string[]) => {
        const stdout = cmd.includes("ls-files")
          ? Array.from({ length: 100 }, (_, i) => `media-${i}`).join("\0") +
            "\0"
          : cmd[0] === "stat"
            ? "60000"
            : cmd[0] === "head"
              ? (++reads, "\0".repeat(60000))
              : "";
        return { exitCode: 0, stdout, stderr: "" };
      },
      { sandboxed: true, remote: true } as const,
    );
    const result = await getSessionDiff("/virtual/scan-budget", "main", exec);
    expect(reads).toBeLessThan(35);
    expect(result.truncated).toBe(true);
  });

  test("drops an incomplete path from a byte-capped untracked listing", async () => {
    const statPaths: string[] = [];
    const exec = Object.assign(
      async (cmd: string[]) => {
        let stdout = "";
        if (cmd.includes("ls-files"))
          stdout = "whole.txt\0" + "partial".repeat(150_000);
        if (cmd[0] === "stat") {
          statPaths.push(cmd.at(-1)!);
          stdout = "3";
        }
        if (cmd[0] === "head") stdout = "hi\n";
        return { exitCode: 0, stdout, stderr: "" };
      },
      { sandboxed: true, remote: true } as const,
    );
    const result = await getSessionDiff("/virtual/list-budget", "main", exec);
    expect(statPaths).toEqual(["whole.txt"]);
    expect(result.files.map((file) => file.path)).toEqual(["whole.txt"]);
    expect(result.truncated).toBe(true);
  });

  test("caps remote metadata calls even when every file is oversized", async () => {
    let stats = 0;
    const exec = Object.assign(
      async (cmd: string[]) => {
        let stdout = "";
        if (cmd.includes("ls-files"))
          stdout =
            Array.from(
              { length: MAX_UNTRACKED_FILES + 10 },
              (_, i) => `large-${i}`,
            ).join("\0") + "\0";
        if (cmd[0] === "stat") {
          stats++;
          stdout = "1000000";
        }
        expect(cmd[0]).not.toBe("head");
        return { exitCode: 0, stdout, stderr: "" };
      },
      { sandboxed: true, remote: true } as const,
    );
    const result = await getSessionDiff("/virtual/count-budget", "main", exec);
    expect(stats).toBe(MAX_UNTRACKED_FILES);
    expect(result.files).toHaveLength(MAX_UNTRACKED_FILES);
    expect(result.truncated).toBe(true);
  });

  test("a timed-out untracked scan does not continue issuing filesystem commands", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const commands: string[][] = [];
    const exec = Object.assign(
      async (cmd: string[]) => {
        commands.push(cmd);
        if (cmd[0] === "stat") await gate;
        return {
          exitCode: 0,
          stdout: cmd.includes("ls-files")
            ? "first\0second\0"
            : cmd[0] === "stat"
              ? "5"
              : "",
          stderr: "",
        };
      },
      { sandboxed: true, remote: true } as const,
    );
    const diff = getSessionDiff(
      "/virtual/cancel-scan",
      "main",
      exec,
      false,
      undefined,
      undefined,
      10,
    );
    await expect(diff).rejects.toThrow("Git diff timed out");
    const count = commands.length;
    expect(commands.at(-1)?.[0]).toBe("stat");
    release();
    await Bun.sleep(0);
    expect(commands).toHaveLength(count);
  });

  test("diff filesystem reads and discard never use synchronous I/O", async () => {
    const source = await Bun.file(
      new URL("./git-diff.ts", import.meta.url),
    ).text();
    expect(source).not.toMatch(/\b(?:readFile|read|stat|rm|open)Sync\b/);
  });
});
