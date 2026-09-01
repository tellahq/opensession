/**
 * `opensession bind [address]` — move the server onto a different bind
 * address without re-running the onboarding wizard.
 *
 * The common case: a box onboarded before joining a tailnet. Onboard
 * defaulted to 127.0.0.1, `tailscale up` came later, and the only thing that
 * needs to change is where the listen socket opens. With no argument the
 * target is this box's tailnet address.
 *
 * The bind address is the one config value a live config re-read cannot
 * apply — the socket opens at boot — so this restarts the service too. It
 * even restarts when the config already matches but nothing answers on the
 * address, which is exactly the state a missed restart leaves behind.
 */

import { chmodSync, existsSync } from "fs";
import { backup, readConfig, tailnetIp, writeConfig } from "./config-edit";
import { CONFIG_PATH, ENV_PATH } from "./paths";
import * as service from "./service";
import { bold, dim, heading, info, ok, warn, wrote, yellow } from "./ui";

export async function responding(
  host: string,
  port: number,
  waitMs = 0,
  retryIntervalMs = 250,
): Promise<boolean> {
  const probeHost = host === "0.0.0.0" ? "127.0.0.1" : host;
  const deadline = Date.now() + waitMs;

  while (true) {
    try {
      const res = await fetch(`http://${probeHost}:${port}/api/health`, {
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) return true;
    } catch {
      // A supervisor can report a successful restart before the new process
      // has opened its socket. Keep probing during the startup grace period.
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return false;
    await Bun.sleep(Math.min(retryIntervalMs, remainingMs));
  }
}

export async function bind(address?: string): Promise<number> {
  const config = await readConfig();
  if (!config) {
    warn(`no config at ${CONFIG_PATH} — this box is not onboarded yet.`);
    info(`Run ${bold("opensession onboard")} first.`);
    return 1;
  }

  const target = address || tailnetIp();
  if (!target) {
    warn("no address given and this box is not on a tailnet.");
    info(
      `Join one first (${bold("sudo tailscale up")}) and re-run, or name an address:\n` +
        `  ${bold("opensession bind <ip>")}`,
    );
    return 1;
  }

  const server = (config.server ??= {}) as Record<string, unknown>;
  const oldHost = (server.host as string) || "127.0.0.1";
  const port = Number(server.port) || 3850;
  const newOrigin = `http://${target === "0.0.0.0" ? "127.0.0.1" : target}:${port}`;

  heading("Binding");
  if (oldHost === target) {
    info(`config already binds ${target}:${port} — nothing to rewrite.`);
  } else {
    server.host = target;
    // The public URL follows only while it points at the old bind address —
    // a reverse-proxied or custom-domain URL is a deliberate choice we keep.
    const oldOrigin = `http://${oldHost === "0.0.0.0" ? "127.0.0.1" : oldHost}:${port}`;
    const followUrl =
      !server.publicBaseUrl || server.publicBaseUrl === oldOrigin;
    if (followUrl) server.publicBaseUrl = newOrigin;
    await writeConfig(config);
    wrote(CONFIG_PATH, `host ${oldHost} -> ${target}`);

    // The env file overrides config.json (precedence env -> config -> default),
    // so a stale HOST there would silently undo the change.
    if (existsSync(ENV_PATH)) {
      const env = await Bun.file(ENV_PATH).text();
      let next = env.replace(/^HOST=.*$/m, `HOST=${target}`);
      if (followUrl) {
        next = next.replace(
          /^OPENSESSION_UI_BASE=.*$/m,
          `OPENSESSION_UI_BASE=${newOrigin}`,
        );
      }
      if (next !== env) {
        backup(ENV_PATH);
        await Bun.write(ENV_PATH, next);
        chmodSync(ENV_PATH, 0o600);
        wrote(ENV_PATH, `HOST=${target}`);
      }
    }
  }

  const publicUrl = String(server.publicBaseUrl || newOrigin);
  if (await service.isInstalled()) {
    if (oldHost === target && (await responding(target, port))) {
      ok(`already listening on ${target}:${port}`);
    } else {
      info(dim("restarting the service so the new bind takes effect ..."));
      if ((await service.control("restart")) !== 0) return 1;
      if (await responding(target, port, 15_000)) {
        ok(`listening on ${target}:${port}`);
      } else {
        warn(
          `nothing answering on ${target}:${port} yet`,
          "`opensession logs` to see why",
        );
        return 1;
      }
    }
  } else {
    info(
      dim(
        "no service installed — restart your foreground server to pick this up",
      ),
    );
  }

  info(`\n  Open ${bold(publicUrl)}`);
  if (target !== "127.0.0.1") {
    console.log(
      yellow(
        `\n  Reminder: Until GitHub authentication is set up, Open Session trusts\n` +
          `  everyone who can reach ${target}:${port}. Keep it on Tailscale or an\n` +
          `  equivalent private network. See docs/setup/README.md#trust-model.\n`,
      ),
    );
  }
  return 0;
}
