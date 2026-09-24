#!/usr/bin/env bun
/** One test process, one disposable home. No operator state or credentials. */
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function testEnvironment(
  home: string,
  parent: Record<string, string | undefined>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of [
    "PATH",
    "LANG",
    "LC_ALL",
    "TZ",
    "TERM",
    "CI",
    "NO_COLOR",
    "FORCE_COLOR",
    // `OPENSESSION_SNAPSHOT=record bun run test:snapshots` re-records
    // (docs/transcript-snapshots.md); without it the switch never arrives.
    "OPENSESSION_SNAPSHOT",
  ])
    if (parent[key] !== undefined) env[key] = parent[key]!;
  return {
    ...env,
    NODE_ENV: "test",
    OPENSESSION_TEST_ISOLATED_HOME: home,
    HOME: home,
    USERPROFILE: home,
    TMPDIR: join(home, "tmp"),
    TEMP: join(home, "tmp"),
    TMP: join(home, "tmp"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_DATA_HOME: join(home, ".local/share"),
    OPENSESSION_CONFIG: join(home, "config.json"),
  };
}

export async function runIsolatedTests(
  files: string[],
  snapshots = false,
): Promise<number> {
  if (!files.length) throw new Error("Pass at least one test file");
  const home = await mkdtemp(join(tmpdir(), "os-unit-"));
  try {
    const env = testEnvironment(home, process.env);
    await mkdir(env.TMPDIR!, { recursive: true });
    await writeFile(env.OPENSESSION_CONFIG!, "{}\n");
    if (snapshots)
      Object.assign(env, {
        OPENSESSION_EXECUTOR: "0",
        OPENSESSION_TEST_IN_PROCESS_RUNS: "1",
        OPENSESSION_SNAPSHOT_STRICT: "1",
      });
    const child = Bun.spawn(
      [
        process.execPath,
        "test",
        "--no-orphans",
        "--reporter",
        "dots",
        ...files,
      ],
      {
        env,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      },
    );
    // --no-orphans tears down descendants before the private home is removed.
    return await child.exited;
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const snapshots = args[0] === "--snapshots";
  process.exitCode = await runIsolatedTests(
    snapshots ? args.slice(1) : args,
    snapshots,
  );
}
