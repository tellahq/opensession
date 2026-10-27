import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  reapSessionContainers,
  sessionContainerEnv,
  stopSessionContainers,
  writeContainerShims,
  type RuntimeExec,
} from "./session-containers";

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "os-containers-"));
  dirs.push(dir);
  return dir;
}
afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

/** A fake `docker` that prints its argv, one per line. */
async function fakeRuntime(): Promise<string> {
  const bin = await tempDir();
  await writeFile(
    join(bin, "docker"),
    '#!/usr/bin/env bash\nprintf "%s\\n" "$@"\n',
    { mode: 0o755 },
  );
  return bin;
}

async function runShim(
  shims: string,
  bin: string,
  args: string[],
  sessionId?: string,
): Promise<string[]> {
  const proc = Bun.spawn([join(shims, "docker"), ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: `${shims}:${bin}:/usr/bin:/bin`,
      ...(sessionId
        ? { OPENSESSION_SESSION_ID: sessionId, OPENSESSION_INSTANCE: "inst" }
        : {}),
    },
  });
  const out = await new Response(proc.stdout).text();
  expect(await proc.exited).toBe(0);
  return out.split("\n").filter(Boolean);
}

describe("container ownership wrappers", () => {
  test("wrap only the runtimes on PATH, and label run and create", async () => {
    const bin = await fakeRuntime();
    const shims = await tempDir();
    expect(await writeContainerShims(shims, bin)).toEqual(["docker"]);
    const label = [
      "--label",
      "opensession.session=os-1",
      "--label",
      "opensession.instance=inst",
    ];

    expect(
      await runShim(
        shims,
        bin,
        ["run", "-d", "redis:7", "sh", "-c", "a b"],
        "os-1",
      ),
    ).toEqual(["run", ...label, "-d", "redis:7", "sh", "-c", "a b"]);
    expect(
      await runShim(
        shims,
        bin,
        ["--debug", "container", "create", "img"],
        "os-1",
      ),
    ).toEqual(["--debug", "container", "create", ...label, "img"]);
    // Other subcommands and runs outside a session pass through unchanged.
    expect(await runShim(shims, bin, ["ps", "-a"], "os-1")).toEqual([
      "ps",
      "-a",
    ]);
    expect(await runShim(shims, bin, ["run", "img"])).toEqual(["run", "img"]);
  });

  test("rewriting an unchanged wrapper keeps it in place", async () => {
    const bin = await fakeRuntime();
    const shims = await tempDir();
    await writeContainerShims(shims, bin);
    const before = await readFile(join(shims, "docker"), "utf-8");
    await writeContainerShims(shims, bin);
    expect(await readFile(join(shims, "docker"), "utf-8")).toBe(before);
    expect(await writeContainerShims(await tempDir(), "/nonexistent")).toEqual(
      [],
    );
  });

  test("the run env puts the wrappers first and names the session", () => {
    const env = sessionContainerEnv("os-1", "/usr/bin", "/state/shims");
    expect(env.PATH).toBe("/state/shims:/usr/bin");
    expect(env.OPENSESSION_SESSION_ID).toBe("os-1");
    expect(env.OPENSESSION_INSTANCE).toMatch(/^[0-9a-f]{16}$/);
    expect(sessionContainerEnv("os-1", "/usr/bin", null).PATH).toBe("/usr/bin");
  });
});

type Call = string[];
function fakeExec(
  respond: (argv: string[]) => { code: number; stdout: string },
): { exec: RuntimeExec; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    exec: async (argv) => {
      calls.push(argv);
      return respond(argv);
    },
  };
}

describe("stopSessionContainers", () => {
  test("stops each id's labelled containers and skips a missing runtime", async () => {
    const { exec, calls } = fakeExec((argv) => {
      if (argv[0] === "podman") return { code: 127, stdout: "" };
      if (argv[1] === "ps")
        return {
          code: 0,
          stdout: argv.at(-1)!.endsWith("=os-1") ? "c1\nc2\n" : "",
        };
      return { code: 0, stdout: "" };
    });
    const stopped = await stopSessionContainers(["os-1", "alias-1"], { exec });
    expect(stopped.map((c) => c.id)).toEqual(["c1", "c2"]);
    expect(calls.filter((argv) => argv[1] === "stop")).toEqual([
      ["docker", "stop", "c1", "c2"],
    ]);
    // Podman answered "not installed" once and was not asked again.
    expect(calls.filter((argv) => argv[0] === "podman")).toHaveLength(1);
  });

  test("a failed stop is reported so the reaper's retry is visible", async () => {
    const { exec } = fakeExec((argv) =>
      argv[1] === "ps"
        ? { code: 0, stdout: "c1\n" }
        : { code: argv[1] === "stop" ? 1 : 0, stdout: "" },
    );
    await expect(stopSessionContainers(["os-1"], { exec })).rejects.toThrow(
      "could not stop session containers",
    );
  });
});

describe("reapSessionContainers", () => {
  const now = Date.parse("2026-10-16T12:00:00Z");
  const old = "2026-10-16T10:00:00.123456789Z";
  const podmanOld = "2026-10-16 10:00:00.123456789 +0000 UTC";
  const recent = "2026-10-16T11:58:00Z";
  const inspect = [
    ["c-live", "os-live", "inst", old],
    ["c-archived", "os-archived", "other", old],
    ["c-alias", "alias-archived", "inst", old],
    ["c-deleted", "os-deleted", "inst", old],
    ["c-deleted-podman", "os-deleted", "inst", podmanOld],
    ["c-new", "os-new", "inst", recent],
    ["c-foreign", "os-foreign", "other", old],
  ]
    .map((row) => row.join("\t"))
    .join("\n");
  const sessions = [
    { id: "os-live" },
    { id: "os-archived", archived: true },
    { id: "os-canonical", aliasIds: ["alias-archived"], archived: true },
  ];

  function runtimeExec() {
    return fakeExec((argv) => {
      if (argv[0] === "podman") return { code: 127, stdout: "" };
      if (argv[1] === "ps") return { code: 0, stdout: "ids\n" };
      if (argv[1] === "inspect") return { code: 0, stdout: inspect };
      return { code: 0, stdout: "" };
    });
  }

  test("stops containers of archived and long-missing owners only", async () => {
    const { exec, calls } = runtimeExec();
    const { stopped } = await reapSessionContainers(sessions, {
      exec,
      now,
      instance: "inst",
    });
    expect(stopped.map((c) => c.id)).toEqual([
      "c-archived",
      "c-alias",
      "c-deleted",
      "c-deleted-podman",
    ]);
    expect(calls.filter((argv) => argv[1] === "stop")).toHaveLength(4);
  });

  test("an empty session list never counts every owner as missing", async () => {
    const { exec } = runtimeExec();
    const { stopped } = await reapSessionContainers([], {
      exec,
      now,
      instance: "inst",
    });
    expect(stopped).toEqual([]);
  });
});
