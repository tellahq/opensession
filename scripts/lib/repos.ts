/**
 * `opensession repos` — list and register the repositories sessions run in.
 *
 * `repos add` takes either a local checkout path or a GitHub `owner/name`.
 * The GitHub form is an operator bootstrap command and clones through the
 * operator's gh CLI login. Runtime sessions do not inherit that login: they
 * receive the selected App or connected-user credential process-locally.
 * Registration itself is a config.json edit and is live on the
 * next config re-read; no restart.
 */

import { existsSync } from "fs";
import { basename, isAbsolute, join, resolve } from "path";
import { readConfig, writeConfig } from "./config-edit";
import { CONFIG_PATH, HOME } from "./paths";
import {
  ask,
  bold,
  dim,
  fail,
  heading,
  info,
  ok,
  run,
  runInherit,
  warn,
  wrote,
} from "./ui";

type RepoEntry = {
  label?: string;
  repo?: string;
  wtPrefix?: string;
  defaultBranch?: string;
  ghRepo?: string;
  host?: "github" | "codestorage";
  csRepo?: string;
  default?: boolean;
};

async function detectBranch(dir: string): Promise<string> {
  const { code, stdout } = await run([
    "git",
    "-C",
    dir,
    "symbolic-ref",
    "--short",
    "HEAD",
  ]);
  return code === 0 && stdout ? stdout : "main";
}

/** `owner/name` from a github.com remote URL, in either ssh or https form. */
async function detectGhRepo(dir: string): Promise<string | undefined> {
  const { code, stdout } = await run([
    "git",
    "-C",
    dir,
    "remote",
    "get-url",
    "origin",
  ]);
  if (code !== 0) return undefined;
  const match = stdout.match(/github\.com[:/]([^/]+\/[^/\s]+?)(?:\.git)?$/);
  return match?.[1];
}

// https://<org>.code.storage/<repoId>(.git) — mirrors CS_REMOTE_RE in
// src/server/codestorage/remote.ts (kept local so the CLI stays server-free).
const CS_ORIGIN_RE =
  /^https:\/\/(?:t:[^@]*@)?([A-Za-z0-9][A-Za-z0-9-]*)\.code\.storage\/(.+?)(?:\.git)?\/?$/;

/** {org, repoId} from a code.storage remote URL, or undefined. */
async function detectCsRepo(
  dir: string,
): Promise<{ org: string; repoId: string } | undefined> {
  const { code, stdout } = await run([
    "git",
    "-C",
    dir,
    "remote",
    "get-url",
    "origin",
  ]);
  if (code !== 0) return undefined;
  const match = stdout.trim().match(CS_ORIGIN_RE);
  if (!match) return undefined;
  // An ephemeral remote (…/<repoId>+ephemeral.git) is the same repo's
  // disposable ref namespace — register against the base repo id.
  const repoId = match[2].replace(/\+ephemeral$/, "");
  return repoId ? { org: match[1], repoId } : undefined;
}

async function list(): Promise<number> {
  const config = await readConfig();
  if (!config) {
    warn(`no config at ${CONFIG_PATH}`, "run `opensession onboard` first");
    return 1;
  }
  heading("Repositories");
  const repos = (config.repos ?? {}) as Record<string, RepoEntry>;
  const ids = Object.keys(repos);
  if (!ids.length) {
    info(
      dim(
        `none registered — sessions need at least one: ${bold("opensession repos add")}`,
      ),
    );
    return 0;
  }
  for (const [id, entry] of Object.entries(repos)) {
    const details = [
      entry.repo,
      entry.host === "codestorage"
        ? entry.csRepo && `codestorage:${entry.csRepo}`
        : entry.ghRepo && `github:${entry.ghRepo}`,
      entry.defaultBranch,
    ]
      .filter(Boolean)
      .join("  ");
    ok(`${id}${entry.default ? " (default)" : ""}`, details);
  }
  return 0;
}

async function add(spec?: string): Promise<number> {
  const config = await readConfig();
  if (!config) {
    warn(`no config at ${CONFIG_PATH}`, "run `opensession onboard` first");
    return 1;
  }
  if (!spec) {
    fail("usage: opensession repos add <owner/name | path>");
    info(
      dim(
        "  owner/name clones from GitHub via gh; a path registers an existing checkout",
      ),
    );
    return 1;
  }

  const repos = (config.repos ??= {}) as Record<string, RepoEntry>;
  const isLocal =
    isAbsolute(spec) ||
    spec.startsWith(".") ||
    spec.startsWith("~") ||
    existsSync(resolve(spec));

  let checkout: string;
  let ghRepo: string | undefined;
  let csRepo: { org: string; repoId: string } | undefined;

  if (isLocal) {
    checkout = resolve(spec.replace(/^~(?=\/|$)/, HOME));
    if (!existsSync(join(checkout, ".git"))) {
      fail(`${checkout} is not a git checkout`);
      return 1;
    }
    ghRepo = await detectGhRepo(checkout);
    if (!ghRepo) csRepo = await detectCsRepo(checkout);
  } else if (/^[\w.-]+\/[\w.-]+$/.test(spec)) {
    heading(`Cloning ${spec}`);
    // gh (not raw git) so private repos work with whatever `gh auth login`
    // set up, and the failure mode for a signed-out box is instructive.
    const auth = await run(["gh", "auth", "status"]);
    if (auth.code !== 0) {
      fail(
        "gh is not signed in to GitHub",
        "run `gh auth login` for this bootstrap command",
      );
      info(
        dim(
          "  Or configure the GitHub App in Settings and add repositories from the UI.\n" +
            "  Runtime bot and session credentials never come from this gh login.",
        ),
      );
      return 1;
    }
    ghRepo = spec;
    checkout = ask("Clone to", join(HOME, "checkouts", spec.split("/")[1]));
    if (existsSync(join(checkout, ".git"))) {
      info(dim(`already cloned at ${checkout} — registering it`));
    } else if (
      (await runInherit(["gh", "repo", "clone", spec, checkout])) !== 0
    ) {
      fail(`could not clone ${spec}`);
      return 1;
    }
  } else {
    fail(`'${spec}' is neither an existing path nor an owner/name`);
    return 1;
  }

  const id = ask("Repo id", basename(checkout));
  if (repos[id]) {
    warn(
      `repo '${id}' is already registered`,
      "pick another id or edit config.json",
    );
    return 1;
  }

  const entry: RepoEntry = {
    label: ask("Label", id),
    repo: checkout,
    wtPrefix: id,
    defaultBranch: await detectBranch(checkout),
  };
  if (ghRepo) entry.ghRepo = ghRepo;
  if (csRepo) {
    entry.host = "codestorage";
    entry.csRepo = csRepo.repoId;
  }
  if (!Object.values(repos).some((r) => r.default)) entry.default = true;

  repos[id] = entry;
  await writeConfig(config);
  wrote(CONFIG_PATH, `+ repos.${id}`);
  info(dim("  live on the next config re-read — no restart needed"));
  if (csRepo) {
    info(
      dim(
        `  code.storage origin detected (org ${csRepo.org}) — branch-based reviews, no PRs;\n` +
          "  configure integrations.codestorage (org + privateKeyPath) so pushes can authenticate,\n" +
          "  see docs/setup/codestorage.md",
      ),
    );
  } else if (!ghRepo) {
    info(
      dim(
        "  no github.com or code.storage origin detected, so PR operations are off for this repo",
      ),
    );
  }
  return 0;
}

export async function repos(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (!sub) return await list();
  if (sub === "add") return await add(rest[0]);
  fail(
    `unknown subcommand '${sub}'`,
    "usage: opensession repos [add <owner/name | path>]",
  );
  return 1;
}
