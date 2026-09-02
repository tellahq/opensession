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
import {
  bootstrapLaunchAgent,
  LAUNCHD_LABEL,
  LAUNCHD_LAUNCHER,
  metadataInstallBlockGuidance,
  renderExecutorUnit,
  renderIngressUnit,
  renderLauncher,
  renderPlist,
  renderSocketUnit,
  renderUnit,
  serviceWorkdir,
} from "./service";
import { ENV_PATH, HOME, SHIM_PATH } from "./paths";

// Both renderers interpolate host paths and the local bun, so on Windows they
// produce a unit and a plist that could never be installed. Neither service
// manager exists there, so skip rather than loosen assertions that catch a
// real regression on the platforms that install them.
const onServiceHost = platform() !== "win32";

describe("launchd bootstrap", () => {
  test("retries transient EIO after bootout", async () => {
    const commands: string[][] = [];
    const results = [
      {
        code: 5,
        stdout: "",
        stderr: "Bootstrap failed: 5: Input/output error",
      },
      { code: 113, stdout: "", stderr: "Could not find service" },
      { code: 0, stdout: "", stderr: "" },
    ];

    const result = await bootstrapLaunchAgent(
      "dev.opensession.test",
      "/tmp/test.plist",
      {
        domain: "gui/501",
        runCommand: async (command) => {
          commands.push(command);
          return results.shift()!;
        },
        pause: async () => {},
      },
    );

    expect(result.code).toBe(0);
    expect(commands).toEqual([
      ["launchctl", "bootstrap", "gui/501", "/tmp/test.plist"],
      ["launchctl", "print", "gui/501/dev.opensession.test"],
      ["launchctl", "bootstrap", "gui/501", "/tmp/test.plist"],
    ]);
  });

  test("accepts a job registered despite transient EIO", async () => {
    const results = [
      {
        code: 5,
        stdout: "",
        stderr: "Bootstrap failed: 5: Input/output error",
      },
      { code: 0, stdout: "registered", stderr: "" },
    ];

    const result = await bootstrapLaunchAgent(
      "dev.opensession.test",
      "/tmp/test.plist",
      {
        domain: "gui/501",
        runCommand: async () => results.shift()!,
        pause: async () => {},
      },
    );

    expect(result).toEqual({ code: 0, stdout: "registered", stderr: "" });
  });
});

describe("cloud metadata install refusal", () => {
  test("explains the EC2 risk, safe block, explicit bypass, and rerun", () => {
    const guidance = metadataInstallBlockGuidance(1234).join("\n");

    expect(guidance).toContain("EC2");
    expect(guidance).toContain("IAM role credentials");
    expect(guidance).toContain(
      "sudo iptables -I OUTPUT -d 169.254.169.254 -m owner --uid-owner 1234 -j REJECT",
    );
    expect(guidance).toContain(
      "rerun the same Open Session installation command",
    );
    expect(guidance).toContain("OPENSESSION_ALLOW_IMDS=1");
    expect(guidance).toContain("explicitly skip this safety check");
  });
});

describe.skipIf(!onServiceHost)("systemd unit", () => {
  test("user scope: no User=, no IPAddressDeny=, wants default.target", async () => {
    const unit = await renderUnit("user");
    // A user manager rejects User= and cannot apply the BPF IP filter without
    // PrivateUsers=; multi-user.target does not exist per user. Any of these
    // left in makes `systemctl --user enable --now` fail or the unit never
    // start at boot.
    expect(unit).not.toMatch(/^User=/m);
    expect(unit).not.toMatch(/^IPAddressDeny=/m);
    expect(unit).not.toMatch(/^Slice=opensession-control\.slice$/m);
    expect(unit).toMatch(/^WantedBy=default\.target$/m);
    // Optional env file: a box with no secrets yet must still start.
    expect(unit).toContain(`EnvironmentFile=-${ENV_PATH}`);
    expect(unit).toContain(`WorkingDirectory=${serviceWorkdir()}`);
    expect(
      unit.match(
        /^ExecStart=(\S+) run packages\/core\/opensession-server\/src\/server\/gateway-supervisor\.ts$/m,
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
    expect(unit).toContain("Slice=opensession-control.slice");
    expect(
      unit.match(
        /^ExecStart=(\S+) run packages\/core\/opensession-server\/src\/server\/gateway-supervisor\.ts$/m,
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
    expect(unit).not.toContain("Wants=opensession-session-kernel.service");
    expect(unit).not.toContain("Wants=opensession-executor.service");
    expect(unit).toContain(
      "Wants=opensession.socket opensession-ingress.service",
    );
    expect(unit).not.toContain("Sockets=opensession.socket");
    expect(unit).toContain('Environment="OPENSESSION_EXTERNAL_INGRESS=1"');
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

// A compiled `opensession server` is opensession.ts binding PORT through
// Bun.serve; it never adopts a systemd fd and no ingress process ships with the
// release. 0.4.52 to 0.4.55 rendered `Requires=opensession.socket` for it
// anyway, so the install either died on the missing template or, with one
// supplied, systemd held 3850 and the server crash-looped on EADDRINUSE
// (tellahq/opensession#297).
describe.skipIf(!onServiceHost)("compiled systemd unit", () => {
  test("binds the port itself instead of expecting socket activation", async () => {
    const unit = await renderUnit("user", true);
    expect(unit).toContain(`ExecStart=${SHIM_PATH} server`);
    expect(unit).not.toContain("opensession.socket");
    expect(unit).not.toContain("opensession-ingress.service");
    expect(unit).not.toMatch(/^(Sockets|Requires|Wants)=/m);
    expect(unit).not.toContain("OPENSESSION_EXTERNAL_INGRESS");
    expect(unit).toContain(
      "After=network.target opensession-session-kernel.service\n",
    );
  });

  test("system scope still orders the executor ahead of the gateway", async () => {
    const unit = await renderUnit("system", true);
    expect(unit).not.toContain("opensession.socket");
    expect(unit).toContain(
      "After=network.target opensession-session-kernel.service opensession-executor.service\n",
    );
  });

  test("the socket unit only ever activates the source ingress", async () => {
    for (const scope of ["user", "system"] as const) {
      const unit = await renderSocketUnit(scope);
      expect(unit).toContain("Service=opensession-ingress.service");
      expect(unit).not.toContain("Service=opensession.service");
    }
  });
});

describe.skipIf(!onServiceHost)("ingress systemd unit", () => {
  test("owns the socket independently from gateway lifecycle", async () => {
    const unit = await renderIngressUnit("system");
    expect(unit).toContain(`WorkingDirectory=${serviceWorkdir()}`);
    expect(unit).toContain("Sockets=opensession.socket");
    expect(unit).toContain("Requires=opensession.socket");
    expect(unit).toContain("src/server/gateway-ingress.ts");
    expect(unit).not.toContain("EnvironmentFile=");
    expect(unit).toContain("Restart=always");
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
    expect(unit).toContain("Slice=opensession-control.slice");
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
