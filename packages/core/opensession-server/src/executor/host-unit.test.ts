import { describe, expect, test } from "bun:test";
import { hostUnitArgs, legacyHostUnitArgs, RUN_HOST_HELPER } from "./host-unit";

describe("run-host systemd policy", () => {
  test("derives one fixed command from host identity", () => {
    const hostId = "rh-019d2a5f-4ac8-7000-8000-123456789abc";
    const dir = `/state/run-hosts/${hostId}`;
    const specHash = "a".repeat(64);
    expect(hostUnitArgs(hostId, dir, specHash)).toEqual([
      "sudo",
      "-n",
      RUN_HOST_HELPER,
      "launch",
      hostId,
      dir,
      specHash,
    ]);
  });

  test("keeps the fixed legacy launcher for first-upgrade compatibility", () => {
    const hostId = "rh-019d2a5f-4ac8-7000-8000-123456789abc";
    const dir = `/state/run-hosts/${hostId}`;
    const args = legacyHostUnitArgs(hostId, dir, 1234, 5678, "b".repeat(64));
    expect(args).toContain("systemd-run");
    expect(args).toContain("--uid=1234");
    expect(args).toContain(
      `Environment=OPENSESSION_RUN_JOURNAL=${dir}/journal.json`,
    );
    expect(args).toContain("StandardOutput=journal");
  });
});
