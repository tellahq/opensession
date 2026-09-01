import { afterEach, describe, expect, test } from "bun:test";
import { boundedCdpSystemdArgs, systemdUserEnv } from "./cdp-browser";

describe("systemd user environment", () => {
  const saved = process.env.XDG_RUNTIME_DIR;
  afterEach(() => {
    if (saved === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = saved;
  });

  test("fills in XDG_RUNTIME_DIR when the caller inherited none", () => {
    // The case every agent-driven capture hits: these scripts run from a
    // systemd SYSTEM service, which passes no XDG_RUNTIME_DIR, so systemd
    // cannot address the user bus and every spawn died on "Failed to connect
    // to bus: No medium found".
    delete process.env.XDG_RUNTIME_DIR;
    expect(systemdUserEnv().XDG_RUNTIME_DIR).toBe(
      `/run/user/${process.getuid?.() ?? 1000}`,
    );
  });

  test("never overrides a runtime dir the caller already has", () => {
    process.env.XDG_RUNTIME_DIR = "/run/user/4242";
    expect(systemdUserEnv().XDG_RUNTIME_DIR).toBe("/run/user/4242");
  });

  test("passes the rest of the environment through", () => {
    // systemd-run needs PATH to resolve `bun`, so this must extend the
    // environment rather than replace it.
    expect(systemdUserEnv().PATH).toBe(process.env.PATH);
  });
});

describe("bounded CDP browser", () => {
  test("caps memory, swap, tasks, CPU, and lifetime for the whole browser cgroup", () => {
    expect(boundedCdpSystemdArgs()).toEqual([
      "--property=MemoryHigh=2G",
      "--property=MemoryMax=4G",
      "--property=MemorySwapMax=512M",
      "--property=TasksMax=256",
      "--property=CPUQuota=300%",
      "--property=RuntimeMaxSec=2h",
      "--property=OOMPolicy=stop",
      "--property=KillMode=control-group",
    ]);
  });
});
