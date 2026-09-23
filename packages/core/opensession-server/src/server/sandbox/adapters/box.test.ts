import { describe, expect, test } from "bun:test";
import {
  boxApiBaseUrl,
  boxDesktopUrl,
  BOX_PREVIEW_URL_PATTERN,
  BOX_RUNTIME_HOME_COMMAND,
  BOX_HOME_GUARD,
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
  test("bind-mounts the durable home without changing its canonical spelling", () => {
    expect(BOX_RUNTIME_HOME_COMMAND).toContain(
      "mount --bind /home/user /home/ubuntu",
    );
    expect(BOX_RUNTIME_HOME_COMMAND).toContain("test ! -L /home/ubuntu");
    expect(BOX_RUNTIME_HOME_COMMAND).toContain("umount /home/ubuntu");
    expect(BOX_RUNTIME_HOME_COMMAND).not.toContain("ln -s");
  });

  test("keeps a writable foreign /home/ubuntu mount and reports it as lazy", () => {
    // After archive/resume Box serves the home through a FUSE layer at
    // /home/ubuntu; unmounting it from under a live workspace is the bug this
    // guards against, and the marker switches file writes to the shell path.
    expect(BOX_RUNTIME_HOME_COMMAND).toContain(
      `if test -w /home/ubuntu; then echo ${BOX_RUNTIME_HOME_LAZY_MARKER}; else sudo -n umount /home/ubuntu`,
    );
    expect(BOX_RUNTIME_HOME_COMMAND).not.toContain(
      "test /home/ubuntu -ef /home/user && test -w /home/ubuntu",
    );
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

  test("restores the /home/ubuntu bind mount before a workspace command", async () => {
    // A Box the provider restarted on its own lost the mount; a cwd under
    // /home/ubuntu must still resolve.
    expect(BOX_HOME_GUARD).toStartWith("{ mountpoint -q /home/ubuntu || {");
    expect(BOX_HOME_GUARD).toContain(BOX_RUNTIME_HOME_COMMAND);
    const composed = boxComposeShell("git status", {
      cwd: "/home/ubuntu/worktrees/acme-feature",
    });
    expect(composed.indexOf(BOX_HOME_GUARD)).toBe(0);
    expect(
      composed.indexOf("cd /home/ubuntu/worktrees/acme-feature"),
    ).toBeGreaterThan(BOX_HOME_GUARD.length);
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
