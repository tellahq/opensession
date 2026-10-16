import { lstat, mkdir, realpath } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { PersonalRepoGit } from "./personal-repo-runtime";

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
/** Reject redirects, do not repair existing directories or clobber data. */
async function directory(path: string): Promise<void> {
  let cursor: string = sep;
  for (const part of resolve(path).split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    try {
      await mkdir(cursor, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const info = await lstat(cursor);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error("Invalid personal checkout directory");
  }
}
async function existingDirectory(path: string): Promise<void> {
  let cursor: string = sep;
  for (const part of resolve(path).split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    const info = await lstat(cursor);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error("Invalid personal workspace directory");
  }
}
export interface PersonalGitCommand {
  args: string[];
  cwd?: string;
  env: Record<string, string>;
}
/** Injectable only at trusted application/test wiring, never from metadata. */
export type PersonalGitExecutor = (
  command: PersonalGitCommand,
) => Promise<string>;
export const executePersonalGit: PersonalGitExecutor = async ({
  args,
  cwd,
  env,
}) => {
  const child = Bun.spawn(["git", ...args], {
    cwd,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill(), 120_000);
  async function output(stream: ReadableStream<Uint8Array>, retain: boolean) {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        size += item.value.length;
        if (size > 2 * 1024 * 1024) {
          child.kill();
          throw new Error("Git output limit");
        }
        if (retain) chunks.push(item.value);
      }
      return retain ? Buffer.concat(chunks).toString("utf8") : "";
    } finally {
      reader.releaseLock();
    }
  }
  try {
    const [status, stdout] = await Promise.all([
      child.exited,
      output(child.stdout, true),
      output(child.stderr, false),
    ]);
    if (status !== 0) throw new Error("Personal Git operation failed");
    return stdout.trim();
  } finally {
    clearTimeout(timer);
  }
};

export function createPersonalRepoGit(
  execute: PersonalGitExecutor = executePersonalGit,
): PersonalRepoGit {
  async function run(
    args: string[],
    projected: Record<string, string>,
    cwd?: string,
  ) {
    const home = dirname(projected.GH_CONFIG_DIR!);
    await directory(home);
    // No ambient Git, SSH, gh, credential or process environment inheritance.
    return execute({
      args,
      cwd: cwd ?? home,
      env: {
        PATH: process.env.PATH || "/usr/bin:/bin",
        LANG: "C.UTF-8",
        HOME: home,
        ...projected,
      },
    });
  }
  async function locators(
    cwd: string,
    url: string,
    env: Record<string, string>,
  ) {
    // Effective includes/worktree config and rewrites, without network access.
    const config = (await run(["config", "--null", "--list"], env, cwd))
      .split("\0")
      .filter(Boolean)
      .map((entry) => {
        const split = entry.indexOf("\n");
        return split < 0
          ? ([entry, ""] as const)
          : ([entry.slice(0, split), entry.slice(split + 1)] as const);
      });
    const remotes = (await run(["remote"], env, cwd))
      .split("\n")
      .filter(Boolean);
    if (remotes.length > 64) throw new Error("Too many personal remotes");
    if (!remotes.includes("origin"))
      throw new Error("Personal checkout origin missing");
    for (const [key, value] of config) {
      if (/^remote\..*\.vcs$/i.test(key) && value)
        throw new Error("Personal transport override");
      if (/^remote\..*\.(url|pushurl)$/i.test(key) && value !== url)
        throw new Error("Invalid personal remote locator");
      if (/^url\..*\.(insteadof|pushinsteadof)$/i.test(key) && /\s/.test(key))
        throw new Error("Invalid personal URL rewrite");
      if (
        (/^branch\..*\.(remote|pushremote)$/i.test(key) ||
          /^remote\.pushdefault$/i.test(key)) &&
        !remotes.includes(value)
      )
        throw new Error("Personal branch remote mismatch");
    }
    // Raw URLs above also fence gh, which need not apply Git URL rewrites.
    // Named/default pushes need the same effective HTTPS provenance.
    for (const remote of remotes)
      for (const push of [false, true]) {
        const urls = (
          await run(
            ["remote", "get-url", ...(push ? ["--push"] : []), "--all", remote],
            env,
            cwd,
          )
        ).split("\n");
        if (!urls.length || urls.some((value) => value !== url))
          throw new Error("Personal checkout effective locator mismatch");
      }
  }
  async function validate(input: Parameters<PersonalRepoGit["validate"]>[0]) {
    const { repository, cwd, fullName, branch, env } = input;
    for (const path of [repository, join(repository, ".git"), cwd]) {
      await existingDirectory(path);
    }
    const common = await run(["rev-parse", "--git-common-dir"], env, cwd);
    if (
      (await realpath(resolve(cwd, common))) !==
        (await realpath(join(repository, ".git"))) ||
      (await realpath(
        await run(["rev-parse", "--show-toplevel"], env, cwd),
      )) !== (await realpath(cwd))
    )
      throw new Error("Personal worktree identity mismatch");
    // Detached HEAD and same-repository branch transitions remain legitimate.
    await run(["rev-parse", "--verify", "HEAD^{commit}"], env, cwd);
    const head = await run(["rev-parse", "--abbrev-ref", "HEAD"], env, cwd);
    if (branch !== undefined && head !== branch)
      throw new Error("Personal worktree branch mismatch");
    const url = `https://github.com/${fullName}.git`;
    await locators(repository, url, env);
    await locators(cwd, url, env);
  }
  return {
    validate,
    async defaultBranch(url, env) {
      const refs = await run(["ls-remote", "--symref", "--", url, "HEAD"], env);
      const match = /^ref: refs\/heads\/(.+)\tHEAD$/m.exec(refs);
      if (!match) throw new Error("Repository default branch unavailable");
      return match[1]!;
    },
    async prepare({ repo, cwd, branch, mode, env }) {
      await directory(dirname(repo.repo));
      await directory(dirname(cwd));
      const url = `https://github.com/${repo.ghRepo}.git`;
      if (!(await exists(repo.repo)))
        await run(["clone", "--no-checkout", "--", url, repo.repo], env);
      await directory(repo.repo);
      const origin = await run(
        ["config", "--get", "remote.origin.url"],
        env,
        repo.repo,
      );
      if (origin !== url) throw new Error("Personal checkout origin mismatch");
      await locators(repo.repo, url, env);
      if (await exists(cwd))
        await validate({
          repository: repo.repo,
          cwd,
          fullName: repo.ghRepo!,
          branch: mode === "code" ? branch : undefined,
          env,
        });
      await run(
        ["fetch", "--no-tags", "origin", "+refs/heads/*:refs/remotes/origin/*"],
        env,
        repo.repo,
      );
      if (await exists(cwd)) {
        await directory(cwd);
        const common = await run(["rev-parse", "--git-common-dir"], env, cwd);
        if (
          (await realpath(resolve(cwd, common))) !==
          (await realpath(join(repo.repo, ".git")))
        )
          throw new Error("Personal worktree identity mismatch");
        if (
          mode === "code" &&
          (await run(
            ["symbolic-ref", "--quiet", "--short", "HEAD"],
            env,
            cwd,
          )) !== branch
        )
          throw new Error("Personal worktree branch mismatch");
        return;
      }
      if (mode === "ask") {
        await run(
          [
            "worktree",
            "add",
            "--detach",
            cwd,
            `refs/remotes/origin/${repo.defaultBranch}`,
          ],
          env,
          repo.repo,
        );
        return;
      }
      const hasRef = async (ref: string) => {
        // Missing ref is the only tolerated Git failure in this discovery step;
        // rev-parse errors still cannot cause main-checkout/org credential fallback.
        try {
          await run(["show-ref", "--verify", "--quiet", ref], env, repo.repo);
          return true;
        } catch {
          return false;
        }
      };
      if (await hasRef(`refs/heads/${branch}`))
        await run(["worktree", "add", cwd, branch], env, repo.repo);
      else {
        const start = (await hasRef(`refs/remotes/origin/${branch}`))
          ? branch
          : repo.defaultBranch;
        await run(
          [
            "worktree",
            "add",
            "-b",
            branch,
            cwd,
            `refs/remotes/origin/${start}`,
          ],
          env,
          repo.repo,
        );
      }
    },
  };
}
