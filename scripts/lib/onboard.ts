/**
 * `opensession onboard` — first-run configuration.
 *
 * Writes the two files the server actually reads (`config.json` and the env
 * file) plus a systemd unit templated for this box, and can install the
 * service. Safe to re-run: existing files are backed up to `.bak-<n>` and an
 * existing config needs explicit confirmation.
 *
 * The load-bearing part is the env file. Integration flags default OFF and
 * only the literal string "true" enables them, so anything unrecognised means
 * off. Onboarding writes an explicit value for every integration rather than
 * leaning on that, so the file says what is running instead of implying it.
 */

import { chmodSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { INTEGRATIONS } from "../../src/server/integrations/registry";
import { configPath as engineConfigPath, setBridgeEnabled } from "../../src/server/opencode-config";
import { backup, tailnetIp } from "./config-edit";
import { CONFIG_PATH, ENV_PATH, HOME, OPENSESSION_HOME, REPO_ROOT } from "./paths";

/** Where a release install keeps its first, throwaway repo. */
const SCRATCH_REPO = join(OPENSESSION_HOME, "scratch");

/**
 * Create the scratch repo when it does not exist: `git init`, a README, one
 * commit on main. Sessions need a repo with at least one commit to cut a
 * worktree from; an empty directory fails at `git worktree add`.
 */
function ensureScratchRepo(): void {
  if (existsSync(join(SCRATCH_REPO, ".git"))) return;
  mkdirSync(SCRATCH_REPO, { recursive: true });
  const git = (...args: string[]) => {
    const r = Bun.spawnSync(["git", "-C", SCRATCH_REPO, ...args], { stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr.toString().trim()}`);
  };
  git("init", "-q", "-b", "main");
  git("config", "user.email", "opensession@localhost");
  git("config", "user.name", "Open Session");
  writeFileSync(
    join(SCRATCH_REPO, "README.md"),
    "# Scratch\n\nA throwaway repo for trying Open Session. Register your own under Settings → Repositories.\n",
  );
  git("add", "README.md");
  git("commit", "-q", "-m", "Scratch repo for a first session");
  info(dim(`  created a scratch repo at ${SCRATCH_REPO}`));
}
import { installRecipe, listRecipes } from "./recipes";
import * as service from "./service";
import { ask, askYesNo, bold, canPrompt, dim, heading, info, warn, wrote, yellow } from "./ui";

export type OnboardOptions = {
  force?: boolean;
  /** Write every default and ask nothing (the installer's default path). */
  defaults?: boolean;
};

/** "Open Session" -> "OS". Falls back to the first two characters. */
function deriveMark(name: string): string {
  const caps = name.replace(/[^A-Z]/g, "");
  return caps.length >= 2 ? caps.slice(0, 2) : name.slice(0, 2).toUpperCase();
}

type Answers = {
  productName: string;
  host: string;
  port: number;
  publicBaseUrl: string;
  repoId: string;
  repoPath: string;
  repoBranch: string;
  /** "owner/name", detected from the checkout's origin. */
  repoGhRepo?: string;
  worktreesDir: string;
  enabled: string[];
};

function collect(): Answers {
  heading("Instance configuration");
  info(
    dim(
      "Every field is optional; precedence is env var -> config.json -> built-in\n" +
        "  default. config.json is re-read on change; only the bind address needs a\n" +
        "  restart, and `opensession bind` handles that one on its own.",
    ),
  );

  const productName = ask("Product name", "Open Session");

  // Defaulting to the tailnet address when there is one is the whole point of
  // installing Tailscale up front: the alternative default, 127.0.0.1, works
  // until someone else needs to reach it and then gets "fixed" with 0.0.0.0.
  // Loopback is the default, always. Offering the tailnet address as the bind
  // default only makes sense when a person is there to weigh sharing against
  // exposure; on the defaults path (`--defaults`, no prompt) picking it up
  // silently would put the UI on the tailnet — and on macOS trip the "accept
  // incoming connections" firewall prompt — on a box the installer was told to
  // keep simple. So only prefer the tailnet address when we can actually ask.
  const tailnet = canPrompt() ? tailnetIp() : undefined;
  const host = tailnet
    ? ask(`Bind address (${tailnet} is this box's tailnet address)`, tailnet)
    : ask("Bind address (a Tailscale IP shares it with your team)", "127.0.0.1");
  const port = Number(ask("Port", "3850")) || 3850;
  const publicBaseUrl = ask(
    "Public base URL",
    `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`,
  );

  heading("Your first repository");
  info(dim("Sessions run in git worktrees cut from the repos you register here."));
  // A source checkout can be its own first repo. A release install has no
  // .git under REPO_ROOT, so offer a scratch repo instead: a real git repo
  // with one commit, enough for a first session to get a worktree and run.
  const selfIsRepo = existsSync(join(REPO_ROOT, ".git"));
  const defaultRepoPath = selfIsRepo ? REPO_ROOT : SCRATCH_REPO;
  const repoPath = ask("Repo checkout path", defaultRepoPath);
  if (repoPath === SCRATCH_REPO) ensureScratchRepo();
  const repoId = ask(
    "Repo id",
    repoPath === REPO_ROOT ? "opensession" : repoPath === SCRATCH_REPO ? "scratch" : repoPath.split("/").pop() || "app",
  );
  const repoBranch = ask("Default branch", "main");
  // Same default the server falls back to when `paths.worktreesDir` is unset
  // (config.ts) and the one the docs quote — offering ~/worktrees here meant a
  // wizard-written config silently disagreed with both.
  const worktreesDir = ask("Worktrees directory", join(OPENSESSION_HOME, "worktrees"));

  heading("Integrations");
  info(
    dim(
      "All optional, all off by default. Each needs credentials before it will do\n" +
        "  anything — turn them on later with `opensession integrations enable <id>`.",
    ),
  );
  const enabled: string[] = [];
  if (canPrompt()) {
    // `always` modules self-gate and ignore their flag entirely — asking about
    // them offers a choice that does nothing.
    for (const integration of INTEGRATIONS.filter((i) => !i.always)) {
      if (askYesNo(`Enable ${integration.label}?`, false)) enabled.push(integration.id);
    }
  }

  return {
    productName,
    host,
    port,
    publicBaseUrl,
    repoId,
    repoPath,
    repoBranch,
    repoGhRepo: detectGhRepo(repoPath),
    worktreesDir,
    enabled,
  };
}

/**
 * "owner/name" from the checkout's origin remote. Without it a repo has no
 * `gh` target, so every PR feature is silently off — which is what the wizard
 * used to produce for the very first repo an operator registers (`repos add`
 * has always detected it).
 */
function detectGhRepo(dir: string): string | undefined {
  try {
    const { stdout, exitCode } = Bun.spawnSync(["git", "-C", dir, "remote", "get-url", "origin"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (exitCode !== 0) return undefined;
    return stdout
      .toString()
      .trim()
      .match(/github\.com[:/]([^/]+\/[^/\s]+?)(?:\.git)?$/)?.[1];
  } catch {
    return undefined;
  }
}

function buildConfig(a: Answers): Record<string, unknown> {
  return {
    server: {
      host: a.host,
      port: a.port,
      webhookPort: 3848,
      publicBaseUrl: a.publicBaseUrl,
    },
    paths: {
      worktreesDir: a.worktreesDir,
      mcpConfig: join(REPO_ROOT, "mcp-config.json"),
    },
    branding: {
      productName: a.productName,
      productMark: deriveMark(a.productName),
    },
    repos: {
      [a.repoId]: {
        // The self checkout carries the product's name; anything else is
        // labelled by what it is, so a scratch repo does not show up in the UI
        // as "Open Session".
        label: a.repoId === "scratch" ? "Scratch" : a.repoPath === REPO_ROOT ? a.productName : a.repoId,
        repo: a.repoPath,
        wtPrefix: a.repoId,
        defaultBranch: a.repoBranch,
        ...(a.repoGhRepo ? { ghRepo: a.repoGhRepo } : {}),
        default: true,
      },
    },
    integrations: Object.fromEntries(
      INTEGRATIONS.filter((i) => !i.always).map((i) => [
        i.id,
        { enabled: a.enabled.includes(i.id) },
      ]),
    ),
    // Populate with teammates to enable commit attribution, per-user MCP
    // `allowedUsers` gating and human-ask routing. An empty roster makes every
    // identity-dependent feature a no-op.
    identity: { team: [] },
  };
}

function buildEnv(a: Answers): string {
  const lines = [
    "# Open Session environment and secrets.",
    "# Loaded by the systemd unit (EnvironmentFile) and by Bun for manual runs.",
    "# Generated by `opensession onboard`.",
    "",
    "# --- core server ---",
    `HOST=${a.host}`,
    `PORT=${a.port}`,
    "WEBHOOK_PORT=3848",
    `OPENSESSION_UI_BASE=${a.publicBaseUrl}`,
    `OPENSESSION_WORKTREES_DIR=${a.worktreesDir}`,
    "",
    "# --- integrations ---",
    "# Flags default OFF in code and only the literal string `true` enables them,",
    "# so every integration is written explicitly here. Enable one only once its",
    "# credentials are filled in below.",
  ];

  for (const integration of INTEGRATIONS.filter((i) => !i.always)) {
    const on = a.enabled.includes(integration.id);
    lines.push("", `# ${integration.label} — ${integration.doc}`);
    lines.push(`${integration.enableFlag}=${on}`);
    for (const secret of integration.env) {
      lines.push(`${on ? "" : "# "}${secret.name}=${secret.example ?? ""}`);
    }
  }

  lines.push(
    "",
    "# Agent subprocesses do NOT inherit this file: runs get a minimal env",
    "# (PATH, HOME, LANG, OPENSESSION_MODEL) by design, and MCP servers carry",
    "# their own credentials.",
    "",
  );

  return lines.join("\n");
}

export async function onboard(opts: OnboardOptions = {}): Promise<number> {
  // Defaults mode is the same wizard with every prompt answered by its
  // fallback: one code path, and the answers are exactly what `--advanced`
  // shows as the suggested value.
  if (opts.defaults) {
    process.env.NO_PROMPT = "1";
    info(dim("writing defaults (127.0.0.1:3850, scratch repo, no integrations); `opensession onboard --force` to change them"));
  }
  // Re-running against a live install would replace a working config with
  // defaults. Backups make that recoverable, not harmless.
  if (existsSync(CONFIG_PATH) && !opts.force) {
    warn(`${CONFIG_PATH} already exists — this box is already onboarded.`);
    info(
      dim(
        `Smaller changes have their own commands: ${bold("opensession bind")} (move to the\n` +
          `  tailnet IP), ${bold("opensession team add")}, ${bold("opensession repos add")}.`,
      ),
    );
    if (!canPrompt()) {
      info(`Re-run with ${bold("--force")} to overwrite it (the old file is backed up first).`);
      return 1;
    }
    if (!askYesNo("Overwrite it? The current file is backed up first.", false)) {
      info(dim("Left untouched. Nothing written."));
      return 0;
    }
  }

  const answers = collect();

  heading("Writing configuration");
  mkdirSync(OPENSESSION_HOME, { recursive: true });
  mkdirSync(answers.worktreesDir, { recursive: true });

  // 0600 on both: config.json carries the team identity table (emails, Slack
  // ids, GitHub logins), not just ports.
  for (const [path, contents] of [
    [CONFIG_PATH, JSON.stringify(buildConfig(answers), null, 2) + "\n"],
    [ENV_PATH, buildEnv(answers)],
  ] as const) {
    const backedUp = backup(path);
    await Bun.write(path, contents);
    chmodSync(path, 0o600);
    wrote(path, backedUp ? `(backed up to ${backedUp})` : undefined);
  }

  // Engine on. This flag gates the Anthropic bridge and whether third-party
  // provider models reach the picker, and nothing used to write it: a fresh
  // install booted "healthy" and then failed its first turn pointing at a file
  // no code path created. Only seeded when absent — an operator who turned the
  // engine off deliberately keeps that choice through a re-run.
  if (!existsSync(engineConfigPath())) {
    setBridgeEnabled(true);
    wrote(engineConfigPath(), "(engine enabled)");
  }

  // Offered after the config exists, since installing one appends to it.
  // A fresh install otherwise boots healthy and does nothing, which gives a new
  // operator no sense of what this is for.
  const recommended = listRecipes().filter((r) => r.recommended);
  if (recommended.length && canPrompt()) {
    heading("Suggested automations");
    info(dim("Off by default; you enable them in the UI once you have looked at them."));
    for (const recipe of recommended) {
      info(dim(`  ${recipe.description}`));
      if (askYesNo(`Add ${recipe.label}?`, false)) {
        await installRecipe(recipe);
        wrote(CONFIG_PATH, `+ ${recipe.id}`);
      }
    }
    info(dim("\n  More: `opensession automations`"));
  }

  // Both supervisors run per-user, without root, so installing is the default
  // answer: an install that ends without a running server is the single most
  // common way a first run stalls. `--system` on `service install` is the
  // operator path for a root unit.
  let serviceUp = false;
  try {
    const kind = service.supervisor();
    if (kind !== "none") {
      const what = kind === "launchd" ? "LaunchAgent" : "user service";
      if (askYesNo(`\n  Install and start it as a ${what} now?`, true)) {
        serviceUp = await service.install();
      }
    }
  } catch (err) {
    warn(`could not install the service: ${(err as Error).message}`);
  }

  // Self-development needs a writable origin: sessions on the self repo commit
  // and push to it, and deploy_self fast-forwards from origin/main. A checkout
  // cloned straight from the upstream project can't push there, and after the
  // first local commit ff-only deploys abort forever. Warn now, at setup time,
  // instead of letting the first self-session discover it via a 403.
  try {
    const originUrl = Bun.spawnSync(["git", "remote", "get-url", "origin"], {
      cwd: REPO_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    })
      .stdout.toString()
      .trim();
    if (/github\.com[/:]tellahq\/opensession(\.git)?$/.test(originUrl)) {
      console.log(
        yellow(
          `\n  This checkout's origin is the upstream project (${originUrl}).\n` +
            `  Fine for running it — but self-development sessions push to origin,\n` +
            `  which you can't write to. To let the agent modify Open Session itself,\n` +
            `  fork it, point origin at your fork, and keep upstream for updates:\n` +
            `    git remote rename origin upstream\n` +
            `    git remote add origin git@github.com:<you>/opensession.git\n` +
            `  See docs/self-development.md.\n`,
        ),
      );
    }
  } catch {}

  heading("Next steps");
  if (serviceUp) {
    // The URL is the deliverable of an install; wait for it to actually answer
    // rather than printing an address that 404s for the next thirty seconds.
    const healthy = await service.waitHealthy(answers.publicBaseUrl);
    if (healthy) info(`1. ${bold(`open ${answers.publicBaseUrl}`)}`);
    else info(`1. ${bold(`open ${answers.publicBaseUrl}`)}   ${dim("(still starting; `opensession logs` if it does not come up)")}`);
    info(`2. ${bold("opensession doctor")}     check everything is wired up`);
  } else {
    info(`1. ${bold("opensession start")}      start the server`);
    info(`2. ${bold("opensession doctor")}     check everything is wired up`);
    info(`   ${dim(`then open ${answers.publicBaseUrl}`)}`);
  }
  // The engine is the only step that can't be skipped: without model capacity
  // every session fails its first turn. Name the subscription path first —
  // it's what the default model uses — with the API-key route as the alternative.
  info(`3. ${bold("add model capacity")}     Workspace → Usage: paste a`);
  info(`   ${dim("`claude setup-token` token, or sign in to ChatGPT by device code.")}`);
  info(`   ${dim("Using API keys instead? `opencode auth login`, or Workspace → Models.")}`);
  info(`4. ${bold("create a session")}       a completed turn is the real proof`);
  info(`5. ${bold("opensession team add")}   put yourself on the roster (attribution, sign-in)`);
  if (answers.enabled.length) {
    info(`6. ${dim(`add credentials for ${answers.enabled.join(", ")} in ${ENV_PATH}`)}`);
  }

  console.log(
    yellow(
      `\n  Open Session has no built-in authentication. It trusts everyone who can\n` +
        `  reach ${answers.host}:${answers.port} — keep it on Tailscale or an equivalent private\n` +
        `  network. See docs/setup/README.md#trust-model.\n`,
    ),
  );

  return 0;
}
