import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  boxApiBaseUrl,
  boxDesktopUrl,
  BOX_PREVIEW_URL_PATTERN,
  BOX_RUNTIME_HOME_COMMAND,
  BOX_HOME_GUARD,
  BOX_HOME_HYDRATION_PROBE,
  BOX_RUNTIME_HOME_LAZY_MARKER,
  boxCommandPlaneUnavailable,
  boxComposeShell,
  boxReadRetryable,
  boxKnownHostsKey,
  boxMachineIpSshEndpoint,
  boxMachineType,
  boxNativeFilePath,
  boxResumePrimeCommand,
  boxSnapshotSaveIsRecoverable,
  parseBoxSshEndpoint,
} from "./box";

describe("Box API base", () => {
  test("defaults to the Boat API", () => {
    expect(boxApiBaseUrl()).toBe("https://boat.dev/api/v1");
    expect(boxApiBaseUrl("")).toBe("https://boat.dev/api/v1");
    expect(boxApiBaseUrl("https://boat.dev/api/v1/")).toBe(
      "https://boat.dev/api/v1",
    );
  });

  test("maps the retired ascii.dev base, which lacks /sandboxes, to boat.dev", () => {
    expect(boxApiBaseUrl("https://ascii.dev/api/box/v1")).toBe(
      "https://boat.dev/api/v1",
    );
    expect(boxApiBaseUrl("https://boat.dev/api/box/v1/")).toBe(
      "https://boat.dev/api/v1",
    );
    expect(boxApiBaseUrl("https://ascii.dev/api/v1")).toBe(
      "https://boat.dev/api/v1",
    );
  });

  test("leaves other bases alone", () => {
    expect(boxApiBaseUrl("https://boat.example.test/api/v1/")).toBe(
      "https://boat.example.test/api/v1",
    );
    expect(boxApiBaseUrl("not a url")).toBe("not a url");
  });
});

describe("Box machine profiles", () => {
  test("maps the three provider-supported resource combinations", () => {
    expect(boxMachineType({ cpu: 2, memoryMb: 4_096, diskGb: 40 })).toBe(
      "small",
    );
    expect(boxMachineType({ cpu: 4, memoryMb: 8_192, diskGb: 80 })).toBe(
      "default",
    );
    expect(boxMachineType({ cpu: 8, memoryMb: 16_384, diskGb: 100 })).toBe(
      "large",
    );
  });

  test("uses default when no project profile exists and rejects arbitrary combinations", () => {
    expect(boxMachineType()).toBe("default");
    expect(() =>
      boxMachineType({ cpu: 4, memoryMb: 4_096, diskGb: 80 }),
    ).toThrow("Choose one of Boat's Small, Default, or Large machine sizes");
  });
});

describe("Box named snapshots", () => {
  test("recovers only recent in-flight saves", () => {
    const now = Date.parse("2026-08-21T10:00:00.000Z");
    expect(
      boxSnapshotSaveIsRecoverable(
        { status: "saving", createdAt: "2026-08-21T09:45:00.000Z" },
        now,
      ),
    ).toBe(true);
    expect(
      boxSnapshotSaveIsRecoverable(
        { status: "saving", createdAt: "2026-08-21T08:00:00.000Z" },
        now,
      ),
    ).toBe(false);
    expect(
      boxSnapshotSaveIsRecoverable(
        { status: "ready", createdAt: "2026-08-21T09:55:00.000Z" },
        now,
      ),
    ).toBe(false);
  });
});

describe("Box persistent file paths", () => {
  test("links /home/ubuntu to Boat's home instead of binding it", () => {
    // A bind captured Boat's lazy-restore FUSE mount for the machine's life.
    expect(BOX_RUNTIME_HOME_COMMAND).toContain("ln -s /home/user /home/ubuntu");
    expect(BOX_RUNTIME_HOME_COMMAND).not.toContain("mount --bind");
    // An older release's bind is detached without touching /home/user: the
    // symlink case is handled before any unmount, since unmounting through
    // the link would unmount Boat's own FUSE layer.
    expect(BOX_RUNTIME_HOME_COMMAND).toContain("umount -l /home/ubuntu");
    expect(
      BOX_RUNTIME_HOME_COMMAND.indexOf("[ -L /home/ubuntu ]"),
    ).toBeLessThan(BOX_RUNTIME_HOME_COMMAND.indexOf("umount"));
    expect(BOX_RUNTIME_HOME_COMMAND).toContain(
      `fuse*) echo ${BOX_RUNTIME_HOME_LAZY_MARKER}`,
    );
  });

  test("the home command creates, repairs, and keeps the link", () => {
    const root = mkdtempSync(join(tmpdir(), "box-home-"));
    try {
      const user = join(root, "user");
      const ubuntu = join(root, "ubuntu");
      mkdirSync(user);
      // One pass: the temporary root may itself live under /home/ubuntu.
      const replacements: Record<string, string> = {
        "/home/user": user,
        "/home/ubuntu": ubuntu,
        "/tmp/.opensession-home.lock": join(root, "lock"),
        "sudo -n ": "",
      };
      const script = BOX_RUNTIME_HOME_COMMAND.replace(
        /\/home\/user|\/home\/ubuntu|\/tmp\/\.opensession-home\.lock|sudo -n /g,
        (match) => replacements[match]!,
      );
      const run = () => Bun.spawnSync(["bash", "-c", script]).exitCode;
      // An empty directory (a fresh VM root) becomes the link.
      mkdirSync(ubuntu);
      expect(run()).toBe(0);
      expect(readlinkSync(ubuntu)).toBe(user);
      // Idempotent.
      expect(run()).toBe(0);
      // A link elsewhere is repaired.
      rmSync(ubuntu);
      symlinkSync(root, ubuntu);
      expect(run()).toBe(0);
      expect(readlinkSync(ubuntu)).toBe(user);
      // Real content at the path is never replaced.
      rmSync(ubuntu);
      mkdirSync(ubuntu);
      writeFileSync(join(ubuntu, "keep"), "x");
      expect(run()).not.toBe(0);
      expect(existsSync(join(ubuntu, "keep"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("maps the cross-provider home to Box's native durable home", () => {
    expect(boxNativeFilePath("/home/ubuntu")).toBe("/home/user");
    expect(boxNativeFilePath("/home/ubuntu/.opensession/spec.json")).toBe(
      "/home/user/.opensession/spec.json",
    );
    expect(boxNativeFilePath("/tmp/output")).toBe("/tmp/output");
  });
});

describe("Box SSH control lane", () => {
  test("prefers the provider's reachable host and port over an IPv6 machine address", () => {
    expect(parseBoxSshEndpoint("137.74.205.128:19042")).toEqual({
      host: "137.74.205.128",
      port: 19042,
    });
    expect(parseBoxSshEndpoint("[2001:db8::2]:2200")).toEqual({
      host: "2001:db8::2",
      port: 2200,
    });
    expect(parseBoxSshEndpoint("2001:db8::2")).toBeNull();
  });
});

describe("Box SSH host identity", () => {
  test("scopes a resumed VM host-key rotation to the exact provider endpoint", () => {
    expect(boxKnownHostsKey({ host: "5.135.138.52", port: 19042 })).toBe(
      "[5.135.138.52]:19042",
    );
    expect(boxKnownHostsKey({ host: "162.55.60.74", port: 22 })).toBe(
      "162.55.60.74",
    );
    expect(boxMachineIpSshEndpoint("162.55.60.74")).toEqual({
      host: "162.55.60.74",
      port: 22,
    });
    expect(boxMachineIpSshEndpoint("2001:db8::1")).toBeNull();
  });
});

describe("Box command readiness", () => {
  test("hydrates a resumed workspace without taking Git locks", () => {
    expect(boxResumePrimeCommand("/home/ubuntu/worktrees/app")).toContain(
      "xargs -0 -r -n 64 -P 16 stat",
    );
    expect(boxResumePrimeCommand("/home/ubuntu/worktrees/app")).toContain(
      "GIT_OPTIONAL_LOCKS=0 git status --porcelain",
    );
    expect(boxResumePrimeCommand("/home/ubuntu/worktrees/app")).toContain(
      "test -d /home/ubuntu/worktrees/app/.git",
    );
    // The binaries the Portal relay and dev servers start on come first.
    expect(boxResumePrimeCommand("/home/ubuntu/worktrees/app")).toStartWith(
      '{ cat /home/ubuntu/.bun/bin/bun "$(command -v node)"',
    );
    expect(boxResumePrimeCommand("/home/ubuntu/worktrees/app")).toContain(
      "/objects/pack/*.idx",
    );
  });

  test("keeps command temporary files inside the bind-mounted home", () => {
    expect(boxComposeShell("printf ok")).toStartWith(
      `${BOX_HOME_GUARD} && mkdir -p /home/ubuntu/.tmp && export TMPDIR=/home/ubuntu/.tmp && `,
    );
  });

  test("restores the /home/ubuntu link before a workspace command", async () => {
    // A Box the provider restarted on its own lost the link; a cwd under
    // /home/ubuntu must still resolve.
    expect(BOX_HOME_GUARD).toStartWith(
      '{ [ "$(readlink /home/ubuntu)" = /home/user ] || {',
    );
    expect(BOX_HOME_GUARD).toContain(BOX_RUNTIME_HOME_COMMAND);
    const composed = boxComposeShell("git status", {
      cwd: "/home/ubuntu/worktrees/acme-feature",
    });
    expect(composed.indexOf(BOX_HOME_GUARD)).toBe(0);
    expect(
      composed.indexOf("cd /home/ubuntu/worktrees/acme-feature"),
    ).toBeGreaterThan(BOX_HOME_GUARD.length);
  });

  test("the home scripts are valid shell", () => {
    for (const script of [BOX_HOME_GUARD, BOX_HOME_HYDRATION_PROBE]) {
      expect(Bun.spawnSync(["bash", "-n", "-c", script]).exitCode).toBe(0);
    }
    expect(
      Bun.spawnSync(["bash", "-c", BOX_HOME_HYDRATION_PROBE]).stdout.toString(),
    ).toMatch(/^(ready|hydrating)\n$/);
  });

  test("only retries explicit no-command 409 states", () => {
    expect(
      boxCommandPlaneUnavailable({ status: 409, code: "machine_not_running" }),
    ).toBe(true);
    expect(
      boxCommandPlaneUnavailable({ status: 409, code: "boat_starting" }),
    ).toBe(true);
    expect(
      boxCommandPlaneUnavailable({ status: 409, code: "boat_restoring" }),
    ).toBe(true);
    expect(
      boxCommandPlaneUnavailable({ status: 409, code: "box_starting" }),
    ).toBe(true);
    expect(
      boxCommandPlaneUnavailable({ status: 502, code: "boat_direct_failed" }),
    ).toBe(false);
    expect(
      boxCommandPlaneUnavailable({ status: 400, code: "machine_not_running" }),
    ).toBe(false);
    expect(boxCommandPlaneUnavailable({ status: 409, code: "other" })).toBe(
      false,
    );
  });
});

describe("Box preview routes", () => {
  test("reads the URL the in-sandbox host CLI prints on either domain", () => {
    expect(
      "registered https://swift-otter-9021-3000.on.boat.dev?_token=abc\n".match(
        BOX_PREVIEW_URL_PATTERN,
      )?.[0],
    ).toBe("https://swift-otter-9021-3000.on.boat.dev?_token=abc");
    expect(
      "https://swift-otter-9021-3000.on.ascii.dev?_token=abc".match(
        BOX_PREVIEW_URL_PATTERN,
      )?.[0],
    ).toBe("https://swift-otter-9021-3000.on.ascii.dev?_token=abc");
    expect(
      BOX_PREVIEW_URL_PATTERN.test("https://example.com/on.boat.dev"),
    ).toBe(false);
  });
});

describe("Box desktop", () => {
  test("returns the tokenized stream page Boat mints", () => {
    expect(
      boxDesktopUrl({
        desktopUrl:
          "https://name-desktop.on.boat.dev/stream.html?fps=60#token=abc",
      }),
    ).toBe("https://name-desktop.on.boat.dev/stream.html?fps=60#token=abc");
  });

  test("refuses a missing or non-https desktop URL", () => {
    expect(() => boxDesktopUrl({})).toThrow(/did not return a desktop URL/);
    expect(() => boxDesktopUrl({ desktopUrl: "http://x" })).toThrow();
  });
});

describe("Box read retries", () => {
  test("retries gateway errors and lost requests, never a timeout or a refusal", () => {
    const status = (code: number) =>
      Object.assign(new Error(`HTTP ${code}`), { status: code });
    expect(boxReadRetryable(status(502))).toBe(true);
    expect(boxReadRetryable(status(503))).toBe(true);
    expect(boxReadRetryable(status(504))).toBe(true);
    expect(boxReadRetryable(new Error("socket hang up"))).toBe(true);
    expect(boxReadRetryable(status(404))).toBe(false);
    expect(boxReadRetryable(status(409))).toBe(false);
    expect(boxReadRetryable(status(500))).toBe(false);
    expect(
      boxReadRetryable(
        new Error("box API GET /sandboxes/bx_1 timed out after 30s"),
      ),
    ).toBe(false);
  });
});
