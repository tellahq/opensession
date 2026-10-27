import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { composeAgentShell } from "../agent-driver";
import {
  runRemoteLifecycleHook,
  runResumeHook,
  setupLeftoversKillScript,
  type RemoteDriver,
} from "./bootstrap";

const root = mkdtempSync(join(tmpdir(), "opensession-hooks-"));
const home = join(root, "home");
const repo = join(root, "repo");
mkdirSync(join(repo, ".agents"), { recursive: true });
mkdirSync(home, { recursive: true });
process.env.OPENSESSION_SANDBOX_CONFIG = join(root, "sandbox.json");
writeFileSync(
  process.env.OPENSESSION_SANDBOX_CONFIG,
  JSON.stringify({
    perRepo: {
      "with-pre-setup": {
        preSetupScript: '#!/bin/sh\necho pre-setup ran >> "$HOME/order"\n',
      },
    },
    workspaceResumeScript: 'echo workspace >> "$HOME/order"\n',
  }),
);

afterAll(() => rmSync(root, { recursive: true, force: true }));

/** The Linux guest layout's home, mapped into the scratch dir: nothing here
 *  may touch this machine's real home. */
const guest = (text: string) =>
  text
    .replaceAll(
      "/home/ubuntu/.opensession/lifecycle",
      `${home}/.opensession/lifecycle`,
    )
    .replace(/HOME=\/home\/ubuntu(?=[\s'])/g, `HOME=${home}`);

/** A driver that runs on this machine, the way a guest would. */
const local: RemoteDriver = {
  os: "linux",
  async exec(cmd, opts) {
    const script = guest(composeAgentShell(cmd, opts));
    const child = Bun.spawn(["bash", "-c", script], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => child.kill(), opts?.timeoutMs ?? 60_000);
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]).finally(() => clearTimeout(timer));
    return { exitCode, stdout, stderr };
  },
  async execBackground() {},
  async writeFile(path, content) {
    const target = guest(path);
    if (!target.startsWith(root)) throw new Error(`outside scratch: ${path}`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  },
  async ensureStarted() {},
};

function hook(name: string, body: string) {
  const path = join(repo, ".agents", name);
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(path, 0o755);
}

/** These run real shells with sleeps (2 to 4 s); a loaded host needs room. */
const SLOW_HOOK_TEST_MS = 20_000;
describe("setup", () => {
  test(
    "a settings pre-setup script runs before .agents/setup",
    async () => {
      hook("setup", 'echo repo setup ran >> "$HOME/order"');
      const result = await runRemoteLifecycleHook(
        local,
        repo,
        "setup",
        "fresh",
        "with-pre-setup",
        {
          sandboxId: "sbx",
          provider: "box",
          repoId: "with-pre-setup",
        },
      );
      expect(result.ran).toBe(true);
      expect(readFileSync(join(home, "order"), "utf8")).toBe(
        "pre-setup ran\nrepo setup ran\n",
      );
      // Once per disk.
      expect(
        (
          await runRemoteLifecycleHook(
            local,
            repo,
            "setup",
            "fresh",
            "with-pre-setup",
          )
        ).ran,
      ).toBe(false);
      rmSync(join(home, "order"));
    },
    SLOW_HOOK_TEST_MS,
  );

  test(
    "processes setup leaves running are stopped when it ends",
    async () => {
      const tag = `setup-leftover-${Date.now()}`;
      hook(
        "setup",
        `nohup bash -c 'exec -a ${tag} sleep 300' >/dev/null 2>&1 &\n(setsid bash -c 'exec -a ${tag} sleep 300' &)\necho done`,
      );
      const result = await runRemoteLifecycleHook(
        local,
        repo,
        "setup",
        "fresh",
        "leftovers",
      );
      expect(result.ran).toBe(true);
      const left = Bun.spawnSync(["pgrep", "-f", tag]);
      expect(left.stdout.toString().trim()).toBe("");
    },
    SLOW_HOOK_TEST_MS,
  );

  test(
    "the kill script spares processes without the marker",
    async () => {
      const bystander = Bun.spawn(["sleep", "30"]);
      const run = await local.exec(setupLeftoversKillScript("not-a-real-run"));
      expect(run.exitCode).toBe(0);
      expect(run.stdout).toBe("");
      expect(bystander.killed).toBe(false);
      bystander.kill();
    },
    SLOW_HOOK_TEST_MS,
  );
});

describe("resume", () => {
  test(
    "a slow .agents/resume does not hold the wake past the bound",
    async () => {
      hook("resume", `sleep 3; echo resumed >> "$HOME/order"`);
      const started = Date.now();
      await runResumeHook(
        local,
        "box",
        "sbx",
        { cwd: repo, sessionId: "s", repoId: "r" },
        500,
      );
      expect(Date.now() - started).toBeLessThan(2_500);
      // The workspace script ran first; the hook keeps going.
      expect(readFileSync(join(home, "order"), "utf8")).toBe("workspace\n");
      await Bun.sleep(3_500);
      expect(readFileSync(join(home, "order"), "utf8")).toBe(
        "workspace\nresumed\n",
      );
      expect(
        existsSync(join(home, ".opensession/lifecycle/workspace-resume.log")),
      ).toBe(true);
    },
    SLOW_HOOK_TEST_MS,
  );
});
