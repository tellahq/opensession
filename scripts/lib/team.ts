/**
 * `opensession team` — manage the identity roster (`identity.team` in
 * config.json) without hand-editing JSON.
 *
 * An empty roster silently no-ops every identity-dependent feature: commit
 * attribution, the people directory and pickers, per-user MCP `allowedUsers`
 * gating, human-ask routing, and GitHub web sign-in (only logins on the team
 * may sign in). A fresh install hits that as "why does nothing know who I
 * am", so doctor and onboard both point here.
 */

import { readConfig, writeConfig } from "./config-edit";
import { CONFIG_PATH } from "./paths";
import {
  ask,
  bold,
  canPrompt,
  dim,
  fail,
  heading,
  info,
  ok,
  warn,
  wrote,
} from "./ui";

type Member = {
  name: string;
  email?: string;
  github?: string;
  slackId?: string;
  aliases?: string[];
};

function roster(config: Record<string, any>): Member[] {
  const identity = (config.identity ??= {});
  return (identity.team ??= []) as Member[];
}

async function list(): Promise<number> {
  const config = await readConfig();
  if (!config) {
    warn(`no config at ${CONFIG_PATH}`, "run `opensession onboard` first");
    return 1;
  }
  heading("Team");
  const team = roster(config);
  if (!team.length) {
    info(
      dim("nobody yet — attribution, pickers and sign-in are all no-ops until"),
    );
    info(
      dim(
        `someone is on the roster. Add yourself: ${bold("opensession team add")}`,
      ),
    );
    return 0;
  }
  for (const m of team) {
    const details = [
      m.email,
      m.github && `gh:${m.github}`,
      m.slackId && `slack:${m.slackId}`,
    ]
      .filter(Boolean)
      .join("  ");
    ok(m.name, details || undefined);
  }
  return 0;
}

async function add(nameArg?: string): Promise<number> {
  const config = await readConfig();
  if (!config) {
    warn(`no config at ${CONFIG_PATH}`, "run `opensession onboard` first");
    return 1;
  }
  if (!nameArg && !canPrompt()) {
    fail("usage: opensession team add <name>", "no terminal to prompt from");
    return 1;
  }

  heading("Add a team member");
  const name = nameArg || ask("Full name (also the git author name)", "");
  if (!name) {
    fail("a name is required");
    return 1;
  }

  const team = roster(config);
  const clash = team.find((m) => m.name.toLowerCase() === name.toLowerCase());
  if (clash) {
    warn(
      `'${clash.name}' is already on the roster`,
      "edit them in config.json",
    );
    return 1;
  }

  const member: Member = { name };
  const email = ask("Email (git commit attribution)", "");
  if (email) member.email = email;
  const github = ask("GitHub login (sign-in, PR ownership)", "");
  if (github) member.github = github;
  const slackId = ask("Slack member id (e.g. U0123456789)", "");
  if (slackId) member.slackId = slackId;
  const alias = ask(
    "Short alias (picker name, e.g. their first name)",
    "",
  ).toLowerCase();
  if (alias && alias !== name.toLowerCase()) member.aliases = [alias];

  team.push(member);
  await writeConfig(config);
  wrote(CONFIG_PATH, `+ ${name}`);
  info(dim("  live on the next config re-read — no restart needed"));

  // Sign-in only works once the GitHub App side exists; say so at the moment
  // someone sets a login expecting it to.
  const github_ = (config.integrations ?? {}).github as
    | Record<string, unknown>
    | undefined;
  if (
    member.github &&
    !github_?.oauthClientId &&
    !process.env.OPENSESSION_GITHUB_CLIENT_ID
  ) {
    info(
      dim(
        `\n  A GitHub login unlocks web sign-in and PRs authored as ${name} once\n` +
          `  per-user GitHub auth is set up (a GitHub App + integrations.github in\n` +
          `  config.json) — see docs/setup/github.md, "Per-user GitHub auth".`,
      ),
    );
  }
  return 0;
}

async function remove(nameArg?: string): Promise<number> {
  const config = await readConfig();
  if (!config) {
    warn(`no config at ${CONFIG_PATH}`, "run `opensession onboard` first");
    return 1;
  }
  if (!nameArg) {
    fail("usage: opensession team remove <name>");
    return 1;
  }
  const team = roster(config);
  const needle = nameArg.toLowerCase();
  const index = team.findIndex(
    (m) =>
      m.name.toLowerCase() === needle ||
      m.github?.toLowerCase() === needle ||
      m.aliases?.includes(needle),
  );
  if (index < 0) {
    fail(
      `nobody called '${nameArg}' on the roster`,
      "`opensession team` to list",
    );
    return 1;
  }
  const [gone] = team.splice(index, 1);
  await writeConfig(config);
  wrote(CONFIG_PATH, `- ${gone.name}`);
  return 0;
}

export async function team(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (!sub) return await list();
  if (sub === "add") return await add(rest.join(" ") || undefined);
  if (sub === "remove") return await remove(rest.join(" ") || undefined);
  fail(
    `unknown subcommand '${sub}'`,
    "usage: opensession team [add [name] | remove <name>]",
  );
  return 1;
}
