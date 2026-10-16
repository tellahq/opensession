import { expect, test } from "bun:test";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  chmod,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { hostUnitArgs } from "../packages/core/opensession-server/src/executor/host-unit";

const helperPath = resolve(import.meta.dir, "opensession-run-host");
test("fixed personal action cannot be confused with ordinary or legacy launch", () => {
  expect(hostUnitArgs("rh-fixture", "/fixture", "hash")[3]).toBe("launch");
  expect(hostUnitArgs("rh-fixture", "/fixture", "hash", true)[3]).toBe(
    "launch-personal",
  );
});

test("real helper shell rejects old runtime/ordinary personal launch before systemd invocation", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "personal-helper-policy-"));
  const hostId = "rh-019d2a5f-4ac8-7000-8000-123456789abc";
  const hosts = join(tmp, "hosts");
  const dir = join(hosts, hostId);
  const entryDir = join(
    tmp,
    "repo/packages/core/opensession-server/src/runner-host",
  );
  const capture = join(tmp, "captured-argv");
  try {
    await mkdir(dir, { recursive: true });
    await mkdir(entryDir, { recursive: true });
    await writeFile(join(entryDir, "host.ts"), "// synthetic old runtime\n");
    const launcher = join(tmp, "systemd-run-fixture");
    await writeFile(
      launcher,
      `#!/bin/sh\nprintf '%s\\n' "$@" > '${capture}'\n`,
    );
    await chmod(launcher, 0o700);
    const user = {
      username: "fixture-user",
      uid: process.getuid!(),
      gid: process.getgid!(),
    };
    const config = join(tmp, "config");
    await writeFile(
      config,
      [
        user.username,
        user.uid,
        user.gid,
        join(tmp, "repo"),
        "/bin/true",
        tmp,
        join(tmp, "empty.env"),
        hosts,
        launcher,
        "/bin/true",
        "/usr/bin:/bin",
        tmp,
        tmp,
        "0",
        "",
        "source",
        "/bin/true",
      ].join("\n") + "\n",
    );
    const source = await readFile(helperPath, "utf8");
    // Only root/config bootstrap is substituted. The actual shell policy,
    // JSON parser, command selection and systemd argv run unmodified as this
    // unprivileged test uid. No sudo, accounts or live services are touched.
    const fixture = source
      .replace('config="/etc/opensession/run-host.conf"', `config="${config}"`)
      .replace('[ "$(id -u)" -ne 0 ]', '[ "0" -ne 0 ]')
      .replace('$(id -u "$service_user")', "$service_uid")
      .replace('$(id -g "$service_user")', "$service_gid");
    const script = join(tmp, "helper");
    await writeFile(script, fixture);
    const run = async (...args: string[]) => {
      const proc = Bun.spawn(["/bin/sh", script, ...args], {
        env: { PATH: "/usr/bin:/bin" },
        stdout: "ignore",
        stderr: "pipe",
      });
      const stderr = await new Response(proc.stderr).text();
      const code = await proc.exited;
      if (args[0] === "check-version" && code !== 0) throw new Error(stderr);
      return code;
    };
    expect(await run("check-version", "2")).toBe(0);
    expect(await run("check-personal")).not.toBe(0);
    await writeFile(
      join(dir, "spec.json"),
      JSON.stringify({ personalRepo: { registryId: "personal-fixture" } }),
    );
    expect(await run("launch", hostId, dir, "a".repeat(64))).not.toBe(0);
    expect(await run("launch-personal", hostId, dir, "a".repeat(64))).not.toBe(
      0,
    );
    await expect(readFile(capture)).rejects.toThrow();
    await writeFile(
      join(entryDir, "personal-host.ts"),
      "// synthetic new entrypoint\n",
    );
    expect(await run("check-personal")).toBe(0);
    await writeFile(join(dir, "personal-github-auth.json"), "{}");
    expect(await run("launch-personal", hostId, dir, "a".repeat(64))).toBe(0);
    const args = await readFile(capture, "utf8");
    expect(args).toContain("/personal-host.ts");
    expect(args).toContain(`--uid=${user.uid}`);
    expect(args).not.toContain("GH_TOKEN");
    await writeFile(
      join(dir, "spec.json"),
      JSON.stringify({ prompt: "shared synthetic" }),
    );
    expect(await run("launch", hostId, dir, "a".repeat(64))).toBe(0);
    expect(await readFile(capture, "utf8")).toContain("/host.ts");
    expect(await run("launch-personal", hostId, dir, "a".repeat(64))).not.toBe(
      0,
    );
    // Synthetic old-v2 capability responder: ordinary version compatibility
    // cannot establish support for personal execution.
    await writeFile(
      script,
      '#!/bin/sh\ncase "$1" in check-version) [ "$2" = 2 ];; check) exit 0;; *) exit 2;; esac\n',
    );
    expect(await run("check-version", "2")).toBe(0);
    expect(await run("check-personal")).not.toBe(0);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}, 20_000);

test("compiled capability is fixed, bounded and executed as service identity", async () => {
  const helper = await readFile(helperPath, "utf8");
  expect(helper).toContain('timeout 10s runuser -u "$1" -- env -i');
  expect(helper).toContain("-o pipefail");
  expect(helper).toContain("head -c 128");
  expect(helper).toContain('"$runner_bin" personal-runner-host');
  const main = await readFile(
    resolve(import.meta.dir, "../packages/core/opensession-server/src/main.ts"),
    "utf8",
  );
  expect(main).toContain('sub === "personal-runner-capability"');
  expect(main).toContain('console.log("personal-runner-host-v2")');
  expect(main).toContain('sub === "personal-runner-host"');
});

test("compiled release includes both personal worker sidecars selected by clients", async () => {
  const build = await readFile(
    resolve(import.meta.dir, "../scripts/build-compile.ts"),
    "utf8",
  );
  for (const name of [
    "personal-repo-runtime-policy-worker",
    "personal-github-connection-worker",
  ])
    expect(build).toContain(`name: "${name}.js"`);
  expect(build).toContain("await buildWorkerSidecars(stage)");
  expect(build).toContain('"-czf", tarball, name');
  const policy = await readFile(
    resolve(
      import.meta.dir,
      "../packages/core/opensession-server/src/server/personal-repo-runtime-policy.ts",
    ),
    "utf8",
  );
  const broker = await readFile(
    resolve(
      import.meta.dir,
      "../packages/core/opensession-server/src/server/personal-github/worker-client.ts",
    ),
    "utf8",
  );
  expect(policy).toContain("workerEntry(");
  expect(policy).toContain('"personal-repo-runtime-policy-worker.js"');
  expect(broker).toContain("workerEntry(");
  expect(broker).toContain('"personal-github-connection-worker.js"');
});

test("compiled personal capability v1 cannot opt into installation-only v2", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "personal-capability-v2-"));
  try {
    const source = await readFile(helperPath, "utf8");
    const start = source.indexOf("personal_runtime_available() {");
    const end = source.indexOf('\naction="', start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const policy = source.slice(start, end);
    // Only the privilege wrapper is stubbed. The actual helper capability
    // query, timeout/output bound and exact response comparison run unchanged.
    await writeFile(join(tmp, "runuser"), '#!/bin/sh\nshift 3\nexec "$@"\n');
    await chmod(join(tmp, "runuser"), 0o700);
    const binary = join(tmp, "compiled-fixture");
    for (const capability of [
      "personal-runner-host-v1",
      "",
      "personal-runner-host-v2",
    ]) {
      await writeFile(
        binary,
        `#!/bin/sh\n[ "$1" = personal-runner-capability ] || exit 2\nprintf '%s\\n' '${capability}'\n`,
      );
      await chmod(binary, 0o700);
      const proc = Bun.spawn(
        ["/bin/sh", "-c", `${policy}\npersonal_runtime_available`],
        {
          env: {
            PATH: `${tmp}:/usr/bin:/bin`,
            runner_mode: "compiled",
            service_user: "synthetic",
            home_dir: tmp,
            service_path: "/usr/bin:/bin",
            runner_bin: binary,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      expect(await proc.exited).toBe(
        capability === "personal-runner-host-v2" ? 0 : 1,
      );
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
