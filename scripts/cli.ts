#!/usr/bin/env bun
/**
 * The `opensession` command.
 *
 * Reachable as `opensession` once install.sh has put the shim on PATH, and as
 * `bun run scripts/cli.ts` from a checkout. The surface mirrors what the
 * reference self-hosted tools (self-hosted tools, openclaw) expose, because that is the
 * bar this install experience is being measured against: onboard, update,
 * start/stop, doctor.
 *
 * Everything heavy lives in scripts/lib/ — this file is argument parsing and
 * dispatch, so `opensession --help` stays fast even on a box where nothing is
 * configured yet.
 */

import { existsSync } from "fs";
import { isCompiledBinary } from "../packages/core/opensession-server/src/runner-host/exe";
import { bind } from "./lib/bind";
import { doctor } from "./lib/doctor";
import { onboard } from "./lib/onboard";
import { repos } from "./lib/repos";
import { team } from "./lib/team";
import { ENV_PATH, REPO_ROOT } from "./lib/paths";
import * as service from "./lib/service";
import { update } from "./lib/update";
import {
  bold,
  dim,
  fail,
  green,
  heading,
  info,
  ok,
  run,
  runInherit,
  warn,
} from "./lib/ui";
import {
  INTEGRATIONS,
  findIntegration,
} from "../packages/core/opensession-server/src/server/integrations/registry";
import {
  findRecipe,
  installRecipe,
  installedKeys,
  listRecipes,
  removeRecipe,
} from "./lib/recipes";
import { plugins } from "./lib/plugins";
import {
  connect,
  installRunnerService,
  runnerRun,
  runnerStatus,
  runnersList,
  runnersPair,
  runnersRemove,
} from "./lib/connect";
import { sandbox } from "./lib/sandbox";
import { configuredServerUrl } from "./lib/server-url";

const argv = process.argv.slice(2);
const command = argv[0] ?? "help";
const flags = new Set(argv.filter((a) => a.startsWith("-")));
const positional = argv.slice(1).filter((a) => !a.startsWith("-"));

function flagValue(name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function usage(): void {
  console.log(`
${bold("opensession")} — self-hosted agent infrastructure

${bold("Setup")}
  onboard [--force]        configure this box (writes config + env + service)
                           --defaults: no questions, the installer's path
                           --org <name>: set up an org App + per-user sign-in
  bind [address]           move the server to a new bind address and restart
                           (no address: this box's tailnet IP)
  team [add|remove]        manage the identity roster (attribution, sign-in)
  repos [add <spec>]       register repositories; owner/name clones via gh
  doctor                   check tooling, config, integrations and the server
  service install          install and start the user service (--system: root unit)
  service uninstall        stop and remove it
  sandbox enable docker    install, configure and qualify local Docker
  sandbox test <provider>  re-run a connection qualification
  sandbox disable <provider> stop new use without deleting live sandboxes
  sandbox ingress install <https-origin> install an owned Caddy fragment

${bold("Running")}
  start [--foreground]     start the server
  stop                     stop the service
  restart                  restart the service
  status                   is it running?
  logs [-f] [-n N]         tail the service journal

${bold("Maintenance")}
  update [--channel <ref>] pull upstream (ff, or merge on a fork with local
         [--check]         commits), reinstall deps, health-gated restart;
                           --check shows what it would pull, changes nothing
         [--no-restart]    skip the restart
  integrations             list integrations and whether they are on
  integrations enable <id>
  integrations disable <id>
  automations              list bundled automation recipes
  automations add <id>     install one (takes effect on restart)
  automations remove <id>
  plugins                  list installed packages
  plugins add <owner/repo> review and install a package (a git repo with an
         [--users a,b]     opensession-plugin.json: feeds, automations,
         [--yes]           skills, MCP servers; never runtime code)
  plugins update <name>
  plugins remove <name>
  version

${bold("Runners")}           ${dim("trusted persistent machines for specialized work")}
  runners                  list attached Runners
  runners pair             mint a one-time pairing code
  runners remove <id>      revoke a Runner
  connect --server <url> --code <code>
                           attach THIS machine to a server
  runner run               stay attached (outbound control channel)
  runner service install   install the reconnecting user service
  runner status            is this machine attached?

Docs: docs/setup/README.md
`);
}

async function version(): Promise<number> {
  // A release install (binary or tarball) carries release.json; a source
  // checkout has package.json + a live git tree. Neither read may throw.
  const rel = await Bun.file(`${REPO_ROOT}/release.json`)
    .json()
    .catch(() => null as { version?: string; commit?: string } | null);
  if (rel?.version) {
    console.log(
      `opensession ${rel.version}${rel.commit ? ` (${rel.commit})` : ""}`,
    );
    console.log(dim(`  ${REPO_ROOT}`));
    return 0;
  }
  const pkg = await Bun.file(`${REPO_ROOT}/package.json`)
    .json()
    .catch(() => ({ version: "unknown" }) as { version?: string });
  const { stdout: sha } = await run(["git", "rev-parse", "--short", "HEAD"], {
    cwd: REPO_ROOT,
  });
  const { stdout: branch } = await run(
    ["git", "rev-parse", "--abbrev-ref", "HEAD"],
    {
      cwd: REPO_ROOT,
    },
  );
  console.log(`opensession ${pkg.version}${sha ? ` (${branch} ${sha})` : ""}`);
  console.log(dim(`  ${REPO_ROOT}`));
  return 0;
}

async function start(): Promise<number> {
  const publicUrl = await configuredServerUrl();
  if (
    flags.has("--foreground") ||
    flags.has("-f") ||
    !(await service.isInstalled())
  ) {
    info(dim(`starting in the foreground · ${REPO_ROOT}`));
    info(`Open ${bold(publicUrl)}`);
    // Compiled binary: re-exec ourselves as the server subcommand (there is no
    // `bun`/opensession.ts on disk). From source: run the entry under bun.
    const compiled = isCompiledBinary();
    const command = compiled
      ? [process.execPath, "server"]
      : ["bun", "run", "packages/core/opensession-server/opensession.ts"];
    const kernelCommand = compiled
      ? [process.execPath, "session-kernel-service"]
      : [
          "bun",
          "run",
          "packages/core/opensession-server/src/session-kernel-service.ts",
        ];
    const token = `${crypto.randomUUID()}${crypto.randomUUID()}`;
    const sharedEnv = { OPENSESSION_SESSION_KERNEL_TOKEN: token };
    const kernel = Bun.spawn(kernelCommand, {
      cwd: REPO_ROOT,
      env: {
        PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
        HOME: process.env.HOME || "",
        NODE_ENV: process.env.NODE_ENV || "production",
        ...(process.env.OPENSESSION_STATE_DIR
          ? { OPENSESSION_STATE_DIR: process.env.OPENSESSION_STATE_DIR }
          : {}),
        ...(process.env.OPENSESSION_SESSIONS_DIR
          ? { OPENSESSION_SESSIONS_DIR: process.env.OPENSESSION_SESSIONS_DIR }
          : {}),
        ...sharedEnv,
      },
      stdout: "inherit",
      stderr: "inherit",
    });
    try {
      return await runInherit(command, REPO_ROOT, sharedEnv);
    } finally {
      kernel.kill("SIGTERM");
      await kernel.exited;
    }
  }
  const code = await service.control("start");
  if (code === 0) info(`Open ${bold(publicUrl)}`);
  return code;
}

/**
 * The sandbox-local OIDC client intentionally has no server imports. Keeping
 * this small path in the normal CLI gives repository hooks the stable command
 * `opensession sandbox id-token …` without giving a sandbox admin commands.
 */
async function sandboxIdToken(): Promise<number> {
  return await runInherit(
    ["bun", `${REPO_ROOT}/scripts/workload-identity-client.ts`, ...argv],
    process.cwd(),
  );
}

async function status(): Promise<number> {
  heading("Status");
  const kind = service.supervisor();
  if (kind === "none") {
    info(dim("no service manager here"));
  } else if (!(await service.isInstalled())) {
    warn(`no ${kind} service installed`, "run `opensession service install`");
  } else {
    const state = await service.state();
    if (state === "active") ok(`${kind} service active`);
    else if (state === "inactive") fail(`${kind} service not running`);
    else warn(`could not query ${kind}`, "no permission or no session bus");
  }
  return 0;
}

/** Flip an ENABLE_* flag in the env file, creating the line if absent. */
async function setIntegration(id: string, on: boolean): Promise<number> {
  const spec = findIntegration(id);
  if (!spec) {
    fail(
      `unknown integration '${id}'`,
      `known: ${INTEGRATIONS.map((i) => i.id).join(", ")}`,
    );
    return 1;
  }
  if (!existsSync(ENV_PATH)) {
    fail(`no env file at ${ENV_PATH}`, "run `opensession onboard` first");
    return 1;
  }

  const text = await Bun.file(ENV_PATH).text();
  const line = `${spec.enableFlag}=${on}`;
  const pattern = new RegExp(`^${spec.enableFlag}=.*$`, "m");
  await Bun.write(
    ENV_PATH,
    pattern.test(text) ? text.replace(pattern, line) : `${text}\n${line}\n`,
  );

  ok(`${spec.label} ${on ? "enabled" : "disabled"}`, ENV_PATH);
  if (on) {
    const missing = spec.env.filter((e) => e.required);
    if (missing.length) {
      info(
        dim(
          `  needs: ${missing.map((m) => m.name).join(", ")} — see ${spec.doc}`,
        ),
      );
    }
  }
  warn("restart to apply", "opensession restart");
  return 0;
}

async function listIntegrations(): Promise<number> {
  const envText = existsSync(ENV_PATH) ? await Bun.file(ENV_PATH).text() : "";
  heading("Integrations");
  for (const spec of INTEGRATIONS) {
    if (spec.always) {
      info(`${dim("always")}  ${spec.label}`);
      continue;
    }
    const on = new RegExp(`^${spec.enableFlag}=true$`, "m").test(envText);
    info(
      `${on ? green("on ") : dim("off")}     ${spec.label}  ${dim(spec.id)}`,
    );
  }
  info(dim(`\n  opensession integrations enable <id>`));
  return 0;
}

/**
 * Bundled recipes are opt-in: installing one writes it into the config seed
 * list, and the server creates it (create-if-absent) on the next boot.
 */
async function listAutomations(): Promise<number> {
  const recipes = listRecipes();
  if (!recipes.length) {
    warn("no bundled recipes found", RECIPES_HINT);
    return 0;
  }
  const installed = await installedKeys();
  heading("Automation recipes");
  for (const recipe of recipes) {
    const key = recipe.automation.eventKey || recipe.automation.name;
    const mark = installed.has(key) ? green("added") : dim("  -  ");
    info(`${mark}  ${recipe.id.padEnd(24)} ${dim(recipe.description)}`);
    if (recipe.requires?.length) {
      info(
        `         ${dim(`needs the ${recipe.requires.join(", ")} integration`)}`,
      );
    }
  }
  info(dim("\n  opensession automations add <id>"));
  return 0;
}

async function addAutomation(id: string): Promise<number> {
  const recipe = findRecipe(id);
  if (!recipe) {
    fail(
      `unknown recipe '${id}'`,
      `known: ${listRecipes()
        .map((r) => r.id)
        .join(", ")}`,
    );
    return 1;
  }
  const result = await installRecipe(recipe);
  if (result === "already-present") {
    info(dim(`${recipe.id} is already installed`));
    return 0;
  }
  ok(`added ${recipe.label}`, "disabled until you enable it in the UI");
  if (recipe.requires?.length) {
    info(
      dim(
        `  needs: ${recipe.requires.join(", ")} — opensession integrations enable <id>`,
      ),
    );
  }
  if (recipe.notes) info(dim(`  ${recipe.notes}`));
  warn("restart to create it", "opensession restart");
  return 0;
}

async function removeAutomation(id: string): Promise<number> {
  const recipe = findRecipe(id);
  if (!recipe) {
    fail(`unknown recipe '${id}'`);
    return 1;
  }
  if (!(await removeRecipe(recipe))) {
    info(dim(`${recipe.id} was not in the seed list`));
    return 0;
  }
  ok(`removed ${recipe.label} from the seed list`);
  // Seeding is create-if-absent, so an already-created automation stays put.
  info(
    dim(
      "  an automation already created from it is untouched — delete it in the UI",
    ),
  );
  return 0;
}

const RECIPES_HINT = "expected them in recipes/automations/";

async function main(): Promise<number> {
  switch (command) {
    case "onboard":
    case "setup":
      return await onboard({
        force: flags.has("--force"),
        defaults: flags.has("--defaults"),
        org: flagValue("--org"),
      });

    case "bind":
      return await bind(positional[0]);

    case "team":
      return await team(positional);

    case "repos":
      return await repos(positional);

    case "doctor":
      return await doctor();

    case "sandbox":
      if (argv[1] === "id-token") return await sandboxIdToken();
      return await sandbox(positional);

    case "start":
      return await start();
    case "stop":
      return await service.control("stop");
    case "restart":
      return await service.control("restart");
    case "status":
      return await status();

    case "logs":
      return await service.logs(
        flags.has("-f") || flags.has("--follow"),
        Number(flagValue("-n") ?? flagValue("--lines") ?? 100),
      );

    case "service":
      if (positional[0] === "install") {
        const installed = await service.install({
          scope: flags.has("--system") ? "system" : "user",
        });
        if (!installed) return 1;
        info(`Open ${bold(await configuredServerUrl())}`);
        return 0;
      }
      if (positional[0] === "uninstall")
        return (await service.uninstall()) ? 0 : 1;
      fail("usage: opensession service install [--system] | uninstall");
      return 1;

    case "update":
      return await update({
        channel: flagValue("--channel"),
        check: flags.has("--check"),
        restart: !flags.has("--no-restart"),
      });

    case "integrations":
      if (positional[0] === "enable")
        return await setIntegration(positional[1] ?? "", true);
      if (positional[0] === "disable")
        return await setIntegration(positional[1] ?? "", false);
      return await listIntegrations();

    case "automations":
      if (positional[0] === "add")
        return await addAutomation(positional[1] ?? "");
      if (positional[0] === "remove")
        return await removeAutomation(positional[1] ?? "");
      return await listAutomations();

    case "plugins":
    case "packages":
      return await plugins(positional, {
        yes: flags.has("--yes") || flags.has("-y"),
        users: flagValue("--users"),
      });

    case "connect":
      return await connect({
        server: flagValue("--server"),
        code: flagValue("--code"),
        name: flagValue("--name"),
        label: flagValue("--label"),
      });

    case "runner":
      if (positional[0] === "run") return await runnerRun();
      if (positional[0] === "service" && positional[1] === "install") {
        if (await installRunnerService()) return 0;
        info(
          dim(
            "  run `opensession runner run` in the foreground to hold the channel open meanwhile",
          ),
        );
        return 1;
      }
      if (positional[0] === "status" || !positional[0])
        return await runnerStatus();
      // The pairing UI and docs both say `opensession runner connect`; keep
      // that spelling working alongside the top-level `connect`.
      if (positional[0] === "connect")
        return await connect({
          server: flagValue("--server"),
          code: flagValue("--code"),
          name: flagValue("--name"),
          label: flagValue("--label"),
        });
      fail("usage: opensession runner run|status|connect|service install");
      return 1;

    case "runners":
      if (positional[0] === "pair") return await runnersPair();
      if (positional[0] === "remove")
        return await runnersRemove(positional[1] ?? "");
      return await runnersList();

    // First-party stdio MCP entry point. Keeping it behind the installed
    // command gives Connections a stable target across release worktrees.
    case "apple-mobile-mcp": {
      const { startAppleMobileServer } =
        await import("../packages/integrations/apple-mobile/src/server");
      await startAppleMobileServer(argv.slice(1));
      await new Promise<never>(() => {});
    }

    // Internal git credential-helper entrypoint. It stays out of --help, but is
    // routed through the installed command so compiled releases need no Bun or
    // source-tree sidecar.
    case "github-credential": {
      const { githubCredentialHelper } =
        await import("./lib/github-credential");
      return await githubCredentialHelper(positional[0]);
    }

    case "version":
    case "--version":
    case "-v":
      return await version();

    case "help":
    case "--help":
    case "-h":
      usage();
      return 0;

    default:
      fail(`unknown command '${command}'`);
      usage();
      return 1;
  }
}

process.exit(await main());
