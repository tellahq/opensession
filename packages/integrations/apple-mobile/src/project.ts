import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { loadConfig } from "./config";
import { findExecutable, runChecked } from "./exec";
import { resolveProjectDir } from "./security";

export async function gitSnapshot(projectDir: string): Promise<{
  commit: string;
  branch: string;
  clean: boolean;
  changes: string[];
}> {
  if (!findExecutable("git"))
    throw new Error("git is required for release plans");
  const cwd = resolveProjectDir(projectDir);
  const commit = (
    await runChecked({ executable: "git", args: ["rev-parse", "HEAD"], cwd })
  ).stdout.trim();
  const branch = (
    await runChecked({
      executable: "git",
      args: ["branch", "--show-current"],
      cwd,
    })
  ).stdout.trim();
  const status = (
    await runChecked({
      executable: "git",
      args: ["status", "--porcelain"],
      cwd,
    })
  ).stdout;
  const changes = status
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return { commit, branch, clean: changes.length === 0, changes };
}

export async function inspectProject(projectDirInput: string) {
  const projectDir = resolveProjectDir(projectDirInput);
  const loaded = await loadConfig(projectDir);
  let git: Awaited<ReturnType<typeof gitSnapshot>> | undefined;
  try {
    git = await gitSnapshot(projectDir);
  } catch {}
  return {
    projectDir,
    configPath: relative(projectDir, loaded.path),
    configHash: loaded.hash,
    config: loaded.config,
    git,
    files: {
      packageSwift: existsSync(join(projectDir, "Package.swift")),
      xtoolYml: existsSync(join(projectDir, "xtool.yml")),
    },
  };
}

export async function enforceReleasePolicy(projectDir: string) {
  const loaded = await loadConfig(projectDir);
  const git = await gitSnapshot(projectDir);
  if ((loaded.config.release?.requireClean ?? true) && !git.clean) {
    throw new Error(
      `Release requires a clean worktree; changes: ${git.changes.join(", ")}`,
    );
  }
  const allowed = loaded.config.release?.allowedBranches ?? ["main"];
  if (!allowed.includes(git.branch)) {
    throw new Error(
      `Branch ${git.branch || "<detached>"} is not release-enabled (${allowed.join(", ")})`,
    );
  }
  return { ...loaded, git };
}
