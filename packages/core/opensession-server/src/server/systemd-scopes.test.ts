import { describe, expect, test } from "bun:test";
import {
  ENGINE_SLICE,
  PREVIEW_SLICE,
  controlPlaneWorkloadCommand,
  engineScopeSystemdArgs,
  processRunsInControlPlane,
  previewScopeSystemdArgs,
  previewScopeUnit,
} from "./systemd-scopes";

describe("systemd scope resource controls", () => {
  test("detached engines get bounded memory, swap, tasks, and an aggregate slice", () => {
    expect(engineScopeSystemdArgs({})).toEqual([
      `--slice=${ENGINE_SLICE}`,
      "--property=MemoryHigh=6G",
      "--property=MemoryMax=12G",
      "--property=MemorySwapMax=1G",
      "--property=TasksMax=1024",
      "--property=OOMPolicy=stop",
    ]);
  });

  test("previews get a separate budget and leave CPU headroom", () => {
    expect(previewScopeSystemdArgs({})).toEqual([
      `--slice=${PREVIEW_SLICE}`,
      "--property=MemoryHigh=8G",
      "--property=MemoryMax=12G",
      "--property=MemorySwapMax=1G",
      "--property=TasksMax=768",
      "--property=CPUQuota=600%",
      "--property=OOMPolicy=stop",
    ]);
  });

  test("trusted env overrides tune limits while malformed values fall back", () => {
    expect(
      engineScopeSystemdArgs({
        OPENSESSION_ENGINE_MEMORY_HIGH: "4G",
        OPENSESSION_ENGINE_MEMORY_MAX: "nope",
        OPENSESSION_ENGINE_TASKS_MAX: "2048",
      }),
    ).toContain("--property=MemoryHigh=4G");
    expect(
      engineScopeSystemdArgs({ OPENSESSION_ENGINE_MEMORY_MAX: "nope" }),
    ).toContain("--property=MemoryMax=12G");
    expect(
      engineScopeSystemdArgs({ OPENSESSION_ENGINE_TASKS_MAX: "2048" }),
    ).toContain("--property=TasksMax=2048");
  });

  test("gateway-owned shell commands escape into the low-priority agent slice", () => {
    expect(
      processRunsInControlPlane(
        "0::/opensession.slice/opensession-control.slice/opensession.service",
      ),
    ).toBe(true);
    const scoped = controlPlaneWorkloadCommand(
      ["setsid", "/bin/bash", "-c", "cargo test"],
      "opensession-agent-cmd-test",
      {
        env: { PATH: "/bin" },
        cgroup:
          "0::/opensession.slice/opensession-control.slice/opensession.service",
        scopesAvailable: true,
      },
    );
    expect(scoped.unit).toBe("opensession-agent-cmd-test");
    expect(scoped.command).toEqual([
      "systemd-run",
      "--user",
      "--scope",
      "--collect",
      "--quiet",
      "--unit=opensession-agent-cmd-test",
      "--slice=opensession-agents.slice",
      "--property=MemoryHigh=6G",
      "--property=MemoryMax=12G",
      "--property=MemorySwapMax=1G",
      "--property=TasksMax=1024",
      "--property=OOMPolicy=stop",
      "--property=TimeoutStopSec=2",
      "--",
      "setsid",
      "/bin/bash",
      "-c",
      "cargo test",
    ]);
  });

  test("commands already owned by a run host stay in its system workload unit", () => {
    const command = ["/bin/bash", "-c", "cargo test"];
    expect(
      controlPlaneWorkloadCommand(command, "unused", {
        env: { PATH: "/bin" },
        cgroup:
          "0::/opensession.slice/opensession-workloads.slice/bks-run.service",
        scopesAvailable: true,
      }),
    ).toEqual({ command, env: { PATH: "/bin" } });
  });

  test("preview unit names are stable without exposing worktree paths", () => {
    const first = previewScopeUnit("/srv/worktrees/a");
    expect(first).toBe(previewScopeUnit("/srv/worktrees/a"));
    expect(first).not.toBe(previewScopeUnit("/srv/worktrees/b"));
    expect(first).toMatch(/^opensession-preview-[a-f0-9]{16}$/);
    expect(first).not.toContain("worktrees");
  });
});
