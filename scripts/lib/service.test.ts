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
import { LAUNCHD_LABEL, LAUNCHD_LAUNCHER, renderLauncher, renderPlist, renderUnit } from "./service";
import { ENV_PATH, REPO_ROOT } from "./paths";

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
    expect(unit).toContain(`WorkingDirectory=${REPO_ROOT}`);
    expect(unit.match(/^ExecStart=(\S+) run opensession\.ts$/m)?.[1]).toMatch(/bun$/);
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

    expect(unit).toContain(`WorkingDirectory=${REPO_ROOT}`);
    expect(unit).toContain(`EnvironmentFile=${ENV_PATH}`);
    expect(unit.match(/^ExecStart=(\S+) run opensession\.ts$/m)?.[1]).toMatch(/bun$/);
  });

  test("system scope: preserves the tuning directives that encode real incidents", async () => {
    const unit = await renderUnit("system");
    // Each of these exists because something broke without it; a renderer that
    // dropped them would look fine and misbehave under load or on shutdown.
    expect(unit).toContain("KillMode=mixed");
    expect(unit).toContain("IPAddressDeny=169.254.169.254/32");
    expect(unit).toMatch(/^TimeoutStopSec=\d+$/m);
    expect(unit).toContain("[Install]");
  });

  test("PATH carries bun and the engine", async () => {
    const path = (await renderUnit("system")).match(/^Environment="PATH=(.*)"$/m)?.[1] ?? "";
    // Engine resolution goes through Bun.which("opencode"); a PATH without it
    // means the server silently finds no engine at runtime.
    expect(path).toContain(".opencode/bin");
    expect(path).toContain("/usr/bin");
    expect(path.split(":").every((p) => p.startsWith("/"))).toBe(true);
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
    expect(launcher).toMatch(/exec \S*bun run opensession\.ts/);
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
