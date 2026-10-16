import { expect, test } from "bun:test";
import {
  stopPersonalPhysicalHost,
  type PersonalPhysicalDependencies,
} from "./personal-host-physical";
import type { PersonalRunConsumer } from "./personal-run-consumers";
const c: PersonalRunConsumer = {
  runKey: "logical",
  hostId: "rh-019d2a5f-4ac8-7000-8000-123456789abc",
  sessionId: "private",
  binding: {
    registryId: "unused-by-physical-probe",
    descriptor: {
      kind: "personal",
      ownerGithubAccountId: 41,
      repositoryOwnerGithubAccountId: 41,
      appRecordId: "fixture",
      githubAppId: 1,
      installationId: 2,
      repositoryId: 3,
      accessRevision: 1,
      fullName: "fixture/repo",
    },
  },
};
function fixture() {
  let active = true,
    populated = false,
    executorKnown = true;
  let stops = 0;
  const files = new Map<string, string>();
  const group = `/system.slice/bks-run-${c.hostId}.service`;
  const deps: PersonalPhysicalDependencies = {
    command: async (args) => {
      if (args[0] === "sudo") {
        stops++;
        active = false;
        return { code: 0, output: "" };
      }
      return {
        code: 0,
        output: `LoadState=loaded\nActiveState=${active ? "active" : "inactive"}\nControlGroup=${group}\n`,
      };
    },
    read: async (path) => {
      if (path.endsWith("cgroup.events"))
        return `populated ${populated ? 1 : 0}\nfrozen 0\n`;
      const value = files.get(path);
      if (value !== undefined) return value;
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
    executorStop: async (host, hash) => {
      expect(host).toBe(c.hostId);
      expect(hash).toBe("hash");
      if (!executorKnown) throw new Error("executor unknown");
      stops++;
      active = false;
    },
  };
  return {
    deps,
    files,
    stops: () => stops,
    inactive() {
      active = false;
    },
    populated() {
      populated = true;
    },
    unknown() {
      executorKnown = false;
    },
  };
}
test("validated executor stop still needs positive cgroup/process absence", async () => {
  const f = fixture();
  await stopPersonalPhysicalHost(c, "/fixture", "hash", "executor", f.deps);
  expect(f.stops()).toBe(1);
  const busy = fixture();
  busy.populated();
  await expect(
    stopPersonalPhysicalHost(c, "/fixture", "hash", "executor", busy.deps),
  ).rejects.toThrow("cgroup absence");
});
test("systemd absence alone cannot cover an unknown delayed executor launch", async () => {
  const f = fixture();
  f.inactive();
  f.unknown();
  await expect(
    stopPersonalPhysicalHost(c, "/fixture", "hash", "unknown", f.deps),
  ).rejects.toThrow("executor unknown");
  expect(f.stops()).toBe(0);
});
test("known never-dispatched preparation needs actual absence without entering executor or broker", async () => {
  const f = fixture();
  f.inactive();
  f.unknown();
  await stopPersonalPhysicalHost(c, "/fixture", "hash", "never", f.deps);
  expect(f.stops()).toBe(1);
  const unexpected = fixture();
  await expect(
    stopPersonalPhysicalHost(c, "/fixture", "hash", "never", unexpected.deps),
  ).rejects.toThrow("Unexpected physical host");
  expect(unexpected.stops()).toBe(0);
});
test("successor metadata is rejected before any physical stop", async () => {
  const f = fixture();
  f.files.set(
    "/fixture/meta.json",
    JSON.stringify({ hostId: "successor", osSessionId: c.sessionId, pid: 123 }),
  );
  await expect(
    stopPersonalPhysicalHost(c, "/fixture", "hash", "executor", f.deps),
  ).rejects.toThrow("identity mismatch");
  expect(f.stops()).toBe(0);
});
test("matching live process rejects despite inactive cgroup; reused pid is not mistaken for original", async () => {
  const f = fixture();
  f.files.set(
    "/fixture/meta.json",
    JSON.stringify({
      hostId: c.hostId,
      osSessionId: c.sessionId,
      pid: 123,
      bootId: "boot",
      startTicks: "42",
    }),
  );
  const fields = Array.from({ length: 20 }, () => "0");
  fields[0] = "S";
  fields[19] = "42";
  f.files.set("/proc/123/stat", `123 (fixture) ${fields.join(" ")}`);
  f.files.set("/proc/sys/kernel/random/boot_id", "boot");
  await expect(
    stopPersonalPhysicalHost(c, "/fixture", "hash", "executor", f.deps),
  ).rejects.toThrow("process absence");
  fields[19] = "43";
  f.files.set("/proc/123/stat", `123 (fixture) ${fields.join(" ")}`);
  await stopPersonalPhysicalHost(c, "/fixture", "hash", "executor", f.deps);
});
