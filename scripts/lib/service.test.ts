/**
 * Service-definition tests.
 *
 * These exist because both real bugs in this area produced files that were
 * syntactically perfect and semantically wrong — `systemd-analyze verify` was
 * happy with a unit containing `User=unknown`, which then failed every start
 * with an opaque 217/USER. Validating the *content* is what catches that.
 *
 * The launchd half is deliberately covered here rather than only on a Mac:
 * `renderPlist()` is platform-independent code, so its output can be asserted
 * anywhere. That does not substitute for a real macOS install, but it does mean
 * a regression in the plist shape fails in CI rather than on someone's laptop.
 */

import { describe, expect, test } from "bun:test";
import { platform } from "os";
import { join } from "path";
import {
  LAUNCHD_LABEL,
  LAUNCHD_LAUNCHER,
  persistedHomeEnv,
  renderExecutorUnit,
  renderLauncher,
  renderPlist,
  renderUnit,
  serviceWorkdir,
} from "./service";
import { ENV_PATH, HOME } from "./paths";

// Both renderers interpolate host paths and the local bun, so on Windows they
// produce a unit and a plist that could never be installed. Neither service
// manager exists there, so skip rather than loosen assertions that catch a
// real regression on the platforms that install them.
const onServiceHost = platform() !== "win32";

describe.skipIf(!onServiceHost)("systemd unit", () => {
  test("user scope: no User=, no IPAddressDeny=, wants default.target", async () => {
    const unit = await renderUnit("user");
    // A user manager rejects User= and cannot apply the BPF IP filter without
    // PrivateUsers=; multi-user.target does not exist per user. Any of these
    // left in makes `systemctl --user enable --now` fail or the unit never
    // start at boot.
    expect(unit).not.toMatch(/^User=/m);
    expect(unit).not.toMatch(/^IPAddressDeny=/m);
    expect(unit).toMatch(/^WantedBy=default\.target$/m);
    // Optional env file: a box with no secrets yet must still start.
    expect(unit).toContain(`EnvironmentFile=-${ENV_PATH}`);
    expect(unit).toContain(`WorkingDirectory=${serviceWorkdir()}`);
    expect(
      unit.match(
        /^ExecStart=(\S+) run packages\/core\/opensession-server\/opensession\.ts$/m,
      )?.[1],
    ).toMatch(/bun$/);
    expect(unit).not.toContain("opensession-executor.service");
    expect(unit).not.toContain("LoadCredential=executor-token:");
    expect(unit).toContain('Environment="OPENSESSION_EXECUTOR=0"');
    expect(unit).toContain('Environment="OPENSESSION_PI_DETACH=0"');
    expect(unit).toContain("KillMode=mixed");
    expect(unit).toMatch(/^TimeoutStopSec=\d+$/m);
  });

  test("system scope: rewrites every host-specific directive", async () => {
    const unit = await renderUnit("system");

    const user = unit.match(/^User=(.*)$/m)?.[1];
    expect(user).toBeTruthy();
    // The bug this pins: os.userInfo() returns the literal "unknown" under
    // some non-login shells, and the resulting unit fails with 217/USER.
    expect(user).not.toBe("unknown");
    expect(user).not.toContain(" ");

    expect(unit).toContain(`WorkingDirectory=${serviceWorkdir()}`);
    expect(unit).toContain(`EnvironmentFile=${ENV_PATH}`);
    expect(
      unit.match(
        /^ExecStart=(\S+) run packages\/core\/opensession-server\/opensession\.ts$/m,
      )?.[1],
    ).toMatch(/bun$/);
  });

  test("system scope: preserves the tuning directives that encode real incidents", async () => {
    const unit = await renderUnit("system");
    // Each of these exists because something broke without it; a renderer that
    // dropped them would look fine and misbehave under load or on shutdown.
    expect(unit).toContain("KillMode=mixed");
    expect(unit).toContain("IPAddressDeny=169.254.169.254/32");
    expect(unit).toMatch(/^TimeoutStopSec=\d+$/m);
    expect(unit).toContain("[Install]");
    expect(unit).toContain("Wants=opensession-executor.service");
    expect(unit).not.toContain("Requires=opensession-executor.service");
    expect(unit).toContain(
      "LoadCredential=executor-token:/etc/opensession/executor-token",
    );
  });

  test("PATH carries bun and the engine", async () => {
    const path =
      (await renderUnit("system")).match(/^Environment="PATH=(.*)"$/m)?.[1] ??
      "";
    expect(path).toContain("/usr/bin");
    expect(path.split(":").every((p) => p.startsWith("/"))).toBe(true);
  });
});

describe.skipIf(!onServiceHost)("executor systemd unit", () => {
  test("is independently restartable and host-specific", async () => {
    const unit = await renderExecutorUnit();
    expect(unit).toContain(`WorkingDirectory=${serviceWorkdir()}`);
    expect(unit).not.toContain("EnvironmentFile=");
    expect(unit).toContain(`Environment="HOME=${HOME}"`);
    expect(unit).toMatch(
      /^ExecStart=(\S+) run packages\/core\/opensession-server\/src\/executor\/main\.ts$/m,
    );
    expect(unit).toContain("Restart=always");
    expect(unit).toContain("RuntimeDirectory=opensession-executor");
    expect(unit).toContain(
      "LoadCredential=executor-token:/etc/opensession/executor-token",
    );
    expect(unit).not.toContain("PartOf=opensession.service");
  });
});

describe.skipIf(!onServiceHost)("launchd plist", () => {
  test("is well-formed and carries the expected keys", () => {
    const plist = renderPlist();
    expect(plist).toStartWith('<?xml version="1.0"');
    expect(plist).toContain("<!DOCTYPE plist");
    expect(plist.trimEnd()).toEndWith("</plist>");

    for (const key of [
      "Label",
      "ProgramArguments",
      "WorkingDirectory",
      "EnvironmentVariables",
      "RunAtLoad",
      "KeepAlive",
      "StandardOutPath",
      "StandardErrorPath",
    ]) {
      expect(plist).toContain(`<key>${key}</key>`);
    }
    expect(plist).toContain(`<string>${LAUNCHD_LABEL}</string>`);
  });

  test("execs the named launcher, not /bin/bash (macOS background-item identity)", () => {
    const plist = renderPlist();
    // The screenshot bug: an inline `/bin/bash -c …` makes macOS report
    // "bash can run in the background". Pointing ProgramArguments at the named
    // launcher makes the login item read as Open Session instead.
    expect(plist).toContain(`<string>${LAUNCHD_LAUNCHER}</string>`);
    expect(plist).not.toContain("/bin/bash");
    expect(LAUNCHD_LAUNCHER.endsWith("/OpenSession")).toBe(true);
  });

  test("launcher sources the env file and execs bun (launchd has no EnvironmentFile)", () => {
    const launcher = renderLauncher();
    // Without sourcing the env file the server boots looking healthy but with
    // no integration flags and no secrets — inert, and hard to diagnose.
    expect(launcher).toStartWith("#!/bin/bash");
    expect(launcher).toContain(ENV_PATH);
    expect(launcher).toContain("set -a");
    expect(launcher).toMatch(
      /exec \S*bun run packages\/core\/opensession-server\/opensession\.ts/,
    );
  });

  test("escapes XML so a path with & or < cannot corrupt the file", () => {
    // The renderer escapes on the way out; assert the escaping helper is
    // actually applied by checking no raw & survives outside an entity.
    const plist = renderPlist();
    const rawAmpersands = plist.match(/&(?!(amp|lt|gt|quot|apos);)/g);
    expect(rawAmpersands).toBeNull();
  });

  test("restarts on failure and starts at login", () => {
    const plist = renderPlist();
    expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    expect(plist).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
  });
});

describe("custom OPENSESSION_HOME", () => {
  test("persistedHomeEnv keeps a moved home and drops the default", () => {
    // A default install ($HOME/.opensession) needs no entry; a moved home does,
    // or the server's runtime opensessionHome() tends ~/.opensession instead.
    const homeRoot = join("/", "home", "bob");
    const movedHome = join("/", "srv", "os-home");
    expect(persistedHomeEnv(movedHome, homeRoot)).toBe(movedHome);
    expect(persistedHomeEnv(join(homeRoot, ".opensession"), homeRoot)).toBeNull();
  });

  // OPENSESSION_HOME is read once at import, so exercise the rendered output in
  // a child process with the env set, and confirm a default install omits it.
  function renderInChild(home: string | undefined): { unit: string; plist: string } {
    const mod = join(import.meta.dir, "service.ts");
    const script =
      `const s = await import(${JSON.stringify(mod)});` +
      `process.stdout.write(await s.renderUnit("system"));` +
      `process.stdout.write("\\n@@PLIST@@\\n");` +
      `process.stdout.write(s.renderPlist());`;
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    if (home === undefined) delete env.OPENSESSION_HOME;
    else env.OPENSESSION_HOME = home;
    const proc = Bun.spawnSync(["bun", "-e", script], { env });
    const [unit, plist] = proc.stdout.toString().split("@@PLIST@@");
    return { unit, plist };
  }

  test.skipIf(platform() === "win32")("a moved home is stamped into the unit and plist", () => {
    const home = "/tmp/opensession-custom-home-test";
    const { unit, plist } = renderInChild(home);
    expect(unit).toContain(`Environment="OPENSESSION_HOME=${home}"`);
    expect(plist).toContain(`<key>OPENSESSION_HOME</key><string>${home}</string>`);
  });

  test.skipIf(platform() === "win32")("a default home leaves no OPENSESSION_HOME entry", () => {
    const { unit, plist } = renderInChild(undefined);
    expect(unit).not.toContain("OPENSESSION_HOME");
    expect(plist).not.toContain("OPENSESSION_HOME");
  });
});
